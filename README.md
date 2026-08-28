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
