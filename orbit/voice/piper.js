'use strict';
// Sintesi vocale locale con Piper (gratuito, offline, nessun servizio e nessuna chiave). Installato da tools/installa-voce.js in
// %LOCALAPPDATA%\Orbit\tts, fuori dal vault. Un unico processo Piper resta acceso mentre serve (evita 1-2 secondi di caricamento a ogni frase)
// e viene spento dopo 5 minuti di inattivita. Nessun audio resta su disco: il file temporaneo si cancella appena letto.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const MAX_CARATTERI = 700;
const TIMEOUT_MS = 30000;
const SPEGNI_DOPO_MS = 5 * 60 * 1000;

class PiperTTS {
  // exe/binArgs/modello iniettabili nei test (un falso Piper).
  constructor({ dir, exe, binArgs = [], modello, nomeVoce = 'Paola (Piper, locale)' }) {
    this.dir = dir;
    this.exe = exe || (dir && path.join(dir, 'piper', IS_WIN ? 'piper.exe' : 'piper'));
    this.binArgs = binArgs;
    this.modello = modello || (dir && path.join(dir, 'it_IT-paola-medium.onnx'));
    this.nomeVoce = nomeVoce;
    this.cartellaOut = null;
    this.proc = null; this.pendenti = []; this.buf = ''; this.coda = Promise.resolve(); this.timerSpegni = null;
    this.lsCorrente = 1;                                  // length_scale del processo acceso: 1 = velocita normale, minore = piu veloce
  }

  disponibile() { return !!(this.exe && this.modello && fs.existsSync(this.exe) && fs.existsSync(this.modello)); }
  stato() { return { disponibile: this.disponibile(), voce: this.nomeVoce, motore: 'Piper (locale, offline)' }; }

  _avvia() {
    if (this.proc) return;
    this.cartellaOut = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tts-'));
    const args = this.binArgs.concat(['--model', this.modello, '--json-input', '--output_dir', this.cartellaOut, '--length_scale', String(this.lsCorrente)]);
    const p = spawn(this.exe, args, { cwd: path.dirname(this.exe), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = p; this.buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const riga = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        const attesa = this.pendenti.shift();
        if (attesa && riga) attesa.risolvi(riga);
      }
    });
    const cade = motivo => {
      if (this.proc !== p) return;
      this.proc = null;
      for (const a of this.pendenti.splice(0)) a.rifiuta(new Error(motivo));
      try { fs.rmSync(this.cartellaOut, { recursive: true, force: true }); } catch (e) { /* gia rimossa */ }
    };
    p.on('error', e => cade('Piper non si avvia: ' + e.message));
    p.on('close', () => cade('Piper si e fermato'));
    p.stdin.on('error', () => { /* gestito da close */ });
  }

  // Avvia Piper in anticipo (carica il modello) cosi la prima frase non aspetta; si spegne da solo dopo 5 minuti di inattivita.
  scalda() {
    if (!this.disponibile() || this.proc) return;
    this._avvia();
    clearTimeout(this.timerSpegni);
    this.timerSpegni = setTimeout(() => this._spegni(), SPEGNI_DOPO_MS);
    if (this.timerSpegni.unref) this.timerSpegni.unref();
  }

  _spegni() {
    clearTimeout(this.timerSpegni); this.timerSpegni = null;
    const p = this.proc; if (!p) return;
    this.proc = null;
    try { p.stdin.end(); } catch (e) { /* gia chiuso */ }
    setTimeout(() => { try { if (IS_WIN) execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {}); else p.kill('SIGKILL'); } catch (e) { /* gia terminato */ } }, 1500);
    const d = this.cartellaOut; setTimeout(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ok */ } }, 2000);
  }

  // Restituisce un Buffer WAV. Le richieste vengono serializzate: Piper elabora una frase alla volta.
  // velocita: 1 normale, 1.2 piu veloce... Piper la applica nativamente (length_scale), senza gli artefatti dell'allungamento dell'audio.
  sintetizza(testo, { velocita = 1 } = {}) {
    const ls = Math.round(Math.min(1.3, Math.max(0.65, 1 / (Number(velocita) || 1))) * 100) / 100;
    const pulito = String(testo || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CARATTERI);
    if (!pulito) return Promise.reject(new Error('Testo vuoto.'));
    if (!this.disponibile()) return Promise.reject(new Error('La voce locale non e installata: esegui node orbit/tools/installa-voce.js'));
    const lavoro = () => new Promise((resolve, reject) => {
      if (this.proc && ls !== this.lsCorrente) this._spegni();      // la velocita cambia di rado: si riavvia con il nuovo valore
      this.lsCorrente = ls;
      this._avvia();
      clearTimeout(this.timerSpegni);
      const timer = setTimeout(() => { reject(new Error('Piper non ha risposto in tempo.')); this._spegni(); }, TIMEOUT_MS);
      this.pendenti.push({
        risolvi: file => {
          clearTimeout(timer);
          this.timerSpegni = setTimeout(() => this._spegni(), SPEGNI_DOPO_MS);
          if (this.timerSpegni.unref) this.timerSpegni.unref();
          try {
            const fileSicuro = path.resolve(file);
            if (path.dirname(fileSicuro) !== path.resolve(this.cartellaOut)) throw new Error('Percorso audio inatteso.');
            const wav = fs.readFileSync(fileSicuro);
            fs.rmSync(fileSicuro, { force: true });               // nessun audio resta su disco
            resolve(wav);
          } catch (e) { reject(e); }
        },
        rifiuta: e => { clearTimeout(timer); reject(e); }
      });
      try { this.proc.stdin.write(JSON.stringify({ text: pulito }) + '\n'); } catch (e) { reject(e); }
    });
    const r = this.coda.then(lavoro, lavoro);
    this.coda = r.catch(() => {});
    return r;
  }

  chiudi() { this._spegni(); }
}

module.exports = { PiperTTS, MAX_CARATTERI };
