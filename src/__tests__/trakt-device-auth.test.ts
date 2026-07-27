import { describe, it, expect, vi, beforeEach } from "vitest";
import { TraktMCPFunctions } from "../trakt/mcp-functions.js";

function createMockPlexClient() {
  return {
    getWatchedMovies: vi.fn().mockResolvedValue([]),
    getWatchedEpisodes: vi.fn().mockResolvedValue([]),
    getCurrentSessions: vi.fn().mockResolvedValue([]),
    markAsWatched: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

const DEVICE_CODE = {
  device_code: "device-abc",
  user_code: "S7ZMN8DR",
  verification_url: "https://auth.trakt.tv/activate",
  expires_in: 600,
  interval: 5,
};

const TOKENS = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_in: 7776000,
  token_type: "bearer",
  scope: "public",
  created_at: 1,
};

/** Wire a mock client into an already-"initialized" TraktMCPFunctions. */
function attachClient(trakt: TraktMCPFunctions, client: Record<string, unknown>) {
  // @ts-expect-error — force init for test
  trakt.isInitialized = true;
  // @ts-expect-error — mock traktClient
  trakt.traktClient = client;
}

describe("Trakt device authentication", () => {
  let trakt: TraktMCPFunctions;

  beforeEach(() => {
    process.env.TRAKT_CLIENT_ID = "test-client-id";
    process.env.TRAKT_CLIENT_SECRET = "test-client-secret";
    trakt = new TraktMCPFunctions(createMockPlexClient() as never);
  });

  describe("traktAuthenticate", () => {
    it("returns the user code and verification url, not an authorize link", async () => {
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue(DEVICE_CODE),
      });

      const result = await trakt.traktAuthenticate();

      expect(result.success).toBe(true);
      expect(result.userCode).toBe("S7ZMN8DR");
      expect(result.verificationUrl).toBe("https://auth.trakt.tv/activate");
      // The out-of-band authorize URL is what Trakt now rejects; it must be gone.
      expect(JSON.stringify(result)).not.toContain("oauth/authorize");
      expect(JSON.stringify(result)).not.toContain("oob");
    });

    it("exposes snake_case aliases for existing clients", async () => {
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue(DEVICE_CODE),
      });

      const result = await trakt.traktAuthenticate();

      expect(result.user_code).toBe("S7ZMN8DR");
      expect(result.verification_url).toBe("https://auth.trakt.tv/activate");
      expect(result.authUrl).toBe("https://auth.trakt.tv/activate");
    });

    it("reports failure when Trakt refuses the device code request", async () => {
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockRejectedValue(new Error("Device code request failed: 403")),
      });

      const result = await trakt.traktAuthenticate();

      expect(result.success).toBe(false);
      expect(result.error).toContain("Device code request failed");
    });
  });

  describe("traktCompleteAuth", () => {
    it("returns tokens once the code is approved, without needing a PIN", async () => {
      const pollDeviceToken = vi.fn().mockResolvedValue({ status: "authorized", tokens: TOKENS });
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue(DEVICE_CODE),
        pollDeviceToken,
        getCurrentUser: vi.fn().mockResolvedValue({ username: "gipasoft", name: "Giorgio", vip: false }),
      });

      await trakt.traktAuthenticate();
      const result = await trakt.traktCompleteAuth();

      expect(result.success).toBe(true);
      expect(pollDeviceToken).toHaveBeenCalledWith("device-abc");
      expect((result.user as Record<string, unknown>).username).toBe("gipasoft");
      expect(result.env_config).toContain("TRAKT_ACCESS_TOKEN=at-1");
    });

    it("ignores a stray PIN and still completes the pending device flow", async () => {
      const exchangeCodeForToken = vi.fn();
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue(DEVICE_CODE),
        pollDeviceToken: vi.fn().mockResolvedValue({ status: "authorized", tokens: TOKENS }),
        exchangeCodeForToken,
        getCurrentUser: vi.fn().mockResolvedValue({ username: "gipasoft", name: "Giorgio", vip: false }),
      });

      await trakt.traktAuthenticate();
      const result = await trakt.traktCompleteAuth("FFBCECF1");

      expect(result.success).toBe(true);
      expect(exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it("reports pending instead of hanging when approval has not happened yet", async () => {
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue(DEVICE_CODE),
        pollDeviceToken: vi.fn().mockResolvedValue({ status: "pending" }),
        getCurrentUser: vi.fn(),
      });

      await trakt.traktAuthenticate();

      // Fake timers let the whole poll budget elapse without a real 30s wait.
      vi.useFakeTimers();
      try {
        const pending = trakt.traktCompleteAuth();
        await vi.advanceTimersByTimeAsync(35000);
        const result = await pending;

        expect(result.success).toBe(false);
        expect(result.pending).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up on a device code that outlived its expiry", async () => {
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue({ ...DEVICE_CODE, expires_in: 1 }),
        pollDeviceToken: vi.fn(),
        getCurrentUser: vi.fn(),
      });

      await trakt.traktAuthenticate();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const result = await trakt.traktCompleteAuth();

      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("expired");
    });

    it.each([
      ["denied", "denied"],
      ["expired", "expired"],
      ["used", "already used"],
    ])("surfaces a %s code as a clear error", async (status, expected) => {
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue(DEVICE_CODE),
        pollDeviceToken: vi.fn().mockResolvedValue({ status }),
        getCurrentUser: vi.fn(),
      });

      await trakt.traktAuthenticate();
      const result = await trakt.traktCompleteAuth();

      expect(result.success).toBe(false);
      expect(String(result.error).toLowerCase()).toContain(expected);
      expect(result.pending).toBeUndefined();
    });

    it("tells the caller to authenticate first when nothing is pending", async () => {
      attachClient(trakt, { pollDeviceToken: vi.fn() });

      const result = await trakt.traktCompleteAuth();

      expect(result.success).toBe(false);
      expect(result.error).toContain("trakt_authenticate");
    });

    it("stops reusing a device code after it is consumed", async () => {
      const pollDeviceToken = vi.fn().mockResolvedValue({ status: "authorized", tokens: TOKENS });
      attachClient(trakt, {
        requestDeviceCode: vi.fn().mockResolvedValue(DEVICE_CODE),
        pollDeviceToken,
        getCurrentUser: vi.fn().mockResolvedValue({ username: "gipasoft", name: "Giorgio", vip: false }),
      });

      await trakt.traktAuthenticate();
      await trakt.traktCompleteAuth();
      const second = await trakt.traktCompleteAuth();

      expect(second.success).toBe(false);
      expect(pollDeviceToken).toHaveBeenCalledTimes(1);
    });
  });
});
