# Distribuzione QNAP da GHCR

Questa procedura aggiorna **soltanto** il proxy `plex-mcp` dell'applicazione
esistente in QNAP Container Station. Autenticazione, mount, porte, reti,
label e impostazioni specifiche di Container Station devono restare
invariati. Il NAS deve usare architettura `x86_64` (`amd64`).

L'immagine viene costruita e pubblicata solamente da GitHub Actions. Sul NAS
non devono comparire né `build:` nel Compose né comandi
`docker compose build`.

## Il Compose del repository è solo un riferimento

Il file [docker-compose.qnap.yml](../docker-compose.qnap.yml) è un esempio
sanitizzato per il confronto: non contiene la configurazione reale completa e
**non deve essere copiato sopra** il `docker-compose.yml` attivo.

Lavorare nella cartella reale dell'applicazione Container Station. Prima di
modificare qualsiasi file:

```bash
cp docker-compose.yml docker-compose.yml.pre-plex-fork
cp config.json config.json.pre-plex-fork
ls -l docker-compose.yml.pre-plex-fork config.json.pre-plex-fork
```

Nel `docker-compose.yml` attivo usare l'immagine pubblicata per il servizio
proxy:

```yaml
services:
  plex-mcp:
    image: ghcr.io/gipasoft/plex-mcp-server:latest
```

Rimuovere una sola volta esclusivamente il vecchio mount:

```yaml
- ./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro
```

Il binario corretto è già incluso nell'immagine. Lasciare il file
`bin/trilium-mcp` sul NAS come backup recuperabile, ma non montarlo più nel
container. Preservare `env_file`, variabili, autenticazione, il mount di
`config.json`, porta `9097:9090`, rete `qnap-network`, label, policy di restart
e ogni impostazione aggiunta da Container Station.

`paperless-mcp` non è un servizio di questo Compose: gira in un'applicazione
Container Station separata, raggiungibile sulla stessa rete `qnap-network`. Non
va reintrodotto qui, altrimenti si torna al conflitto sul nome del container.
Anche Trilium non è un servizio a sé: il suo binario è incorporato in
`plex-mcp`.

Il blocco seguente è facoltativo: aggiungerlo al solo servizio `plex-mcp` se si
desidera che Docker controlli la porta TCP del proxy o se Container Station
richiede un healthcheck. Se esiste già un healthcheck operativo, conservarlo.

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

## Modifica limitata di `config.json`

Nel solo blocco del server Plex sostituire:

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

I blocchi `env`, `options`, Paperless, Trilium e `mcpProxy` non devono
cambiare. Non inserire token, URL privati o altri segreti nel repository.

## Validazione e prima migrazione

Solo l'operatore del QNAP esegue questi comandi. Prima del pull, entrare nella
cartella reale e registrare il digest immutabile attualmente in uso:

```bash
cd /share/Container/container-station-data/application/plex_mcp
docker image inspect "$(docker inspect --format '{{.Image}}' plex-mcp)" \
  --format '{{index .RepoDigests 0}}'
```

Conservare l'output per l'eventuale rollback. Dopo aver rimosso dal Compose
attivo il solo mount Trilium indicato sopra, validare il file e ricreare
soltanto il proxy:

```bash
docker compose -p plex_mcp config --quiet
docker compose -p plex_mcp pull plex-mcp
docker compose -p plex_mcp up -d plex-mcp
docker compose -p plex_mcp ps
docker compose -p plex_mcp logs --since=10m --tail=200 plex-mcp
```

`docker compose config --quiet` valida la configurazione attiva, incluso
l'eventuale healthcheck, senza stampare i valori risolti da variabili ed
`env_file`; non avvia container e non esegue l'healthcheck. È
`docker compose up` ad avviare il container e Docker a eseguire
l'healthcheck. Nominare il servizio nel comando `up` mantiene l'intervento
circoscritto al proxy.

Non usare `docker rm`, `docker compose down -v`, cancellazioni di volumi o
build locali sul NAS.

Attendere che `plex-mcp` resti `Up`; se è stato dichiarato l'healthcheck,
attendere anche lo stato `healthy`. Nei log non devono apparire errori di
configurazione, avvio del comando Plex o connessione ai server downstream.

## Verifica reale dei tre endpoint MCP

Il controllo seguente usa il client MCP TypeScript già incluso nell'immagine:
inizializza tutti e tre gli endpoint, elenca i tool e chiama realmente
`get_on_deck`. Non stampa il token. Se `authTokens` è configurato nel
`config.json` attivo, inserire uno dei valori esatti richiesti dal proxy;
altrimenti premere Invio.

```bash
read -rsp "Token del proxy MCP (Invio se non configurato): " MCP_PROXY_TOKEN
echo
export MCP_PROXY_TOKEN

docker compose exec -T \
  -e MCP_PROXY_TOKEN \
  -w /opt/plex-mcp-server \
  plex-mcp \
  node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.env.MCP_PROXY_TOKEN ?? "";
const headers = token ? { Authorization: token } : {};
const routes = ["plex", "paperless", "trilium"];
const clients = new Map();
const toolsByRoute = new Map();

try {
  for (const route of routes) {
    const client = new Client({
      name: "qnap-verification",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:9090/${route}/mcp`),
      { requestInit: { headers } },
    );
    await client.connect(transport);
    clients.set(route, client);
    const { tools } = await client.listTools();
    toolsByRoute.set(route, tools);
    if (tools.length === 0) {
      throw new Error(`/${route}/mcp non espone alcun tool`);
    }
    console.log(`/${route}/mcp: OK (${tools.length} tool)`);
  }

  const searchNotes = toolsByRoute
    .get("trilium")
    ?.find((tool) => tool.name === "search_notes");
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

  const plex = clients.get("plex");
  const result = await plex.callTool({
    name: "get_on_deck",
    arguments: {},
  });
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("get_on_deck non ha restituito testo JSON");
  const payload = JSON.parse(text);
  const episode = payload.onDeck?.find((item) => item.type === "episode");
  if (!episode) {
    throw new Error("Nessun episodio presente realmente in On Deck");
  }
  for (const field of ["seriesTitle", "seasonNumber", "episodeNumber"]) {
    if (episode[field] === undefined || episode[field] === null) {
      throw new Error(`get_on_deck: campo ${field} assente`);
    }
  }
  console.log("get_on_deck: OK", {
    seriesTitle: episode.seriesTitle,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
  });
} finally {
  await Promise.allSettled(
    [...clients.values()].map((client) => client.close()),
  );
}
NODE

