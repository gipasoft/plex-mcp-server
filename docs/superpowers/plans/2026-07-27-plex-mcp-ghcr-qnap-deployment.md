# Plex MCP GHCR and QNAP Deployment Implementation Plan

> **Per gli agenti esecutori:** SUB-SKILL OBBLIGATORIA: usare `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans` per eseguire il piano attività per attività. I passi usano checkbox (`- [ ]`) per il tracciamento.

**Obiettivo:** pubblicare il fork corretto `gipasoft/plex-mcp-server` come
immagine proxy pubblica su GHCR e aggiornare il QNAP esclusivamente con
`docker compose pull` e `docker compose up -d`.

**Architettura:** una build Docker multi-stage compila Plex MCP con Node 24 e
copia artefatti e dipendenze di produzione dentro
`ghcr.io/tbxark/mcp-proxy:v0.43.2`. Il gateway conserva entrypoint,
Streamable HTTP, autenticazione, Paperless e Trilium; cambia soltanto il
comando Plex, che esegue il file incorporato nell'immagine.

**Stack tecnico:** TypeScript 6, Node.js 24, Vitest 4, Docker BuildKit,
`tbxark/mcp-proxy` 0.43.2, GitHub Actions, GHCR, Docker Compose su QNAP
`linux/amd64`.

## Vincoli globali

- Parlare e documentare le operazioni per l'utente in italiano.
- L'immagine pubblicata è `ghcr.io/gipasoft/plex-mcp-server`.
- Il runtime proxy è fissato a `ghcr.io/tbxark/mcp-proxy:v0.43.2`.
- La piattaforma pubblicata è esclusivamente `linux/amd64`.
- Nessun segreto, `.env` o `config.json` reale entra nel repository o
  nell'immagine.
- `latest` viene pubblicato soltanto da `main` dopo test e build riusciti.
- Ogni pubblicazione include un tag correlato `sha-<commit breve>`, registra il
  digest manifest GHCR e usa `image@sha256:<digest>` come identità immutabile
  per distribuzione e rollback. I tag OCI non sono considerati immutabili.
- Paperless, Trilium, porta `9097:9090`, `qnap-network` e autenticazione proxy
  restano invariati.
- Plex mutativo resta disabilitato salvo una futura scelta esplicita.
- Gli aggiornamenti upstream non vengono importati o distribuiti
  automaticamente.

## Struttura dei file

- `Dockerfile`: compila Plex MCP e crea il runtime proxy.
- `.dockerignore`: impedisce l'invio di dipendenze locali, output, segreti e
  file non necessari al contesto Docker.
- `scripts/smoke-test-image.mjs`: verifica il comportamento dell'immagine
  costruita avviando realmente il proxy con una configurazione controllata.
- `package-lock.json`: riceve gli aggiornamenti transitivi compatibili
  individuati da `npm audit fix`.
- `.github/workflows/security.yml`: blocca vulnerabilità alte e analizza
  sempre il Dockerfile ora presente.
- `.github/workflows/publish.yml`: usa la stessa soglia audit documentata.
- `SECURITY.md`: documenta l'unica eccezione moderata transitoria.
- `.github/workflows/docker-publish.yml`: verifica PR e pubblica GHCR da
  `main` o tag.
- `docker-compose.qnap.yml`: riferimento sanitizzato dell'applicazione QNAP.
- `docs/qnap-ghcr-deployment.md`: prima migrazione, aggiornamento, verifica,
  visibilità GHCR e rollback.
- `src/__tests__/plex-tools.test.ts`: conserva il test di regressione già
  presente per serie, stagione ed episodio.

---

### Task 1: Stabilizzare la baseline di sicurezza delle dipendenze

**File:**

- Modificare: `package-lock.json`
- Modificare: `.github/workflows/security.yml`
- Modificare: `.github/workflows/publish.yml`
- Modificare: `SECURITY.md`

**Interfacce:**

- Consuma: advisory npm correnti e dipendenze MCP SDK 1.29.0.
- Produce: nessuna vulnerabilità alta nota, CI bloccante a livello `high` e
  un'eccezione moderata esplicita e riesaminabile.

- [ ] **Passo 1: riprodurre la baseline vulnerabile**

Eseguire:

```bash
npm audit --audit-level=moderate
```

Risultato atteso: fallimento con advisory alte per `fast-uri` e `postcss`,
advisory moderate per `hono` e `@hono/node-server`.

