'use strict';
// Protocollo di voice/vosk_parola.py con una libreria "vosk" FINTA (nessun modello vero, nessun audio): verifica il conteggio dei campioni,
// il ripiego quando il risultato finale non conferma «Orbit» e le grafie alternative valide solo a inizio frase.
// Serve Python 3: se manca il test e saltato (e risulta come saltato, non come superato).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'voice', 'vosk_parola.py');
const PY = ['python3', 'python'].find(c => { const r = spawnSync(c, ['--version']); return !r.error && r.status === 0; });
const STUB = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-vosk-finto-'));
// Il primo campione di ogni pacchetto decide cosa "sente" il riconoscitore finto.
fs.writeFileSync(path.join(STUB, 'vosk.py'), `
import json, struct
def SetLogLevel(n): pass
class Model:
    def __init__(self, percorso): pass
PARZIALI = {12345: 'orbit', 12346: 'orbit', 12347: 'orbit', 22222: 'orbita che gira', 22223: 'la orbita'}
FINALI = {12345: [('orbit', 0.5)], 12346: [('orbita', 0.7)], 12347: [], 22222: [('orbita', 0.6), ('che', 0.9)], 22223: [('la', 0.3), ('orbita', 0.6)]}
class KaldiRecognizer:
    def __init__(self, modello, frequenza): self.codice = 0
    def SetWords(self, v): pass
    def AcceptWaveform(self, dati):
        self.codice = struct.unpack('<h', dati[:2])[0] if len(dati) >= 2 else 0
        return self.codice == 3000
    def Result(self): return json.dumps({'result': [{'word': 'orbit', 'start': 0.4, 'end': 0.9}]})
    def PartialResult(self): return json.dumps({'partial': PARZIALI.get(self.codice, '')})
    def FinalResult(self): return json.dumps({'result': [{'word': w, 'start': 0, 'end': e} for w, e in FINALI.get(self.codice, [])]})
`);

function avvia(varianti) {
  const p = spawn(PY, [SCRIPT, 'modello-finto', JSON.stringify(['orbit']), JSON.stringify(varianti)], { env: Object.assign({}, process.env, { PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }), stdio: ['pipe', 'pipe', 'ignore'] });
  const righe = [], attese = []; let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const a = attese.shift(); if (a) a(r); else righe.push(r); } });
  const prossima = () => new Promise(ok => { const r = righe.shift(); if (r) ok(r); else attese.push(ok); });
  const manda = (tipo, dati = Buffer.alloc(0)) => { const h = Buffer.alloc(5); h.write(tipo, 0, 'ascii'); h.writeUInt32LE(dati.length, 1); p.stdin.write(Buffer.concat([h, dati])); return prossima(); };
  const pacchetto = (codice, byte = 8000) => { const b = Buffer.alloc(byte); b.writeInt16LE(codice, 0); return manda('A', b); };
  return { prossima, manda, pacchetto, ferma: () => { p.stdin.end(); p.kill(); } };
}

test('vosk_parola.py: conta i campioni, riparte da zero all\'azzeramento, conferma «orbit» dal risultato parziale o finale', { skip: !PY && 'Python non trovato' }, async () => {
  const v = avvia([]);
  try {
    assert.deepEqual(await v.prossima(), { pronto: true });
    assert.deepEqual(await v.pacchetto(100), { attivata: false, campioni: 4000 });
    assert.deepEqual(await v.pacchetto(100), { attivata: false, campioni: 8000 });
    assert.deepEqual(await v.manda('R'), { azzerato: true });
    assert.deepEqual(await v.pacchetto(12345), { attivata: true, fine: 0.5, campioni: 4000 });         // parziale e finale concordano
    assert.deepEqual(await v.pacchetto(3000), { attivata: true, fine: 0.9, campioni: 8000 });          // enunciato chiuso dal riconoscitore
    await v.manda('R');
    // il finale non conferma la parola (il riconoscitore si e gia azzerato): ci si fida del parziale, senza perdere l'attivazione
    assert.deepEqual(await v.pacchetto(12346), { attivata: true, fine: 0.7, campioni: 4000 });
    await v.manda('R');
    assert.deepEqual(await v.pacchetto(12347), { attivata: true, fine: 0.25, campioni: 4000 });        // nessuna parola nel finale: fine dell'audio ricevuto
    // senza varianti configurate, «orbita» non attiva nulla
    assert.equal((await v.pacchetto(22222)).attivata, false);
  } finally { v.ferma(); }
});

test('vosk_parola.py: le varianti valgono solo come prima parola della frase (parlare di orbite non attiva Orbit)', { skip: !PY && 'Python non trovato' }, async () => {
  const v = avvia(['orbita']);
  try {
    await v.prossima();
    assert.deepEqual(await v.pacchetto(22222), { attivata: true, fine: 0.6, campioni: 4000 });         // «orbita che gira...»: prima parola
    await v.manda('R');
    assert.deepEqual(await v.pacchetto(22223), { attivata: false, campioni: 4000 });                   // «la orbita»: non e a inizio frase
  } finally { v.ferma(); }
});

test.after(() => { try { fs.rmSync(STUB, { recursive: true, force: true }); } catch (e) { /* in chiusura */ } });
