# Trilium MCP incorporato nell'immagine proxy

**Data:** 27 luglio 2026  
**Stato:** approvato per la pianificazione

## Obiettivo

Incorporare nell'immagine `ghcr.io/gipasoft/plex-mcp-server` il binario
Trilium MCP corretto, affinché gli aggiornamenti QNAP successivi alla
migrazione iniziale richiedano soltanto:

```sh
docker compose -p plex_mcp pull plex-mcp
docker compose -p plex_mcp up -d plex-mcp
```

La correzione deve permettere a `search_notes` di ordinare le note per data di
modifica e restituire le date esatte, senza modificare note o configurazioni
private.

## Problema confermato

Il proxy QNAP monta attualmente:

```yaml
- ./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro
```

Questo bind mount sostituisce qualsiasi binario presente nell'immagine.
Il binario montato espone il vecchio contratto `search_notes`: applica il
limite senza poter richiedere l'ordinamento ETAPI e non restituisce le date.
Una ricerca match-all con `limit=5` ha quindi restituito cinque note molto
vecchie.

Il fork `gipasoft/trilium-mcp` contiene già la correzione verificata al commit:

```text
9777d36107baa18cc7024b07936c03b7cc793c16
```

La relativa GitHub Action ha completato con successo vet, test con race
detector, build Linux AMD64, smoke test MCP e pubblicazione dell'artefatto.

## Approcci valutati

### Compilazione dal sorgente fissato nell'immagine proxy (scelto)

Un nuovo stage Go nel Dockerfile recupera il fork Trilium al commit esatto,
compila un binario Linux AMD64 statico e lo copia nel runtime proxy.

Vantaggi:

- build riproducibile e riconducibile a un commit;
- nessun binario versionato nel repository;
- distribuzione unica attraverso GHCR;
- aggiornamenti QNAP ridotti a pull e ricreazione del proxy.

### Copia di un binario precompilato

Riduce il lavoro durante la build ma rende meno trasparente la provenienza e
richiede di conservare un binario o un URL di artefatto separato. Non viene
adottato.

### Conservazione del bind mount

Evita la migrazione iniziale ma richiede la sostituzione manuale del binario a
ogni aggiornamento. Non soddisfa il flusso operativo richiesto.

## Architettura

Il Dockerfile mantiene lo stage Node esistente per Plex MCP e aggiunge uno
stage Go dedicato a Trilium MCP.

Lo stage Trilium:

1. usa una versione Go compatibile con il modulo Trilium;
2. recupera `https://github.com/gipasoft/trilium-mcp.git`;
3. effettua checkout del commit completo
   `9777d36107baa18cc7024b07936c03b7cc793c16`;
4. compila con `CGO_ENABLED=0`, `GOOS=linux`, `GOARCH=amd64`,
   `-trimpath` e simboli rimossi;
5. produce `/out/trilium-mcp`.

Lo stage runtime copia il file in:

```text
/usr/local/bin/trilium-mcp
```

Il comando in `config.json` resta invariato. Token, URL, timeout e livello di
log continuano ad arrivare dal file `.env` e dal `config.json` montati sul
QNAP.

Il Dockerfile non contiene token, URL privati o altri segreti.

## Contratto Trilium

Il binario incorporato deve esporre `search_notes` con:

- `query`, obbligatorio;
- `order_by`, opzionale, con `dateModified` e `utcDateModified`;
- `order_direction`, opzionale, con `asc` e `desc`;
- `limit`, intero da 1 a 200.

Una richiesta delle note più recenti usa:

```json
{
  "query": "note.noteId != \"\"",
  "order_by": "dateModified",
  "order_direction": "desc",
  "limit": 5
}
```

I risultati conservano l'ordine ETAPI e includono `date_modified` e
`utc_date_modified` quando fornite da Trilium.

## Migrazione QNAP una tantum

L'operatore QNAP, e soltanto lui, modifica il Compose attivo rimuovendo:

```yaml
- ./bin/trilium-mcp:/usr/local/bin/trilium-mcp:ro
```

Restano invariati:

- mount di `config.json`;
- `.env` e tutti i segreti;
- porta `9097:9090`;
- rete `qnap-network`;
- autenticazione del proxy;
- servizi Paperless e Plex;
- nome del container e policy di riavvio.

Il file `bin/trilium-mcp` può rimanere sul filesystem come rollback
recuperabile, ma non viene più montato.

Dopo la modifica:

```sh
cd /share/Container/container-station-data/application/plex_mcp
docker image inspect "$(docker inspect --format '{{.Image}}' plex-mcp)" \
  --format '{{index .RepoDigests 0}}'
docker compose -p plex_mcp config --quiet
docker compose -p plex_mcp pull plex-mcp
docker compose -p plex_mcp up -d plex-mcp
docker compose -p plex_mcp ps
```

L'operatore conserva il digest stampato dal primo comando come riferimento di
rollback prima di scaricare la nuova immagine.

Nessuna operazione QNAP viene eseguita da Codex.

## Verifica automatica

I test devono controllare:

1. il Dockerfile fissa il repository e il commit Trilium attesi;
2. il runtime contiene `/usr/local/bin/trilium-mcp` eseguibile;
3. il Compose di riferimento non contiene più il bind mount del binario;
4. il Compose preserva mount di configurazione, porte, rete e servizio;
5. lo smoke test inizializza il binario Trilium via stdio;
6. `tools/list` contiene `search_notes` con gli enum di ordinamento;
7. lo smoke test esistente del proxy continua a passare;
8. test Node, build TypeScript e audit esistenti restano verdi.

La CI deve costruire e smoke-testare la stessa immagine che viene poi
pubblicata, senza una seconda build successiva al test.

## Verifica funzionale QNAP

Dopo l'aggiornamento, l'operatore controlla:

1. container `plex-mcp` in stato running/healthy;
2. route `/plex/mcp`, `/paperless/mcp` e `/trilium/mcp` raggiungibili;
3. `search_notes` espone i nuovi argomenti;
4. la richiesta delle cinque note più recenti mostra cinque titoli e date in
   ordine decrescente;
5. una nota modificata manualmente tramite l'interfaccia Trilium appare per
   prima con `limit=1`;
6. nessuna nota viene creata, aggiornata o eliminata dal test automatico.

## Rollback

Il rollback preferito imposta temporaneamente nel Compose il digest GHCR
registrato prima della migrazione e ricrea soltanto `plex-mcp`.

Se occorre ripristinare anche il vecchio modello di distribuzione, l'operatore
può riaggiungere temporaneamente il bind mount del binario conservato. Il
rollback non modifica `.env`, `config.json`, token, URL, Paperless, Plex, porte
o rete.

## Fuori ambito

- modifiche alle note Trilium;
- modifiche al database Trilium;
- cambiamenti al Plex AI Client;
- aggiornamenti di Paperless o Plex;
- creazione di tag o release Trilium;
- esecuzione diretta di comandi sul QNAP.
