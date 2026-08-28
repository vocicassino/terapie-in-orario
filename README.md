# Terapie in Orario – v16

Novità principali:

- Posticipa una dose di 10, 30 o 60 minuti, anche per Telegram.
- Gestione scorte: unità disponibili, consumo per dose e avviso scorta bassa.
- Calendario mensile con stato delle giornate.
- Statistiche organizzative mensili: prese, saltate, non registrate e percentuale di aderenza.
- Sincronizzazione tra dispositivi tramite Backup TIO2: controllo automatico quando l'app torna in primo piano e pulsante “Sincronizza ora”.
- Mantiene backup automatico e recupero Telegram della v15.
- Cache PWA aggiornata a v16.

## Aggiornamento

1. Sostituisci tutti i file della webapp su GitHub.
2. Sostituisci il Worker Cloudflare con `cloudflare/worker.js` e premi **Deploy**.
3. Non modificare KV, TELEGRAM_BOT_TOKEN, Chat ID o Cron Trigger.
4. Apri la PWA una volta e verifica Impostazioni → Sincronizzazione tra dispositivi.

Le statistiche sono soltanto organizzative e non sostituiscono valutazioni mediche o indicazioni terapeutiche.