- [ ] **Passo 2: applicare soltanto gli aggiornamenti compatibili**

Eseguire:

```bash
npm audit fix
```

Non usare `--force`: npm propone un downgrade incompatibile di MCP SDK per
l'advisory residua di `@hono/node-server`.

- [ ] **Passo 3: verificare la nuova baseline**

Eseguire:

```bash
npm audit --audit-level=high
```

Risultato atteso: exit code `0`.

Eseguire inoltre:

```bash
npm audit --audit-level=moderate
```

Risultato atteso: resta soltanto l'advisory moderata
`GHSA-frvp-7c67-39w9` ereditata da MCP SDK 1.29.0.

- [ ] **Passo 4: allineare i workflow di sicurezza**

In `.github/workflows/security.yml` sostituire:

```yaml
run: npm audit --audit-level=moderate
```

con:

```yaml
# MCP SDK 1.29.0 dipende da @hono/node-server 1.x. La sola advisory
# moderata residua riguarda serve-static su Windows, non il trasporto
# stdio eseguito in questo container Linux.
run: npm audit --audit-level=high
```

Rimuovere inoltre la condizione:

```yaml
if: contains(github.event.head_commit.message, 'docker') || contains(github.event.pull_request.title, 'docker')
```

dal job `dockerfile-security`, affinché Hadolint analizzi sempre il Dockerfile.

In `.github/workflows/publish.yml` sostituire allo stesso modo la soglia
`moderate` con `high`.

- [ ] **Passo 5: documentare l'eccezione moderata**

Aggiungere a `SECURITY.md`:

```markdown
## Dependency audit policy

CI blocks all high and critical npm advisories.

MCP SDK 1.29.0 currently depends on `@hono/node-server` 1.x, leaving
`GHSA-frvp-7c67-39w9` unresolved without an incompatible forced SDK
downgrade. The advisory affects `serve-static` path handling on Windows;
this project runs MCP over stdio inside a Linux container and does not use
that path. Remove this exception as soon as MCP SDK supports
`@hono/node-server` 2.0.5 or later.
```

- [ ] **Passo 6: verificare dipendenze, test e build**

```bash
npm audit --audit-level=high
npm test
npm run build
git diff --check
```

Risultato atteso: audit alto, 187 test, compilazione e diff tutti riusciti.

- [ ] **Passo 7: creare il commit di sicurezza**

```bash
git add \
  package-lock.json \
  .github/workflows/security.yml \
  .github/workflows/publish.yml \
  SECURITY.md
git commit -m "chore: update dependency security baseline"
```

---

### Task 2: Creare e verificare l'immagine proxy con Plex MCP incorporato

**File:**

- Creare: `scripts/smoke-test-image.mjs`
- Creare: `Dockerfile`
- Creare: `.dockerignore`
- Verificare: `src/__tests__/plex-tools.test.ts`

**Interfacce:**

- Consuma: `npm test`, `npm run build`,
  `build/plex-mcp-server.js`, `package-lock.json`.
- Produce: immagine locale `plex-mcp-server:test` con `/main` ereditato dal
  proxy e Plex MCP in `/opt/plex-mcp-server`.

- [ ] **Passo 1: scrivere lo smoke test prima del Dockerfile**

Creare `scripts/smoke-test-image.mjs`:

