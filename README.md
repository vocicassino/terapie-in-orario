# Terapie in Orario – v15 Backup automatico + recupero Telegram

Novità:

- Backup automatico dopo modifiche, nuove terapie e registrazioni Presa/Saltata.
- Il codice TIO2 resta stabile e viene usato dietro le quinte.
- Dopo il primo backup il link di recupero viene inviato automaticamente al bot Telegram.
- Pulsante “Invia link di recupero su Telegram” per reinviarlo quando vuoi.
- Dopo un reset del telefono: reinstalla Telegram, apri il messaggio del bot, premi “Ripristina Terapie in Orario” e conferma.
- Il codice manuale resta nelle opzioni avanzate come recupero di emergenza.

## Aggiornamento

1. Sostituisci su GitHub i file della webapp.
2. Sostituisci il codice del Worker con `cloudflare/worker.js` e premi Deploy.
3. Non cambiare KV, token Telegram, Chat ID o Cron.
4. Apri la webapp, vai in Impostazioni e premi una volta “Backup adesso”.
5. Verifica che il bot Telegram riceva il messaggio con il pulsante di ripristino.

Il link Telegram contiene una credenziale di recupero: proteggi l’account Telegram con PIN/verifica in due passaggi.
