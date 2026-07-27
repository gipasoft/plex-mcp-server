# Watch History Series Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Plex episode hierarchy metadata in `get_watch_history` so consumers can identify and group watched series reliably.

**Architecture:** Extend only the JSON projections in the primary session-history path and the library fallback path. Reuse the established `seriesTitle`, `seasonNumber`, and `episodeNumber` contract from `get_on_deck`; the Plex AI Client already consumes `seriesTitle`.

**Tech Stack:** TypeScript 6, Node.js 20+, Vitest 4, Plex HTTP API, MCP SDK

## Global Constraints

- The change is read-only and must not modify Plex or watch history.
- Do not add calls, configuration, dependencies, or metadata inference.
- Emit hierarchy fields only when Plex supplies `grandparentTitle`, `parentIndex`, or `index`.
- Keep behavior unchanged for movies and incomplete metadata.
- Do not publish an image or update the QNAP container without separate explicit authorization.

---

### Task 1: Preserve hierarchy metadata in primary session history

**Files:**
- Modify: `src/plex/tools.ts:943-970`
- Test: `src/__tests__/plex-tools.test.ts`

**Interfaces:**
- Consumes: Plex session objects returned by `PlexClient.makeRequest("/status/sessions/history/all", params)`.
- Produces: `getWatchHistory()` entries with optional `seriesTitle`, `seasonNumber`, and `episodeNumber` properties.

- [ ] **Step 1: Write the failing primary-path regression test**

Add this block inside `describe("PlexTools", ...)` in
`src/__tests__/plex-tools.test.ts`, after the `getOnDeck` tests:

```ts
  describe("getWatchHistory", () => {
    it("includes episode hierarchy metadata from session history", async () => {
      (client.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        MediaContainer: {
          Metadata: [
            {
              sessionKey: "session-1",
              ratingKey: "141844",
              title: "Episodio #1.8",
              type: "episode",
              grandparentTitle: "House of Guinness",
              parentIndex: 1,
              index: 8,
              viewedAt: 1785185004,
              duration: 3172949,
              viewOffset: 3172949,
            },
            {
              sessionKey: "session-2",
              ratingKey: "42",
              title: "Heat",
              type: "movie",
              viewedAt: 1785000000,
            },
          ],
        },
      });

      const result = parseResponse(await tools.getWatchHistory());

      expect(result.watchHistory[0]).toMatchObject({
        seriesTitle: "House of Guinness",
        seasonNumber: 1,
        episodeNumber: 8,
      });
      expect(result.watchHistory[1]).not.toHaveProperty("seriesTitle");
      expect(result.watchHistory[1]).not.toHaveProperty("seasonNumber");
      expect(result.watchHistory[1]).not.toHaveProperty("episodeNumber");
    });
  });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
npx vitest run src/__tests__/plex-tools.test.ts -t "includes episode hierarchy metadata from session history"
```

Expected: FAIL because the first history entry does not contain
`seriesTitle`, `seasonNumber`, or `episodeNumber`.

- [ ] **Step 3: Add the minimal primary-path projection**

In the object returned by `sessions.map((session) => ({ ... }))` in
`src/plex/tools.ts`, immediately after `year`, add:

```ts
          seriesTitle: session.grandparentTitle,
          seasonNumber: session.parentIndex,
          episodeNumber: session.index,
```

Do not add fallback lookups or default values. `JSON.stringify` will omit the
properties when their values are `undefined`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```sh
npx vitest run src/__tests__/plex-tools.test.ts -t "includes episode hierarchy metadata from session history"
```

Expected: PASS.

- [ ] **Step 5: Commit the primary-path change**

```sh
git add src/plex/tools.ts src/__tests__/plex-tools.test.ts
git commit -m "fix: preserve series metadata in Plex session history"
```

### Task 2: Preserve hierarchy metadata in library fallback history

**Files:**
- Modify: `src/plex/tools.ts:1560-1618`
- Test: `src/__tests__/plex-tools.test.ts`

**Interfaces:**
- Consumes: Plex episode objects returned by `/library/sections/{key}/all`.
- Produces: fallback `getWatchHistory()` entries with the same optional hierarchy fields as the primary path.

- [ ] **Step 1: Write the failing fallback regression test**

Add this test to the `describe("getWatchHistory", ...)` block created in
Task 1:

