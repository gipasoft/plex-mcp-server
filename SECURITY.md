# Security Policy

## Supported Versions

Only the latest version on `main` is supported with security updates.

## Reporting Security Vulnerabilities

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, use [GitHub Security Advisories](https://github.com/niavasha/plex-mcp-server/security) to report vulnerabilities privately.

Include:
- Description of the issue
- Steps to reproduce
- Impact assessment

## Security Practices

- API tokens (Plex, Sonarr, Radarr, Trakt) are read from environment variables and never logged
- No `eval()` or dynamic code execution
- All HTTP requests use timeouts
- Dependency vulnerabilities are scanned via CI (`npm audit`, CodeQL, TruffleHog)
- Dependabot auto-merges patch/minor dependency updates

## Dependency audit policy

CI blocks all high and critical npm advisories.

MCP SDK 1.29.0 currently depends on `@hono/node-server` 1.x, leaving
`GHSA-frvp-7c67-39w9` unresolved without an incompatible forced SDK
downgrade. The advisory affects `serve-static` path handling on Windows;
this project runs MCP over stdio inside a Linux container and does not use
that path. Remove this exception as soon as MCP SDK supports
`@hono/node-server` 2.0.5 or later.

## Out of Scope

- Plex Media Server vulnerabilities (report to [Plex](https://www.plex.tv/security/))
- MCP protocol vulnerabilities (report to [Anthropic](https://modelcontextprotocol.io/))
- Sonarr/Radarr vulnerabilities (report upstream)