```javascript
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const image = process.argv[2];
if (!image) {
  throw new Error(
    "Uso: node scripts/smoke-test-image.mjs <nome-immagine>",
  );
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const containerName = `plex-mcp-smoke-${suffix}`;
const tempDirectory = mkdtempSync(
  path.join(tmpdir(), "plex-mcp-image-smoke-"),
);
const configPath = path.join(tempDirectory, "config.json");

const config = {
  mcpProxy: {
    baseURL: "http://127.0.0.1:19090",
    addr: ":19090",
    name: "Plex MCP image smoke test",
    version: "1.0.0",
    type: "streamable-http",
    options: {
      panicIfInvalid: true,
      logEnabled: true,
    },
  },
  mcpServers: {
    plex: {
      command: "node",
      args: ["/opt/plex-mcp-server/build/plex-mcp-server.js"],
      env: {
        PLEX_URL: "http://127.0.0.1:32400",
        PLEX_TOKEN: "smoke-test-token",
      },
      options: {
        panicIfInvalid: true,
        logEnabled: true,
      },
    },
  },
};

writeFileSync(configPath, JSON.stringify(config, null, 2));

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

async function waitForStableContainer() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const running = docker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    if (running !== "true") {
      throw new Error(`Il container si è arrestato:\n${docker([
        "logs",
        containerName,
      ])}`);
    }
  }
}

try {
  docker([
    "run",
    "--detach",
    "--name",
    containerName,
    "--volume",
    `${configPath}:/config/config.json:ro`,
    image,
  ]);

  await waitForStableContainer();

  docker([
    "exec",
    containerName,
    "sh",
    "-ec",
    [
      "test -x /main",
      "test -f /opt/plex-mcp-server/build/plex-mcp-server.js",
      "test -d /opt/plex-mcp-server/node_modules",
      "cd /opt/plex-mcp-server",
      "node --check build/plex-mcp-server.js",
      'node -e "import(\'@modelcontextprotocol/sdk/server/index.js\')"',
    ].join(" && "),
  ]);

  console.log(`Smoke test superato per ${image}`);
} catch (error) {
  let logs = "";
  try {
    logs = docker(["logs", containerName]);
  } catch {
    // Il container potrebbe non essere stato creato.
  }
  if (logs) console.error(logs);
  throw error;
} finally {
  try {
    docker(["rm", "--force", containerName]);
  } catch {
    // Nessun container da rimuovere.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
}
```

- [ ] **Passo 2: verificare che lo smoke test fallisca senza immagine**

Eseguire:

```bash
node scripts/smoke-test-image.mjs plex-mcp-server:test
```

Risultato atteso: `docker run` fallisce perché
`plex-mcp-server:test` non esiste ancora.

- [ ] **Passo 3: creare il Dockerfile minimo**

Creare `Dockerfile`:

```dockerfile
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

WORKDIR /
```

Non aggiungere `ENTRYPOINT` o `CMD`: devono restare quelli dell'immagine
`mcp-proxy`.

- [ ] **Passo 4: creare il contesto Docker sicuro**

Creare `.dockerignore`:

```text
.git
.github
node_modules
build
coverage
exports
.env
.env.*
!.env.example
.npmrc
/config.json
/config.json.*
/config.*.json
*.log
*.tgz
*.key
*.pem
*.crt
*.cer
*.p12
*.pfx
*.p7b
*.p7c
*.p8
*.jks
*.keystore
*.csr
*.der
*.ppk
id_rsa
id_dsa
id_ecdsa
id_ed25519
.DS_Store
Thumbs.db
docs
scripts
```

Lo script è escluso dal contesto perché viene eseguito dall'host, non copiato
nell'immagine. Aggiungere gli stessi pattern relativi a configurazione reale,
`.npmrc`, chiavi e certificati a `.gitignore`, senza ignorare
`docker-compose.qnap.yml` o altri riferimenti sanitizzati versionati.

- [ ] **Passo 5: costruire l'immagine per la piattaforma QNAP**

Eseguire:

```bash
docker build --platform linux/amd64 --tag plex-mcp-server:test .
```

Risultato atteso: test, compilazione TypeScript e build Docker terminano con
exit code `0`.

- [ ] **Passo 6: verificare l'immagine in esecuzione**

Eseguire:

```bash
node scripts/smoke-test-image.mjs plex-mcp-server:test
```

Risultato atteso:

```text
Smoke test superato per plex-mcp-server:test
```

- [ ] **Passo 7: verificare nuovamente il progetto**

Eseguire:

```bash
npm test
npm run build
git diff --check
```

Risultato atteso: 187 test superati, build riuscita, nessun errore nel diff.

- [ ] **Passo 8: creare il commit dell'immagine**

```bash
git add Dockerfile .dockerignore scripts/smoke-test-image.mjs
git commit -m "feat: package Plex MCP with mcp-proxy"
```

---

### Task 3: Aggiungere la verifica e la pubblicazione GitHub Actions

**File:**

- Creare: `.github/workflows/docker-publish.yml`

**Interfacce:**

- Consuma: `Dockerfile`, `scripts/smoke-test-image.mjs`, `GITHUB_TOKEN`.
- Produce: controlli PR e immagini
  `ghcr.io/gipasoft/plex-mcp-server:<tag>`.

- [ ] **Passo 1: creare il workflow senza pubblicazione da PR**

Creare `.github/workflows/docker-publish.yml`:

