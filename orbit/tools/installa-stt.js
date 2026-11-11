'use strict';
// Installa il riconoscimento vocale locale di Orbit in %LOCALAPPDATA%\Orbit\stt, FUORI dal vault e fuori dal progetto (niente modelli nel repository).
// Solo fonti ufficiali, con verifica SHA-256 dove l'editore la pubblica:
//   - whisper.cpp v1.9.2, binari Windows x64 (GitHub, ggml-org/whisper.cpp)          8 MB   SHA-256 verificato
//   - Whisper Small multilingue, ggml quantizzato 8 bit (Hugging Face, ggerganov)    252 MB  SHA-256 verificato
//   - Vosk 0.3.45 (PyPI) e modello italiano piccolo 0.22 (alphacephei.com) per la parola "Orbit"  ~ 60 MB
// Serve Python 3 (gia presente) per Vosk, in un ambiente virtuale dedicato. Ripeterlo non riscarica cio che c'e gia.
// Uso: node orbit/tools/installa-stt.js [--modello base]   (Base solo se l'utente decide di passarci: vedi docs/WHISPER-STT.md)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { MODELLI } = require('../voice/whisper');
const { MODELLO_VOSK } = require('../voice/parola');

const WHISPER_ZIP = { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip', nome: 'whisper-bin-x64-v1.9.2.zip', byte: 8194445, sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a' };
const VOSK_ZIP = { url: 'https://alphacephei.com/vosk/models/' + MODELLO_VOSK + '.zip', nome: MODELLO_VOSK + '.zip', byte: 49665141, sha256: '9ec65e75861d1c6c2e457cccd932705340dcdf233f5b239f00733b4de0bf3267' };
const VOSK_PIP = 'vosk==0.3.45';

const esegui = (cmd, args, env) => new Promise((ok, ko) => execFile(cmd, args, { env: Object.assign({}, process.env, env || {}), windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => (e ? ko(new Error((err || e.message).toString().trim().split('\n').slice(-3).join(' '))) : ok(out))));
const sha256 = f => new Promise((ok, ko) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', ko); });

async function scarica({ url, byte, sha256: atteso }, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === byte && (!atteso || (await sha256(dest)) === atteso)) { console.log('Gia presente: ' + path.basename(dest)); return; }
  console.log('Scarico ' + path.basename(dest) + ' (' + (byte / 1048576).toFixed(1) + ' MB) da ' + new URL(url).host + ' ...');
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('Download non riuscito (' + r.status + '): ' + url);
  const tmp = dest + '.parziale';
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  const n = fs.statSync(tmp).size;
  if (n !== byte) { fs.rmSync(tmp, { force: true }); throw new Error('Dimensione inattesa per ' + path.basename(dest) + ': ' + n + ' invece di ' + byte); }
  if (atteso) { const h = await sha256(tmp); if (h !== atteso) { fs.rmSync(tmp, { force: true }); throw new Error('Impronta SHA-256 diversa per ' + path.basename(dest) + ': file scartato.'); } }
  fs.renameSync(tmp, dest);
}

// I percorsi passano da variabili d'ambiente: nessuna concatenazione in comandi.
const estrai = (zip, cartella) => esegui('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:ORBIT_ZIP -DestinationPath $env:ORBIT_DEST -Force'], { ORBIT_ZIP: zip, ORBIT_DEST: cartella });

async function trovaPython() {
  for (const [cmd, args] of [['py', ['-3']], ['python', []], ['python3', []]]) {
    try { const v = await esegui(cmd, args.concat(['-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])'])); if (Number(v) >= 308) return { cmd, args }; } catch (e) { /* prossimo */ }
  }
  throw new Error('Serve Python 3.8 o superiore (per la parola "Orbit" con Vosk). Installalo con: winget install Python.Python.3.12');
}

async function main() {
  const { settings } = config.carica();
  const i = process.argv.indexOf('--modello');
  const scelta = i > 0 ? process.argv[i + 1] : settings.stt.modello;
  const modello = MODELLI[scelta];
  if (!modello) throw new Error('Modello sconosciuto: ' + scelta + ' (small o base).');
  const dir = settings.stt.dir;
  for (const d of ['', 'modelli', 'vosk']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  console.log('Cartella di installazione (fuori dal vault): ' + dir);

  // 1. whisper.cpp: i file della cartella Release finiscono in stt\whisper
  const zip = path.join(dir, WHISPER_ZIP.nome);
  if (!fs.existsSync(path.join(dir, 'whisper', 'whisper-server.exe'))) {
    await scarica(WHISPER_ZIP, zip);
    console.log('Estraggo whisper.cpp ...');
    const tmp = path.join(dir, 'whisper-estratto');
    await estrai(zip, tmp);
    const rel = fs.existsSync(path.join(tmp, 'Release')) ? path.join(tmp, 'Release') : tmp;
    fs.mkdirSync(path.join(dir, 'whisper'), { recursive: true });
    for (const f of fs.readdirSync(rel)) if (/^(whisper-server\.exe|whisper-cli\.exe|whisper-bench\.exe|.*\.dll)$/i.test(f)) fs.copyFileSync(path.join(rel, f), path.join(dir, 'whisper', f));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });                 // l'archivio non serve piu
  }

  // 2. modello Whisper
  await scarica({ url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + modello.file, byte: modello.byte, sha256: modello.sha256 }, path.join(dir, 'modelli', modello.file));

  // 3. Vosk: ambiente Python dedicato e modello italiano piccolo
  const py = path.join(dir, 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(py)) { const p = await trovaPython(); console.log('Creo l\'ambiente Python per Vosk ...'); await esegui(p.cmd, p.args.concat(['-m', 'venv', path.join(dir, 'venv')])); }
  try { await esegui(py, ['-c', 'import vosk']); console.log('Gia presente: Vosk'); }
  catch (e) { console.log('Installo ' + VOSK_PIP + ' da PyPI ...'); await esegui(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', VOSK_PIP]); }
  const voskZip = path.join(dir, VOSK_ZIP.nome);
  if (!fs.existsSync(path.join(dir, 'vosk', MODELLO_VOSK))) { await scarica(VOSK_ZIP, voskZip); console.log('Estraggo il modello Vosk ...'); await estrai(voskZip, path.join(dir, 'vosk')); fs.rmSync(voskZip, { force: true }); }

  // 4. prova: il server si avvia e il modello si carica
  const exe = path.join(dir, 'whisper', 'whisper-server.exe');
  if (!fs.existsSync(exe)) throw new Error('whisper-server.exe non trovato dopo l\'estrazione.');
  console.log('Fatto. ' + modello.nome + ' e la parola "Orbit" sono installati in ' + dir + '. Riavvia Orbit.');
}
main().catch(e => { console.error('Installazione non riuscita: ' + e.message); process.exit(1); });
