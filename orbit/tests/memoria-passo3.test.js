'use strict';
// Memoria, passo 3: sigle, espansione selettiva per domande ampie, assenze (estratti / presente altrove / verificata), citazioni dal profilo.
// Vault finto in una cartella temporanea; nessuna chiamata a modelli.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mp3-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
scrivi('cervello/INDEX.md', '# Cervello\n\n- [[chi-sono]]\n- [[da-completare]]\n');
scrivi('cervello/persona/chi-sono.md', '# Chi sono\n\nMarco, Ingegneria Informatica.\n');
scrivi('cervello/da-completare.md', '# Da completare\n\n- Che sport fai?\n');
scrivi('cervello/vita/universita.md', '# Universita\n\n## Esami in corso\n\n| Materia | Data |\n| :-- | :-- |\n| Fisica Applicata Moderna (FAM) | venerdi 30 ottobre |\n| Fondamenti di Informatica (FdI) | da definire |\n\n## Punti di attenzione\n\n- Circa 55 h per Fisica.\n- Un solo fac simile di Fisica non basta.\n');
scrivi('cervello/vita/routine.md', '# Routine\n\n## Regole usate dal piano\n\n- Gli allenamenti si saltano solo nell ultima settimana prima di FAM (26 e 28 ottobre).\n\n## Computer\n\nUn Laptop Aurora.\n');
// come nel vault vero: il piano parla di Fisica (nome esteso) e della settimana prima dell'esame, non della sigla
scrivi('scadenze/piano.md', '# Piano\n\n## Come funziona il piano\n\nNei giorni di allenamento (lunedi, mercoledi, venerdi) si smette di studiare alle 20:00; nella settimana prima dell esame di Fisica si guadagnano ore saltando l allenamento.\n\n## Piano giorno per giorno\n\n' +
  '**Settimana 4 (prima dell esame di Fisica)**\n\n| Giorno | Ore | Fisica |\n| :-- | :-- | :-- |\n| Lun 26 | 1h30 (20:30-22:00, salti l allenamento) | Simulazione |\n| Mar 27 | 5h | Ripasso |\n| Mer 28 | 4h30 (19:30-22:00, salti l allenamento) | Teoremi |\n');