```yaml
name: Docker

on:
  push:
    branches:
      - main
    tags:
      - "v*.*.*"
  pull_request:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: gipasoft/plex-mcp-server
  DOCKER_METADATA_SHORT_SHA_LENGTH: 7

jobs:
  verify:
    name: Test, audit, and build
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Audit high-severity vulnerabilities
        run: npm audit --audit-level=high

      - name: Test
        run: npm test

      - name: Build TypeScript
        run: npm run build

  pull-request-image:
    name: Build and smoke-test pull request image
    if: github.event_name == 'pull_request'
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v4

      - name: Build and load candidate
        uses: docker/build-push-action@v7
        with:
          context: .
          platforms: linux/amd64
          load: true
          push: false
          tags: plex-mcp-server:pr
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Smoke test candidate
        run: node scripts/smoke-test-image.mjs plex-mcp-server:pr

  publish:
    name: Build, smoke-test, and publish container
    if: >-
      github.event_name != 'pull_request' &&
      (github.ref == format('refs/heads/{0}', github.event.repository.default_branch) ||
      startsWith(github.ref, 'refs/tags/v'))
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      digest: ${{ steps.published.outputs.digest }}
      immutable_reference: ${{ steps.published.outputs.immutable_reference }}
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v4

      - name: Login to GHCR
        uses: docker/login-action@v4
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Docker metadata
        id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,prefix=sha-
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}

      - name: Build and load candidate with publication tags
        uses: docker/build-push-action@v7
        with:
          context: .
          platforms: linux/amd64
          load: true
          push: false
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Select smoke-test image
        id: candidate
        env:
          IMAGE_TAGS: ${{ steps.meta.outputs.tags }}
        run: |
          SMOKE_IMAGE="$(printf '%s\n' "$IMAGE_TAGS" | sed -n '1p')"
          test -n "$SMOKE_IMAGE"
          docker image inspect "$SMOKE_IMAGE" >/dev/null
          echo "image=$SMOKE_IMAGE" >> "$GITHUB_OUTPUT"

      - name: Smoke test candidate
        run: node scripts/smoke-test-image.mjs "${{ steps.candidate.outputs.image }}"

      - name: Push exact tested local tags
        env:
          IMAGE_TAGS: ${{ steps.meta.outputs.tags }}
        run: |
          while IFS= read -r tag; do
            test -n "$tag" || continue
            docker image inspect "$tag" >/dev/null
            docker push "$tag"
          done <<< "$IMAGE_TAGS"

      - name: Record published digest
        id: published
        env:
          SMOKE_IMAGE: ${{ steps.candidate.outputs.image }}
        run: |
          PUBLISHED_DIGEST="$(
            docker buildx imagetools inspect "$SMOKE_IMAGE" |
              sed -n 's/^Digest:[[:space:]]*//p' |
              head -n 1
          )"
          printf '%s\n' "$PUBLISHED_DIGEST" |
            grep -Eq '^sha256:[0-9a-f]{64}$'
          IMMUTABLE_REFERENCE="${REGISTRY}/${IMAGE_NAME}@${PUBLISHED_DIGEST}"
          echo "digest=$PUBLISHED_DIGEST" >> "$GITHUB_OUTPUT"
          echo "immutable_reference=$IMMUTABLE_REFERENCE" >> "$GITHUB_OUTPUT"
          {
            echo "### Immagine GHCR pubblicata"
            echo "- Digest manifest: \`${PUBLISHED_DIGEST}\`"
            echo "- Riferimento immutabile: \`${IMMUTABLE_REFERENCE}\`"
          } >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Passo 2: verificare localmente immagine e smoke test**

Eseguire localmente:

```bash
docker build --platform linux/amd64 --tag plex-mcp-server:test .
node scripts/smoke-test-image.mjs plex-mcp-server:test
```

Poi controllare che `metadata-action` usi sette caratteri per `type=sha`,
fissati da `DOCKER_METADATA_SHORT_SHA_LENGTH: 7`, e che `latest` sia abilitato
esclusivamente sul branch predefinito.

- [ ] **Passo 3: controllare sintassi e permessi**

Verificare:

```bash
git diff --check
git status --short
```

Controllare manualmente che:

- `npm audit --audit-level=high` preceda ogni job di pubblicazione tramite
  `needs: verify`;
- i job PR abbiano solo `contents: read`;
- `packages: write` sia presente esclusivamente nel job `publish`;
- il job `publish` sia eseguito soltanto sul branch predefinito o su tag
  `v*.*.*`;
- la build pubblicabile usi `load: true` e `push: false`;
- lo smoke test preceda il ciclo `docker push` degli stessi tag locali;
- non esista una seconda build dopo lo smoke test;
- digest e riferimento `image@sha256:<digest>` siano output e riepilogo della
  run;
- la piattaforma sia `linux/amd64`;
- nessun secret personalizzato sia richiesto.

- [ ] **Passo 4: creare il commit del workflow**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "ci: publish Plex MCP proxy image"
```

