/**
 * Trakt MCP Functions
 * MCP tool definitions and implementations for Trakt integration
 */

import { TraktClient } from './client.js';
import { TraktSyncEngine, PlexAPIClient } from './sync.js';
import { PlexToTraktMapper } from './mapper.js';
import {
  TraktConfig,
  SyncOptions,
  MCPStatsResponse,
  TraktTokens
} from './types.js';
import {
  DEFAULT_TRAKT_API_URL,
  DEFAULT_BATCH_SIZE,
  ACHIEVEMENT_THRESHOLDS,
  TRAKT_PREVIEW_LIMIT,
  TRAKT_DEVICE_DEFAULT_INTERVAL,
  TRAKT_DEVICE_POLL_BUDGET_MS
} from './constants.js';
import { SUMMARY_PREVIEW_LENGTH } from '../plex/constants.js';
import { truncate, sanitizeSearchQuery, sleep } from '../shared/utils.js';

interface PendingDeviceAuth {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
}

const ROME_TIME_ZONE = 'Europe/Rome';
const romeOffsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ROME_TIME_ZONE,
  timeZoneName: 'longOffset',
});

function explicitOffsetMinutes(value: string): number | null {
  if (/Z$/i.test(value)) return 0;
  const match = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function romeOffsetMinutes(date: Date): number | null {
  const value = romeOffsetFormatter.formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = value?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export class TraktMCPFunctions {
  private traktClient!: TraktClient;
  private syncEngine!: TraktSyncEngine;
  private mapper: PlexToTraktMapper;
  private isInitialized: boolean = false;
  private pendingDevice?: PendingDeviceAuth;

  constructor(private plexClient: PlexAPIClient) {
    this.mapper = new PlexToTraktMapper();
    // Client will be initialized when authentication is set up
  }

  /**
   * Get all watched movie titles from Trakt (for recommendation engine).
   * Returns null if Trakt is not configured/authenticated.
   */
  async getWatchedMovieTitles(): Promise<Array<{ title: string; year: number; plays: number }> | null> {
    try {
      this.initializeTraktClient();
      const watched = await this.traktClient.getWatchedMovies();
      return watched.map((item) => ({
        title: item.movie.title,
        year: item.movie.year,
        plays: item.plays,
      }));
    } catch {
      return null;
    }
  }

  /**
   * Initialize Trakt client with configuration
   */
  private initializeTraktClient(): void {
    if (this.isInitialized) return;

    const config: TraktConfig = {
      baseUrl: process.env.TRAKT_BASE_URL || DEFAULT_TRAKT_API_URL,
      clientId: process.env.TRAKT_CLIENT_ID || '',
      clientSecret: process.env.TRAKT_CLIENT_SECRET || '',
      redirectUri: process.env.TRAKT_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob',
      accessToken: process.env.TRAKT_ACCESS_TOKEN,
      refreshToken: process.env.TRAKT_REFRESH_TOKEN
    };

    if (!config.clientId || !config.clientSecret) {
      throw new Error('TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET environment variables are required');
    }

    this.traktClient = new TraktClient(config);
    this.syncEngine = new TraktSyncEngine(this.traktClient, this.plexClient);
    this.isInitialized = true;
  }

  /**
   * MCP Function: trakt_authenticate
   * Start the device authorization flow and hand back the code to enter on Trakt.
   */
  async traktAuthenticate(_state?: string): Promise<Record<string, unknown>> {
    this.initializeTraktClient();

    try {
      const device = await this.traktClient.requestDeviceCode();

      this.pendingDevice = {
        deviceCode: device.device_code,
        expiresAt: Date.now() + device.expires_in * 1000,
        intervalMs: (device.interval || TRAKT_DEVICE_DEFAULT_INTERVAL) * 1000,
      };

      // Both camelCase and snake_case are emitted so existing clients keep working.
      return {
        success: true,
        userCode: device.user_code,
        user_code: device.user_code,
        verificationUrl: device.verification_url,
        verification_url: device.verification_url,
        authUrl: device.verification_url,
        expiresIn: device.expires_in,
        expires_in: device.expires_in,
        instructions: [
          `1. Open ${device.verification_url} in your browser`,
          `2. Enter the code ${device.user_code} and approve the app`,
          '3. Use trakt_complete_auth (no arguments) to finish setup'
        ],
        message: `Open ${device.verification_url} and enter the code ${device.user_code}, then complete the setup.`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication initialization failed'
      };
    }
  }

  /**
   * MCP Function: trakt_complete_auth
   * Finish the pending device authorization. Takes no arguments; the legacy
   * `code` parameter is only honoured when no device flow is in progress.
   */
  async traktCompleteAuth(code?: string): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      return {
        success: false,
        error: 'Trakt client not initialized. Call trakt_authenticate first.'
      };
    }

    if (!this.pendingDevice) {
      if (code) {
        // Legacy authorization-code exchange, kept for callers that still hold one.
        try {
          return this.buildAuthSuccess(await this.traktClient.exchangeCodeForToken(code));
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Token exchange failed'
          };
        }
      }
      return {
        success: false,
        error: 'No authentication in progress. Call trakt_authenticate first.'
      };
    }

    const { deviceCode, expiresAt, intervalMs } = this.pendingDevice;

    if (Date.now() >= expiresAt) {
      this.pendingDevice = undefined;
      return {
        success: false,
        error: 'The Trakt code has expired. Call trakt_authenticate to get a new one.'
      };
    }

    const deadline = Math.min(Date.now() + TRAKT_DEVICE_POLL_BUDGET_MS, expiresAt);

    try {
      for (;;) {
        const result = await this.traktClient.pollDeviceToken(deviceCode);

        if (result.status === 'authorized') {
          this.pendingDevice = undefined;
          return this.buildAuthSuccess(result.tokens);
        }

        if (result.status !== 'pending') {
          this.pendingDevice = undefined;
          const reasons: Record<string, string> = {
            expired: 'The Trakt code has expired. Call trakt_authenticate to get a new one.',
            denied: 'Authorization was denied on Trakt.',
            used: 'That Trakt code was already used. Call trakt_authenticate to get a new one.',
          };
          return { success: false, error: reasons[result.status] };
        }

        if (Date.now() + intervalMs >= deadline) {
          return {
            success: false,
            pending: true,
            message: 'Waiting for approval on Trakt. Enter the code, then run trakt_complete_auth again.'
          };
        }

        await sleep(intervalMs);
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed'
      };
    }
  }

  private async buildAuthSuccess(tokens: TraktTokens): Promise<Record<string, unknown>> {
    const user = await this.traktClient.getCurrentUser();

    return {
      success: true,
      user: {
        username: user.username,
        name: user.name,
        vip: user.vip
      },
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        created_at: tokens.created_at
      },
      message: 'Authentication successful! Add these to your environment config to persist across restarts:',
      env_config: `TRAKT_ACCESS_TOKEN=${tokens.access_token}\nTRAKT_REFRESH_TOKEN=${tokens.refresh_token}`,
      nextSteps: [
        'Add the above TRAKT_ACCESS_TOKEN and TRAKT_REFRESH_TOKEN to your MCP client env config or .env file',
        'Use trakt_get_auth_status to verify authentication',
        'Start syncing with trakt_sync_to_trakt'
      ]
    };
  }

  /**
   * MCP Function: trakt_get_auth_status
   * Check current authentication status
   */
  async traktGetAuthStatus(): Promise<Record<string, unknown>> {
    this.initializeTraktClient();

    try {
      const testResult = await this.traktClient.testConnection();
      
      if (testResult.success && testResult.user) {
        return {
          authenticated: true,
          user: {
            username: testResult.user.username,
            name: testResult.user.name,
            vip: testResult.user.vip,
            joined_at: testResult.user.joined_at
          },
          config: this.traktClient.getConfig(),
          message: 'Successfully authenticated with Trakt'
        };
      } else {
        return {
          authenticated: false,
          error: testResult.error,
          message: 'Not authenticated with Trakt. Use trakt_authenticate to set up.'
        };
      }
    } catch (error) {
      return {
        authenticated: false,
        error: error instanceof Error ? error.message : 'Authentication check failed'
      };
    }
  }

  /** Add one explicitly identified movie viewing to Trakt history. */
  async traktAddMovieToHistory(input: {
    traktId: number;
    title: string;
    watchedAt: string;
  }): Promise<Record<string, unknown>> {
    if (!Number.isInteger(input.traktId) || input.traktId <= 0) {
      return { success: false, error: 'A positive integer Trakt movie ID is required' };
    }

    const requestedTitle = input.title?.trim();
    if (!requestedTitle) {
      return { success: false, error: 'A movie title is required for confirmation' };
    }

    if (
      typeof input.watchedAt !== 'string' ||
      !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(input.watchedAt) ||
      Number.isNaN(Date.parse(input.watchedAt))
    ) {
      return {
        success: false,
        error: 'watchedAt must be a valid ISO 8601 date-time with an explicit timezone'
      };
    }

    const watchedAtDate = new Date(input.watchedAt);
    const suppliedOffset = explicitOffsetMinutes(input.watchedAt);
    const expectedOffset = romeOffsetMinutes(watchedAtDate);
    if (
      suppliedOffset === null ||
      expectedOffset === null ||
      suppliedOffset !== expectedOffset
    ) {
      return {
        success: false,
        error: expectedOffset === null
          ? 'Unable to determine the Europe/Rome offset for watchedAt'
          : `watchedAt must use the Europe/Rome offset ${formatOffset(expectedOffset)} for that date`
      };
    }

    if (!this.isInitialized) {
      this.initializeTraktClient();
    }

    try {
      const movie = await this.traktClient.getMovie(input.traktId);
      const watchedAt = watchedAtDate.toISOString();
      const result = await this.traktClient.syncWatchedMovies([{
        watched_at: watchedAt,
        ids: { trakt: movie.ids.trakt },
        title: movie.title,
        year: movie.year,
      }]);
      const notFound = result.not_found.movies.length > 0;

      return {
        success: !notFound,
        movie: {
          title: movie.title,
          year: movie.year,
          traktId: movie.ids.trakt,
        },
        requestedTitle,
        watchedAt,
        added: result.added.movies,
        existing: result.existing.movies,
        notFound: result.not_found.movies,
        message: notFound
          ? 'Trakt did not recognize the selected movie'
          : `Viewing added to Trakt history for ${movie.title}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add movie viewing to Trakt history'
      };
    }
  }

  /**
   * MCP Function: trakt_sync_to_trakt
   * Sync Plex watch history to Trakt
   */
  async traktSyncToTrakt(options: {
    dryRun?: boolean;
    batchSize?: number;
    includeProgress?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      this.initializeTraktClient();
    }

    try {
      const syncOptions: Partial<SyncOptions> = {
        direction: 'plex-to-trakt',
        dryRun: options.dryRun || false,
        batchSize: options.batchSize || DEFAULT_BATCH_SIZE,
        includeProgress: options.includeProgress || false,
        autoResolveConflicts: true
      };

      const result = await this.syncEngine.performFullSync(syncOptions);

      const maxErrors = 10;
      const truncatedErrors = result.errors.length > maxErrors
        ? [...result.errors.slice(0, maxErrors), `... and ${result.errors.length - maxErrors} more errors`]
        : result.errors;

      return {
        success: result.success,
        summary: {
          itemsProcessed: result.itemsProcessed,
          itemsAdded: result.itemsAdded,
          itemsUpdated: result.itemsUpdated,
          itemsFailed: result.itemsFailed,
          totalErrors: result.errors.length,
          duration: `${Math.round(result.duration / 1000)}s`
        },
        conflicts: result.conflicts.length > 0 ? result.conflicts.slice(0, 10) : undefined,
        errors: truncatedErrors.length > 0 ? truncatedErrors : undefined,
        startTime: result.startTime.toISOString(),
        endTime: result.endTime.toISOString(),
        dryRun: syncOptions.dryRun
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Sync failed'
      };
    }
  }

  /**
   * MCP Function: trakt_sync_from_trakt
   * Get Trakt watch history for comparison
   */
  async traktSyncFromTrakt(): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      this.initializeTraktClient();
    }

    try {
      const [watchedMovies, watchedShows] = await Promise.all([
        this.traktClient.getWatchedMovies(),
        this.traktClient.getWatchedShows()
      ]);

      return {
        success: true,
        trakt_data: {
          movies: {
            count: watchedMovies.length,
            items: watchedMovies.slice(0, TRAKT_PREVIEW_LIMIT).map(item => ({
              title: item.movie.title,
              year: item.movie.year,
              plays: item.plays,
              lastWatched: item.last_watched_at
            })),
            totalShowing: Math.min(TRAKT_PREVIEW_LIMIT, watchedMovies.length)
          },
          shows: {
            count: watchedShows.length,
            items: watchedShows.slice(0, TRAKT_PREVIEW_LIMIT).map(item => {
              const totalEpisodes = item.seasons.reduce((sum, season) => 
                sum + season.episodes.length, 0);
              return {
                title: item.show.title,
                year: item.show.year,
                totalEpisodes,
                lastWatched: item.last_watched_at
              };
            }),
            totalShowing: Math.min(TRAKT_PREVIEW_LIMIT, watchedShows.length)
          }
        },
        message: 'Retrieved watch history from Trakt (comparison data)'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch Trakt data'
      };
    }
  }

  /**
   * MCP Function: trakt_get_user_stats
   * Get enhanced user statistics from Trakt
   */
  async traktGetUserStats(userId?: number): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      this.initializeTraktClient();
    }

    try {
      const [user, stats] = await Promise.all([
        this.traktClient.getCurrentUser(),
        this.traktClient.getUserStats()
      ]);

      const totalHours = Math.round((stats.movies.minutes + stats.episodes.minutes) / 60);
      const totalWatched = stats.movies.watched + stats.episodes.watched;

      const enhancedStats: MCPStatsResponse = {
        userId: userId || 0,
        userName: user.name || user.username,
        traktStats: stats,
        enhancedStats: {
          totalHours,
          averageRating: 0, // Would need rating data
          topGenres: [], // Would need detailed analysis
          recentActivity: [], // Would need recent activity endpoint
          milestones: [
            {
              type: `${ACHIEVEMENT_THRESHOLDS.movies} Movies Watched`,
              achieved: stats.movies.watched >= ACHIEVEMENT_THRESHOLDS.movies,
              progress: stats.movies.watched,
              target: ACHIEVEMENT_THRESHOLDS.movies
            },
            {
              type: `${ACHIEVEMENT_THRESHOLDS.episodes} Episodes Watched`,
              achieved: stats.episodes.watched >= ACHIEVEMENT_THRESHOLDS.episodes,
              progress: stats.episodes.watched,
              target: ACHIEVEMENT_THRESHOLDS.episodes
            },
            {
              type: `${ACHIEVEMENT_THRESHOLDS.hours} Hours Watched`,
              achieved: totalHours >= ACHIEVEMENT_THRESHOLDS.hours,
              progress: totalHours,
              target: ACHIEVEMENT_THRESHOLDS.hours
            }
          ]
        },
        generatedAt: new Date().toISOString()
      };

      return {
        success: true,
        stats: enhancedStats,
        message: `Statistics for ${user.username} retrieved from Trakt`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get user stats'
      };
    }
  }

  /**
   * MCP Function: trakt_start_scrobbling
   * Enable real-time scrobbling
   */
  async traktStartScrobbling(sessionData: {
    ratingKey: string;
    title: string;
    type: 'movie' | 'episode';
    progress: number;
    duration?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      this.initializeTraktClient();
    }

    try {
      // This would integrate with real Plex session monitoring
      // For now, demonstrate the capability
      
      return {
        success: true,
        message: 'Scrobbling capability initialized',
        note: 'Real-time scrobbling requires integration with Plex webhook system',
        sessionData: {
          ratingKey: sessionData.ratingKey,
          title: sessionData.title,
          type: sessionData.type,
          progress: sessionData.progress
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start scrobbling'
      };
    }
  }

  /**
   * MCP Function: trakt_get_sync_status
   * Check current sync status
   */
  async traktGetSyncStatus(): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      return {
        syncInProgress: false,
        error: 'Trakt client not initialized'
      };
    }

    const status = this.syncEngine.getSyncStatus();
    
    return {
      syncInProgress: status.inProgress,
      syncId: status.syncId,
      message: status.inProgress ? 'Sync in progress' : 'No active sync'
    };
  }

  /**
   * MCP Function: trakt_search
   * Search for content on Trakt
   */
  async traktSearch(query: string, type?: 'movie' | 'show', year?: number, limit?: number): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      this.initializeTraktClient();
    }

    const sanitizedQuery = sanitizeSearchQuery(query);
    const effectiveLimit = limit || TRAKT_PREVIEW_LIMIT;
    try {
      const results = await this.traktClient.search(sanitizedQuery, type, year);

      return {
        success: true,
        query,
        type: type || 'all',
        year,
        results: results.slice(0, effectiveLimit).map(result => {
          const media = result.type === 'movie' ? result.movie : result.show;
          return {
            type: result.type,
            score: result.score,
            [result.type]: {
              title: media?.title,
              year: media?.year,
              ids: media?.ids,
              overview: media?.overview ? truncate(media.overview, SUMMARY_PREVIEW_LENGTH) : undefined
            }
          };
        }),
        totalResults: results.length,
        showing: Math.min(effectiveLimit, results.length)
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Search failed'
      };
    }
  }
}
