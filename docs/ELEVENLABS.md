# Voce espressiva con ElevenLabs

ElevenLabs (piano Creator) e il motore vocale predefinito di Orbit e l'unico servizio a pagamento autorizzato. Piper (voce Paola, locale) resta come riserva automatica: si usa se manca la chiave o la voce, se i crediti finiscono, se supera il tetto mensile o se la rete non risponde. Dopo un errore ElevenLabs viene messo in pausa per un po (da 30 secondi a un'ora, secondo l'errore), quindi non si spreca nessuna chiamata.

## Impostazione (la fai tu)

1. Crea il file `%LOCALAPPDATA%\Orbit\.env` da un terminale normale (non da una sessione di Claude: i file creati li dentro finiscono nella copia virtualizzata MSIX e Orbit non li vede). In alternativa usa `privato/orbit.env` nel repository, escluso da Git.
2. Scrivi `ELEVENLABS_API_KEY=...` e `ORBIT_TTS_VOCE_ID=...`. La chiave non va in codice, vault, Git o chat.
3. Per scegliere la voce: `node orbit/tools/prova-elevenlabs.js --voci` (non consuma crediti).

Non serve riavviare per aggiungere la chiave: Orbit la rilegge quando manca.

## Modello

Predefinito `eleven_v3`, il piu espressivo (circa 3 secondi sulla prima frase; con velocita diversa da 1 non e stato provato). Alternative: `eleven_multilingual_v2` e piu stabile e accetta la velocita; `eleven_flash_v2_5` e il piu rapido ma meno espressivo (circa 2 secondi). Per rimisurare: `node orbit/tools/prova-elevenlabs.js --misura --conferma` legge una frase da circa 45 caratteri per modello e stampa la latenza (consuma pochi crediti, per questo chiede `--conferma`).

## Crediti e privacy

- Prima di ogni frase Orbit legge i crediti del mese dal servizio (chiamata gratuita, ogni 5 minuti al massimo) e non sintetizza oltre il limite del piano o oltre `ORBIT_TTS_MAX_CARATTERI_MESE`.
- Il testo di ogni frase letta ad alta voce viene inviato a ElevenLabs. Con Piper non usciva dal PC. L'audio non viene mai salvato da Orbit.
- La chiave non compare nello stato dell'interfaccia, nei log o nei messaggi d'errore.
