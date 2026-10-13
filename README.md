# Xenolith Bridge

Ponte HTTP/SSE tra client che parlano **Responses** e il protocollo wire v1 di
**Xenolith**. In precedenza si chiamava **Xenolith Bridge**. È un programma Node.js >=22,
senza dipendenze runtime e senza compilazione.

Il client gestisce gli strumenti e le proprie approvazioni; il ponte traduce
richieste, testo progressivo e risultati sul socket Unix di un engine già avviato.

```text
Client Responses → HTTP/SSE → Xenolith Bridge → JSONL Unix socket → Xenolith
```

## Stato della consegna

**0.2.0-alpha.4: candidato di consegna**, con licenza MIT e nuovo nome.
Il frontend implementato è Responses HTTP/SSE. L'integrazione è verificata con
Codex CLI 0.162.1, simulatore e Gemma reale su Xenolith Lunar Lake.
Non implementa ancora il protocollo Anthropic Messages richiesto da Claude Code.

| Funzionalità | Stato |
|---|---|
| Testo SSE, function/custom tools, namespace singolo | Verificati |
| Lettura, modifica ed esecuzione di un programma | Verificate con modello reale |
| Resume dalla cronologia del client | Verificato; ricostruisce il contesto |
| Compattazione locale | Manuale verificata sul modello; automatica con simulatore |
| Riuso KV con `--reuse-kv` | Disponibile nel processo del ponte |
| Ripristino KV dopo riavvio del ponte | Non implementato |
| Frontend Anthropic/Claude Code | Non implementato |

