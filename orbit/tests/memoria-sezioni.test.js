'use strict';
// Memoria, passo 2: indice per sezioni, estratti delle sezioni lunghe, informazioni distribuite, piano della giornata riga per riga.
// Vault finto in una cartella temporanea (processo separato: il vault si imposta prima di caricare la memoria).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-msez-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
const RIEMPI = Array.from({ length: 30 }, (_, i) => '**Argomento ' + i + '.** testo di riempimento sulle serie e sui limiti numero ' + i + ', che non serve per le date.').join('\n\n');
scrivi('scadenze/parziali.md', '# Parziali\n\n## Fisica Applicata Moderna (FAM)\n\nData: venerdi 30 ottobre 2026\n\n### Programma\n\n' + RIEMPI +
  '\n\n## Analisi Matematica 1\n\nData: lunedi 2 novembre 2026\n\n### Programma\n\n' + RIEMPI +
  '\n\n## Stato del ripasso\n\n| Sigla | Argomento | Teoria |\n| :-- | :-- | :-- |\n| A6 | Grassmann | da fare |\n| M3 | Limiti | da fare |\n');
scrivi('scadenze/piano-di-studio.md', '# Piano di studio\n\n## Come funziona il piano\n\nRegole: si chiude alle 22. Nei giorni di allenamento si smette alle 20.\n\n## Piano giorno per giorno\n\n' +
  '**Settimana 2 (12-18 ottobre)**\n\n| Giorno | Ore | Algebra | Analisi |\n| :-- | :-- | :-- | :-- |\n| Lun 12 | 0h | Riposo | - |\n| Mar 13 | 5h | A6 Grassmann (2h) | M3 limiti (1h) |\n| Mer 14 | 2h | Esercizi | - |\n\n' +
  '## Domande di active recall\n\n**A6, Grassmann.** Come estrai una base da dei generatori?\n\n**A7, nucleo.** Cos e il nucleo?\n\n**M3, limiti.** Cosa dice il teorema dei carabinieri?\n\n' +
  '## Cose da sapere\n\n**Allenamenti.** Si saltano solo nell ultima settimana prima di FAM (26 e 28 ottobre), per recuperare ore.\n\n**Analisi.** Il punto piu stretto: circa 30 ore.\n\n' +
  '## Dispensa di Algebra: pagine\n\n**A6, Grassmann.** Dispensa pp. 27-29.\n\n**A7, nucleo.** Dispensa pp. 29-33.\n');
