/**
 * Trakt API constants and configuration defaults
 */

export const DEFAULT_TRAKT_API_URL = "https://api.trakt.tv";
export const TRAKT_OAUTH_URL = "https://api.trakt.tv/oauth/authorize";
export const TRAKT_API_TIMEOUT = 10000;

/**
 * Device code (OAuth 2.0 device authorization) endpoints.
 * Trakt's browser authorize flow now mandates PKCE and delivers failures by
 * redirecting to the redirect_uri, which for the out-of-band URN is not
 * navigable. The device flow needs neither a redirect_uri nor PKCE, so it is
 * the supported path for headless servers like this one.
 */
export const TRAKT_DEVICE_CODE_PATH = "/oauth/device/code";
export const TRAKT_DEVICE_TOKEN_PATH = "/oauth/device/token";

/** Trakt's documented fallback poll interval, in seconds. */
export const TRAKT_DEVICE_DEFAULT_INTERVAL = 5;

/**
 * How long a single trakt_complete_auth call keeps polling before returning
 * "pending". The caller authorizes on Trakt *before* triggering completion, so
 * the first poll normally succeeds; this bound just keeps the MCP request well
 * clear of client-side timeouts.
 */
export const TRAKT_DEVICE_POLL_BUDGET_MS = 30000;
export const TRAKT_INITIAL_RATE_LIMIT_DELAY = 1000;
export const TRAKT_DEFAULT_RETRY_AFTER = 60;
export const TRAKT_RATE_LIMIT_BACKOFF_MULTIPLIER = 2;
export const TRAKT_BATCH_DELAY_MS = 1000;
export const DEFAULT_BATCH_SIZE = 50;
export const INCREMENTAL_BATCH_SIZE = 25;
export const TRAKT_PREVIEW_LIMIT = 100;

export const ACHIEVEMENT_THRESHOLDS = {
  movies: 100,
  episodes: 1000,
  hours: 100,
} as const;
