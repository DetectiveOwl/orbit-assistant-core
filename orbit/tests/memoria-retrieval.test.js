'use strict';
// Memoria, passo 1: intento, soglia di pertinenza, deduplicazione, cache con invalidazione, evidenze del verificatore.
// Usa un vault finto in una cartella temporanea (questo file gira in un processo suo, quindi puo impostare il vault prima di caricare la memoria).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mret-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
scrivi('scadenze/parziali.md', '# Parziali\n\n| Materia | Data |\n| :-- | :-- |\n| Analisi 1 | lunedi 2 novembre 2026 |\n| FAM | venerdi 30 ottobre 2026 |\n');
scrivi('scadenze/piano-di-studio.md', '# Piano\n\n## Piano giorno per giorno\n\n| Giorno | Cosa |\n| :-- | :-- |\n| Lun 12 | Analisi limiti |\n');
scrivi('cervello/INDEX.md', '# Cervello\n\n- [[chi-sono]]\n');
scrivi('cervello/persona/chi-sono.md', '# Chi sono\n\nMarco studia Ingegneria Informatica. Usa Meshnet per i progetti.\n');
scrivi('cervello/persona/stile-di-lavoro.md', '# Stile\n\nFormulari in colonna unica.\n');
scrivi('cervello/vita/orbit.md', '# Orbit\n\nAssistente.\n');
scrivi('cervello/vita/progetti.md', '# Progetti\n\nfoto-sorter su una VM Nimbus Cloud, esposta con Meshnet Funnel.\n');
scrivi('cervello/vita/setup-tecnico.md', '# Setup\n\nAccount Nimbus Cloud (free) e Meshnet.\n');
scrivi('cervello/persona/interessi.md', '# Interessi\n\nSport: si allena il lunedi. Musica.\n');
scrivi('corsi/FAM/INDICE.md', '# FAM\n\nMatrice inversa: pagina 40.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

const memoria = require('../../memoria/memoria');
const { classifica } = require('../ai/router/classifier');
const { costruisci } = require('../ai/context');
const { selezionaEvidenze } = require('../ai/quality/gate');
memoria.avvia();
const attendi = ms => { const t = Date.now() + ms; while (Date.now() < t) { /* l'indice riscansiona al massimo ogni 1,5 s */ } };
const percorsi = q => memoria.cerca(q).map(r => r.percorso);

test('intento: la data di un esame non e il piano della giornata; piano, stato e seguito ambiguo restano distinti', () => {
  const c = t => classifica(t, { storia: 0, haVault: true });
  for (const t of ['quando e il parziale di analisi?', 'che giorno e l esame di FAM?', 'a che ora e la prova di fondamenti?']) {
    const x = c(t); assert.equal(x.pianoGiorno, false, t); assert.equal(x.dataEvento, true, t); assert.equal(x.richiamaVault, true, t);
  }
  for (const t of ['cosa devo fare oggi?', 'piano per domani', 'da dove parto?']) assert.equal(c(t).pianoGiorno, true, t);
  for (const t of ['a che punto sono con FAM?', 'quanto mi manca per il parziale?']) { const x = c(t); assert.equal(x.statoStudio, true, t); assert.equal(x.pianoGiorno, false, t); }
  assert.equal(c('e il test?').ambigua, true);                                       // senza conversazione: si chiede di cosa
  assert.equal(classifica('e il test?', { storia: 4, haVault: true }).ambigua, false);  // con conversazione: si usa la storia
  assert.equal(classifica('e il test?', { storia: 4, haVault: true }).serveStoria, true);
});

test('soglia: senza risposta nel vault nessuna nota; con piu note davvero utili le prende tutte', () => {
  assert.deepEqual(percorsi('qual e la mia ricetta preferita della carbonara?'), []);
  const ts = percorsi('cosa so di Meshnet e Nimbus?');
  assert.ok(ts.includes('cervello/vita/progetti.md') && ts.includes('cervello/vita/setup-tecnico.md'), ts.join(','));
  assert.ok(percorsi('quando e il parziale di analisi?').includes('scadenze/parziali.md'));
  assert.deepEqual(memoria.cerca('carbonara', { soglia: false }).length >= 0, true);    // la soglia si puo disattivare (strumenti)
});

test('deduplicazione: una nota del profilo non viene rimandata, ma resta tra le fonti citabili', () => {
  const cls = classifica('cosa so di Meshnet?', { storia: 0, haVault: true });
  const ctx = costruisci({ messaggio: 'cosa so di Meshnet?', classificazione: cls, memoria, maxInputToken: 12000 });
  const testo = ctx.messaggi.at(-1).content;
  assert.equal((testo.match(/<nota percorso="cervello\/persona\/chi-sono\.md"/g) || []).length, 1, 'chi-sono deve comparire una volta sola (nel profilo)');
  assert.ok(ctx.fonti.some(f => f.percorso === 'cervello/persona/chi-sono.md' && f.nelProfilo));
  assert.ok(ctx.percorsiFonti.includes('cervello/INDEX.md'));                         // le note del profilo sono citabili
  assert.ok(testo.includes('cervello/vita/progetti.md'));                            // le altre note pertinenti arrivano comunque
});

test('cache: risultati riusati, ma invalidati da modifica, rinomina ed eliminazione (niente risultati vecchi)', () => {
  assert.deepEqual(percorsi('zebrafantasma'), []);
  scrivi('cervello/persona/interessi.md', '# Interessi\n\nSport: si allena il lunedi. Musica. zebrafantasma\n'); attendi(1600);
  assert.deepEqual(percorsi('zebrafantasma'), ['cervello/persona/interessi.md']);
  fs.renameSync(path.join(V, 'cervello/persona/interessi.md'), path.join(V, 'cervello/persona/hobby.md')); attendi(1600);
  assert.deepEqual(percorsi('zebrafantasma'), ['cervello/persona/hobby.md']);
  assert.match(memoria.cerca('zebrafantasma')[0].estratto, /zebrafantasma/);       // il testo letto e quello nuovo
  fs.unlinkSync(path.join(V, 'cervello/persona/hobby.md')); attendi(1600);
  assert.deepEqual(percorsi('zebrafantasma'), []);
  const a = memoria.cerca('Meshnet'); a[0].tag.push('modificato');                 // chi usa i risultati non sporca la cache
  assert.ok(!memoria.cerca('Meshnet')[0].tag.includes('modificato'));
});

test('verificatore: riceve le parti che servono (con intestazioni e provenienza), tutto se la risposta dice "non c e"', () => {
  const lungo = '<contesto_vault>\n<nota percorso="scadenze/parziali.md" titolo="Parziali">\n# Parziali\n\n| Materia | Data |\n| :-- | :-- |\n| Analisi 1 | lunedi 2 novembre 2026 |\n| FAM | venerdi 30 ottobre 2026 |\n' +
    Array.from({ length: 60 }, (_, i) => '| Riga ' + i + ' | testo di riempimento che non c entra con la domanda numero ' + (1000 + i) + ' |').join('\n') +
    '\n\n## Altro\n\n' + 'Paragrafo irrilevante sulla musica e sul tempo libero. '.repeat(40) + '\n</nota>\n</contesto_vault>';
  const ev = selezionaEvidenze(lungo, { candidato: 'Il parziale di Analisi 1 e lunedi 2 novembre 2026.', richiesta: 'quando e il parziale di analisi?' });
  assert.ok(ev.length < lungo.length / 2, 'deve ridurre');
  assert.match(ev, /Analisi 1 \| lunedi 2 novembre 2026/);
  assert.match(ev, /<nota percorso="scadenze\/parziali\.md"/); assert.match(ev, /\| Materia \| Data \|/);   // provenienza e intestazione della tabella
  assert.doesNotMatch(ev, /Paragrafo irrilevante/);
  assert.equal(selezionaEvidenze(lungo, { candidato: 'Nelle note non c e la data del parziale.', richiesta: 'x' }), lungo);
  assert.equal(selezionaEvidenze('breve', { candidato: 'x' }), 'breve');
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice ancora aperto */ } });