---

### Task 4: Documentare e validare il riferimento QNAP sanitizzato

**File:**

- Creare: `docker-compose.qnap.yml`
- Creare: `docs/qnap-ghcr-deployment.md`

**Interfacce:**

- Consuma: immagine GHCR, `.env`, `config.json`, `bin/trilium-mcp`,
  `qnap-network`.
- Produce: riferimento di confronto e procedura di modifica minima
  dell'applicazione QNAP attiva.

- [ ] **Passo 1: creare il Compose sanitizzato solo per confronto**

Creare `docker-compose.qnap.yml`:

```yaml
services:
  paperless-mcp:
    image: ghcr.io/barryw/paperlessmcp:v0.3.2
    container_name: paperless-mcp
    pull_policy: always
    environment:
      PAPERLESS_BASE_URL: "${PAPERLESS_BASE_URL}"
      PAPERLESS_API_TOKEN: "${PAPERLESS_API_TOKEN}"
      MAX_DOWNLOAD_SIZE_BYTES: ${MAX_DOWNLOAD_SIZE_BYTES:-10485760}
      MCP_PORT: "5000"
      HTTP_TIMEOUT_SECONDS: "60"
    networks:
      - qnap-network
    restart: unless-stopped
    labels:
      - diun.enable=true

  plex-mcp:
    image: ghcr.io/gipasoft/plex-mcp-server:latest
    container_name: plex-mcp
    pull_policy: always
    env_file:
      - .env
    volumes:
      - ./config.json:/config/config.json:ro
      - ./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro
    ports:
      - "9097:9090"
    command: ["-config", "/config/config.json"]
    networks:
      - qnap-network
    restart: unless-stopped
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
    labels:
      - diun.enable=true

networks:
  qnap-network:
    external: true
```

Inserire in testa un commento esplicito: questo file è un riferimento
sanitizzato per confronto e non deve mai sovrascrivere il Compose QNAP attivo.
La guida deve prescrivere modifiche minime direttamente al
`docker-compose.yml` reale, preservando Paperless, Trilium, autenticazione,
mount, porte, reti, label, restart policy e impostazioni Container Station.
L'healthcheck è facoltativo: aggiungerlo soltanto se desiderato o richiesto,
oppure conservare quello reale già presente.

- [ ] **Passo 2: scrivere la modifica esatta di `config.json`**

In `docs/qnap-ghcr-deployment.md` indicare di sostituire esclusivamente:

```json
"command": "npx",
"args": [
  "-y",
  "plex-mcp-server@latest"
]
```

con:

```json
"command": "node",
"args": [
  "/opt/plex-mcp-server/build/plex-mcp-server.js"
]
```

Specificare esplicitamente che blocchi `env`, `options`, Paperless, Trilium e
`mcpProxy` non devono cambiare.

- [ ] **Passo 3: documentare prima migrazione e backup senza sostituzione**

Inserire:

```bash
cp docker-compose.yml docker-compose.yml.pre-plex-fork
cp config.json config.json.pre-plex-fork
docker compose config
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
docker compose ps
docker compose logs --tail=100 plex-mcp
```

Spiegare che il primo `up` ricrea soltanto il proxy e non Paperless. Vietare
esplicitamente `cp docker-compose.qnap.yml docker-compose.yml`. Precisare che
`docker compose config` valida e normalizza l'healthcheck dichiarato ma non lo
esegue; è Docker a eseguirlo dopo `docker compose up`.

- [ ] **Passo 4: documentare aggiornamenti ordinari**

Inserire:

```bash
docker compose pull
docker compose up -d
```

Specificare che non devono comparire `build:` o `docker compose build` nella
configurazione QNAP.

- [ ] **Passo 5: documentare il rollback completo**

Inserire:

```bash
cp docker-compose.yml.pre-plex-fork docker-compose.yml
cp config.json.pre-plex-fork config.json
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
```

Documentare anche il rollback garantito a un'immagine del fork usando il
digest manifest reale registrato nel riepilogo GitHub Actions:

```yaml
image: ghcr.io/gipasoft/plex-mcp-server@sha256:<digest-manifest-registrato>
```

