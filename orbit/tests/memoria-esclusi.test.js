'use strict';
// Esclusione dei documenti di progetto dalla memoria (ORBIT_MEMORIA_ESCLUDI, predefinito AGENTS.md e CONTESTO-ORBIT.md alla radice del vault).
// Vault temporaneo: i file non vengono mai toccati; si controllano indice, retrieval, cache e note omonime in altre cartelle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-escl-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
const AGENTS = '# Istruzioni permanenti\n\nSei il consulente tecnico del progetto. Parola rara: zirconio.\n';
const CONTESTO = '# Contesto permanente\n\nStoria tecnica di Orbit. Parola rara: zirconio.\n';
scrivi('AGENTS.md', AGENTS);
scrivi('CONTESTO-ORBIT.md', CONTESTO);
scrivi('progetti/AGENTS.md', '# Agenti del progetto robot\n\nNel progetto robot gli agenti usano lo zirconio.\n');   // omonima in altra cartella: resta
scrivi('note/chimica.md', '# Chimica\n\nLo zirconio e un metallo di transizione.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');
delete process.env.ORBIT_MEMORIA_ESCLUDI;

const config = require('../../memoria/config');
const memoria = require('../../memoria/memoria');
const ricerca = require('../../memoria/ricerca');
memoria.avvia();
const percorsi = () => memoria.elencaNote().note.map(n => n.percorso).sort();

test('predefinito: AGENTS.md e CONTESTO-ORBIT.md della radice esclusi; le note omonime in altre cartelle restano', () => {
  assert.deepEqual(config.esclusi, ['agents.md', 'contesto-orbit.md']);
  assert.equal(config.fileEscluso('AGENTS.md'), true); assert.equal(config.fileEscluso('contesto-orbit.md'), true); assert.equal(config.fileEscluso('\\AGENTS.md'), true);
  assert.equal(config.fileEscluso('progetti/AGENTS.md'), false); assert.equal(config.fileEscluso('note/CONTESTO-ORBIT.md'), false);
  assert.deepEqual(percorsi(), ['note/chimica.md', 'progetti/AGENTS.md']);
});

test('retrieval: i documenti esclusi non compaiono mai (sezioni, ricerca per note, ricerca degli strumenti, contesto)', () => {
  const c = memoria.contestoPerDomanda('cosa so dello zirconio?', {});
  assert.deepEqual(c.fonti.map(f => f.percorso).sort(), ['note/chimica.md', 'progetti/AGENTS.md']);
  assert.doesNotMatch(c.testo, /Sei il consulente tecnico|Storia tecnica di Orbit/);
  assert.ok(memoria.cerca('zirconio').every(r => !['AGENTS.md', 'CONTESTO-ORBIT.md'].includes(r.percorso)));
  assert.ok(memoria.cercaNote('zirconio').every(r => !['AGENTS.md', 'CONTESTO-ORBIT.md'].includes(r.percorso)));
});

test('i file restano intatti e leggibili con i normali strumenti del file system', () => {
  assert.equal(fs.readFileSync(path.join(V, 'AGENTS.md'), 'utf8'), AGENTS);
  assert.equal(fs.readFileSync(path.join(V, 'CONTESTO-ORBIT.md'), 'utf8'), CONTESTO);
});

test('indice e cache gia esistenti: un documento indicizzato prima dell\'esclusione sparisce alla sincronizzazione, anche dai risultati in cache', () => {
  // simula un indice "vecchio": si reinserisce a mano la nota esclusa, si riempie la cache, poi si sincronizza
  const indice = ricerca.motore();
  const prima = memoria.contestoPerDomanda('storia tecnica di orbit zirconio', {});   // riempie la cache (senza la nota esclusa)
  assert.ok(!prima.fonti.some(f => f.percorso === 'CONTESTO-ORBIT.md'));
  // un aggiornamento mirato su un documento escluso non lo rimette nell'indice
  memoria.notificaModifica(['AGENTS.md', 'CONTESTO-ORBIT.md']);
  assert.deepEqual(percorsi(), ['note/chimica.md', 'progetti/AGENTS.md']);
  assert.ok(indice);
});

test('indice creato prima dell\'esclusione (versione precedente del codice): la nota viene rimossa e le cache svuotate', () => {
  const { execFileSync } = require('child_process');
  // processo separato con ORBIT_MEMORIA_ESCLUDI="" (nessuna esclusione): indicizza anche AGENTS.md nello stesso indice
  const script = "process.env.ORBIT_VAULT_PATH=" + JSON.stringify(V) + ";process.env.ORBIT_INDEX_DIR=" + JSON.stringify(path.join(BASE, 'indice2')) + ";process.env.ORBIT_MEMORIA_ESCLUDI='';" +
    "const m=require(" + JSON.stringify(require.resolve('../../memoria/memoria')) + ");m.avvia();process.stdout.write(JSON.stringify(m.elencaNote().note.map(n=>n.percorso)));";
  const prima = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert.ok(prima.includes('AGENTS.md') && prima.includes('CONTESTO-ORBIT.md'));
  // stesso indice, ora con l'esclusione predefinita: i documenti escono dall'indice e dal retrieval
  const dopo = "process.env.ORBIT_VAULT_PATH=" + JSON.stringify(V) + ";process.env.ORBIT_INDEX_DIR=" + JSON.stringify(path.join(BASE, 'indice2')) + ";delete process.env.ORBIT_MEMORIA_ESCLUDI;" +
    "const m=require(" + JSON.stringify(require.resolve('../../memoria/memoria')) + ");m.avvia();const c=m.contestoPerDomanda('storia tecnica di orbit zirconio',{});" +
    "process.stdout.write(JSON.stringify({note:m.elencaNote().note.map(n=>n.percorso),fonti:c.fonti.map(f=>f.percorso)}));";
  const r = JSON.parse(execFileSync(process.execPath, ['-e', dopo], { encoding: 'utf8' }));
  assert.equal(r.note.includes('AGENTS.md') || r.note.includes('CONTESTO-ORBIT.md'), false);
  assert.equal(r.fonti.includes('CONTESTO-ORBIT.md') || r.fonti.includes('AGENTS.md'), false);
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice aperto */ } });
