'use strict';
// Trascrizione locale con Whisper (whisper.cpp, modello Small multilingue). Gratuita, offline dopo l'installazione, nessuna chiave.
// Un solo processo whisper-server.exe per Orbit, avviato in anticipo e senza bloccare: il modello si carica una volta e resta in memoria.
// Ascolta solo su 127.0.0.1, su una porta libera scelta all'avvio. L'audio arriva in memoria e non viene mai scritto su disco da Orbit.
// Installato da tools/installa-stt.js in <dati>\stt (fuori dal vault). Vedi docs/WHISPER-STT.md.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');

const IS_WIN = process.platform === 'win32';
// File dei modelli (ggml, quantizzati 8 bit: quasi la stessa precisione del modello pieno, meta della memoria). Small e il modello in uso;
// Base e qui solo perche il passaggio futuro sia un parametro (ORBIT_STT_MODELLO=base), mai un ripiego automatico.
const MODELLI = {
  small: { file: 'ggml-small-q8_0.bin', nome: 'Whisper Small multilingue (ggml-small-q8_0)', sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f', byte: 264464607 },
  base: { file: 'ggml-base-q8_0.bin', nome: 'Whisper Base multilingue (ggml-base-q8_0)', sha256: 'c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9', byte: 81768585 }
};
const SOGLIA_NESSUN_PARLATO = 0.6;
const DURATA_MIN_S = 0.35;        // sotto questa durata non si trascrive (registrazione vuota o un colpo di tosse)
const DURATA_MAX_S = 60;
const TIMEOUT_MS = 60000;
const AVVIO_MAX_MS = 90000;

// Frasi che Whisper "inventa" sul silenzio o sul rumore (sottotitoli, ringraziamenti): se il testo e SOLO questo, e vuoto.
// Solo frasi tipiche dei sottotitoli: un comando vero ("Orbit, ciao") non viene mai scartato per il suo contenuto.
const ALLUCINAZIONI = [/^sottotitoli( creati)? (a cura|dalla comunit)/i, /^grazie per (la|l'?)\s?visione[.!]?$/i, /^iscriviti al canale/i, /amara\.org/i];

function pulisci(testo) {
  let t = String(testo || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (ALLUCINAZIONI.some(re => re.test(t))) return '';
  return t;
}

const normalizza = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Vero se il testo e solo un pezzo del prompt (stesse parole, stesso ordine): Whisper lo ha ripetuto invece di trascrivere.
function ecoDelPrompt(testo, prompt) {
  const t = normalizza(testo);
  return t.length >= 4 && (' ' + normalizza(prompt) + ' ').includes(' ' + t + ' ');
}

function durataWav(buf) {
  // WAV PCM: si cerca il blocco "data" e si legge il formato dal blocco "fmt "
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let p = 12, rate = 0, canali = 0, bit = 0, dati = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), n = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') { canali = buf.readUInt16LE(p + 10); rate = buf.readUInt32LE(p + 12); bit = buf.readUInt16LE(p + 22); }
    if (id === 'data') { dati = Math.min(n, buf.length - p - 8); break; }
    p += 8 + n + (n % 2);
  }
  if (rate !== 16000 || canali !== 1 || bit !== 16 || !dati) return null;
  return dati / 32000;
}

const portaLibera = () => new Promise((ok, ko) => { const s = net.createServer(); s.unref(); s.on('error', ko); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

class WhisperSTT {
  // exe, binArgs e fetchFn iniettabili nei test (un falso server).
  constructor({ dir, modello = 'small', lingua = 'it', thread = 6, contesto = 3, prompt = '', exe, binArgs = [], fetchFn, log = null }) {
    this.dir = dir;
    this.info = MODELLI[modello] || MODELLI.small;
    this.modello = modello in MODELLI ? modello : 'small';
    this.fileModello = dir && path.join(dir, 'modelli', this.info.file);
    this.exe = exe || (dir && path.join(dir, 'whisper', IS_WIN ? 'whisper-server.exe' : 'whisper-server'));
    this.binArgs = binArgs; this.lingua = lingua; this.thread = thread; this.contesto = contesto; this.prompt = String(prompt || '').trim();
    this.fetch = fetchFn || fetch; this.log = log;
    this.proc = null; this.porta = null; this.pronto = false; this.avvio = null; this.errore = null; this.coda = Promise.resolve();
    this.ultima = null; this.trascrizioni = 0;
  }

  disponibile() { return !!(this.exe && this.fileModello && fs.existsSync(this.exe) && fs.existsSync(this.fileModello)); }
  stato() {
    return {
      motore: 'whisper.cpp', modello: this.info.nome, lingua: this.lingua, thread: this.thread, disponibile: this.disponibile(),
      pronto: this.pronto, caricamento: !!this.avvio && !this.pronto, errore: this.errore, ultima: this.ultima, trascrizioni: this.trascrizioni,
      pid: this.proc ? this.proc.pid : null
    };
  }

  // Un processo whisper rimasto da un avvio precedente (Orbit chiuso male) viene chiuso: mai due modelli in memoria.
  _chiudiOrfano() {
    const pidFile = path.join(this.dir, 'whisper.pid');
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (pid && IS_WIN) {
        const r = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        if (/whisper-server/i.test(r)) execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' });
      } else if (pid) { try { process.kill(pid); } catch (e) { /* gia chiuso */ } }
    } catch (e) { /* nessun file o processo gia chiuso */ }
    try { fs.unlinkSync(pidFile); } catch (e) { /* non c'era */ }
  }

  // Avvio in background: restituisce subito una promessa; chi trascrive la aspetta. Mai due avvii insieme.
  avvia() {
    if (this.pronto) return Promise.resolve(true);
    if (this.avvio) return this.avvio;
    if (!this.disponibile()) { this.errore = 'Whisper non installato: esegui node orbit/tools/installa-stt.js'; return Promise.resolve(false); }
    this.errore = null;
    this.avvio = (async () => {
      if (this.dir && !this.binArgs.length) this._chiudiOrfano();
      this.porta = await portaLibera();
      const args = this.binArgs.concat(['-m', this.fileModello, '-l', this.lingua, '-t', String(this.thread), '--host', '127.0.0.1', '--port', String(this.porta), '-nt', '-nlp']);   // -nlp: niente probabilita delle lingue (raddoppierebbe il tempo)
      const p = spawn(this.exe, args, { cwd: path.dirname(this.exe), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = p;
      let coda = '';
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { coda = (coda + d).slice(-2000); });
      if (this.dir && !this.binArgs.length) { try { fs.writeFileSync(path.join(this.dir, 'whisper.pid'), String(p.pid)); } catch (e) { /* solo per la pulizia */ } }
      const chiudi = () => { try { p.kill(); } catch (e) { /* gia chiuso */ } };
      process.once('exit', chiudi);
      p.on('exit', codice => {
        process.removeListener('exit', chiudi);
        if (this.proc !== p) return;
        this.proc = null; this.pronto = false; this.avvio = null;
        this.errore = 'Il processo di Whisper si e fermato (codice ' + codice + ')' + (/error|fail/i.test(coda) ? ': ' + coda.split('\n').filter(r => /error|fail/i.test(r)).slice(-1)[0] : '');
        if (this.log) this.log.warn('Whisper: ' + this.errore);
      });
      p.on('error', e => { this.errore = 'Whisper non si avvia: ' + e.message; });
      const t0 = Date.now();
      while (Date.now() - t0 < AVVIO_MAX_MS) {
        if (this.proc !== p) break;
        try { const r = await this.fetch('http://127.0.0.1:' + this.porta + '/', { signal: AbortSignal.timeout(2000) }); if (r.status < 500) { this.pronto = true; break; } } catch (e) { /* non ancora in ascolto */ }
        await new Promise(r => setTimeout(r, 250));
      }
      if (!this.pronto) { if (!this.errore) this.errore = 'Whisper non e partito in tempo.'; chiudi(); this.avvio = null; return false; }
      if (this.log) this.log.info('Whisper pronto (' + this.info.nome + ', ' + this.thread + ' thread) in ' + (Date.now() - t0) + ' ms');
      return true;
    })().catch(e => { this.errore = 'Whisper non si avvia: ' + e.message; this.avvio = null; return false; });
    return this.avvio;
  }

  // wav: PCM 16 bit mono 16 kHz. Le trascrizioni passano una alla volta (un solo modello in memoria).
  trascrivi(wav, { lingua } = {}) {
    const lavoro = this.coda.then(() => this._trascrivi(wav, { lingua }));
    this.coda = lavoro.catch(() => {});
    return lavoro;
  }

  async _trascrivi(wav, { lingua }) {
    const durata = durataWav(wav);
    if (durata === null) throw Object.assign(new Error('Audio non valido: serve WAV PCM 16 bit mono a 16 kHz.'), { codice: 'AUDIO_NON_VALIDO' });
    if (durata < DURATA_MIN_S) return { testo: '', vuoto: true, motivo: 'registrazione troppo breve', durataAudioS: +durata.toFixed(2) };
    if (durata > DURATA_MAX_S) throw Object.assign(new Error('Registrazione troppo lunga (oltre ' + DURATA_MAX_S + ' s).'), { codice: 'TROPPO_LUNGA' });
    if (!(await this.avvia())) throw Object.assign(new Error(this.errore || 'Whisper non disponibile.'), { codice: 'NON_PRONTO' });
    // La finestra audio di Whisper e di 30 s: per un comando breve basta una finestra proporzionale alla durata (circa 3 volte piu veloce).
    const ctx = this.contesto > 0 ? Math.min(1500, Math.ceil((durata * 50 * this.contesto) / 64) * 64) : 0;
    const campi = { response_format: 'verbose_json', temperature: '0', audio_ctx: String(ctx) };
    if (this.prompt) campi.prompt = this.prompt;       // vocabolario di partenza (nomi, sigle): vuoto per impostazione predefinita, si attiva dopo averlo misurato
    if (lingua && lingua !== this.lingua) campi.language = lingua;
    const t0 = Date.now();
    let j;
    try { j = await this._invia(wav, campi); }
    catch (e) {
      // una connessione chiusa dal server (succede dopo pause lunghe) si riprova una volta
      if (e.codice !== 'TIMEOUT' && /ECONNRESET|socket hang up|EPIPE/.test(e.message)) j = await this._invia(wav, campi);
      else throw e;
    }
    const latenzaMs = Date.now() - t0;
    const segmenti = Array.isArray(j.segments) ? j.segments : [];
    // Regola di riferimento di Whisper: un segmento con alta probabilita di "nessun parlato" e fiducia bassa e rumore, non parole.
    const validi = segmenti.filter(x => !((Number(x.no_speech_prob) || 0) > SOGLIA_NESSUN_PARLATO && (Number(x.avg_logprob) || 0) < -1));
    let testo = segmenti.length && !validi.length ? '' : pulisci(j.text);
    if (testo && this.prompt && ecoDelPrompt(testo, this.prompt)) testo = '';     // sul rumore Whisper a volte ripete il vocabolario che gli si e dato
    // Fiducia: media del logprob dei segmenti. Molto bassa = trascrizione inaffidabile (rumore, parole incomprensibili): non si invia nulla.
    const logprob = segmenti.length ? segmenti.reduce((s, x) => s + (Number(x.avg_logprob) || 0), 0) / segmenti.length : null;
    const inaffidabile = !!testo && logprob !== null && logprob < -1.2;
    this.trascrizioni++;
    this.ultima = { durataAudioS: +durata.toFixed(2), latenzaMs, rtf: +(latenzaMs / 1000 / durata).toFixed(2), contesto: ctx, caratteri: testo.length, inaffidabile };
    return { testo: inaffidabile ? '' : testo, vuoto: !testo || inaffidabile, motivo: !testo ? 'nessun parlato riconosciuto' : inaffidabile ? 'trascrizione poco affidabile' : null, lingua: j.language || null, logprob, durataAudioS: +durata.toFixed(2), latenzaMs, rtf: this.ultima.rtf };
  }

  // POST multipart con una connessione nuova ogni volta (whisper-server chiude le connessioni: niente keep-alive riusato male).
  _invia(wav, campi) {
    const confine = 'orbit' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const A = '\r\n';
    const parti = Object.entries(campi).map(([k, v]) => Buffer.from('--' + confine + A + 'Content-Disposition: form-data; name="' + k + '"' + A + A + v + A));
    parti.push(Buffer.from('--' + confine + A + 'Content-Disposition: form-data; name="file"; filename="comando.wav"' + A + 'Content-Type: audio/wav' + A + A), wav, Buffer.from(A + '--' + confine + '--' + A));
    const corpo = Buffer.concat(parti);
    return new Promise((ok, ko) => {
      const req = http.request({ host: '127.0.0.1', port: this.porta, path: '/inference', method: 'POST', agent: false, timeout: TIMEOUT_MS, headers: { 'Content-Type': 'multipart/form-data; boundary=' + confine, 'Content-Length': corpo.length, Connection: 'close' } }, res => {
        const dati = []; res.on('data', d => dati.push(d));
        res.on('end', () => { if (res.statusCode !== 200) return ko(Object.assign(new Error('Trascrizione non riuscita: risposta ' + res.statusCode), { codice: 'ERRORE' })); try { ok(JSON.parse(Buffer.concat(dati).toString('utf8'))); } catch (e) { ko(Object.assign(new Error('Trascrizione non riuscita: risposta non valida'), { codice: 'ERRORE' })); } });
      });
      req.on('timeout', () => { req.destroy(); ko(Object.assign(new Error('La trascrizione ha superato il tempo massimo.'), { codice: 'TIMEOUT' })); });
      req.on('error', e => ko(Object.assign(new Error('Trascrizione non riuscita: ' + e.message), { codice: 'ERRORE' })));
      req.end(corpo);
    });
  }

  ferma() { const p = this.proc; this.proc = null; this.pronto = false; this.avvio = null; if (p) { try { p.kill(); } catch (e) { /* gia chiuso */ } } if (this.dir) { try { fs.unlinkSync(path.join(this.dir, 'whisper.pid')); } catch (e) { /* non c'era */ } } }
}

module.exports = { WhisperSTT, MODELLI, pulisci, durataWav, ecoDelPrompt };
