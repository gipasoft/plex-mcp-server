# Metadati della serie nella cronologia Plex

**Data:** 28 luglio 2026  
**Stato:** approvato per la pianificazione

## Obiettivo

Fare in modo che `get_watch_history` conservi il collegamento fra un episodio
e la relativa serie. Una richiesta come “Qual è l'ultima serie TV che ho
visto?” deve quindi poter restituire il titolo della serie, non soltanto un
titolo generico come `Episodio #1.8`.

La modifica è di sola lettura e non cambia Plex né la cronologia.

## Problema confermato

Il server Plex attivo non rende disponibile l'endpoint primario della
cronologia e `get_watch_history` usa il fallback basato sulle librerie. Il
payload reale contiene `ratingKey`, titolo episodio, tipo e `lastViewedAt`, ma
la proiezione del tool scarta i campi parentali restituiti da Plex:

- `grandparentTitle`;
- `parentIndex`;
- `index`.

Anche il percorso primario costruisce una nuova proiezione senza questi campi.
Il client AI supporta già `seriesTitle` e `grandparentTitle`, quindi il dato
viene perso nel server MCP prima di raggiungere il client.

## Approcci valutati

### Conservare i metadati nella risposta MCP (scelto)

Entrambi i percorsi di `get_watch_history` espongono:

- `seriesTitle`, derivato da `grandparentTitle`;
- `seasonNumber`, derivato da `parentIndex`;
- `episodeNumber`, derivato da `index`.

È la correzione più piccola e affidabile: mantiene l'identità Plex originale e
usa lo stesso contratto già adottato da `get_on_deck`.

### Lookup aggiuntivo dal client

Il client potrebbe invocare `get_media_details` o `search_media` per ogni
episodio. I payload reali di entrambi i tool omettono però la serie; inoltre
titoli generici come `Episodio #1.8` non sono identificatori univoci. Questo
approccio non risolve il difetto.

### Messaggio di errore più esplicito

Il client potrebbe dichiarare che il server non fornisce il titolo della serie.
Sarebbe corretto ma non soddisferebbe la richiesta dell'utente.

## Contratto e flusso dati

Per film e altri elementi i nuovi campi restano assenti. Per un episodio la
risposta contiene, quando Plex li fornisce:

```json
{
  "ratingKey": "141844",
  "title": "Episodio #1.8",
  "type": "episode",
  "seriesTitle": "House of Guinness",
  "seasonNumber": 1,
  "episodeNumber": 8,
  "lastViewedAt": 1785185004
}
```

Il flusso diventa:

1. Plex restituisce l'elemento della cronologia o della libreria;
2. il server MCP preserva i tre campi gerarchici nella proiezione JSON;
3. il Plex AI Client legge `seriesTitle`;
4. il riepilogo deterministico raggruppa gli episodi per serie e sceglie il
   timestamp più recente.

Non vengono introdotte nuove chiamate, configurazioni o dipendenze.

## Gestione dei dati mancanti

I campi sono opzionali perché Plex può ometterli per elementi non episodici o
metadati incompleti. Il server non inventa titoli o numeri e non tenta
inferenze dal riassunto, dall'anno o dal titolo episodio.

Il comportamento esistente resta invariato quando i campi parentali non sono
presenti.

## Verifica

I test di regressione devono coprire separatamente:

1. percorso primario `/status/sessions/history/all`;
2. fallback `/library/sections/{key}/all`;
3. presenza di `seriesTitle`, `seasonNumber` ed `episodeNumber` per gli
   episodi;
4. assenza di valori inventati quando Plex non restituisce metadati parentali;
5. suite completa e build TypeScript del server MCP;
6. test del Plex AI Client che dimostra che `seriesTitle` produce il riepilogo
   deterministico con il nome della serie.

## Distribuzione

La correzione richiede una nuova immagine del server MCP e il successivo
aggiornamento del container QNAP. Il Plex AI Client non richiede modifiche per
consumare il nuovo campo.

La pubblicazione e l'aggiornamento QNAP non fanno parte dell'implementazione
locale e saranno eseguiti soltanto con autorizzazione esplicita.

## Fuori ambito

- accesso diretto del client alle API Plex;
- inferenze basate sui riassunti degli episodi;
- modifiche a Plex, Trakt, Sonarr o Radarr;
- cambiamenti agli altri tool MCP;
- aggiornamento automatico del container QNAP.
