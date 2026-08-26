# Terapie in Orario – protezione duplicati

Questa versione aggiunge:

- controllo automatico prima del salvataggio: la stessa terapia non può essere inserita due volte se nome, dose, giorni, orari e periodicità coincidono e le date si sovrappongono;
- nella pagina **Oggi**, eventuali duplicati già presenti vengono evidenziati;
- sul duplicato compare **Rimuovi questa copia**, che elimina la copia errata anche dalle giornate future;
- il Worker Cloudflare raggruppa eventuali copie equivalenti e invia **un solo promemoria Telegram**;
- se una delle copie equivalenti è già stata segnata **Presa** o **Saltata**, il Worker non invia il promemoria per le altre copie;
- cache PWA aggiornata alla versione 12.

## Aggiornamento

Sostituire i file della webapp su GitHub e sostituire anche `cloudflare/worker.js` nel Worker Cloudflare, quindi premere **Deploy**.
