'use strict';
// Parola di attivazione "Orbit" in locale: Vosk (modello piccolo italiano) in un processo Python figlio, separato da Whisper.
// E leggero (circa un decimo del tempo reale su questo PC) e non manda nulla in rete. L'audio arriva a pacchetti dal browser solo
// quando c'e un suono (il browser fa da filtro sul silenzio) e non viene salvato. Il processo si spegne dopo 10 minuti senza audio
// ed esce da solo se Orbit si chiude (stdin chiuso).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const MODELLO_VOSK = 'vosk-model-small-it-0.22';
const SPEGNI_DOPO_MS = 10 * 60 * 1000;
const RISPOSTA_MAX_MS = 5000;

class ParolaVosk {
  // python e script iniettabili nei test.
  constructor({ dir, parole = ['orbit'], varianti = [], python, script, modello, rispostaMaxMs = RISPOSTA_MAX_MS, log = null }) {
    this.dir = dir;
    this.parole = parole;
    this.varianti = varianti; this.rispostaMaxMs = rispostaMaxMs;
    this.python = python || (dir && path.join(dir, 'venv', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python'));
    this.script = script || path.join(__dirname, 'vosk_parola.py');
    this.modello = modello || (dir && path.join(dir, 'vosk', MODELLO_VOSK));
    this.log = log;
    this.proc = null; this.avvio = null; this.pronto = false; this.errore = null; this.attese = []; this.buf = ''; this.timer = null;
    this.pacchetti = 0; this.attivazioni = 0;
  }

  disponibile() { return !!(this.python && this.modello && fs.existsSync(this.python) && fs.existsSync(this.modello) && fs.existsSync(this.script)); }
  stato() { return { motore: 'Vosk (' + MODELLO_VOSK + ')', parole: this.parole, varianti: this.varianti, disponibile: this.disponibile(), pronto: this.pronto, caricamento: !!this.avvio && !this.pronto, errore: this.errore, pacchetti: this.pacchetti, attivazioni: this.attivazioni }; }

  avvia() {
    if (this.pronto) return Promise.resolve(true);
    if (this.avvio) return this.avvio;
    if (!this.disponibile()) { this.errore = 'Parola di attivazione locale non installata: esegui node orbit/tools/installa-stt.js'; return Promise.resolve(false); }
    this.errore = null;
    this.avvio = new Promise(risolvi => {
      const p = spawn(this.python, [this.script, this.modello, JSON.stringify(this.parole), JSON.stringify(this.varianti)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }) });
      this.proc = p; this.buf = '';
      const chiudi = () => { try { p.kill(); } catch (e) { /* gia chiuso */ } };
      process.once('exit', chiudi);
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', d => {
        this.buf += d; let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const riga = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
          if (!riga) continue;
          let j; try { j = JSON.parse(riga); } catch (e) { continue; }
          if (j.pronto) { this.pronto = true; risolvi(true); continue; }
          if (j.errore && !this.pronto) { this.errore = j.errore; risolvi(false); continue; }
          const a = this.attese.shift(); if (a) a.ok(j);
        }
      });
      p.stdin.on('error', () => { /* gestito da exit */ });
      p.on('error', e => { this.errore = 'Python non si avvia: ' + e.message; risolvi(false); });
      p.on('exit', () => {
        process.removeListener('exit', chiudi);
        if (this.proc !== p) return;
        this.proc = null; this.pronto = false; this.avvio = null;
        for (const a of this.attese.splice(0)) a.ko(new Error('Il riconoscimento della parola si e fermato.'));
        risolvi(false);
      });
    }).then(ok => { if (!ok) this.avvio = null; else if (this.log) this.log.info('Parola di attivazione locale pronta (' + this.parole.join(', ') + ')'); return ok; });
    return this.avvio;
  }

  _manda(tipo, dati = Buffer.alloc(0)) {
    return new Promise((ok, ko) => {
      const testa = Buffer.alloc(5); testa.write(tipo, 0, 'ascii'); testa.writeUInt32LE(dati.length, 1);
      // senza risposta in tempo il processo si riavvia: una risposta tardiva verrebbe attribuita alla richiesta successiva (le risposte arrivano in ordine)
      const t = setTimeout(() => { const i = this.attese.findIndex(a => a.ok === fine); if (i >= 0) this.attese.splice(i, 1); ko(new Error('Il riconoscimento della parola non risponde.')); this.ferma(); }, this.rispostaMaxMs);
      const fine = j => { clearTimeout(t); ok(j); };
      this.attese.push({ ok: fine, ko: e => { clearTimeout(t); ko(e); } });
      this.proc.stdin.write(Buffer.concat([testa, dati]));
    });
  }
  _rinviaSpegnimento() { clearTimeout(this.timer); this.timer = setTimeout(() => this.ferma(), SPEGNI_DOPO_MS); if (this.timer.unref) this.timer.unref(); }

  // pcm: Int16 mono 16 kHz. Restituisce { attivata, fine } (fine in secondi dall'ultimo azzeramento).
  async analizza(pcm) {
    if (!(await this.avvia())) throw Object.assign(new Error(this.errore || 'Parola di attivazione non disponibile.'), { codice: 'NON_PRONTO' });
    this._rinviaSpegnimento();
    this.pacchetti++;
    const r = await this._manda('A', pcm);
    if (r.attivata) this.attivazioni++;
    return { attivata: !!r.attivata, fine: r.attivata ? r.fine : null, campioni: typeof r.campioni === 'number' ? r.campioni : null };
  }
  async azzera() { if (!this.pronto) return; await this._manda('R'); }
  ferma() {
    clearTimeout(this.timer); const p = this.proc; this.proc = null; this.pronto = false; this.avvio = null;
    for (const a of this.attese.splice(0)) a.ko(new Error('Il riconoscimento della parola si e fermato.'));
    if (p) { try { p.stdin.end(); p.kill(); } catch (e) { /* gia chiuso */ } }
  }
}

module.exports = { ParolaVosk, MODELLO_VOSK };
