'use strict';
// Diagnostica del riconoscimento vocale locale con i motori VERI installati (Whisper Small + Vosk). Non serve il microfono:
// usa WAV a 16 kHz passati come argomenti, oppure frasi italiane generate al momento con la voce locale Piper (se installata).
// Misura: caricamento del modello, attivazioni (e false attivazioni) della parola "Orbit", taglio del comando dopo la parola,
// latenza e rapporto tempo di elaborazione / durata dell'audio (RTF), CPU e memoria del processo Whisper, e uso in attesa.
// Uso: node orbit/tools/prova-stt.js [file.wav ...]          Nessun audio viene salvato: i file generati stanno in una cartella temporanea e si cancellano.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const config = require('../config');
const { WhisperSTT } = require('../voice/whisper');
const { ParolaVosk } = require('../voice/parola');

const FRASI = [
  { testo: 'Orbit, cosa devo fare oggi?', parola: true },
  { testo: 'Orbit', parola: true, solo: true },
  { testo: 'Orbit, quando è il parziale di analisi?', parola: true },
  { testo: 'Orbit, spiegami in modo semplice come si calcola il rango di una matrice con il metodo di Gauss e quali errori devo evitare durante il parziale di venerdì.', parola: true },
  { testo: 'Oggi ho studiato le orbite dei pianeti e poi sono andato in palestra.', parola: false },
  { testo: 'Domani pomeriggio vado a correre con Luca al parco.', parola: false }
];

function leggiWav(f) {
  const b = fs.readFileSync(f); let p = 12, rate = 0, canali = 1, dati = null;
  while (p + 8 <= b.length) { const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4); if (id === 'fmt ') { canali = b.readUInt16LE(p + 10); rate = b.readUInt32LE(p + 12); } if (id === 'data') { dati = b.subarray(p + 8, p + 8 + Math.min(n, b.length - p - 8)); break; } p += 8 + n + (n % 2); }
  const n = dati.length / 2 / canali, s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = dati.readInt16LE(i * 2 * canali) / 32768;
  const m = Math.round(n * 16000 / rate), o = new Int16Array(m);
  for (let i = 0; i < m; i++) { const x = i * rate / 16000, j = Math.floor(x), f = x - j; o[i] = Math.round(((s[j] || 0) * (1 - f) + (s[j + 1] || 0) * f) * 32767); }
  return o;
}
function wav(pcm) { const b = Buffer.alloc(44 + pcm.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40); Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2).copy(b, 44); return b; }
const conSilenzio = (pcm, primaS, dopoS) => { const o = new Int16Array(Math.round(primaS * 16000) + pcm.length + Math.round(dopoS * 16000)); o.set(pcm, Math.round(primaS * 16000)); return o; };

function processo(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$p = Get-Process -Id $env:ORBIT_PID; "{0} {1}" -f $p.TotalProcessorTime.TotalMilliseconds, $p.WorkingSet64'], { encoding: 'utf8', env: Object.assign({}, process.env, { ORBIT_PID: String(pid) }), windowsHide: true }).trim().split(/\s+/);
    return { cpuMs: Math.round(Number(out[0].replace(',', '.'))), ramMB: Math.round(Number(out[1]) / 1048576) };
  } catch (e) { return null; }
}

