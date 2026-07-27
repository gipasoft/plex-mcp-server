# Embedded Trilium MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `plex-mcp-server` with the verified Trilium MCP binary embedded so that, after one QNAP Compose migration, future upgrades require only image pull and container recreation.

**Architecture:** Add a pinned Go build stage to the existing multi-stage Dockerfile and copy the resulting static Trilium binary into the `mcp-proxy` runtime. Remove the QNAP bind mount that currently shadows that binary, and extend the existing image smoke test to initialize Trilium over stdio and verify the live `search_notes` ordering schema before the exact tested image is pushed.

**Tech Stack:** Docker BuildKit, Go 1.23, Node.js 24, Vitest 4, MCP JSON-RPC over stdio, GitHub Actions, GHCR, Docker Compose.

## Global Constraints

- Build Trilium MCP only from `https://github.com/gipasoft/trilium-mcp.git`.
- Pin the complete source commit `9777d36107baa18cc7024b07936c03b7cc793c16`.
- Compile with `CGO_ENABLED=0`, `GOOS=linux`, `GOARCH=amd64`, `-trimpath`, and `-ldflags="-s -w"`.
- Install the runtime binary at `/usr/local/bin/trilium-mcp`.
- Do not include tokens, private URLs, `.env`, or the real `config.json` in the image or repository.
- Preserve the existing Plex MCP build, `mcp-proxy` version `v0.43.2`, entrypoint, configuration mount, port, network, healthcheck, and service name.
- Remove only the QNAP bind mount `./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro`.
- Keep ETAPI as the authority for ordering; do not add local sorting.
- The smoke-tested local image must be the exact image pushed to GHCR.
- Codex must not execute commands on the QNAP.

---

## File Map

- `src/__tests__/trilium-packaging.test.ts`: static regression contract for the pinned source, runtime copy, and sanitized QNAP Compose.
- `Dockerfile`: builds Plex MCP, builds pinned Trilium MCP, and assembles both in the existing proxy runtime.
- `scripts/smoke-test-image.mjs`: verifies the existing proxy payload plus the embedded Trilium executable and its live MCP schema.
- `docker-compose.qnap.yml`: sanitized QNAP reference without the obsolete Trilium bind mount.
- `docs/qnap-ghcr-deployment.md`: one-time migration, routine pull/up flow, functional verification, and rollback.
- `.github/workflows/docker-publish.yml`: runs the candidate image smoke test on
  `fix/**` pushes and continues to publish only from `main` or version tags.

---

### Task 1: Lock the embedded binary and Compose contract

**Files:**
- Create: `src/__tests__/trilium-packaging.test.ts`
- Modify: `Dockerfile`
- Modify: `docker-compose.qnap.yml`

**Interfaces:**
- Consumes: Docker BuildKit multi-stage builds and the existing runtime image `ghcr.io/tbxark/mcp-proxy:v0.43.2`.
- Produces: executable `/usr/local/bin/trilium-mcp` in the runtime and a Compose reference that no longer shadows it.

- [ ] **Step 1: Write the failing packaging contract**

Create `src/__tests__/trilium-packaging.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("../../Dockerfile", import.meta.url),
  "utf8",
);
const qnapCompose = readFileSync(
  new URL("../../docker-compose.qnap.yml", import.meta.url),
  "utf8",
);

describe("embedded Trilium MCP packaging", () => {
  it("builds the verified fork commit and copies its binary into the runtime", () => {
    expect(dockerfile).toContain(
      "FROM golang:1.23-bookworm AS trilium-build",
    );
    expect(dockerfile).toContain(
      "https://github.com/gipasoft/trilium-mcp.git",
    );
    expect(dockerfile).toContain(
      "9777d36107baa18cc7024b07936c03b7cc793c16",
    );
    expect(dockerfile).toContain("CGO_ENABLED=0 GOOS=linux GOARCH=amd64");
    expect(dockerfile).toContain("-trimpath");
    expect(dockerfile).toContain('-ldflags="-s -w"');
    expect(dockerfile).toContain(
      "COPY --from=trilium-build /out/trilium-mcp /usr/local/bin/trilium-mcp",
    );
  });

  it("uses the embedded binary without changing the QNAP proxy contract", () => {
    expect(qnapCompose).not.toContain("./bin/trilium-mcp");
    expect(qnapCompose).toContain(
      "./config.json:/config/config.json:ro",
    );
    expect(qnapCompose).toContain(
      "image: ghcr.io/gipasoft/plex-mcp-server:latest",
    );
    expect(qnapCompose).toContain('"9097:9090"');
    expect(qnapCompose).toContain("qnap-network");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```powershell