scrivi('note/rete.md', '# Rete\n\n## VPN\n\nMeshnet collega il PC alla VM.\n');
scrivi('note/server.md', '# Server\n\n## Cloud\n\nLa VM gira su Nimbus Cloud.\n');
scrivi('note/glossario.md', '# Glossario\n\nIl corso di SO (Sistemi Operativi) e al secondo anno.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

const memoria = require('../../memoria/memoria');
const ricerca = require('../../memoria/ricerca');
const { classifica } = require('../ai/router/classifier');
const { costruisci } = require('../ai/context');
const { controlla } = require('../ai/quality/deterministic');
const { promptVerifica } = require('../ai/quality/gate');
memoria.avvia();
const contesto = q => costruisci({ messaggio: q, storia: [], classificazione: classifica(q, { haVault: true }), memoria, maxInputToken: 12000 });
const vault = c => (c.messaggi.at(-1).content.match(/<contesto_vault>[\s\S]*?<\/contesto_vault>/) || [''])[0];
const sezioni = c => (vault(c).match(/<sezione /g) || []).length;

test('sigle: il dizionario e derivato dal vault e funziona per qualunque sigla, nelle due forme', () => {
  const d = ricerca.motore().sigle();
  assert.equal(d.get('fam').definizione, 'Fisica Applicata Moderna');
  assert.equal(d.get('fdi').definizione, 'Fondamenti di Informatica');
  assert.equal(d.get('so').definizione, 'Sistemi Operativi');
  assert.equal(d.get('fam').percorso, 'cervello/vita/universita.md');
  assert.equal(d.has('ottobre'), false);
});

test('domanda 7: arrivano la regola, le ore guadagnate e la definizione della sigla, con provenienza', () => {
  const c = contesto('perche gli allenamenti si saltano prima di FAM?'); const b = vault(c);
  assert.match(b, /si saltano solo nell ultima settimana prima di FAM/);
  assert.match(b, /\| Lun 26 \| 1h30 \(20:30-22:00, salti l allenamento\)/); assert.match(b, /\| Mer 28 \| 4h30/);
  assert.match(b, /si smette di studiare alle 20:00/);                          // perche si guadagnano ore
  assert.match(b, /\[Sigla: FAM = Fisica Applicata Moderna \(definita in cervello\/vita\/universita\.md/);
});

test('domanda 12: una domanda ampia su una sigla porta i dettagli scritti con il nome esteso', () => {
  const c = contesto('cosa devo sapere su FAM?'); const b = vault(c);
  assert.match(b, /venerdi 30 ottobre/); assert.match(b, /55 h per Fisica/); assert.match(b, /fac simile di Fisica non basta/);
  assert.match(b, /Sigla: FAM = Fisica Applicata Moderna/);
});

test('domande specifiche: niente espansione e niente contesto in piu', () => {
  for (const q of ['che computer ho?', 'quando e il parziale di analisi?', 'a che pagina della dispensa c e la matrice inversa?']) assert.equal(classifica(q, { haVault: true }).ampia, false, q);
  const c = contesto('che computer ho?');
  assert.equal(sezioni(c), 1); assert.match(vault(c), /Laptop Aurora/);
  for (const q of ['perche gli allenamenti si saltano?', 'cosa devo sapere su FAM?', 'cosa so di Meshnet e Nimbus?']) assert.equal(classifica(q, { haVault: true }).ampia, true, q);
});

test('assenze: estratti dichiarati come tali, termine presente altrove segnalato, assenza verificata solo se vera', () => {
  const c = contesto('qual e la mia ricetta preferita della carbonara?'); const b = vault(c);
  assert.doesNotMatch(b, /<sezione /);
  assert.match(b, /Assenza verificata: "carbonara" non compare in nessuna nota del vault/);
  const g = vault(contesto('cosa devo sapere su FAM?'));
  assert.match(g, /nelle parti del vault che ho letto non c'e/);              // regola sulle assenze per gli estratti
  assert.doesNotMatch(g, /Assenza verificata: "fam"/);
  // un termine coperto solo da note non incluse: avviso "compare anche in", mai "assenza verificata"
  const r = { sigle: [], termini: [{ termine: 'meshnet', peso: 2, noteNelVault: ['note/rete.md'] }, { termine: 'pizza', peso: 2, noteNelVault: [] }] };
  const testo = memoria._avvisiAssenze(r, new Map(), []);
  assert.match(testo, /"meshnet" compare anche in note non incluse qui \(note\/rete\.md\)/);
  assert.match(testo, /Assenza verificata: "pizza"/);
});

test('informazioni distribuite: due note diverse per due termini', () => {
  const b = vault(contesto('cosa so di Meshnet e Nimbus?'));
  assert.match(b, /Meshnet collega il PC/); assert.match(b, /Nimbus Cloud/);
});

test('citazioni dal profilo: citabili le note del profilo, non quelle solo collegate con [[link]]', () => {
  const c = contesto('che computer ho?');
  assert.ok(c.percorsiFonti.includes('cervello/INDEX.md') && c.percorsiFonti.includes('cervello/persona/chi-sono.md'));
  assert.ok(!c.percorsiFonti.includes('cervello/da-completare.md'));             // solo collegata dall'indice: non letta
  assert.match(c.messaggi.at(-1).content, /le note che compaiono solo come \[\[collegamento\]\] non sono state lette e non si citano/);
  const piano = { criteri: [], verifica: { modo: 'ai', controlli: ['fonti_citate'] } };
  const ok = controlla({ testo: 'Hai un Laptop Aurora (cervello/persona/chi-sono.md, cervello/vita/routine.md).', piano, fonti: c.percorsiFonti, richiesta: 'x' });
  assert.equal(ok.esito, 'PASS', JSON.stringify(ok));
  const no = controlla({ testo: 'Vedi cervello/da-completare.md.', piano, fonti: c.percorsiFonti, richiesta: 'x' });
  assert.equal(no.esito, 'FAIL');                                               // il controllo resta severo
});

test('verificatore: la regola sulle assenze non verificate fa parte delle istruzioni, i criteri restano', () => {
  const { QualityGate } = require('../ai/quality/gate');
  const fonte = fs.readFileSync(require.resolve('../ai/quality/gate'), 'utf8');
  assert.match(fonte, /assenza non verificata/);
  assert.ok(typeof QualityGate === 'function');
  assert.match(promptVerifica({ richiesta: 'r', piano: { criteri: ['a', 'b'] }, candidato: 'c', testoFonti: 'f', risultatiLocali: [] }), /1\. a\n2\. b/);
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice aperto */ } });
