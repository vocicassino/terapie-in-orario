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
