# Terapie in Orario - Fix ripristino backup

Questa versione mantiene tutte le funzioni precedenti (notifiche Presa/Saltata, Ripeti, mesi alterni e controllo duplicati) e rende il ripristino cloud più robusto.

Correzioni:
- verifica automatica del Worker Cloudflare prima del ripristino;
- ritenta automaticamente il download del backup se Cloudflare KV non lo rende subito disponibile;
- accetta sia il codice `TIO1...`, sia il link di condivisione completo, sia un payload compatibile senza prefisso;
- non sovrascrive permanentemente le impostazioni se il ripristino fallisce;
- mostra il motivo reale dell'errore nella sezione Backup;
- dopo ogni nuovo backup verifica che il file sia realmente recuperabile;
- cache PWA aggiornata a v13.

Per questa correzione non è necessario cambiare il Worker se quello pubblicato espone già `/backup` e `/check` con `backupSupported: true`.