```ts
    it("includes episode hierarchy metadata in the library fallback", async () => {
      (client.makeRequest as ReturnType<typeof vi.fn>).mockImplementation(
        async (endpoint: string) => {
          if (endpoint === "/status/sessions/history/all") {
            throw new Error("session history unavailable");
          }
          if (endpoint === "/library/sections") {
            return {
              MediaContainer: {
                Directory: [{ key: "7", title: "Serie TV", type: "show" }],
              },
            };
          }
          if (endpoint === "/library/sections/7/all") {
            return {
              MediaContainer: {
                Metadata: [
                  {
                    ratingKey: "141844",
                    title: "Episodio #1.8",
                    type: "episode",
                    grandparentTitle: "House of Guinness",
                    parentIndex: 1,
                    index: 8,
                    lastViewedAt: 1785185004,
                    viewCount: 1,
                    duration: 3172949,
                  },
                ],
              },
            };
          }
          throw new Error(`Unexpected endpoint: ${endpoint}`);
        },
      );

      const result = parseResponse(
        await tools.getWatchHistory(10, undefined, "episode"),
      );

      expect(result.note).toBe(
        "Generated from library metadata (fallback method)",
      );
      expect(result.watchHistory[0]).toMatchObject({
        ratingKey: "141844",
        seriesTitle: "House of Guinness",
        seasonNumber: 1,
        episodeNumber: 8,
      });
    });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
npx vitest run src/__tests__/plex-tools.test.ts -t "includes episode hierarchy metadata in the library fallback"
```

Expected: FAIL because the fallback history entry omits the three hierarchy
properties.

- [ ] **Step 3: Preserve the fields through both fallback projections**

In `getWatchHistoryFromLibraries()`, add these fields to the `historyItems`
object built from each raw Plex item, immediately after `year`:

```ts
          seriesTitle: item.grandparentTitle,
          seasonNumber: item.parentIndex,
          episodeNumber: item.index,
```

Then add the same properties to the final `allViewedItems.map()` projection,
immediately after `year`:

```ts
        seriesTitle: item.seriesTitle,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
```

- [ ] **Step 4: Run focused and full server verification**

Run:

```sh
npx vitest run src/__tests__/plex-tools.test.ts -t "getWatchHistory"
npm test
npm run build
```

Expected: both focused tests PASS, the full Vitest suite passes with no
failures, and TypeScript compilation exits with code 0.

- [ ] **Step 5: Commit the fallback change**

```sh
git add src/plex/tools.ts src/__tests__/plex-tools.test.ts
git commit -m "fix: preserve series metadata in fallback history"
```

### Task 3: Lock the client/server metadata contract

**Files:**
- Test: `D:/Repositories/+arr/plex-ai-client/test/agent.test.ts:481-510`

**Interfaces:**
- Consumes: MCP `get_watch_history` entries containing `seriesTitle`.
- Produces: a client regression fixture proving that the deterministic summary uses the MCP contract selected in this plan.

- [ ] **Step 1: Update one client fixture to use the server contract**

In the test `adds a deterministic latest-series summary to watch history
results`, change only the first episode fixture:

```ts
            {
              type: "episode",
              seriesTitle: "The Last of Us",
              title: "Niente di simile al mondo",
              viewedAt: "2023-09-30T20:00:00.000Z",
            },
```

Keep the other fixtures on `grandparentTitle`; this verifies compatibility
with both the new canonical field and existing Plex-shaped payloads.

- [ ] **Step 2: Run the focused client contract test**

From `D:/Repositories/+arr/plex-ai-client`, run:

```sh
npx vitest run test/agent.test.ts -t "adds a deterministic latest-series summary to watch history results"
```

Expected: PASS, proving the client already consumes `seriesTitle`.

- [ ] **Step 3: Run the complete client verification**

Run:

```sh
npm test
npm run build
```

Expected: the full client suite passes and TypeScript compilation exits with
code 0.

- [ ] **Step 4: Commit the client contract test**

```sh
git add test/agent.test.ts
git commit -m "test: cover MCP series metadata contract"
```

### Task 4: Confirm repository state and deployment boundary

**Files:**
- Verify only: both repositories

**Interfaces:**
- Consumes: commits produced by Tasks 1-3.
- Produces: a clean handoff identifying the server image rebuild as the remaining deployment action.

- [ ] **Step 1: Check both worktrees**

Run:

```sh
git status --short
git log -3 --oneline
git -C D:/Repositories/+arr/plex-ai-client status --short
git -C D:/Repositories/+arr/plex-ai-client log -3 --oneline
```

Expected: both worktrees are clean and their latest commits include the
server fixes and client contract test.

- [ ] **Step 2: Record the operational boundary**

Report that source and tests are complete, while image publication and QNAP
container update remain unexecuted pending separate explicit authorization.