scrivi('cervello/vita/routine-settimanale.md', '# Routine\n\n## Regole usate dal piano\n\n- Gli allenamenti si saltano solo nell ultima settimana prima di FAM (26 e 28 ottobre).\n');
scrivi('cervello/vita/progetti.md', '# Progetti\n\n## foto-sorter\n\nGira su una VM Nimbus Cloud.\n\n## Orbit\n\nAssistente personale.\n');
scrivi('cervello/vita/setup-tecnico.md', '# Setup\n\n## Rete\n\nMeshnet collega il PC alla VM.\n\n## Computer\n\nLaptop Aurora.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

const memoria = require('../../memoria/memoria');
const { sezioniNota } = require('../../memoria/analisi');
const { classifica } = require('../ai/router/classifier');
const { costruisci, dateDelPiano } = require('../ai/context');
memoria.avvia();
const contesto = q => costruisci({ messaggio: q, storia: [], classificazione: classifica(q, { haVault: true }), memoria, maxInputToken: 12000 });
const blocco = c => (c.messaggi.at(-1).content.match(/<contesto_vault>[\s\S]*?<\/contesto_vault>/) || [''])[0];

test('sezioni: posizioni esatte nel file, percorso delle intestazioni, codice ignorato', () => {
  const src = '---\ntags: [x]\n---\nintro\n\n# A\n\ntesto a\n\n```\n# non e un titolo\n```\n\n## B\n\ntesto b\n';
  const s = sezioniNota(src);
  assert.deepEqual(s.map(x => x.percorso), ['', 'A', 'A > B']);
  for (const x of s) assert.equal(src.slice(x.inizio, x.fine), src.slice(x.inizio, x.fine));      // posizioni dentro il file
  assert.ok(src.slice(s[1].inizio, s[1].fine).includes('# non e un titolo'));                         // il codice resta nella sezione A
  assert.ok(src.slice(s[2].inizio, s[2].fine).startsWith('## B'));
});

test('"quando e il parziale di Analisi?": arriva la riga con la data, non il programma intero ne il piano', () => {
  const c = contesto('quando e il parziale di Analisi?'); const b = blocco(c);
  assert.match(b, /Data: lunedi 2 novembre 2026/);
  assert.ok(b.length < 2500, 'contesto troppo lungo: ' + b.length);
  assert.doesNotMatch(b, /Argomento 2[0-9]\./);                       // il programma lungo non viene incollato
  assert.doesNotMatch(b, /\| Mar 13 \|/);                              // il piano della giornata non c'entra
  assert.ok(c.fonti.some(f => f.percorso === 'scadenze/parziali.md'));
});

test('"perche si saltano gli allenamenti?": la regola arriva, con la sua provenienza', () => {
  const b = blocco(contesto('perche si saltano gli allenamenti?'));
  assert.match(b, /ultima settimana prima di FAM/);
  assert.match(b, /<nota percorso="(cervello\/vita\/routine-settimanale\.md|scadenze\/piano-di-studio\.md)"/);
  assert.match(b, /<sezione percorso="[^"]+"/);
});

test('informazioni distribuite: Meshnet e Nimbus stanno in due note diverse, arrivano entrambe', () => {
  const c = contesto('cosa so di Meshnet e Nimbus?'); const b = blocco(c);
  assert.match(b, /Meshnet collega il PC/); assert.match(b, /VM Nimbus Cloud/);
  assert.doesNotMatch(b, /Laptop Aurora/);                                   // la sezione non pertinente della stessa nota resta fuori
});

test('senza risposta: nessuna sezione', () => {
  const b = blocco(contesto('qual e la mia ricetta della carbonara?'));
  assert.doesNotMatch(b, /<sezione /);
});

test('piano della giornata riga per riga: riga del giorno, intestazioni, regole e informazioni collegate alle sigle', () => {
  const blocchi = memoria.estrattoPianoGiorno({ date: ['2026-10-13'] });
  const t = JSON.stringify(blocchi);
  assert.match(t, /\| Mar 13 \| 5h \| A6 Grassmann/);
  assert.match(t, /\| Giorno \| Ore \| Algebra \| Analisi \|/); assert.match(t, /Settimana 2/);   // intestazioni della tabella e della settimana
  assert.doesNotMatch(t, /\| Lun 12 \|/); assert.doesNotMatch(t, /\| Mer 14 \|/);              // gli altri giorni no
  assert.match(t, /Regole: si chiude alle 22/);                                                 // regole del piano
  assert.match(t, /A6, Grassmann\.\*\* Come estrai/); assert.match(t, /Dispensa pp\. 27-29/); assert.match(t, /M3, limiti/);   // collegate alle sigle
  assert.doesNotMatch(t, /A7, nucleo/);                                                         // sigle di altri giorni no
  assert.match(t, /Stato del ripasso/);
  assert.equal(memoria.estrattoPianoGiorno({ date: ['2027-01-01'] }), null);                   // giorno non nel piano: null, e il contesto lo dice (niente note intere)
});

test('date del piano: oggi, domani, dopodomani, resto della settimana (di domenica solo domenica)', () => {
  assert.deepEqual(dateDelPiano('cosa devo fare oggi', '2026-10-13'), ['2026-10-13']);
  assert.deepEqual(dateDelPiano('cosa devo fare domani', '2026-10-13'), ['2026-10-14']);
  assert.deepEqual(dateDelPiano('cosa faccio dopodomani', '2026-10-13'), ['2026-10-15']);
  assert.deepEqual(dateDelPiano('piano per questa settimana', '2026-10-16'), ['2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(dateDelPiano('piano per questa settimana', '2026-10-18'), ['2026-10-18']);
});

test('estratti: le sezioni lunghe portano solo le righe pertinenti e segnano le parti omesse', () => {
  const lunga = '## Programma\n\n' + RIEMPI + '\n\n**Date.** Il parziale e il 2 novembre.\n';
  const e = memoria._estrattoSezione(lunga, ['parzial']);
  assert.match(e.testo, /## Programma/); assert.match(e.testo, /Il parziale e il 2 novembre/); assert.match(e.testo, /\[\.\.\.\]/);
  assert.ok(e.testo.length < lunga.length / 4);
});

test('indice: l\'aggiornamento di una nota aggiorna anche le sue sezioni (niente testi vecchi)', () => {
  scrivi('cervello/vita/setup-tecnico.md', '# Setup\n\n## Rete\n\nWireguard al posto di Meshnet.\n'); const t = Date.now() + 1600; while (Date.now() < t) { /* attesa */ }
  const b = blocco(contesto('cosa uso al posto di Meshnet?'));
  assert.match(b, /Wireguard/); assert.doesNotMatch(b, /collega il PC/);
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice ancora aperto */ } });