Spiegare che `sha-<commit breve>` è un tag correlato utile, ma può essere
sovrascritto; soltanto il digest identifica immutabilmente il manifest.

- [ ] **Passo 6: documentare la visibilità pubblica GHCR**

Dopo la prima pubblicazione:

1. aprire il profilo GitHub `gipasoft`;
2. aprire **Packages**;
3. selezionare `plex-mcp-server`;
4. aprire **Package settings**;
5. in **Danger Zone**, scegliere **Change visibility**;
6. impostare **Public** e confermare con il nome del package.

La documentazione ufficiale conferma che le immagini pubbliche del Container
registry possono essere scaricate senza autenticazione.

- [ ] **Passo 7: verificare il Compose nell'ambiente QNAP**

Dalla cartella reale dell'applicazione, dopo aver preservato tutti i file e
aver applicato soltanto le modifiche approvate al Compose attivo, eseguire:

```bash
docker compose config
```

Risultato atteso: exit code `0`, immagine
`ghcr.io/gipasoft/plex-mcp-server:latest`, rete esterna `qnap-network` e
ogni impostazione reale preservata. Se è stato aggiunto l'healthcheck,
controllarne la dichiarazione normalizzata; il comando non lo esegue.

- [ ] **Passo 8: creare il commit QNAP**

```bash
git add docker-compose.qnap.yml docs/qnap-ghcr-deployment.md
git commit -m "docs: add QNAP GHCR deployment"
```

---

### Task 5: Verificare l'intero branch e aprire la Pull Request del fork

**File:**

- Verificare: tutti i file modificati dal commit `74e3183` in avanti.

**Interfacce:**

- Consuma: test, build, immagine, workflow e documentazione.
- Produce: Pull Request verificata verso `gipasoft/plex-mcp-server:main`.

- [ ] **Passo 1: eseguire la verifica completa fresca**

```bash
npm audit --audit-level=high
npm test
npm run build
docker build --platform linux/amd64 --tag plex-mcp-server:test .
node scripts/smoke-test-image.mjs plex-mcp-server:test
QNAP_CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$QNAP_CHECK_DIR"' EXIT
cp docker-compose.qnap.yml "$QNAP_CHECK_DIR/docker-compose.yml"
printf 'PLEX_URL=http://127.0.0.1:32400\nPLEX_TOKEN=validation-only\n' \
  > "$QNAP_CHECK_DIR/.env"
printf '{}\n' > "$QNAP_CHECK_DIR/config.json"
mkdir -p "$QNAP_CHECK_DIR/bin"
touch "$QNAP_CHECK_DIR/bin/trilium-mcp"
PAPERLESS_BASE_URL=http://127.0.0.1:8000 \
PAPERLESS_API_TOKEN=validation-only \
docker compose \
  --project-directory "$QNAP_CHECK_DIR" \
  -f "$QNAP_CHECK_DIR/docker-compose.yml" \
  config
git diff --check origin/main...HEAD
git status --short
```

Risultato atteso:

- audit alto riuscito;
- 187 test superati;
- build TypeScript riuscita;
- build Docker riuscita;
- smoke test riuscito;
- Compose sanitizzato valido come riferimento;
- nessun errore di whitespace;
- working tree pulito.

Eseguire inoltre asserzioni statiche focalizzate che falliscano prima della
correzione e riescano dopo, verificando almeno: audit nel gate, permessi
read-only sulle PR, `packages: write` solo su `publish`, build caricata e
smoke-testata prima di ogni `docker push`, assenza di rebuild post-smoke,
digest nel riepilogo/output, `latest` soltanto dal branch predefinito,
procedura QNAP senza sovrascrittura, tre route MCP, rollback a digest e pattern
di esclusione dei segreti.

- [ ] **Passo 2: richiedere una code review indipendente**

Usare `superpowers:requesting-code-review` sull'intervallo:

```text
base: origin/main
head: HEAD
```

Correggere tutti i rilievi critici e importanti, rieseguendo l'intera verifica.

- [ ] **Passo 3: pubblicare il branch aggiornato**

```bash
git push fork fix/get-on-deck-episode-context
```

- [ ] **Passo 4: aprire la Pull Request nel fork**

```bash
gh pr create \
  --repo gipasoft/plex-mcp-server \
  --base main \
  --head fix/get-on-deck-episode-context \
  --title "feat: publish corrected Plex MCP proxy image" \
  --body "Adds episode context to get_on_deck and packages the fork with mcp-proxy for verified GHCR/QNAP deployment. Includes tests, Docker smoke verification, GitHub Actions publishing, QNAP configuration, and rollback documentation."
```