async function main() {
  const { settings } = config.carica();
  const stt = settings.stt;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-prova-stt-'));
  try {
    let campioni = [];
    const argWav = process.argv.slice(2).filter(f => /\.wav$/i.test(f));
    if (argWav.length) campioni = argWav.map(f => ({ nome: path.basename(f), testo: null, parola: null, pcm: leggiWav(f) }));
    else {
      const piper = path.join(settings.dataDir, 'tts', 'piper', 'piper.exe'), voceTts = path.join(settings.dataDir, 'tts', 'it_IT-paola-medium.onnx');
      if (!fs.existsSync(piper)) throw new Error('Passa dei file WAV oppure installa la voce locale (node orbit/tools/installa-voce.js) per generare le frasi di prova.');
      for (const [i, f] of FRASI.entries()) {
        const out = path.join(tmp, 'f' + i + '.wav');
        await new Promise((ok, ko) => { const p = execFile(piper, ['--model', voceTts, '--output_file', out], { windowsHide: true }, e => (e ? ko(e) : ok())); p.stdin.end(f.testo); });
        campioni.push(Object.assign({ nome: 'frase ' + (i + 1), pcm: leggiWav(out) }, f));
      }
      campioni.push({ nome: 'silenzio 3 s', testo: '', parola: false, pcm: new Int16Array(48000) });
      const rumore = new Int16Array(48000); for (let i = 0; i < rumore.length; i++) rumore[i] = Math.round((Math.random() * 2 - 1) * 900); campioni.push({ nome: 'rumore 3 s', testo: '', parola: false, pcm: rumore });
    }

    const w = new WhisperSTT({ dir: stt.dir, modello: stt.modello, lingua: stt.lingua, thread: stt.thread, contesto: stt.contesto, prompt: stt.prompt });
    const v = new ParolaVosk({ dir: stt.dir, parole: stt.paroleAttivazione, varianti: stt.varianti });
    console.log('Modello: ' + w.info.nome + ' | thread ' + stt.thread + ' | finestra x' + stt.contesto + ' | lingua ' + stt.lingua + ' | CPU ' + os.cpus()[0].model + ' (' + os.cpus().length + ' thread logici)');
    let t0 = Date.now(); if (!(await w.avvia())) throw new Error(w.stato().errore);
    console.log('Whisper caricato in ' + (Date.now() - t0) + ' ms; memoria ' + JSON.stringify(processo(w.proc.pid)));
    t0 = Date.now(); if (!(await v.avvia())) throw new Error(v.stato().errore);
    console.log('Vosk (parola "' + stt.paroleAttivazione.join('/') + '") caricato in ' + (Date.now() - t0) + ' ms');

    // In attesa della parola Whisper non lavora: CPU del processo prima e dopo 5 s di sola parola di attivazione
    const primaAttesa = processo(w.proc.pid);
    const tAttesa = Date.now(); await v.azzera();
    for (let i = 0; i < 20; i++) await v.analizza(Buffer.from(conSilenzio(new Int16Array(0), 0.25, 0).buffer));
    const dopoAttesa = processo(w.proc.pid);
    console.log('In attesa (' + (Date.now() - tAttesa) + ' ms di pacchetti a Vosk): CPU di Whisper +' + (dopoAttesa && primaAttesa ? dopoAttesa.cpuMs - primaAttesa.cpuMs : '?') + ' ms');

    const righe = [];
    for (const c of campioni) {
      const flusso = conSilenzio(c.pcm, 0.3, 1.0);
      await v.azzera();
      let fine = null; const tv = Date.now();
      for (let i = 0; i < flusso.length && fine === null; i += 4000) { const r = await v.analizza(Buffer.from(flusso.slice(i, i + 4000).buffer)); if (r.attivata) fine = r.fine; }
      const msVosk = Date.now() - tv;
      const margine = Number(process.env.ORBIT_PROVA_MARGINE || 0.2);   // come in public/voice.js: l'audio del comando parte poco prima della fine della parola
      const comando = fine !== null ? flusso.slice(Math.max(0, Math.round((fine - margine) * 16000))) : flusso;
      const cpu0 = processo(w.proc.pid);
      const r = await w.trascrivi(wav(comando));
      const cpu1 = processo(w.proc.pid);
      righe.push({ campione: c.nome, atteso: c.testo, parolaAttesa: c.parola, parolaRilevata: fine !== null, fineParolaS: fine, msVosk, audioComandoS: r.durataAudioS, latenzaMs: r.latenzaMs, rtf: r.rtf, cpuWhisperMs: cpu0 && cpu1 ? cpu1.cpuMs - cpu0.cpuMs : null, ramMB: cpu1 && cpu1.ramMB, testo: r.testo, vuoto: r.vuoto, motivo: r.motivo });
      console.log((fine !== null ? '[ORBIT] ' : '[ -   ] ') + c.nome.padEnd(14) + ' audio ' + String(r.durataAudioS).padEnd(5) + ' s  latenza ' + String(r.latenzaMs).padStart(5) + ' ms  RTF ' + r.rtf + '  -> ' + JSON.stringify(r.testo) + (r.vuoto ? ' (vuoto: ' + r.motivo + ')' : ''));
    }
    const ok = righe.filter(x => x.parolaAttesa !== null && x.parolaAttesa === x.parolaRilevata).length, tot = righe.filter(x => x.parolaAttesa !== null).length;
    const lat = righe.filter(x => !x.vuoto && x.audioComandoS > 0);
    console.log('\nParola di attivazione corretta in ' + ok + ' casi su ' + tot + '. Latenza media ' + Math.round(lat.reduce((s, x) => s + x.latenzaMs, 0) / Math.max(1, lat.length)) + ' ms, RTF medio ' + (lat.reduce((s, x) => s + x.rtf, 0) / Math.max(1, lat.length)).toFixed(2) + '.');
    if (process.argv.includes('--json')) console.log(JSON.stringify(righe, null, 1));
    w.ferma(); v.ferma();
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gia rimossa */ } }
}
main().catch(e => { console.error('Prova non riuscita: ' + e.message); process.exit(1); });
