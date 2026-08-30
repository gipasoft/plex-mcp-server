import { describe, it, expect, vi, beforeEach } from "vitest";
import { TraktMCPFunctions } from "../trakt/mcp-functions.js";
import { TRAKT_PREVIEW_LIMIT } from "../trakt/constants.js";
import { SUMMARY_PREVIEW_LENGTH } from "../plex/constants.js";

const LONG_OVERVIEW = "C".repeat(1000);

function createMockPlexClient() {
  return {
    getWatchedMovies: vi.fn().mockResolvedValue([]),
    getWatchedEpisodes: vi.fn().mockResolvedValue([]),
    getCurrentSessions: vi.fn().mockResolvedValue([]),
    markAsWatched: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSearchResults(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? "movie" : "show",
    score: 100 - i,
    movie: i % 2 === 0 ? { title: `Movie ${i}`, year: 2024, ids: { trakt: i }, overview: LONG_OVERVIEW } : undefined,
    show: i % 2 !== 0 ? { title: `Show ${i}`, year: 2024, ids: { trakt: i }, overview: LONG_OVERVIEW } : undefined,
  }));
}

describe("TraktMCPFunctions", () => {
  let trakt: TraktMCPFunctions;

  beforeEach(() => {
    process.env.TRAKT_CLIENT_ID = "test-client-id";
    process.env.TRAKT_CLIENT_SECRET = "test-client-secret";
    const plexClient = createMockPlexClient();
    trakt = new TraktMCPFunctions(plexClient as never);
  });

  describe("traktSearch", () => {
    it("respects custom limit", async () => {
      const results = makeSearchResults(50);
      // Mock the traktClient.search method by initializing then overriding
      // @ts-expect-error — force init for test
      trakt.isInitialized = true;
      // @ts-expect-error — mock traktClient
      trakt.traktClient = { search: vi.fn().mockResolvedValue(results) };

      const result = await trakt.traktSearch("test", undefined, undefined, 10);
      expect((result.results as unknown[]).length).toBe(10);
      expect(result.showing).toBe(10);
      expect(result.totalResults).toBe(50);
    });

    it("defaults to TRAKT_PREVIEW_LIMIT when no limit given", async () => {
      const results = makeSearchResults(200);
      // @ts-expect-error — force init for test
      trakt.isInitialized = true;
      // @ts-expect-error — mock traktClient
      trakt.traktClient = { search: vi.fn().mockResolvedValue(results) };

      const result = await trakt.traktSearch("test");
      expect((result.results as unknown[]).length).toBe(TRAKT_PREVIEW_LIMIT);
    });

    it("truncates overviews", async () => {
      const results = makeSearchResults(1);
      // @ts-expect-error — force init for test
      trakt.isInitialized = true;
      // @ts-expect-error — mock traktClient
      trakt.traktClient = { search: vi.fn().mockResolvedValue(results) };

      const result = await trakt.traktSearch("test");
      const item = (result.results as Array<{ movie?: { overview?: string }; show?: { overview?: string } }>)[0];
      const overview = item.movie?.overview || item.show?.overview || "";
      expect(overview.length).toBeLessThanOrEqual(SUMMARY_PREVIEW_LENGTH + 3);
    });
  });

  describe("traktAddMovieToHistory", () => {
    it("resolves the Trakt ID and adds exactly one timestamped movie play", async () => {
      const getMovie = vi.fn().mockResolvedValue({
        title: "Close Encounters of the Third Kind",
        year: 1977,
        ids: { trakt: 114, slug: "close-encounters", imdb: "tt0075860", tmdb: 840 },
      });
      const syncWatchedMovies = vi.fn().mockResolvedValue({
        added: { movies: 1, shows: 0, seasons: 0, episodes: 0 },
        existing: { movies: 0, shows: 0, seasons: 0, episodes: 0 },
        not_found: { movies: [], shows: [], seasons: [], episodes: [] },
      });
      // @ts-expect-error — force init for test
      trakt.isInitialized = true;
      // @ts-expect-error — mock traktClient
      trakt.traktClient = { getMovie, syncWatchedMovies };

      const result = await trakt.traktAddMovieToHistory({
        traktId: 114,
        title: "Incontri ravvicinati del terzo tipo",
        watchedAt: "2026-08-30T21:00:00+02:00",
      });

      expect(getMovie).toHaveBeenCalledWith(114);
      expect(syncWatchedMovies).toHaveBeenCalledWith([{
        watched_at: "2026-08-30T19:00:00.000Z",
        ids: { trakt: 114 },
        title: "Close Encounters of the Third Kind",
        year: 1977,
      }]);
      expect(result).toMatchObject({
        success: true,
        watchedAt: "2026-08-30T19:00:00.000Z",
        added: 1,
      });
    });

    it.each([
      { traktId: 0, title: "Film", watchedAt: "2026-08-30T21:00:00+02:00" },
      { traktId: 114, title: "", watchedAt: "2026-08-30T21:00:00+02:00" },
      { traktId: 114, title: "Film", watchedAt: "2026-08-30T21:00:00" },
      { traktId: 114, title: "Film", watchedAt: "2026-08-30T21:00:00Z" },
      { traktId: 114, title: "Film", watchedAt: "2026-01-30T21:00:00+02:00" },
    ])("rejects invalid, timezone-less, or non-Rome input %#", async (input) => {
      // @ts-expect-error — force init for test
      trakt.isInitialized = true;
      const syncWatchedMovies = vi.fn();
      // @ts-expect-error — mock traktClient
      trakt.traktClient = { syncWatchedMovies };

      const result = await trakt.traktAddMovieToHistory(input);

      expect(result.success).toBe(false);
      expect(syncWatchedMovies).not.toHaveBeenCalled();
    });
  });

  describe("traktSyncFromTrakt", () => {
    it("respects TRAKT_PREVIEW_LIMIT for watched items", async () => {
      const movies = Array.from({ length: 200 }, (_, i) => ({
        movie: { title: `Movie ${i}`, year: 2024 },
        plays: 1,
        last_watched_at: "2026-01-01",
      }));
      const shows = Array.from({ length: 200 }, (_, i) => ({
        show: { title: `Show ${i}`, year: 2024 },
        last_watched_at: "2026-01-01",
        seasons: [{ episodes: [{ number: 1 }] }],
      }));

      // @ts-expect-error — force init for test
      trakt.isInitialized = true;
      // @ts-expect-error — mock traktClient
      trakt.traktClient = {
        getWatchedMovies: vi.fn().mockResolvedValue(movies),
        getWatchedShows: vi.fn().mockResolvedValue(shows),
      };

      const result = await trakt.traktSyncFromTrakt();
      expect(result.success).toBe(true);
      const data = result.trakt_data as {
        movies: { items: unknown[]; totalShowing: number };
        shows: { items: unknown[]; totalShowing: number };
      };
      expect(data.movies.items.length).toBe(TRAKT_PREVIEW_LIMIT);
      expect(data.movies.totalShowing).toBe(TRAKT_PREVIEW_LIMIT);
      expect(data.shows.items.length).toBe(TRAKT_PREVIEW_LIMIT);
    });
  });
});
