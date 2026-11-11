'use strict';
// Integrita degli script del bridge Windows (windows/cli-host.ps1, Handles.cs, Engine.cs).
// Origine di fiducia: windows/MANIFEST.sha256 nel repository, accanto agli script, piu un pin OBBLIGATORIO dell'host (env, fuori dal repo) per avviare il bridge.
// Il manifest non contiene hash nel codice: si rigenera con `node smart-inbox/integrita.js --scrivi` e il test lo confronta con i file.
// Non protegge da chi puo riscrivere insieme script, manifest e codice host (stessi privilegi): vedi docs/smart-inbox-ts6b.md.
const fs = require('node:fs'), path = require('node:path');
const { sha, errore } = require('./policy');

const MANIFEST = 'MANIFEST.sha256';
const PIN_ENV = 'SMART_INBOX_SCRIPT_MANIFEST_SHA256';
const PIN = /^[0-9a-f]{64}$/i;
const DIR = path.join(__dirname, 'windows');
const RICHIESTI = ['cli-host.ps1', 'Handles.cs', 'Engine.cs'];
const RIGA = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
// Hash sul contenuto con fine riga LF: gli script sono testo e Git/autocrlf puo cambiare CRLF/LF tra checkout senza cambiare il programma.
// I byte eseguiti sono esattamente quelli normalizzati e verificati (vedi copiaVerificata).
const normalizza = buf => Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

function leggiManifest(testo) {
  const voci = new Map();
  for (const riga of testo.split('\n').filter(r => r.trim() !== '')) {
    const m = RIGA.exec(riga.replace(/\r$/, ''));
    if (!m || m[2] === MANIFEST || voci.has(m[2])) throw errore('MANIFEST_BRIDGE_NON_VALIDO');
    voci.set(m[2], m[1]);
  }
  if (RICHIESTI.some(n => !voci.has(n))) throw errore('MANIFEST_BRIDGE_NON_VALIDO');
  return voci;
}

// Ritorna Map nome -> byte verificati. I nomi vengono SOLO dal manifest, mai da input del modello o della richiesta.
// pin: sha256 del manifest (normalizzato) deciso dall'host, indipendente dal repository; se presente deve coincidere.
// obbligatorio: senza pin valido nessuno script viene accettato (e quindi nessuna scrittura: il bridge non parte).
function verificaScript({ dir = DIR, pin = null, obbligatorio = false } = {}) {
  if (obbligatorio && !pin) throw errore('MANIFEST_BRIDGE_PIN_MANCANTE');
  if (pin && !PIN.test(String(pin))) throw errore('MANIFEST_BRIDGE_PIN_NON_VALIDO');
  let grezzo;
  try { grezzo = normalizza(fs.readFileSync(path.join(dir, MANIFEST))); } catch { throw errore('MANIFEST_BRIDGE_ASSENTE'); }
  if (pin && sha(grezzo) !== String(pin).toLowerCase()) throw errore('MANIFEST_BRIDGE_PIN_DIVERSO');
  const voci = leggiManifest(grezzo.toString('utf8'));
  const presenti = fs.readdirSync(dir, { withFileTypes: true });
  // Niente file in piu (un .cs/.ps1 non elencato), cartelle, collegamenti o file mancanti.
  if (presenti.some(e => e.name !== MANIFEST && (!e.isFile() || !voci.has(e.name))) || [...voci.keys()].some(n => !presenti.some(e => e.name === n && e.isFile()))) throw errore('SCRIPT_BRIDGE_NON_VERIFICATI');
  const byte = new Map();
  for (const [nome, atteso] of voci) {
    const contenuto = normalizza(fs.readFileSync(path.join(dir, nome)));
    if (sha(contenuto) !== atteso) throw errore('SCRIPT_BRIDGE_NON_VERIFICATI');
    byte.set(nome, contenuto);
  }
  return byte;
}

// Scrive i byte verificati in una cartella nuova (esclusiva) e ne ritorna hash e percorso: il bridge parte da questa copia, non dal repo,
// cosi non c'e finestra tra verifica e uso. Lo script ricontrolla gli .cs prima di Add-Type con gli hash passati dal chiamante.
function copiaVerificata(byte, dest) {
  fs.mkdirSync(dest, { recursive: false });
  for (const [nome, contenuto] of byte) fs.writeFileSync(path.join(dest, nome), contenuto, { flag: 'wx' });
  return { dir: dest, hashCs: ['Handles.cs', 'Engine.cs'].map(n => n + '=' + sha(byte.get(n))).join(';') };
}

function scriviManifest(dir = DIR) {
  const nomi = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name !== MANIFEST).map(e => e.name).sort();
  fs.writeFileSync(path.join(dir, MANIFEST), nomi.map(n => sha(normalizza(fs.readFileSync(path.join(dir, n)))) + '  ' + n).join('\n') + '\n');
  return nomi;
}

module.exports = { MANIFEST, PIN_ENV, verificaScript, copiaVerificata, scriviManifest, normalizza };
if (require.main === module) {
  if (process.argv[2] === '--pin') process.stdout.write(sha(normalizza(fs.readFileSync(path.join(DIR, MANIFEST)))) + '\n');   // da rivedere e impostare in SMART_INBOX_SCRIPT_MANIFEST_SHA256 dall'host
  else if (process.argv[2] === '--scrivi') process.stdout.write('manifest scritto per: ' + scriviManifest().join(', ') + '\n');
  else { verificaScript(); process.stdout.write('script del bridge conformi al manifest\n'); }
}
