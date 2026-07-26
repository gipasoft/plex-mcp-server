# Plex MCP GHCR and QNAP Deployment Design

## Goal

Publish the corrected `gipasoft/plex-mcp-server` fork as a public Docker
image built exclusively by GitHub Actions, so the QNAP installation can be
updated with:

```bash
docker compose pull
docker compose up -d
```

The deployed Plex MCP must expose the existing `/plex/mcp` Streamable HTTP
endpoint through the current `tbxark/mcp-proxy` gateway. Paperless and Trilium
must continue to use the same proxy without behavioral changes.

## Current deployment

The QNAP is `x86_64` and runs one Container Station application containing:

- `paperless-mcp`, an HTTP MCP service using
  `ghcr.io/barryw/paperlessmcp:v0.3.2`;
- `plex-mcp`, the shared gateway using
  `ghcr.io/tbxark/mcp-proxy:latest`;
- an external Docker network named `qnap-network`;
- a host mapping from port `9097` to proxy port `9090`.

The proxy mounts `config.json`, `.env`, and the local Trilium binary. Its Plex
entry currently executes:

```json
{
  "command": "npx",
  "args": ["-y", "plex-mcp-server@latest"]
}
```

This downloads the upstream npm package at container startup. It bypasses the
fork, makes startup depend on npm availability, and prevents GitHub Actions
from being the sole build path.

## Chosen architecture

The fork will publish a custom proxy image:

```text
ghcr.io/gipasoft/plex-mcp-server
```

The image will retain `mcp-proxy` as its entrypoint while embedding the
compiled Plex MCP application and its production dependencies at:

```text
/opt/plex-mcp-server
```

The runtime base will be pinned to:

```text
ghcr.io/tbxark/mcp-proxy:v0.43.2
```

The official proxy image already includes Node, npm, npx, Python, the
`mcp-proxy` executable, and its `/main` entrypoint. Pinning the version tag
reduces accidental drift and prevents routine `latest` updates from entering
the QNAP deployment through a rebuild. A tag and the other external build
inputs remain mutable, so the build is not claimed to be byte-for-byte
reproducible; the published manifest digest is the immutable deployment and
rollback identity.

The QNAP `config.json` Plex entry will become:

```json
{
  "command": "node",
  "args": ["/opt/plex-mcp-server/build/plex-mcp-server.js"]
}
```

All existing Plex environment variables remain unchanged. The Paperless URL,
Trilium command, proxy authentication, paths, port mapping, volumes, and
network remain unchanged.

## Repository changes

The fork will add these files:

- `Dockerfile`: multi-stage Node build plus pinned `mcp-proxy` runtime;
- `.dockerignore`: excludes Git metadata, local dependencies, build output,
  real `config.json` and backups, npm credentials, keys, certificates,
  secrets, logs, editor state, and test artifacts;
- `.github/workflows/docker-publish.yml`: verifies and publishes the image;
- `docker-compose.qnap.yml`: sanitized deployment reference without secrets;
- `docs/qnap-ghcr-deployment.md`: first deployment, update, verification, and
  rollback instructions.

The Docker build stage will use Node 24 on Debian Bookworm, run `npm ci`,
compile TypeScript, and retain production dependencies only. The final image
will copy `build/`, `package.json`, `package-lock.json`, and production
`node_modules/` into `/opt/plex-mcp-server`. It will inherit the proxy
entrypoint and command instead of replacing them.

No `.env`, `.npmrc`, QNAP `config.json` or its backups, private key,
certificate, Plex token, Arr API key, Trakt secret, or MCP authentication
token will be copied into the image. The same real configuration and secret
files are ignored by Git without excluding the tracked sanitized Compose
reference.

## Dependency audit baseline

The inherited lockfile currently contains compatible updates for all reported
high-severity advisories. Those updates will be applied before the image is
published.

One moderate advisory remains in `@hono/node-server` versions below 2.0.5.
The current and latest `@modelcontextprotocol/sdk` 1.29.0 requires
`@hono/node-server` 1.x, so npm offers only an incompatible forced SDK
downgrade as an automatic resolution. The affected `serve-static` Windows
path is not used by this Linux, stdio-based Plex MCP process.

The fork will document this exception, reject high-severity advisories in CI,
and remove the exception when MCP SDK supports the corrected Hono Node Server
major version. It will not force an unsupported transitive major override or
downgrade MCP SDK.

## GitHub Actions

The Docker workflow will support:

- pull requests targeting `main`;
- pushes to `main`;
- tags matching `v*.*.*`;
- manual `workflow_dispatch`.

Pull requests will run:

1. `npm ci`;
2. `npm audit --audit-level=high`;
3. `npm test`;
4. `npm run build`;
5. a loaded `linux/amd64` Docker build without publication;
6. the real image smoke test against that loaded candidate.

Pushes to `main`, version tags, and manual runs from `main` will publish only
after the same dependency audit, tests, and TypeScript build pass. The
publishing job builds and loads the candidate once with every metadata tag,
smoke-tests one of those exact local tags, then runs `docker push` for each
exact local tag. It never rebuilds between smoke test and publication.

Workflow and PR jobs default to read-only repository contents. Only the
publication job receives package-write permission through the repository
`GITHUB_TOKEN`:

```yaml
permissions:
  contents: read

jobs:
  publish:
    permissions:
      contents: read
      packages: write
```

Published tags will be:

- `latest` for the verified `main` branch;
- `sha-<short-commit>` as a commit-correlated convenience tag for every
  published commit;
