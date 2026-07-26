# Distribuzione QNAP da GHCR

Questa guida aggiorna una sola applicazione di QNAP Container Station: Paperless,
Trilium, la rete `qnap-network`, le porte e le variabili già presenti restano
invariati. Cambiano esclusivamente l'immagine di `plex-mcp` e il comando Plex
nel relativo server MCP. Il NAS QNAP deve usare architettura `x86_64` (`amd64`).

L'immagine viene costruita e pubblicata solamente da GitHub Actions. Sul NAS non
devono essere presenti né `build:` nel Compose né comandi `docker compose build`.

## File Compose e prerequisiti

Usare [docker-compose.qnap.yml](../docker-compose.qnap.yml) come contenuto del
file `docker-compose.yml` nella cartella reale dell'applicazione Container
Station. Non creare una seconda applicazione: il file continua a gestire gli
stessi servizi `paperless-mcp` e `plex-mcp` nella rete esterna `qnap-network`.

Prima di eseguire Compose, conservare nella stessa cartella reale i file già in
uso `.env`, `config.json` e `bin/trilium-mcp`. Non inserire segreti nel file
Compose né nel repository.

## Modifica limitata di `config.json`

Nel solo blocco del server Plex, sostituire esclusivamente:

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

I blocchi `env`, `options`, Paperless, Trilium e `mcpProxy` non devono cambiare.

## Prima migrazione e backup

Nella cartella reale dell'applicazione, creare i backup prima di sostituire il
Compose attivo con il contenuto di `docker-compose.qnap.yml` e prima di applicare
la modifica limitata a `config.json`. Quindi eseguire:

```bash
cp docker-compose.yml docker-compose.yml.pre-plex-fork
cp config.json config.json.pre-plex-fork
docker compose config
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
docker compose ps
docker compose logs --tail=100 plex-mcp
```

Subito dopo i primi due comandi del blocco, copiare il Compose sanitizzato sul
file attivo con `cp docker-compose.qnap.yml docker-compose.yml`, applicare la
sola modifica Plex a `config.json` descritta sopra, quindi proseguire dalla riga
`docker compose config`.

Il primo `docker compose up -d --no-deps plex-mcp` ricrea soltanto il proxy
`plex-mcp`: non ricrea Paperless e non avvia una seconda applicazione.

Controllare che `plex-mcp` diventi `healthy`, che la porta del proxy resti
`9097:9090` e che i log non mostrino errori di avvio del processo `node`.

## Aggiornamenti ordinari

Per ogni versione pubblicata eseguire, dalla stessa cartella dell'applicazione:

```bash
docker compose pull
docker compose up -d
```

Questi sono gli unici comandi necessari sul QNAP per aggiornare. La
configurazione QNAP non contiene `build:` e non richiede `docker compose build`:
la build è responsabilità di GitHub Actions.

## Rollback completo

Per tornare alla configurazione precedente, ripristinare entrambi i backup e
ricreare soltanto il proxy:

```bash
cp docker-compose.yml.pre-plex-fork docker-compose.yml
cp config.json.pre-plex-fork config.json
docker compose pull plex-mcp
docker compose up -d --no-deps plex-mcp
```

Per restare sul fork ma bloccare il proxy a un'immagine già pubblicata, impostare
nel servizio `plex-mcp` un tag SHA, quindi eseguire gli ultimi due comandi:

```yaml
image: ghcr.io/gipasoft/plex-mcp-server:sha-74e3183
```

## Rendere pubblica l'immagine GHCR

Dopo la prima pubblicazione, aprire il profilo GitHub `gipasoft`, poi:

1. Aprire **Packages**.
2. Selezionare `plex-mcp-server`.
3. Aprire **Package settings**.
4. In **Danger Zone**, scegliere **Change visibility**.
5. Impostare **Public** e confermare con il nome del package.

La [documentazione ufficiale di GitHub](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)
conferma che le immagini pubbliche del Container registry possono essere
scaricate senza autenticazione; dopo il cambio di visibilità non è quindi
necessario un `docker login` sul QNAP per questa immagine.

## Verifica sul QNAP

Dalla cartella reale dell'applicazione, con `.env`, `config.json` e
`bin/trilium-mcp` già conservati, eseguire:

```bash
docker compose -f docker-compose.qnap.yml config
```

Il comando deve terminare con exit code `0`. Verificare nell'output
`ghcr.io/gipasoft/plex-mcp-server:latest`, la rete esterna `qnap-network` e
l'healthcheck che apre la porta `9090`.