unset MCP_PROXY_TOKEN
```

Questo verifica in modo esplicito `/plex/mcp`, `/paperless/mcp` e
`/trilium/mcp`. Se la coda On Deck non contiene episodi, avviare o riprendere
un episodio in Plex e ripetere il controllo: una coda priva di episodi non è,
da sola, prova di un errore di distribuzione.

## Verifica da Plex AI Client

Nel Plex AI Client già configurato eseguire, senza cambiare URL o
autenticazione:

1. **Plex:** «Cosa c'è in continua visione? Mostra serie, stagione ed
   episodio.» Verificare che il risultato reale contenga serie, numero di
   stagione e numero di episodio coerenti con Plex.
2. **Paperless:** «Cerca un documento recente.» Verificare una risposta reale,
   non soltanto la presenza del tool.
3. **Trilium:** «Usa Trilium in sola lettura. Restituisci le cinque note
   modificate più di recente, ordinate dalla più recente alla meno recente,
   mostrando titolo e data.» Verificare cinque risultati recenti e ordinati,
   non soltanto la presenza del tool.

Rieseguire infine:

```bash
docker compose -p plex_mcp ps
docker compose -p plex_mcp logs --since=10m --tail=200 plex-mcp
```

## Criteri di successo e rollback

La migrazione è riuscita soltanto se:

- `plex-mcp` resta `Up` e, se configurato, diventa `healthy`;
- i log non contengono errori di startup, configurazione o processi MCP;
- i tre endpoint superano inizializzazione ed elenco tool;
- un episodio reale di `get_on_deck` espone `seriesTitle`, `seasonNumber` ed
  `episodeNumber`;
- Plex AI Client interroga realmente Plex, Paperless e Trilium.

Se il container si arresta o Plex AI Client perde una sorgente, il rollback
normale consiste nel rimettere nel campo `image` il digest GHCR registrato
prima del pull e ricreare soltanto `plex-mcp`:

```bash
docker compose -p plex_mcp config --quiet
docker compose -p plex_mcp pull plex-mcp
docker compose -p plex_mcp up -d plex-mcp
docker compose -p plex_mcp ps
docker compose -p plex_mcp logs --since=10m --tail=200 plex-mcp
```

Rimontare il vecchio `bin/trilium-mcp` è soltanto un fallback di emergenza:
ripristina anche il vecchio comportamento che non ordina le note recenti.

## Rollback garantito a una build del fork

Ogni pubblicazione produce un tag correlato al commit, per esempio
`sha-1a2b3c4`, ma un tag OCI può essere sovrascritto e non è una garanzia di
immutabilità. La run GitHub Actions scrive nel riepilogo il digest manifest e
il riferimento immutabile:

```text
ghcr.io/gipasoft/plex-mcp-server@sha256:<64-caratteri-esadecimali>
```

Registrare quel valore dopo ogni pubblicazione riuscita. Per un rollback
garantito, copiare il riferimento **reale** dal riepilogo della run nel campo
`image` del `docker-compose.yml` attivo, quindi:

```bash
docker compose -p plex_mcp config --quiet
docker compose -p plex_mcp pull plex-mcp
docker compose -p plex_mcp up -d plex-mcp
docker compose -p plex_mcp ps
```

Il tag `sha-*` resta utile per correlare commit e build, ma il solo riferimento
`image@sha256:<digest>` identifica in modo immutabile il manifest verificato.

## Aggiornamenti ordinari

Per ogni versione pubblicata, dalla stessa cartella dell'applicazione:

```bash
cd /share/Container/container-station-data/application/plex_mcp
docker compose -p plex_mcp config --quiet
docker compose -p plex_mcp pull plex-mcp
docker compose -p plex_mcp up -d plex-mcp
```

Se il Compose è stato bloccato a un digest per rollback, impostare prima il
nuovo digest registrato (oppure tornare deliberatamente a `latest`); un
riferimento digest non cambia con `pull`.

Ripetere sempre i controlli di stato, log, tre endpoint e Plex AI Client
descritti sopra. In caso di fallimento applicare i criteri di rollback.

## Rendere pubblica l'immagine GHCR

Dopo la prima pubblicazione, aprire il profilo GitHub `gipasoft`, quindi:

1. Aprire **Packages**.
2. Selezionare `plex-mcp-server`.
3. Aprire **Package settings**.
4. In **Danger Zone**, scegliere **Change visibility**.
5. Impostare **Public** e confermare con il nome del package.

Le immagini pubbliche di GitHub Container Registry possono essere scaricate
senza `docker login`; nessun segreto deve comunque essere incluso
nell'immagine o nei file versionati.