npm test -- --run src/__tests__/trilium-packaging.test.ts
```

Expected: FAIL because the Dockerfile has no Go stage or runtime copy and the Compose still contains the bind mount.

- [ ] **Step 3: Add the pinned Trilium build stage**

Insert this stage before the existing `plex-build` stage in `Dockerfile`:

```dockerfile
FROM golang:1.23-bookworm AS trilium-build

RUN git init /src/trilium-mcp \
 && git -C /src/trilium-mcp remote add origin https://github.com/gipasoft/trilium-mcp.git \
 && git -C /src/trilium-mcp fetch --depth 1 origin 9777d36107baa18cc7024b07936c03b7cc793c16 \
 && git -C /src/trilium-mcp checkout --detach FETCH_HEAD \
 && cd /src/trilium-mcp \
 && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -trimpath -ldflags="-s -w" -o /out/trilium-mcp .
```

Add this copy after the existing Node payload copies in the runtime stage:

```dockerfile
COPY --from=trilium-build /out/trilium-mcp /usr/local/bin/trilium-mcp
```

- [ ] **Step 4: Remove the shadowing bind mount**

Delete only this line from `docker-compose.qnap.yml`:

```yaml
- ./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro
```

Keep the `volumes:` block and the `config.json` mount.

- [ ] **Step 5: Run the focused and complete test suites**

Run:

```powershell
npm test -- --run src/__tests__/trilium-packaging.test.ts
npm test
```

Expected: the focused test passes; all existing tests plus the two new tests pass.

- [ ] **Step 6: Check formatting and commit**

Run:

```powershell
git diff --check
git status --short
git add Dockerfile docker-compose.qnap.yml src/__tests__/trilium-packaging.test.ts
git commit -m "feat: embed verified Trilium MCP binary"
```

Expected: one implementation commit with no unrelated files.

---

### Task 2: Verify the live Trilium MCP schema in the image

**Files:**
- Modify: `scripts/smoke-test-image.mjs`
- Modify: `.github/workflows/docker-publish.yml`

**Interfaces:**
- Consumes: image argument `process.argv[2]` and embedded `/usr/local/bin/trilium-mcp`.
- Produces: a smoke-test failure unless the binary initializes and `search_notes` exposes the approved ordering enum contract.

- [ ] **Step 1: Add a stdio Docker helper**

Add after the existing `docker()` helper:

```js
function dockerWithInput(args, input) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
```

- [ ] **Step 2: Add deterministic MCP response parsing**

Add after `waitForStableContainer()`:

```js
function jsonRpcResponses(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function verifyTriliumSchema(output) {
  const response = jsonRpcResponses(output).find(
    (entry) => entry.id === 2,
  );
  if (!response || response.error) {
    throw new Error(`tools/list Trilium non riuscito: ${output}`);
  }
  const tools = response.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list Trilium non contiene tools");
  }
  const search = tools.find((tool) => tool.name === "search_notes");
  if (!search) {
    throw new Error("search_notes assente dal binario Trilium incorporato");
  }
  const properties = search.inputSchema?.properties;
  const orderBy = properties?.order_by?.enum;
  const direction = properties?.order_direction?.enum;
  if (
    JSON.stringify(orderBy) !==
      JSON.stringify(["dateModified", "utcDateModified"]) ||
    JSON.stringify(direction) !== JSON.stringify(["asc", "desc"])
  ) {
    throw new Error(
      `schema search_notes inatteso: ${JSON.stringify(properties)}`,
    );
  }
}
```

- [ ] **Step 3: Invoke Trilium over stdio before accepting the image**

Inside the existing `try` block, before the proxy container is started, add:

```js
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "image-smoke", version: "1.0.0" },
    },
  });
  const initialized = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const toolsList = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const triliumOutput = dockerWithInput(
    [
      "run",
      "--rm",
      "--interactive",
      "--env",
      "TRILIUM_URL=http://127.0.0.1:9999",
      "--env",
      "TRILIUM_TOKEN=smoke-test-token",
      "--entrypoint",
      "/usr/local/bin/trilium-mcp",
      image,
    ],
    `${initialize}\n${initialized}\n${toolsList}\n`,
  );
  verifyTriliumSchema(triliumOutput);
