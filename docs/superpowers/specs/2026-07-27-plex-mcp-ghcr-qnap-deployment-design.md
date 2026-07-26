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
`mcp-proxy` executable, and its `/main` entrypoint. Pinning the version makes
fork builds reproducible and prevents an unreviewed proxy update from entering
the QNAP deployment through a rebuild.

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

No `.env`, QNAP `config.json`, Plex token, Arr API key, Trakt secret, or MCP
authentication token will be copied into the image.

## GitHub Actions

The Docker workflow will support:

- pull requests targeting `main`;
- pushes to `main`;
- tags matching `v*.*.*`;
- manual `workflow_dispatch`.

Pull requests will run:

1. `npm ci`;
2. `npm test`;
3. `npm run build`;
4. a `linux/amd64` Docker build without publication.

Pushes to `main`, version tags, and manual runs from `main` will publish only
after the verification steps pass. The workflow will use the repository
`GITHUB_TOKEN` with these permissions:

```yaml
permissions:
  contents: read
  packages: write
```

Published tags will be:

- `latest` for the verified `main` branch;
- `sha-<short-commit>` for every published commit;
- `X.Y.Z` and `X.Y` for a `vX.Y.Z` Git tag.

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

Add a TCP healthcheck that uses Python already present in the proxy image:

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

Change only the Plex `command` and `args` in `config.json`. Preserve every
environment variable and every Paperless, Trilium, proxy, and authentication
setting.

Validate and deploy only the proxy service during the first migration:

```bash
docker compose config
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
docker compose ps
docker compose logs --tail=100 plex-mcp
```

After successful migration, normal updates use:

```bash
docker compose pull
docker compose up -d
```

## Verification

Automated repository verification requires:

- all existing Vitest tests to pass;
- the `get_on_deck` regression test to verify `seriesTitle`,
  `seasonNumber`, and `episodeNumber`;
- TypeScript compilation to succeed;
- the Docker image to build for `linux/amd64`;
- a container smoke test to confirm that `/main` can start with a valid
  mounted proxy configuration and that the embedded Plex command exists.

QNAP verification requires:

1. `plex-mcp` remains running and becomes healthy;
2. proxy logs contain no command, configuration, or startup errors;
3. `/plex/mcp`, `/paperless/mcp`, and `/trilium/mcp` remain reachable through
   port `9097`;
4. `get_on_deck` returns episode records containing `seriesTitle`,
   `seasonNumber`, and `episodeNumber`;
5. Plex AI Client can query Plex, Paperless, and Trilium normally.

## Failure handling and rollback

Every published image has an immutable `sha-*` tag. To roll back to a known
fork build, set the Compose image to that tag and run:

```bash
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
```

To restore the pre-fork deployment:

```bash
cp docker-compose.yml.pre-plex-fork docker-compose.yml
cp config.json.pre-plex-fork config.json
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
```

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
