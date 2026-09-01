# Terapie in Orario – v17 Restyling grafico

Questa versione mantiene la logica della v16 e interviene soprattutto sull'interfaccia.

## Novità grafiche
- Home ridisegnata con riepilogo giornaliero, barra di avanzamento e prossima terapia evidenziata.
- Schede terapia più compatte con immagine/iniziale, badge e menu “•••” per le azioni secondarie.
- Navigazione inferiore con icone SVG uniformi.
- Calendario e statistiche ridisegnati, inclusa percentuale aderenza con indicatore circolare.
- Impostazioni più ordinate: i dati tecnici Telegram sono raccolti in “Configurazione tecnica”.
- Indicatore Cloud/Locale nell'intestazione.
- Migliore resa su smartphone piccoli e tablet.
- Tema scuro automatico quando il dispositivo usa la modalità scura.
- Cache PWA aggiornata a v17.

## Aggiornamento
1. Sostituisci su GitHub i file della webapp con quelli di questa cartella.
2. Non è necessario modificare il Worker Cloudflare: la logica server è la stessa della v16.
3. Riapri la webapp. Se necessario, aprila una volta con `?v=17` per forzare il caricamento dei file nuovi.

La webapp resta un promemoria personale e non sostituisce le indicazioni del medico o del farmacista.


## Aggiornamento v18

- Corretto il menu in basso su smartphone piccoli.
- Le scritte non si accavallano più.
- Su schermi stretti restano visibili sempre le icone e l'etichetta della sezione attiva.


## v19 – Ripristino promemoria Telegram

- Il profilo Telegram viene riallineato automaticamente a Cloudflare ad ogni apertura dell'app.
- Attivare/disattivare il toggle Telegram viene salvato e sincronizzato subito.
- Dopo un ripristino backup, il profilo Telegram viene ricreato automaticamente.
- Nuovo pulsante **Verifica e ripara Telegram** nelle Impostazioni.
- Il Worker registra un heartbeat del Cron Trigger e la diagnostica mostra l'ultima esecuzione.
- La diagnostica controlla: Worker, token Telegram, profilo, Chat ID, numero di terapie e Cron.

### Aggiornamento obbligatorio
Per questa versione va aggiornato anche `cloudflare/worker.js` su Cloudflare e va mantenuto il Cron Trigger consigliato `*/15 * * * *`.


## v20 – Correzione diagnostica Telegram

Corretto l'errore `Failed to fetch` del pulsante **Verifica e ripara Telegram**.
La causa era il preflight CORS: la webapp inviava anche l'header `cache-control`, mentre il Worker autorizzava soltanto `content-type`.

Modifiche:
- rimossa dalla richiesta diagnostica l'intestazione non necessaria `cache-control`;
- il Worker ora accetta anche `cache-control` nelle richieste CORS;
- messaggio di errore più chiaro se la comunicazione viene bloccata dal browser;
- cache PWA v20.

Per la correzione completa bisogna aggiornare sia i file GitHub sia `cloudflare/worker.js` e fare Deploy.


## v21 – promemoria Telegram quasi all'orario esatto

- Cron Cloudflare consigliato: `* * * * *` (ogni minuto).
- Finestra di recupero Worker: 3 minuti, con deduplicazione.
- Diagnostica Telegram segnala il Cron come anomalo se non viene eseguito da oltre 5 minuti.
- Cache PWA aggiornata a v21.

### IMPORTANTE
Il Cron Trigger non può essere cambiato dal codice del Worker. In Cloudflare devi aprire:
Worker > Triggers > Cron Triggers

e sostituire l'espressione precedente con:

`* * * * *`



## v22 – correzione terapie di oggi

- Normalizzazione automatica dei giorni provenienti da vecchi backup/versioni (anche se salvati come testo).
- La schermata Oggi usa giorni e orari normalizzati.
- Dopo un ripristino, le terapie vengono normalizzate prima del rendering.
- Nella lista Terapie lo stato non mostra più genericamente “Attiva” quando la terapia è già terminata.
- Sono mostrati motivi chiari: “Terminata”, “Non iniziata”, “Pausa mensile”, oppure “Oggi”.
- Se la data fine è trascorsa, viene indicato di usare “Ripeti” per impostarla nuovamente.
- Nessuna modifica richiesta al Worker Cloudflare rispetto alla v21.


## v23 – correzione valori scorte

Corretto il campo “Unità per assunzione”: il precedente `min=0.1` + `step=0.5`
rendeva **1** un valore non valido (il browser proponeva infatti 0,6 oppure 1,1).

Ora i campi scorte accettano liberamente valori decimali:
- 1
- 0,5
- 0,25
- 1,5
ecc.

Nessuna modifica al Worker Cloudflare è necessaria.


## v24 – terapia ciclica

Aggiunta una vera programmazione ciclica, utile per terapie come:
- 14 giorni di terapia
- ogni 2 mesi
- per 3 cicli

Esempio con inizio 01/09/2026:
- 01/09–14/09
- 01/11–14/11
- 01/01/2027–14/01/2027

La Data fine complessiva viene calcolata automaticamente.
La schermata Oggi, il Calendario e Telegram usano la stessa logica.
L'anti-duplicato continua a bloccare copie vere, ma il messaggio ora invita a modificare
la terapia esistente e trasformarla in ciclica invece di crearne una seconda.

Questa versione richiede anche l'aggiornamento del Worker Cloudflare.


## v25 – calendario completo e modifica manuale dei singoli giorni

- Il Calendario mostra nomi e orari delle terapie programmate in ogni giorno.
- Toccando un giorno si apre la programmazione manuale.
- Per ogni terapia puoi:
  - includerla in quel giorno;
  - rimuoverla solo da quel giorno;
  - cambiare gli orari solo per quel giorno;
  - aprire direttamente “Modifica terapia” per cambiare il programma generale.
- “Ripristina automatico” elimina tutte le modifiche manuali del giorno.
- Le modifiche manuali sono incluse nel backup e nella sincronizzazione Cloudflare.
- Telegram rispetta inclusioni, esclusioni e orari manuali.
- La modifica di una terapia esistente non viene più bloccata da vecchie copie sovrapposte; il blocco anti-duplicato resta per la creazione di nuove copie.
- Cache PWA aggiornata a v25.

Questa versione richiede anche l'aggiornamento del Worker Cloudflare.


## v26 – Cron ogni 15 minuti

Configurazione consigliata per ridurre le esecuzioni Cloudflare:

`*/15 * * * *`

Il Worker controlla gli ultimi 20 minuti ad ogni esecuzione, così una terapia
impostata tra due controlli non viene persa. La deduplicazione impedisce
l'invio dello stesso promemoria più volte.

La diagnostica Telegram considera normale un'ultima esecuzione del Cron
entro 20 minuti.

Se vuoi mantenere il consumo Cloudflare ridotto, non usare il Cron ogni minuto.
