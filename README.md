# Fix notifiche dopo "Presa"

Questa versione corregge il problema per cui il promemoria Telegram arrivava anche dopo aver registrato la dose come **Presa** o **Saltata**.

## Causa
L'app salvava la conferma solo sul dispositivo. Il Worker Cloudflare conosceva gli orari delle terapie, ma non lo stato della singola dose.

## Correzione
- Nuovo endpoint Worker: `POST /dose-status`
- Quando premi **Presa** o **Saltata**, l'app sincronizza immediatamente lo stato della dose con Cloudflare.
- Il Cron controlla lo stato prima di inviare Telegram.
- Se la dose è già `taken` o `skipped`, non invia nulla.
- Il pulsante **Annulla registrazione** rimuove il blocco.
- Le sincronizzazioni fallite vengono accodate e ritentate ogni 30 secondi.
- Le notifiche locali già visibili vengono chiuse quando registri la dose.
- Cache PWA aggiornata a `v10`.

## Aggiornamento necessario
Sostituire almeno:
1. `app.js` su GitHub Pages
2. `sw.js` su GitHub Pages
3. `cloudflare/worker.js` nel Worker Cloudflare e fare **Deploy**

Il Worker e l'app devono essere aggiornati insieme.