```

Extend the existing in-container shell assertions with:

```js
      "test -x /usr/local/bin/trilium-mcp",
```

- [ ] **Step 4: Run the candidate image smoke test on fix branches**

Extend the workflow push trigger:

```yaml
  push:
    branches:
      - main
      - "fix/**"
```

Change the `pull-request-image` job condition to:

```yaml
    if: >-
      github.event_name == 'pull_request' ||
      (github.event_name == 'push' &&
      startsWith(github.ref, 'refs/heads/fix/'))
```

Keep the publish job condition unchanged so feature branches can build and
smoke-test images but cannot push packages.

- [ ] **Step 5: Run static checks**

```powershell
node --check scripts/smoke-test-image.mjs
npm test
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Run the image smoke test when Docker is available**

Run:

```powershell
docker build -t plex-mcp-server:trilium-smoke .
node scripts/smoke-test-image.mjs plex-mcp-server:trilium-smoke
```

Expected: the Docker build succeeds and the script prints
`Smoke test superato per plex-mcp-server:trilium-smoke`.

If the local Docker daemon is unavailable, record that limitation and require
the GitHub Actions `Build, smoke-test, and publish container` job to pass before
merging or giving QNAP commands.

- [ ] **Step 7: Commit the smoke-test contract**

Run:

```powershell
git add scripts/smoke-test-image.mjs .github/workflows/docker-publish.yml
git commit -m "test: verify embedded Trilium MCP schema"
```

Expected: one commit containing only the smoke-test extension.

---

### Task 3: Document the one-time QNAP migration

**Files:**
- Modify: `docs/qnap-ghcr-deployment.md`

**Interfaces:**
- Consumes: embedded binary and Compose contract from Task 1.
- Produces: exact operator-only migration, verification, routine upgrade, and rollback commands.

- [ ] **Step 1: Replace obsolete bind-mount guidance**

Change the migration section so it explicitly requires removing only:

```yaml
- ./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro
```

State that `bin/trilium-mcp` should remain on disk as a recoverable backup but
must no longer be mounted. Preserve the warning not to overwrite the complete
active QNAP Compose with the sanitized repository example.

- [ ] **Step 2: Add pre-update rollback evidence**

Before the pull command, document:

```sh
cd /share/Container/container-station-data/application/plex_mcp
docker image inspect "$(docker inspect --format '{{.Image}}' plex-mcp)" \
  --format '{{index .RepoDigests 0}}'
```

State that the operator records the printed immutable digest before pulling.

- [ ] **Step 3: Document the canonical project-scoped commands**

Use these commands for validation and update:

```sh
docker compose -p plex_mcp config --quiet
docker compose -p plex_mcp pull plex-mcp
docker compose -p plex_mcp up -d plex-mcp
docker compose -p plex_mcp ps
docker compose -p plex_mcp logs --since=10m --tail=200 plex-mcp
```

State that only the user operates the QNAP and that `docker rm`, volume
deletion, `docker compose down -v`, and local builds are not part of the
procedure.

- [ ] **Step 4: Extend endpoint verification for ordering**

In the existing MCP verification script, after `listTools()` for Trilium,
assert:

```js
const triliumTools = await clients.get("trilium").listTools();
const searchNotes = triliumTools.tools.find(
  (tool) => tool.name === "search_notes",
);
const properties = searchNotes?.inputSchema?.properties;
if (
  JSON.stringify(properties?.order_by?.enum) !==
    JSON.stringify(["dateModified", "utcDateModified"]) ||
  JSON.stringify(properties?.order_direction?.enum) !==
    JSON.stringify(["asc", "desc"])
) {
  throw new Error("search_notes non espone l'ordinamento atteso");
}
console.log("search_notes ordering schema: OK");
```