- [ ] **Passo 5: verificare i controlli GitHub**

```bash
gh pr checks --repo gipasoft/plex-mcp-server --watch
```

Risultato atteso: CI Node 22/24, sicurezza e nuovo workflow Docker verdi.

- [ ] **Passo 6: presentare le opzioni d'integrazione**

Usare `superpowers:finishing-a-development-branch`. Non unire la Pull Request
senza la scelta esplicita dell'utente.

---

### Task 6: Pubblicare e rendere pubblica l'immagine GHCR

**File:**

- Nessuna modifica locale prevista.

**Interfacce:**

- Consuma: Pull Request approvata e workflow `Docker`.
- Produce: `latest` dal branch predefinito, tag `sha-*` correlati al commit,
  digest manifest registrato e riferimento immutabile
  `image@sha256:<digest>` pubblici su GHCR.

- [ ] **Passo 1: unire la PR soltanto dopo autorizzazione**

Dopo la scelta esplicita dell'utente:

```bash
gh pr merge \
  --repo gipasoft/plex-mcp-server \
  --squash \
  --delete-branch
```

- [ ] **Passo 2: osservare la pubblicazione**

```bash
gh run list \
  --repo gipasoft/plex-mcp-server \
  --workflow Docker \
  --limit 5
```

Prendere automaticamente l'ID della run più recente associata al workflow e
verificarla:

```bash
PLEX_RUN_ID="$(gh run list \
  --repo gipasoft/plex-mcp-server \
  --workflow Docker \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
gh run watch "$PLEX_RUN_ID" --repo gipasoft/plex-mcp-server
```

La run deve mostrare, prima di qualsiasi push: `npm audit
--audit-level=high`, test, build TypeScript, build Docker caricata e smoke test.
Il riepilogo deve contenere il digest manifest e il riferimento immutabile. Lo
stesso gate vale per push `main`, tag versione e pubblicazioni manuali da
`main`.

- [ ] **Passo 3: verificare package, tag e digest**

```bash
gh api \
  /user/packages/container/plex-mcp-server \
  --jq '{name: .name, visibility: .visibility, html_url: .html_url}'
```

```bash
gh api \
  /user/packages/container/plex-mcp-server/versions \
  --jq '.[0].metadata.container.tags'
```

Risultato atteso: package `plex-mcp-server` con `latest` e almeno un tag
`sha-*`. `latest` deve essere associato soltanto a una pubblicazione del branch
predefinito; i tag versione non lo generano.

Aprire il riepilogo della run e registrare il valore reale:

```text
ghcr.io/gipasoft/plex-mcp-server@sha256:<64-caratteri-esadecimali>
```

Verificare che il digest sia interrogabile e salvare l'output con la
documentazione operativa del QNAP:

```bash
docker buildx imagetools inspect \
  ghcr.io/gipasoft/plex-mcp-server@sha256:<digest-reale-registrato>
```

Il placeholder deve essere sostituito con il digest reale della run: non usare
il tag `sha-*` come garanzia di immutabilità.

- [ ] **Passo 4: rendere il package pubblico**

Seguire i sei passaggi GitHub documentati nell'Attività 4. Ripetere:

```bash
gh api \
  /user/packages/container/plex-mcp-server \
  --jq '.visibility'
```

Risultato atteso:

```text
public
```

- [ ] **Passo 5: verificare il pull dal QNAP**

```bash
docker pull ghcr.io/gipasoft/plex-mcp-server:latest
```

Risultato atteso: download riuscito senza `docker login ghcr.io`.
Confrontare il digest mostrato dal pull con quello registrato nel riepilogo
della run prima della migrazione.

---

### Task 7: Migrare il proxy QNAP e verificare i tre MCP

**File QNAP:**

- Modificare: `docker-compose.yml` dell'applicazione MCP Proxy.
- Modificare: `config.json` della stessa applicazione.
- Preservare: `.env`, `bin/trilium-mcp`.

**Interfacce:**

- Consuma: immagine GHCR pubblica e configurazione esistente.
- Produce: proxy aggiornato con `/plex/mcp`, `/paperless/mcp` e
  `/trilium/mcp` operativi.

- [ ] **Passo 1: creare backup recuperabili**

```bash
cp docker-compose.yml docker-compose.yml.pre-plex-fork
cp config.json config.json.pre-plex-fork
```