- `X.Y.Z` and `X.Y` for a `vX.Y.Z` Git tag.

`latest` is emitted only when the source ref is the repository default branch,
never for a version tag. After all tags have been pushed, the workflow resolves
the GHCR manifest digest, exposes it as a job output, and writes both the digest
and `ghcr.io/gipasoft/plex-mcp-server@sha256:<digest>` to the Actions summary.

The image target is only `linux/amd64`, matching the QNAP `x86_64`
architecture. Multi-platform emulation is intentionally excluded.

After the first successful publication, the GitHub Container Registry package
will be made public once in the package settings. The public source repository
and image contain no runtime secrets, so anonymous QNAP pulls are acceptable.

## QNAP migration

The existing MCP Proxy Container Station application will be updated in place.
A second application directory is not needed because the custom image replaces
only the image used by the existing proxy service. Paperless remains a
separate service in the same application and Trilium remains a mounted binary.
The tracked `docker-compose.qnap.yml` is a sanitized comparison reference, not
a replacement for the active QNAP Compose.

Before editing, run from the existing application directory:

```bash
cp docker-compose.yml docker-compose.yml.pre-plex-fork
cp config.json config.json.pre-plex-fork
```

Change the proxy image to:

```yaml
services:
  plex-mcp:
    image: ghcr.io/gipasoft/plex-mcp-server:latest
```

Optionally add a TCP healthcheck that uses Python already present in the proxy
image when explicit monitoring or Container Station policy requires it. Keep
an existing working healthcheck unchanged:

```yaml
healthcheck:
  test:
    - CMD
    - python3
    - -c
    - "import socket; socket.create_connection(('127.0.0.1', 9090), 5).close()"
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 15s
```

Change only the proxy `image` in the active `docker-compose.yml` and only the
Plex `command` and `args` in `config.json`. Preserve the real Paperless and
Trilium services, environment variables, authentication, mounts, ports,
networks, labels, restart policies, and Container Station settings. Never copy
the sanitized repository Compose over the active file.

Validate and deploy only the proxy service during the first migration:

```bash
docker compose config
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
docker compose ps
docker compose logs --tail=100 plex-mcp
```

`docker compose config` validates and normalizes the declared healthcheck; it
does not execute it. Docker begins executing a declared healthcheck only after
`docker compose up`.

After successful migration, normal updates use:

```bash
docker compose pull
docker compose up -d
```

## Verification

Automated repository verification requires:

- `npm audit --audit-level=high` to pass before every possible publication;
- all existing Vitest tests to pass;
- the `get_on_deck` regression test to verify `seriesTitle`,
  `seasonNumber`, and `episodeNumber`;
- TypeScript compilation to succeed;
- the Docker image to build for `linux/amd64`;
- a container smoke test to confirm that `/main` can start with a valid
  mounted proxy configuration and that the embedded Plex command exists;
- static checks that publication pushes only the loaded, smoke-tested local
  tags and that package-write permission belongs only to the publishing job.

QNAP verification requires:

1. `plex-mcp` remains running and, when a healthcheck is declared, becomes
   healthy;
2. proxy logs contain no command, configuration, or startup errors;
3. a real MCP client initializes `/plex/mcp`, `/paperless/mcp`, and
   `/trilium/mcp` and lists tools from every route;
4. a real `get_on_deck` call returns an episode containing `seriesTitle`,
   `seasonNumber`, and `episodeNumber`;
5. Plex AI Client performs a real read against Plex, Paperless, and Trilium;
6. state and logs remain clean after the functional calls.

## Failure handling and rollback

Every published image has a commit-correlated `sha-*` tag, but registry tags can
be overwritten. Guaranteed rollback uses the manifest digest recorded in the
publishing run summary. Set the active Compose image to the exact recorded
reference:

```yaml
image: ghcr.io/gipasoft/plex-mcp-server@sha256:<recorded-manifest-digest>
```

Then validate and deploy only the proxy:

```bash
docker compose config
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
docker compose ps
```

To restore the pre-fork deployment:

```bash
cp docker-compose.yml.pre-plex-fork docker-compose.yml
cp config.json.pre-plex-fork config.json
docker compose config
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
```

Rollback is required when the proxy exits or does not become healthy when a
healthcheck is configured, logs show startup/configuration failures, any MCP
route cannot initialize, a real episode omits the new context fields, or Plex
AI Client loses any of the three sources. An On Deck queue containing no
episode is an inconclusive content precondition and must be retried with a real
episode before judging the deployment.

Because Paperless is a separate service and the first migration uses
`--no-deps`, a Plex proxy rollback does not recreate the Paperless container.
The Trilium binary and all runtime secrets stay on the QNAP throughout the
migration.

## Ongoing maintenance

Future fork changes use feature branches and pull requests into the fork's
`main` branch. `latest` is updated only after the required checks pass.

Upstream changes from `niavasha/plex-mcp-server` are imported into a dedicated
branch, reviewed, tested, and merged through a pull request. Automatic upstream
synchronization is excluded so upstream changes cannot reach the QNAP without
review.

The pinned `mcp-proxy` version is upgraded separately through an explicit pull
request with Docker build and QNAP compatibility verification.

## Non-goals

- Implementing a new native Streamable HTTP server in Plex MCP;
- moving Paperless or Trilium into the fork image;
- embedding QNAP configuration or secrets in GitHub;
- publishing an npm fork;
- automatically deploying to the QNAP from GitHub Actions;
- automatically merging upstream Plex MCP or proxy updates.