Per Codex, l'integrazione con sessioni durabili, ripristino KV tra processi e
telemetria TUI è nel [fork nativo](https://github.com/crrisci/codex/tree/xenolith-native).
Il ponte rimane la base per harness che necessitano di traduzione HTTP.
Vedi [stato della consegna e prossima milestone](docs/STATO-XENOLITH-BRIDGE.md).
Il prossimo requisito del ponte è portare binding e checkpoint durabili anche qui,
prima di aggiungere un frontend Anthropic.

### Migrazione del nome

Il pacchetto e il comando principale diventano `xenolith-bridge`; `xenolith-bridge` resta
un alias. I comandi `node src/cli.js ...` restano validi. L'identificatore interno del
provider e le variabili dei test `XENOLITH_BRIDGE_*` sono conservati per riprendere le
conversazioni esistenti. La directory di lavoro locale non viene rinominata.

## Avvio

Collegamento a un servizio Xenolith già disponibile:

```sh
node src/cli.js serve --socket /percorso/wire.sock --port 8080
```

Il processo stampa base URL, modello, contesto e limite output ottenuti da
`describe`. Ascolta esclusivamente su `127.0.0.1`. Con `--port 0`, o senza
`--port`, il sistema sceglie una porta libera. Non avvia né ferma Xenolith.
La readiness e `/healthz` riflettono la discovery iniziale; ogni richiesta
di inferenza verifica nuovamente l'engine.

Per avviare anche Codex senza cambiare la sua configurazione personale:

```sh
node src/cli.js run --socket /percorso/wire.sock \
  --codex-home ./codex-home-isolata -- \
  exec --ephemeral --skip-git-repo-check --sandbox workspace-write \
  --json "Leggi README.md e riassumilo brevemente."
```

`run` richiede una directory `CODEX_HOME` esplicita: usare una directory dedicata,
non quella personale. Passa gli override provider solo al processo figlio,
ignora user config e regole utente/progetto e usa `--no-daemon`. Non copia auth,
non usa bypass di sandbox e non modifica le copie sorelle. Le approvazioni
rimangono quelle di Codex. Solo il subprocess Codex posseduto viene terminato
alla chiusura del launcher. Questa versione del launcher supporta `exec`.

Modello e contesto provengono dall'engine; `--max-output-tokens N` limita
l'output del ponte (default 4096, ulteriormente limitato da `describe.max_output`).
Un modello locale non presente nel catalogo Codex usa i metadati fallback:
Codex segnala questo fatto. Non è ancora fornito un catalogo Gemma personalizzato.

## Funzionalità implementate

- `POST /v1/responses` con `stream:true`; `GET /v1/models` e `GET /healthz`.
- Discovery e validazione wire v1, limiti di frame/corpo e timeout.
- Testo e cronologia testuale, istruzioni `system`/`developer` iniziali,
  eventi SSE incrementali, heartbeat e backpressure.
- Tool function e custom/freeform, namespace singoli con nomi wire reversibili,
  argomenti JSON e associazione risultati tramite `call_id`.
- Pubblicazione dei tool completi solo dopo `done.stop:tool_use` riuscito.
  Il ponte non esegue comandi o tool.
- Disconnessione HTTP: `cancel` sulla connessione generatrice, lettura dell'ACK
  e del terminale con timeout. Errori/EOF non vengono trasformati in successo.
- Errori HTTP prima dello stream e `response.failed` durante lo stream;
  limite output e aborto producono `response.incomplete`.

Per impostazione predefinita ogni richiesta usa **`ephemeral` con transcript completo**. Il risultato del
tool eseguito da Codex torna come item di input della richiesta successiva,
poi viene importato nel transcript Xenolith. Non si creano sessioni durabili
nell'engine. La mappa
namespace è ricostruita deterministicamente a ogni richiesta.

### Riuso KV opzionale

```sh
node src/cli.js run --socket /percorso/wire.sock --reuse-kv \
  --codex-home ./codex-home-isolata -- \
  exec --ephemeral --skip-git-repo-check --sandbox workspace-write \
  --json "Leggi e correggi il programma."
```

`--reuse-kv` (anche su `serve`) abilita una cache locale al processo. Solo le
richieste con `prompt_cache_key` non vuota possono usarla; le altre restano
ephemeral. La prima richiesta crea una sessione Xenolith esclusiva e importa
la cronologia con `rebuild`. Le successive usano `append` e `generate` soltanto
se istruzioni, strumenti e l'intero prefisso coincidono con il turno confermato.
I risultati vengono associati agli ID nativi, distinti dai `call_id` Responses.
Qualunque divergenza ricrea la sessione; errori, cancellazione e output incompleto
la invalidano. Richieste concorrenti per la stessa chiave ricevono 429.

La cache mantiene al massimo quattro sessioni, rimuove quelle inattive da dieci
minuti al prossimo accesso e cancella solo le proprie sessioni alla chiusura.
Non riprende sessioni di altri processi o di esecuzioni precedenti. Un arresto
forzato può lasciare record e snapshot nel servizio: non vengono cancellati
automaticamente alla ripartenza. Il riuso effettivo dipende dai contatori del
runtime, non dal solo successo di `append`.

### Riavvio e compattazione

Per conservare la conversazione **omettere `--ephemeral`** e riutilizzare la
stessa home dedicata e la stessa sandbox:

```sh
node src/cli.js run --socket /percorso/wire.sock --reuse-kv \
  --codex-home ./codex-home-isolata -- \
  exec --skip-git-repo-check --sandbox workspace-write --json "Correggi il programma."

node src/cli.js run --socket /percorso/wire.sock --reuse-kv \
  --codex-home ./codex-home-isolata -- \
  exec --sandbox workspace-write resume --skip-git-repo-check --json SESSION_ID \
  "Riprendi e verifica i test."
```

Codex salva il transcript nella propria home e lo reinvia dopo `resume`.
Xenolith Bridge ricostruisce una nuova sessione: **il KV non viene conservato tra
processi**. Il resume dopo riavvio non usa `previous_response_id` e non richiede
uno stato persistente dell'adapter. I cambi di sandbox/istruzioni che producono
messaggi developer intercalati sono ancora rifiutati esplicitamente.

Con Codex 0.162.1 questo provider usa la **compattazione locale**: una normale
richiesta `/v1/responses` genera un riassunto testuale senza strumenti attivi.
Le chiamate storiche sono importate anche quando il loro catalogo è assente,
senza autorizzare nuove chiamate a quegli strumenti. Il turno successivo
ricostruisce la sessione dalla cronologia compatta; il KV del vecchio prefisso
viene invalidato. La soglia automatica del launcher è il 75% del contesto
dichiarato dall'engine. La compattazione manuale è verificata tramite
`thread/compact/start` nell'app-server Codex; il launcher `run` espone `exec`.
Non viene implementato `/responses/compact` e non vengono inventati blob cifrati.
La fedeltà del riassunto dipende dal modello.

I wrapper shell riconosciuti di Codex vengono proiettati come testo JSON con
`stdout` e `execution` (intestazione originale, exit code o session ID).
Il contenuto dello stdout, incluse righe che somigliano a metadati, è conservato.
Formati sconosciuti e altri tool restano invariati. Il prompt spiega al modello
come usare questi campi; il ponte non filtra la risposta finale del modello.

La proiezione usage è contabilità di calcolo: `input_tokens = input + cache_read`,
`output_tokens = output`, totale uguale alla somma. L'input può includere replay
e shadow work e non equivale necessariamente alla lunghezza tokenizzata del
prompt. `xenolith_usage` conserva i contatori nativi, compreso `total`, che ha
una semantica diversa. La validazione dei contatori precede la pubblicazione
dei tool.

## Limiti espliciti

Non supportati: reasoning attivo o item reasoning storici, immagini/audio,
tool hosted e deferred, Responses Lite/`additional_tools`, namespace annidati,
output JSON vincolato o verbosity, compressione delle richieste, WebSocket,
`previous_response_id`, storage Responses, ripristino KV tra processi, rewind,
compattazione remota cifrata e API diversa dagli endpoint elencati. Le richieste relative
ricevono un errore esplicito. Non vengono sostituite da inferenza remota.

`reasoning.summary:auto` e `include:["reasoning.encrypted_content"]`, che Codex
invia anche nel probe locale, sono accettati con reasoning disabilitato:
non vengono prodotti summary o blob cifrati. `tool_choice` deve essere `auto`.
Le richieste di reasoning effort diverso da `none` vengono rifiutate.

Gli output dei tool storici devono seguire l'ordine delle chiamate: risultati
fuori ordine o ID ignoti/duplicati sono rifiutati per evitare associazioni
errate, soprattutto con chiamate multiple allo stesso nome. Gli schemi function
sono inoltrati senza semplificazioni: il test reale ha accettato le dichiarazioni
inviate da Codex ed eseguito `exec_command`, ma non ha esercitato ogni schema.
La grammatica di un custom tool viene
descritta nel prompt, non applicata come vincolo di decoding dal ponte.
La validazione del tool rimane al client.

Il trasporto Xenolith v1 non rappresenta `phase` nella cronologia importata:
il ponte genera `commentary` per testo con tool e `final_answer` per testo
con stop normale, ma non conserva una distinta semantica di fase nel prompt
wire. Cambiamenti di istruzioni developer interleaved vengono rifiutati.

## Test locali

```sh
npm test
npm run test:codex
```

La prima suite usa HTTP reale e un socket Unix simulato per verificare testo,
Unicode/frammentazione, tool/custom/namespace, errori, limiti, heartbeat e cancel.
La seconda richiede `codex` nel PATH e verifica:

1. Richieste HTTP effettive della CLI installata, con endpoint di cattura.
2. Testo attraverso Codex → adapter → wire simulato → SSE → Codex.
3. Codex esegue `cat input.txt` su una fixture con nonce casuale; il simulatore
   riceve l'output, ne estrae il nonce e genera la risposta finale. Nessun nonce
   è presente nel prompt. Si verificano `call_id`, exit code e turno completato.
4. Launcher, discovery, home isolata e chiusura dopo il completamento.
5. Resume con `exec resume` dopo la chiusura del launcher.
6. Compattazione manuale con tool storici, nuovo turno e resume dopo riavvio.
7. Compattazione automatica attivata dall’usage simulato sopra la soglia.

Tutti gli artefatti restano sotto `.test-artifacts/` nel repository, ignorata
da Git. Ogni test crea directory/socket propri e chiude solo i propri processi
e connessioni. Gli artefatti delle prove Codex includono richieste catturate e
stdout/stderr per diagnosi; il server di produzione non registra i prompt.
I test non vengono saltati silenziosamente se la CLI manca.
In un sandbox che vieta `listen`, l'esecuzione deve essere autorizzata per
socket loopback e Unix locali; non richiede accesso a un servizio d'inferenza remoto.

## Test con modello reale su Intel/WSL

La batteria opt-in avvia il binario esistente e verifica discovery, testo SSE,
testo Codex, lettura di un nonce, conservazione di intestazioni letterali nel
file e lettura/modifica/esecuzione di un programma difettoso. I test della
fixture vengono eseguiti prima e dopo la modifica e devono restare invariati.
Le risposte finali devono rispettare esattamente il formato richiesto.

```sh
XENOLITH_BIN=/home/simo/dev/xenolith_lnl/xenolith \
XENOLITH_MODEL=/home/simo/.models/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf \
npm run test:model
```

Per abilitare il riuso nel test: `XENOLITH_BRIDGE_REUSE_KV=1`. Per selezionare prove:
`XENOLITH_BRIDGE_PHASES=codex_tool,codex_literal,codex_coding`.
La fase `codex_lifecycle` corregge un carrello su più file con test immutabili,
compatta, riprende il lavoro e riavvia client, adapter ed engine posseduti. Ogni prova Codex crea
una propria home/workspace; i turni all'interno della stessa prova possono
riusare KV. `session-events.jsonl` distingue hit, miss e fallimenti di cleanup.

Richiede Linux, Codex nel PATH, almeno 21 GiB disponibili e nessun engine
Xenolith attivo. Usa `--ctx 65536`, socket/state/cache e home Codex dedicati,
mantiene il lock globale dell'engine e chiude solo i processi che avvia.
Non compila o installa Xenolith. Conserva `result.json`, log engine, richieste,
eventi wire, SSE e output Codex sotto `.test-artifacts/real-*`.

Restano da ampliare custom tool reali, copertura degli schemi, sampler,
saturazione del contesto 65536 e prove di coding più estese. Il test reale
registra `exact_result` solo quando supera il confronto rigoroso della risposta.
La CLI dell'adapter non avvia l'engine pesante: prima verificare binario, memoria,
socket e proprietario dei pesi senza interrompere sessioni altrui.

Vedi [analisi iniziale](docs/ANALISI-INIZIALE.md) e
[verifica sul Mac](docs/VERIFICA-MAC.md), [verifica WSL](docs/VERIFICA-WSL.md)
e [prova sul modello reale](docs/VERIFICA-MODELLO.md), con il successivo
[test di coding e KV](docs/VERIFICA-CODING-KV.md) e
[riavvio e compattazione](docs/VERIFICA-RESUME-COMPACT.md).

## Codex nativo

Il lavoro sull'integrazione nativa in un fork locale di Codex è descritto nella
[milestone](docs/MILESTONE-CODEX-NATIVO.md) e nelle [istruzioni del fork](native/README.md).
Il fork conserva licenza Apache-2.0 e avvisi upstream; l'adapter indipendente resta MIT.
La milestone nativa è verificata su Intel/WSL: [risultati e limiti](docs/VERIFICA-CODEX-NATIVO.md).

## Licenza

Adapter HTTP: licenza [MIT](LICENSE), come Xenolith. Le patch e i test del fork in `native/` usano [Apache-2.0](native/LICENSE). Copyright (c) 2026 Francesco Pio Crisci.