Verificare:

```bash
ls -l \
  docker-compose.yml.pre-plex-fork \
  config.json.pre-plex-fork
```

- [ ] **Passo 2: applicare solo le modifiche approvate**

Nel Compose impostare:

```yaml
image: ghcr.io/gipasoft/plex-mcp-server:latest
```

Modificare soltanto il campo `image` del servizio proxy. Aggiungere
l'healthcheck dell'Attività 4 soltanto se esplicitamente desiderato o richiesto;
se il Compose attivo ne contiene già uno funzionante, conservarlo.

In `config.json` impostare:

```json
"command": "node",
"args": [
  "/opt/plex-mcp-server/build/plex-mcp-server.js"
]
```

Non copiare `docker-compose.qnap.yml` sopra il Compose attivo. Non modificare
token, URL, servizi Paperless o Trilium, autenticazione, mount, porte, reti,
label, restart policy o impostazioni Container Station.

- [ ] **Passo 3: validare senza ricreare container**

```bash
docker compose config
```

Risultato atteso: exit code `0`.

Il comando valida la dichiarazione dell'eventuale healthcheck, ma non lo
esegue e non ricrea container.

- [ ] **Passo 4: scaricare l'immagine e ricreare solo il proxy**

```bash
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
```

- [ ] **Passo 5: verificare stato e log**

```bash
docker compose ps
docker compose logs --since=10m --tail=200 plex-mcp
```

Risultato atteso: `plex-mcp` rimane `Up` e, se l'healthcheck è dichiarato,
diventa `healthy`; i log non contengono errori di avvio, configurazione,
comando Plex o connessione ai downstream.

- [ ] **Passo 6: verificare funzionalmente i tre endpoint**

Eseguire senza modifiche il blocco operativo
`docker compose exec -T ... node --input-type=module` documentato in
`docs/qnap-ghcr-deployment.md`. Il blocco usa il client MCP TypeScript già
presente nell'immagine, riceve l'eventuale token da una lettura silenziosa,
inizializza e chiama `listTools()` su:

```text
http://127.0.0.1:9090/plex/mcp
http://127.0.0.1:9090/paperless/mcp
http://127.0.0.1:9090/trilium/mcp
```

Risultato atteso: le tre route completano un handshake MCP reale ed espongono
almeno un tool. Un semplice controllo TCP o un HTTP status non sostituisce
questa verifica.

- [ ] **Passo 7: verificare payload Plex reale e Plex AI Client**

Lo stesso client MCP deve chiamare realmente `get_on_deck`, trovare un episodio
e controllare campi non null:

```json
{
  "seriesTitle": "valore reale",
  "seasonNumber": 3,
  "episodeNumber": 2
}
```

I valori effettivi possono essere diversi e devono corrispondere ai metadati
dell'episodio. Se On Deck non contiene episodi, riprendere un episodio e
ripetere: l'assenza di episodi è una precondizione inconclusiva, non un esito
positivo.

Da Plex AI Client eseguire poi una richiesta reale per ogni sorgente:

```text
Plex: Cosa c'è in continua visione? Mostra serie, stagione ed episodio.
Paperless: Cerca un documento recente.
Trilium: Cerca una nota esistente.
```

- Plex restituisce episodi con serie, stagione e numero episodio;
- Paperless restituisce un risultato reale di ricerca;
- Trilium restituisce un risultato reale di ricerca.

- [ ] **Passo 8: eseguire o documentare il rollback**

Ripetere `docker compose ps` e i log dopo le chiamate. Eseguire il rollback se
il proxy si arresta o non diventa healthy quando configurato, i log mostrano
errori, una delle tre route non completa handshake/lista tool, un episodio
reale non contiene i tre campi o Plex AI Client perde una sorgente:

```bash
cp docker-compose.yml.pre-plex-fork docker-compose.yml
cp config.json.pre-plex-fork config.json
docker compose config
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
docker compose ps
docker compose logs --since=10m --tail=200 plex-mcp
```

Se tutte le verifiche riescono, conservare i backup e usare in futuro:

```bash
docker compose pull
docker compose up -d
```

Per un rollback garantito a una build del fork, impostare nel Compose attivo il
riferimento `ghcr.io/gipasoft/plex-mcp-server@sha256:<digest-reale>` registrato
nella run, validare con `docker compose config` e ricreare soltanto
`plex-mcp`. Non considerare immutabile il tag `sha-*`.
