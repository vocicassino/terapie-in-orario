# Terapie in Orario – Ripeti + mesi alterni

Questa versione parte dalla versione con blocco dei promemoria quando una dose è già segnata come **Presa** o **Saltata**.

## Novità

- Pulsante **↻ Ripeti** su ogni terapia corrente.
- Il pulsante crea una nuova terapia già compilata con nome, dose, foto, codice a barre, giorni, orari, note e periodicità.
- La nuova terapia parte dalla data odierna. Se la terapia originale aveva una durata definita, viene mantenuta la stessa durata.
- Nuovo campo **Periodicità mensile** nella creazione/modifica della terapia:
  - Ogni mese
  - Mesi alterni (un mese sì, uno no)
- Nei mesi alterni il mese della **Data inizio** è il primo mese attivo. Esempio: agosto → ottobre → dicembre.
- La regola dei mesi alterni è applicata sia nella PWA sia nel Worker Cloudflare/Telegram.
- Cache PWA aggiornata a `v11`.

## Aggiornamento

1. Sostituisci i file della webapp su GitHub Pages.
2. Sostituisci anche `cloudflare/worker.js` nel Worker e fai **Deploy**.
3. Non devi cambiare KV, token Telegram o Cron Trigger.