Document the read-only acceptance request:

```text
Usa Trilium in sola lettura. Restituisci le cinque note modificate più di
recente, ordinate dalla più recente alla meno recente, mostrando titolo e data.
```

- [ ] **Step 5: Update rollback guidance**

State that rollback normally means restoring the recorded previous GHCR digest
and recreating only `plex-mcp`. Re-adding the saved bind mount is an emergency
fallback only; it restores the old Trilium behavior.

- [ ] **Step 6: Validate and commit documentation**

Run:

```powershell
rg -n -F "./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro" docs/qnap-ghcr-deployment.md docker-compose.qnap.yml
git diff --check
git add docs/qnap-ghcr-deployment.md
git commit -m "docs: migrate QNAP to embedded Trilium MCP"
```

Expected: the mount string appears only where the documentation tells the
operator which line to remove, never in `docker-compose.qnap.yml`.

---

### Task 4: Full verification, publication, and handoff

**Files:**
- Inspect: all files changed from `origin/main`.
- Modify only if verification exposes a defect.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: pushed `main`, green GitHub Actions publication, immutable image reference, and QNAP commands for the user.

- [ ] **Step 1: Run the complete local verification**

Run:

```powershell
npm ci
npm audit --audit-level=high
npm test
npm run build
node --check scripts/smoke-test-image.mjs
git diff --check origin/main...HEAD
git status --short
```

Expected: audit has no high-severity failure, 201 tests pass, TypeScript builds,
the script parses, the diff has no whitespace errors, and the worktree is
clean.

- [ ] **Step 2: Audit the exact change set**

Run:

```powershell
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- Dockerfile docker-compose.qnap.yml scripts/smoke-test-image.mjs docs/qnap-ghcr-deployment.md
git grep -n -E 'TRILIUM_TOKEN=|Authorization:|private-token' HEAD -- ':!docs/superpowers/**'
```

Expected: no real secret or private endpoint; the only Trilium token is the
literal `smoke-test-token` test value; no QNAP runtime file is present.

- [ ] **Step 3: Push the feature branch**

Run:

```powershell
git push -u origin fix/embed-trilium-mcp
```

Expected: the branch is present on `gipasoft/plex-mcp-server`.

- [ ] **Step 4: Require a green GitHub Actions run for the exact branch commit**

Inspect the workflow run for the exact `HEAD` SHA. Require success for:

- Node setup and dependency installation;
- high-severity audit;
- 201 Vitest tests;
- TypeScript build;
- Linux AMD64 Docker build;
- proxy smoke test;
- embedded Trilium MCP stdio initialization and schema assertion.

Do not merge after a failed or unrelated run.

- [ ] **Step 5: Fast-forward `main` and publish GHCR**

After the feature-branch run is green:

```powershell
git switch main
git pull --ff-only origin main
git merge --ff-only fix/embed-trilium-mcp
git push origin main
```

Expected: the push triggers the publication workflow for the exact merged SHA.

- [ ] **Step 6: Require successful publication and record identity**

Inspect the `main` workflow for the exact merged SHA. Require successful build,
schema smoke test, push, and a recorded immutable reference of the form:

The summary must contain `ghcr.io/gipasoft/plex-mcp-server@sha256:` followed
by exactly 64 lowercase hexadecimal digits.

Copy the actual reference from the workflow summary into the final handoff; do
not invent or infer it.

- [ ] **Step 7: Give operator-only QNAP instructions**

Report:

- repository and exact merged commit;
- green workflow URL;
- exact immutable GHCR reference;
- the one line the user must remove from the active Compose;
- the QNAP directory
  `/share/Container/container-station-data/application/plex_mcp`;
- the canonical `-p plex_mcp` config, pull, up, ps, and logs commands;
- read-only acceptance checks for Plex, Paperless, and ordered Trilium notes;
- explicit confirmation that Codex did not execute anything on the QNAP.

Do not claim the live QNAP test passed until the user returns its actual output.
