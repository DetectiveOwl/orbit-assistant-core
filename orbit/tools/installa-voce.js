'use strict';
// Installa la voce locale di Orbit (Piper, gratuito e offline) in %LOCALAPPDATA%\Orbit\tts, FUORI dal vault.
// Scarica solo da fonti ufficiali: il programma da GitHub (rhasspy/piper) e la voce italiana da Hugging Face (rhasspy/piper-voices).
// Totale circa 86 MB. Uso: node tools/installa-voce.js   (ripeterlo non riscarica cio che c'e gia)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');

const PIPER_ZIP = { url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', nome: 'piper_windows_amd64.zip', byteAttesi: 22477236 };
const VOCE = {
  base: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/',
  file: [{ nome: 'it_IT-paola-medium.onnx', byteAttesi: 63511038 }, { nome: 'it_IT-paola-medium.onnx.json', byteAttesi: 7099 }]
};

async function scarica(url, dest, byteAttesi) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === byteAttesi) { console.log('Gia presente: ' + path.basename(dest)); return; }
  console.log('Scarico ' + path.basename(dest) + ' (' + (byteAttesi / 1048576).toFixed(1) + ' MB) da ' + new URL(url).host + ' ...');
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('Download non riuscito (' + r.status + '): ' + url);
  const tmp = dest + '.parziale';
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  const byte = fs.statSync(tmp).size;
  if (byte !== byteAttesi) { fs.rmSync(tmp, { force: true }); throw new Error('Dimensione inattesa per ' + path.basename(dest) + ': ' + byte + ' invece di ' + byteAttesi); }
  fs.renameSync(tmp, dest);
}

function estrai(zip, cartella) {
  // I percorsi passano da variabili d'ambiente: nessuna concatenazione in comandi.
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:ORBIT_ZIP -DestinationPath $env:ORBIT_DEST -Force'], { env: Object.assign({}, process.env, { ORBIT_ZIP: zip, ORBIT_DEST: cartella }) }, err => (err ? reject(err) : resolve())));
}

async function main() {
  const { settings } = config.carica();
  const dir = path.join(settings.dataDir, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  console.log('Cartella di installazione (fuori dal vault): ' + dir);
  await scarica(PIPER_ZIP.url, path.join(dir, PIPER_ZIP.nome), PIPER_ZIP.byteAttesi);
  if (!fs.existsSync(path.join(dir, 'piper', 'piper.exe'))) { console.log('Estraggo il programma ...'); await estrai(path.join(dir, PIPER_ZIP.nome), dir); }
  for (const f of VOCE.file) await scarica(VOCE.base + f.nome, path.join(dir, f.nome), f.byteAttesi);
  if (!fs.existsSync(path.join(dir, 'piper', 'piper.exe'))) throw new Error('piper.exe non trovato dopo l\'estrazione.');
  console.log('Fatto. Voce italiana installata: paola (medium). Riavvia Orbit.');
}
main().catch(e => { console.error('Installazione non riuscita: ' + e.message); process.exit(1); });
