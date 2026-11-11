'use strict';
// Riconoscimento vocale locale di Orbit: unisce parola di attivazione (Vosk) e trascrizione (Whisper) e li espone all'interfaccia.
// La cattura del microfono e il rilevamento delle pause (VAD) stanno nel browser (public/voice.js); qui arriva solo l'audio da analizzare,
// che resta in memoria e non viene salvato (salvo la prova opzionale ORBIT_STT_DIAGNOSTICA_DIR). Il testo trascritto torna al browser, che lo invia alla stessa chat dei messaggi digitati.
//   GET  /api/voce/stato      stato e disponibilita (avvia in background Whisper e Vosk se installati)
//   POST /api/voce/ascolta    pacchetto PCM 16 kHz per la parola "Orbit"  -> { attivata, fine, campioni } (campioni: quanti ne ha ricevuti Vosk)
//   POST /api/voce/azzera     nuova sessione di ascolto della parola
//   POST /api/voce/trascrivi  WAV del comando -> { testo, vuoto, motivo, latenzaMs, durataAudioS, rtf }
const { WhisperSTT } = require('./whisper');
const { ParolaVosk } = require('./parola');
const fs = require('fs');
const path = require('path');

const MAX_PACCHETTO = 128 * 1024;          // circa 4 s di audio per pacchetto della parola
const MAX_COMANDO = 2.2 * 1024 * 1024;     // circa 65 s di audio per un comando

// Solo per le prove (diagnostica + cartella): tiene gli ultimi 10 comandi come cmd-<timestamp>.wav. Sono registrazioni della voce: la cartella va cancellata.
function salvaProva(dir, wav, log) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cmd-' + Date.now() + '.wav'), wav);
    fs.readdirSync(dir).filter(f => /^cmd-\d+\.wav$/.test(f)).sort().slice(0, -10).forEach(f => fs.unlinkSync(path.join(dir, f)));
  } catch (e) { if (log) log.warn('STT diagnostica: salvataggio audio non riuscito (' + e.message + ')'); }
}

// Solo per la diagnostica: picco e RMS massimo (finestre da 20 ms) in % del fondo scala e campioni a ±32767, per vedere il clipping. Presume PCM 16 bit con intestazione da 44 byte.
function livelliWav(wav) {
  const n = Math.max(0, (wav.length - 44) >> 1);
  let picco = 0, clip = 0, rmsMax = 0, somma = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const v = wav.readInt16LE(44 + i * 2), a = Math.abs(v);
    if (a > picco) picco = a;
    if (a >= 32767) clip++;
    somma += v * v;
    if (++k === 320) { rmsMax = Math.max(rmsMax, Math.sqrt(somma / k)); somma = 0; k = 0; }
  }
  return { piccoPct: +(picco / 327.68).toFixed(1), rmsMaxPct: +(rmsMax / 327.68).toFixed(1), campioniClip: clip };
}

function leggiBinario(req, max, tipi) {
  return new Promise((ok, ko) => {
    if (req.headers['x-orbit'] !== '1' || !tipi.some(t => (req.headers['content-type'] || '').startsWith(t))) return ko({ status: 403, errore: 'Richiesta non valida.' });
    // oltre il limite si scarta il resto del corpo (fino a 8 MB) e si risponde 413 alla fine, senza troncare la connessione
    const parti = []; let n = 0, troppo = false;
    req.on('data', d => { n += d.length; if (troppo) { if (n > 8 * 1024 * 1024) req.destroy(); return; } if (n > max) { troppo = true; parti.length = 0; } else parti.push(d); });
    req.on('end', () => (troppo ? ko({ status: 413, errore: 'Audio troppo lungo.' }) : ok(Buffer.concat(parti))));
    req.on('error', () => ko({ status: 400, errore: 'Richiesta interrotta.' }));
  });
}

const STATO_ERRORE = { NON_PRONTO: 503, AUDIO_NON_VALIDO: 400, TROPPO_LUNGA: 413, TIMEOUT: 504 };

function creaVoceLocale({ settings, log = null, whisper, parola }) {
  const stt = settings.stt || {};
  whisper = whisper || new WhisperSTT({ dir: stt.dir, modello: stt.modello, lingua: stt.lingua, thread: stt.thread, contesto: stt.contesto, prompt: stt.prompt, log });
  parola = parola || new ParolaVosk({ dir: stt.dir, parole: stt.paroleAttivazione, varianti: stt.varianti, log });
  const motore = stt.motore || 'whisper';

  function stato() {
    if (motore === 'whisper') { whisper.avvia(); parola.avvia(); }          // non blocca: il primo stato fa partire il caricamento
    return { motore, lingua: stt.lingua || 'it', stt: whisper.stato(), parola: parola.stato(), istruzioni: whisper.disponibile() && parola.disponibile() ? null : 'node orbit/tools/installa-stt.js' };
  }

  async function gestisci(req, res, { invia }) {
    const p = new URL(req.url, 'http://localhost').pathname, m = req.method;
    try {
      if (m === 'GET' && p === '/api/voce/stato') return invia(res, 200, stato());
      if (motore !== 'whisper') return invia(res, 409, { errore: 'Il riconoscimento locale e spento (ORBIT_STT_MOTORE=' + motore + ').' });
      if (m === 'POST' && p === '/api/voce/ascolta') {
        const pcm = await leggiBinario(req, MAX_PACCHETTO, ['application/octet-stream']);
        if (pcm.length % 2) return invia(res, 400, { errore: 'Audio non valido.' });
        return invia(res, 200, await parola.analizza(pcm));
      }
      if (m === 'POST' && p === '/api/voce/azzera') { await leggiBinario(req, 1024, ['application/octet-stream', 'application/json']).catch(() => null); await parola.azzera(); return invia(res, 200, { ok: true }); }
      if (m === 'POST' && p === '/api/voce/trascrivi') {
        const wav = await leggiBinario(req, MAX_COMANDO, ['audio/wav']);
        if (stt.diagnostica && stt.diagnosticaDir) salvaProva(stt.diagnosticaDir, wav, log);
        const r = await whisper.trascrivi(wav);
        if (stt.diagnostica && log) log.info('STT diagnostica: ' + JSON.stringify(Object.assign({ testo: r.testo, vuoto: r.vuoto, motivo: r.motivo, durataAudioS: r.durataAudioS, logprob: r.logprob, latenzaMs: r.latenzaMs, rtf: r.rtf }, livelliWav(wav))));
        return invia(res, 200, r);
      }
      return invia(res, 404, { errore: 'Non trovato.' });
    } catch (e) {
      if (e && e.status) return invia(res, e.status, { errore: e.errore });
      if (log) log.warn('Voce locale: ' + (e && e.message));
      return invia(res, STATO_ERRORE[e && e.codice] || 502, { errore: e && e.message ? e.message : 'Errore del riconoscimento vocale.', codice: (e && e.codice) || 'ERRORE' });
    }
  }

  function ferma() { whisper.ferma(); parola.ferma(); }
  return { motore, gestisci, stato, ferma, whisper, parola };
}

module.exports = { creaVoceLocale, leggiBinario };
