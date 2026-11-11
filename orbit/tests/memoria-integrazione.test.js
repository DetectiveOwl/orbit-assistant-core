'use strict';
// Correzioni finali dell'integrazione Obsidian: piano terminato o assente, freschezza della cache dopo modifiche (di Orbit ed esterne),
// apprendimento senza doppioni e con provenienza. Vault temporaneo, memoria vera, provider finto: nessuna chiamata a modelli.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nomeUtente } = require('../../memoria/profilo');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mint-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
const leggi = p => fs.readFileSync(path.join(V, p), 'utf8');
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
scrivi('cervello/INDEX.md', '# Cervello\n\n- [[chi-sono]]\n');
scrivi('cervello/persona/chi-sono.md', '# Chi sono\n\nMarco.\n\n## Sport\n- si allena il lunedi\n- Gioca a pallavolo dal 2019.\n');
scrivi('cervello/da-completare.md', '# Da completare\n');
scrivi('scadenze/piano-di-studio.md', '# Piano\n\n## Come funziona il piano\n\nSi studia dopo le lezioni.\n\n## Piano giorno per giorno\n\n**Settimana 1**\n\n| Giorno | Ore | Cosa |\n| :-- | :-- | :-- |\n' +
  '| Lun 5 | 3h | RIGA-LUN-5 |\n| Mar 6 | 2h | RIGA-MAR-6 |\n\n## Domande di active recall\n\nTESTO-NON-PERTINENTE-DEL-PIANO lungo e inutile per oggi.\n');
