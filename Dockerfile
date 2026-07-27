FROM golang:1.23-bookworm AS trilium-build

RUN git init /src/trilium-mcp \
 && git -C /src/trilium-mcp remote add origin https://github.com/gipasoft/trilium-mcp.git \
 && git -C /src/trilium-mcp fetch --depth 1 origin 9777d36107baa18cc7024b07936c03b7cc793c16 \
 && git -C /src/trilium-mcp checkout --detach FETCH_HEAD \
 && cd /src/trilium-mcp \
 && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -trimpath -ldflags="-s -w" -o /out/trilium-mcp .

FROM node:24-bookworm-slim AS plex-build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src

RUN npm test \
 && npm run build \
 && npm prune --omit=dev

FROM ghcr.io/tbxark/mcp-proxy:v0.43.2

LABEL org.opencontainers.image.source="https://github.com/gipasoft/plex-mcp-server"
LABEL org.opencontainers.image.description="mcp-proxy with the gipasoft Plex MCP fork embedded"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /opt/plex-mcp-server

COPY --from=plex-build /build/build ./build
COPY --from=plex-build /build/package.json ./package.json
COPY --from=plex-build /build/package-lock.json ./package-lock.json
COPY --from=plex-build /build/node_modules ./node_modules
COPY --from=trilium-build /out/trilium-mcp /usr/local/bin/trilium-mcp

WORKDIR /