scrivi('scadenze/parziali.md', '# Parziali\n\n## Programma\n\nPROGRAMMA-INTERO.\n\n## Stato del ripasso\n\n| Sigla | Stato |\n| :-- | :-- |\n| A1 | fatto |\n| A2 | da fare |\n');
scrivi('note/bici.md', '# Bici\n\n## Uscite\n\nLa bici e rossa e pesa dodici chili.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

const memoria = require('../../memoria/memoria');
const { classifica } = require('../ai/router/classifier');
const { costruisci } = require('../ai/context');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const { MockProvider, settingsProva } = require('./helpers');
const { nucleoRiga } = require('../integrations/obsidian/scrittura');
memoria.avvia();

const contesto = (q, oggi) => costruisci({ messaggio: q, storia: [], classificazione: classifica(q, { haVault: true }), memoria, maxInputToken: 12000, oggi });
const vault = c => (c.messaggi.at(-1).content.match(/<contesto_vault>[\s\S]*?<\/contesto_vault>/) || [''])[0];
const trova = q => memoria.contestoPerDomanda(q, {});

// ---------- 1-2. piano della giornata ----------
test('piano: giorno presente = righe del giorno; nessuna nota intera', () => {
  // 5 ottobre 2026 e un lunedi
  const b = vault(contesto('cosa devo fare oggi?', '2026-10-05'));
  assert.match(b, /RIGA-LUN-5/); assert.doesNotMatch(b, /RIGA-MAR-6/); assert.doesNotMatch(b, /Piano di studio: /);
});

test('piano terminato: avviso esplicito con l\'ultimo giorno presente, solo lo stato, mai le note intere', () => {
  const c = contesto('cosa devo fare oggi?', '2026-11-03'); const b = vault(c);
  assert.match(b, /\[Piano di studio: in scadenze\/piano-di-studio\.md non c'e nessuna riga per martedì 3 novembre 2026 \(l'ultimo giorno presente nel piano e "Mar 6"\)/);
  assert.match(b, /Stato del ripasso[\s\S]*A2 \| da fare/);
  assert.doesNotMatch(b, /TESTO-NON-PERTINENTE-DEL-PIANO/); assert.doesNotMatch(b, /PROGRAMMA-INTERO/); assert.doesNotMatch(b, /RIGA-LUN-5/);
  assert.ok(c.percorsiFonti.includes('scadenze/piano-di-studio.md'));            // si puo citare il piano come "controllato"
});

test('data fuori dall\'intervallo del piano (prima dell\'inizio, domani, dopodomani): stesso comportamento, nessuna data fissa', () => {
  for (const [q, oggi, quando] of [['cosa devo fare oggi?', '2026-09-01', 'martedì 1 settembre 2026'], ['cosa devo fare domani?', '2027-03-10', 'giovedì 11 marzo 2027'], ['cosa devo fare dopodomani?', '2026-10-05', 'mercoledì 7 ottobre 2026']]) {
    const b = vault(contesto(q, oggi));
    assert.match(b, new RegExp('non c\'e nessuna riga per ' + quando), q + ' ' + oggi);
    assert.doesNotMatch(b, /TESTO-NON-PERTINENTE-DEL-PIANO|PROGRAMMA-INTERO/);
  }
});

test('piano assente: lo dice, e non ripiega su altre note intere', () => {
  fs.renameSync(path.join(V, 'scadenze/piano-di-studio.md'), path.join(BASE, 'piano-spostato.md'));
  try {
    memoria.notificaModifica(['scadenze/piano-di-studio.md']);
    const b = vault(contesto('cosa devo fare oggi?', '2026-10-05'));
    assert.match(b, /\[Piano di studio: nel vault non c'e un piano di studio \(scadenze\/piano-di-studio\.md non esiste\)/);
    assert.match(b, /Stato del ripasso/); assert.doesNotMatch(b, /PROGRAMMA-INTERO/);
  } finally {
    fs.renameSync(path.join(BASE, 'piano-spostato.md'), path.join(V, 'scadenze/piano-di-studio.md'));
    memoria.notificaModifica(['scadenze/piano-di-studio.md']);
  }
});

// ---------- 3-4. cache e modifiche al vault ----------
test('modifica esterna (come da Obsidian) e lettura subito dopo: niente testo vecchio dalla cache', () => {
  assert.match(trova('quanto pesa la bici?').testo, /dodici/);
  scrivi('note/bici.md', '# Bici\n\n## Uscite\n\nLa bici e rossa e pesa  undici chili.\n');
  assert.match(trova('quanto pesa la bici?').testo, /undici/);
  // due modifiche esterne in rapida successione
  scrivi('note/bici.md', '# Bici\n\n## Uscite\n\nLa bici e rossa e pesa  tredici chili.\n');
  scrivi('note/bici.md', '# Bici\n\n## Uscite\n\nLa bici e rossa e pesa quattordici chili.\n');
  assert.match(trova('quanto pesa la bici?').testo, /quattordici/);
});

test('nota eliminata o rinominata ancora in cache: non viene piu restituita (e la rinomina si trova subito)', () => {
  scrivi('note/canoa.md', '# Canoa\n\nLa canoa verde sta al club.\n');
  memoria.notificaModifica(['note/canoa.md']);
  assert.match(trova('la canoa verde?').testo, /canoa verde/);
  fs.mkdirSync(path.join(V, 'hobby'), { recursive: true });
  fs.renameSync(path.join(V, 'note/canoa.md'), path.join(V, 'hobby/Canoa.md'));
  const r = trova('la canoa verde?');
  assert.deepEqual(r.fonti.map(f => f.percorso), ['hobby/Canoa.md']);
  fs.unlinkSync(path.join(V, 'hobby/Canoa.md'));
  const e = trova('la canoa verde?');
  assert.doesNotMatch(e.testo, /canoa verde sta al club/); assert.equal(e.fonti.length, 0);
});

// ---------- 5-7. apprendimento ----------
function app(risposta) {
  const a = creaApp({ settings: settingsProva({ settings: { dataDir: path.join(BASE, 'dati') } }), provider: new MockProvider({ produttore: () => ({ text: risposta }) }), storage: new Storage(':memory:'), memoria, attendiFn: () => Promise.resolve() });
  a.permessi.impostaAbilitata('obsidian', true); a.permessi.impostaLivello('obsidian', 'crea', 'consenti'); a.permessi.impostaLivello('obsidian', 'amplia', 'consenti');
  return a;
}
const conta = (testo, re) => (testo.match(re) || []).length;

test('stesso ricordo ripetuto (stessa risposta, richieste successive, richieste concorrenti): scritto una volta sola', async () => {
  const r = '<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">Nuota il giovedi.</orbit_ricorda>';
  const a = app('Ok.\n' + r + '\n' + r);
  const primo = await a.orchestrator.elabora({ messaggio: 'nuoto il giovedi' });
  assert.equal(conta(leggi('cervello/persona/chi-sono.md'), /Nuota il giovedi/g), 1);
  assert.match(primo.testo, /Ho aggiunto al tuo cervello/);
  const secondo = await a.orchestrator.elabora({ messaggio: 'te l\'ho detto, nuoto il giovedi' });
  assert.match(secondo.testo, /Lo avevo gia nel tuo cervello/);
  await Promise.all([a.orchestrator.elabora({ messaggio: 'nuoto il giovedi' }), a.orchestrator.elabora({ messaggio: 'nuoto il giovedi!' })]);
  assert.equal(conta(leggi('cervello/persona/chi-sono.md'), /Nuota il giovedi/g), 1);
  // nota nuova creata da due richieste concorrenti: una la crea, l'altra trova il fatto gia scritto
  const b = app('Ok.\n<orbit_ricorda nota="cervello/vita/musica" sezione="Strumenti">Suona la chitarra.</orbit_ricorda>');
  await Promise.all([b.orchestrator.elabora({ messaggio: 'suono la chitarra' }), b.orchestrator.elabora({ messaggio: 'suono la chitarra!' })]);
  assert.equal(conta(leggi('cervello/vita/musica.md'), /Suona la chitarra/g), 1);
  // un fatto gia scritto a mano nel vault (senza marcatore) conta come presente: compatibilita con le note esistenti
  const c = app('Ok.\n<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">Gioca a pallavolo dal 2019</orbit_ricorda>');
  const terzo = await c.orchestrator.elabora({ messaggio: 'gioco a pallavolo dal 2019' });
  assert.equal(conta(leggi('cervello/persona/chi-sono.md'), /pallavolo dal 2019/g), 1); assert.match(terzo.testo, /Lo avevo gia/);
});

test('informazioni simili ma non identiche: si scrivono entrambe', async () => {
  const a = app('Ok.\n<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">Gioca a pallavolo dal 2021.</orbit_ricorda>\n<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">Gioca a beach volley dal 2019.</orbit_ricorda>');
  await a.orchestrator.elabora({ messaggio: 'gioco a pallavolo dal 2021 e a beach volley dal 2019' });
  const t = leggi('cervello/persona/chi-sono.md');
  assert.match(t, /pallavolo dal 2019/); assert.match(t, /pallavolo dal 2021/); assert.match(t, /beach volley dal 2019/);
  assert.notEqual(nucleoRiga('- Nuota il giovedi (Orbit, 2026-10-12, detto da Marco in chat)'), nucleoRiga('- Nuota il venerdi'));
  assert.equal(nucleoRiga('- Nuota il Giovedì. (Orbit, 2026-10-12, detto da Marco in chat, conversazione 3)'), nucleoRiga('* nuota il giovedi'));
});

test('data e provenienza sui nuovi ricordi; le righe esistenti non cambiano; la nota nuova e subito recuperabile', async () => {
  const prima = leggi('cervello/persona/chi-sono.md');
  const a = app('Ok.\n<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">Corre la domenica mattina.</orbit_ricorda>\n<orbit_ricorda nota="cervello/vita/viaggi" sezione="Mete">Vuole andare in Islanda.</orbit_ricorda>\n<orbit_conflitto nota="cervello/persona/chi-sono.md">Le note dicono lunedi, ora dice martedi.</orbit_conflitto>');
  const r = await a.orchestrator.elabora({ messaggio: 'corro la domenica mattina e voglio andare in Islanda, e mi alleno il martedi' });
  const conv = r.conversazioneId;
  const dopo = leggi('cervello/persona/chi-sono.md');
  assert.ok(dopo.startsWith(prima.trimEnd()));                                     // il testo esistente resta identico
  assert.match(dopo, new RegExp('- Corre la domenica mattina\\. \\(Orbit, \\d{4}-\\d{2}-\\d{2}, detto da ' + nomeUtente() + ' in chat, conversazione ' + conv + '\\)'));
  const nuova = leggi('cervello/vita/viaggi.md');
  assert.match(nuova, new RegExp('^---\\ntags: \\[cervello\\]\\ncreata: \\d{4}-\\d{2}-\\d{2}\\norigine: Orbit\\nfonte: detto da ' + nomeUtente() + ' in chat \\(conversazione .+\\)\\naffidabilita: alta\\n---'));
  assert.match(nuova, /# Viaggi\n\n## Mete\n\n- Vuole andare in Islanda\. \(Orbit, /); assert.match(nuova, /Torna a \[\[INDEX\]\]/);
  assert.match(leggi('cervello/da-completare.md'), /## Conflitti da chiarire\n\n- cervello\/persona\/chi-sono\.md: Le note dicono lunedi, ora dice martedi\. \(Orbit, \d{4}-/);
  // memoria dopo una nuova scrittura: la nota e il fatto si trovano alla domanda successiva, senza attese ne riavvio
  const t = trova('voglio andare in Islanda?');
  assert.deepEqual(t.fonti.map(f => f.percorso), ['cervello/vita/viaggi.md']);
  assert.equal(memoria.leggiNota('viaggi').frontmatter.fonte.startsWith('detto da ' + nomeUtente() + ' in chat'), true);
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice aperto */ } });
