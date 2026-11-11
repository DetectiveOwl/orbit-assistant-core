'use strict';
// Assistente esecutivo (autonomia A/B/C, area bozze, recupero errori, onesta sull'esito, stile sintetico).
// Solo dati sintetici: vault finto in una cartella temporanea, provider finto, nessuna chiamata AI e nessun accesso al vault vero.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-esec-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
scrivi('corsi/matrici.md', '# Matrici\n\n## Inversa\n\nLa matrice inversa si calcola con Gauss-Jordan.\n');
scrivi('corsi/autovalori.md', '# Autovalori\n\nSono le radici del polinomio caratteristico.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

const memoria = require('../../memoria/memoria');
const config = require('../config');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const { OrbitError } = require('../ai/errors');
const { rilevaScritturaNota } = require('../ai/router/strumenti');
const A = require('../ai/autonomia');
const { MockProvider, settingsProva } = require('./helpers');
memoria.avvia();
test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice SQLite ancora aperto su Windows: cartella temporanea del sistema */ } });

const snapshot = () => {
  const out = {};
  (function giro(d) { for (const v of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, v.name); if (v.isDirectory()) giro(p); else out[path.relative(V, p)] = fs.readFileSync(p, 'utf8'); } })(V);
  return out;
};

function ambiente({ risposte = ['Fatto.'], area = 'Bozze', abilita = true, crea = 'conferma', produttore } = {}) {
  const provider = new MockProvider({ produttore: produttore || (({ n }) => ({ text: risposte[Math.min(n - 1, risposte.length - 1)] })) });
  const settings = settingsProva({ settings: { dataDir: path.join(BASE, 'dati'), areaBozze: area } });
  const app = creaApp({ settings, provider, storage: new Storage(':memory:'), memoria, attendiFn: () => Promise.resolve() });
  if (abilita) app.permessi.impostaAbilitata('obsidian', true);
  app.permessi.impostaLivello('obsidian', 'crea', crea);
  return { app, provider };
}
// Risponde da solo alle richieste di conferma (come farebbe l'utente dall'interfaccia) e le conta.
async function chiedi(app, messaggio, { approva = null } = {}) {
  const eventi = [];
  const r = await app.orchestrator.elabora({ messaggio, onEvent: e => { eventi.push(e); if (e.tipo === 'conferma_richiesta') setImmediate(() => app.permessi.rispondi(e.conferma.id, approva === true)); } });
  return { r, eventi, conferme: eventi.filter(e => e.tipo === 'conferma_richiesta') };
}
const nota = (percorso, corpo = '# Titolo\n\nTesto di prova.') => '<orbit_nota azione="crea" percorso="' + percorso + '" tag="prova">\n' + corpo + '\n</orbit_nota>';
const esiste = p => fs.existsSync(path.join(V, p));

test('autonomia A: una lettura nel vault parte da sola, senza conferme, e la risposta e breve', async () => {
  const { app } = ambiente({ risposte: ['<orbit_strumento nome="obsidian.cerca_note">{"query": "matrici"}</orbit_strumento>', 'Ho trovato 1 nota: corsi/matrici.md.'] });
  const { r, eventi, conferme } = await chiedi(app, 'Cerca i miei appunti sulle matrici');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(conferme.length, 0);
  assert.ok(eventi.some(e => e.tipo === 'strumento_fine' && e.nome === 'obsidian.cerca_note' && e.ok));
  assert.match(r.testo, /corsi\/matrici\.md/);
  assert.ok(r.testo.length < 200);
});

test('autonomia B: una bozza nell\'area autorizzata si crea subito, senza conferma', async () => {
  const prima = snapshot();
  const { app } = ambiente({ risposte: ['Ho creato la bozza.\n' + nota('Bozze/Autovalori', '# Autovalori\n\nBozza.')] });
  const { r, conferme } = await chiedi(app, 'Crea una bozza sugli autovalori');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(conferme.length, 0);
  assert.ok(esiste('Bozze/Autovalori.md'));
  assert.match(r.testo, /Nota creata: `Bozze\/Autovalori\.md`/);
  assert.deepEqual(Object.keys(snapshot()).sort(), Object.keys(prima).concat(path.join('Bozze', 'Autovalori.md')).sort());
  fs.rmSync(path.join(V, 'Bozze'), { recursive: true, force: true });
});

test('autonomia B: le sottocartelle dell\'area valgono, i percorsi che ne escono no', () => {
  const area = A.areaBozze('Bozze/');
  for (const [p, atteso] of [['Bozze/a', true], ['bozze/sotto/a.md', true], ['Bozze', false], ['Bozze2/a', false], ['corsi/a', false], ['Bozze/../corsi/a', false], ['.obsidian/a', false], ['C:\\Bozze\\a', false]])
    assert.equal(A.dentroArea(p, area), atteso, p);
  assert.equal(A.dentroArea('Bozze/a', null), false);
  for (const x of ['../fuori', '.obsidian', 'Bozze/../x', 'C:\\x']) assert.throws(() => A.areaBozze(x), undefined, x);
});

test('autonomia C: fuori dall\'area serve la conferma, una volta sola; senza consenso non si scrive nulla', async () => {
  const { app } = ambiente({ risposte: ['Ecco.\n' + nota('corsi/Nuova', '# Nuova')] });
  const no = await chiedi(app, 'Crea una bozza sugli autovalori', { approva: false });
  assert.equal(no.conferme.length, 1);
  assert.match(no.conferme[0].conferma.destinazione, /corsi\/Nuova/);
  assert.ok(!esiste('corsi/Nuova.md'));
  assert.match(no.r.testo, /Non sono riuscito a creare/);
  assert.doesNotMatch(no.r.testo, /Nota creata/);
  const si = await chiedi(app, 'Crea una bozza sugli autovalori', { approva: true });
  assert.equal(si.conferme.length, 1);
  assert.ok(esiste('corsi/Nuova.md'));
  fs.rmSync(path.join(V, 'corsi', 'Nuova.md'));
});

test('area bozze spenta (predefinito): anche una bozza chiede conferma', async () => {
  const { app } = ambiente({ area: '', risposte: ['Ok.\n' + nota('Bozze/X', '# X')] });
  const { conferme } = await chiedi(app, 'Crea una bozza su X', { approva: false });
  assert.equal(conferme.length, 1);
  assert.ok(!esiste('Bozze/X.md'));
});

test('categoria di autonomia riportata dall\'Integration Manager: A lettura, B bozza in area, C con conferma', async () => {
  const { app } = ambiente();
  const m = app.integrazioni;
  assert.equal((await m.esegui('obsidian', 'cerca_note', { query: 'matrici' })).categoria, 'A');
  assert.equal((await m.esegui('obsidian', 'crea_nota', { percorso: 'Bozze/B1', contenuto: '# B1' })).categoria, 'B');
  let info;
  const c = await m.esegui('obsidian', 'crea_nota', { percorso: 'corsi/C1', contenuto: '# C1' }, { onConferma: i => { info = i; setImmediate(() => app.permessi.rispondi(i.id, true)); } });
  assert.equal(c.categoria, 'C'); assert.ok(info);
  fs.rmSync(path.join(V, 'Bozze'), { recursive: true, force: true }); fs.rmSync(path.join(V, 'corsi', 'C1.md'));
  assert.deepEqual(['lettura', 'bozza', 'crea', 'modifica'].map((l, i) => A.categoriaAutonomia(l, ['consenti', 'consenti', 'conferma', 'nega'][i])), ['A', 'A', 'C', 'C']);
});

test('"bozza" e una richiesta di scrittura, una domanda sulle bozze no', () => {
  for (const t of ['Crea una bozza sugli autovalori', 'prepara una bozza del riassunto', 'Scrivimi una bozza di piano'])
    assert.equal(rilevaScritturaNota(t), true, t);
  for (const t of ['cos\'e una bozza', 'non creare nessuna bozza', 'spiegami gli autovalori'])
    assert.equal(rilevaScritturaNota(t), false, t);
});

test('recupero: ricerca senza risultati, una sola riformulazione e il modello riceve i risultati', async () => {
  const { app, provider } = ambiente({ risposte: ['<orbit_strumento nome="obsidian.cerca_note">{"query": "dimmi tutto sulla matrice inversa con il metodo di Cramer"}</orbit_strumento>', 'Ho trovato corsi/matrici.md.'] });
  const { r, eventi } = await chiedi(app, 'Cerca nei miei appunti la matrice inversa');
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = eventi.filter(e => e.tipo === 'recupero');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].motivo, 'nessun_risultato');
  const visto = JSON.stringify(provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.messages));
  assert.match(visto, /riformulata/);
  assert.match(visto, /corsi\/matrici\.md/);
});

test('recupero: nota non trovata, il modello riceve i nomi simili; nessun recupero per una query gia minima', async () => {
  const { app } = ambiente();
  const rec = [];
  const emetti = e => rec.push(e);
  const r = await app.orchestrator.usaStrumento({ emetti, run: { id: 'x', scritture: { ok: 0, ko: 0 } }, integrazione: 'obsidian', strumento: 'leggi_nota', params: { percorso: 'corsi/matrici-inverse' } });
  assert.equal(r.ok, false);
  assert.match(r.errore, /Note con nome simile: .*corsi\/matrici\.md/);
  assert.equal(rec.filter(e => e.tipo === 'recupero').length, 1);
  assert.equal(A.queryAlternativa('matrici'), null);
  assert.equal(A.queryAlternativa('matrici inverse'), null);
  assert.equal(A.queryAlternativa('dimmi tutto sulla matrice inversa con Cramer'), 'matrice inversa');
});

test('una scrittura fallita non si ripete e non si dichiara riuscita', async () => {
  const { app, provider } = ambiente({ crea: 'nega', risposte: ['Ho creato la bozza Autovalori nella cartella autorizzata.\n' + nota('Bozze/Autovalori', '# A')] });
  app.permessi.impostaLivello('obsidian', 'bozza', 'nega');
  const { r } = await chiedi(app, 'Crea una bozza sugli autovalori');
  assert.equal(r.ok, true);
  assert.ok(!esiste('Bozze/Autovalori.md'));
  assert.match(r.testo, /Non sono riuscito a creare `Bozze\/Autovalori`/);
  assert.doesNotMatch(r.testo, /Nota creata/);
  assert.equal(provider.conteggio('produttore'), 1);
  assert.equal(app.audit.elenca().filter(a => a.azione === 'crea_nota').length, 1);
});

test('"ho creato la bozza" senza nessuna scrittura eseguita viene tolto (integrazione spenta o blocco assente)', async () => {
  for (const abilita of [false, true]) {
    const { app } = ambiente({ abilita, risposte: ['Ecco la sintesi: gli autovalori sono radici. Ho creato la bozza "Autovalori" nella cartella autorizzata.'] });
    const { r } = await chiedi(app, 'Crea una bozza sugli autovalori');
    assert.doesNotMatch(r.testo, /Ho creato la bozza/);
    assert.match(r.testo, /Non ho scritto nulla nel vault/);
    assert.match(r.testo, /radici/);                                       // il contenuto utile resta
    assert.equal(/disattivata/.test(r.testo), !abilita);
  }
});

test('stile: istruzione di sintesi solo per i compiti operativi, nessun vincolo per spiegazioni e documenti', async () => {
  const sintetico = [];
  for (const [messaggio, atteso] of [['Cerca i miei appunti sulle matrici', true], ['Crea una bozza sugli autovalori', true], ['Spiegami nel dettaglio gli autovalori', false], ['Cerca e riassumi gli appunti sulle matrici', false], ['Cosa sono gli autovalori?', false], ['Fammi un riepilogo delle cose da fare', false]]) {
    const { app, provider } = ambiente({ risposte: ['Risposta di prova.'], area: '' });
    await chiedi(app, messaggio);
    sintetico.push(/in una o due frasi/.test(provider.chiamate.find(c => c.ruolo === 'produttore').system));
    assert.equal(sintetico.at(-1), atteso, messaggio);
  }
});

test('una risposta estesa richiesta non viene accorciata dal codice', async () => {
  const lunga = 'Gli autovalori sono... '.repeat(80);
  const { app } = ambiente({ risposte: [lunga] });
  const { r } = await chiedi(app, 'Spiegami nel dettaglio gli autovalori');
  assert.equal(r.ok, true);
  assert.equal(r.testo, lunga.trim());
});

test('errori: messaggio pulito all\'utente, dettagli tecnici solo negli eventi diagnostici', async () => {
  const grezzo = 'Claude Code ha restituito un errore (codice 1): Traceback at C:\\segreto\\file.js:12';
  const { app } = ambiente({ produttore: () => { throw new OrbitError('BAD_RESPONSE', grezzo); } });
  const { r, eventi } = await chiedi(app, 'ciao come stai');
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.errore, /Traceback|codice 1|segreto/);
  assert.match(r.errore, /Riprova/);
  const ev = eventi.find(e => e.tipo === 'errore');
  assert.match(ev.dettaglio, /Traceback/);
  const salvata = app.storage.richiesta(r.richiesta);
  assert.match(JSON.stringify(salvata), /Traceback/);
  assert.equal(A.erroreUtente('X', 'Errore\n    at fn (file.js:1:1)\n    at altra'), 'Errore');
});

test('errore di autenticazione: nessuna escalation verso altri modelli, un solo tentativo', async () => {
  const { app, provider } = ambiente({ produttore: () => { throw new OrbitError('NOT_LOGGED_IN', 'Claude Code non e collegato al tuo abbonamento.', { fatal: true }); } });
  const { r, eventi } = await chiedi(app, 'spiegami gli autovalori');
  assert.equal(r.codice, 'NOT_LOGGED_IN');
  assert.equal(provider.conteggio('produttore'), 1);
  assert.ok(!eventi.some(e => e.tipo === 'escalation'));
});

test('area bozze nella configurazione: spenta di default, valida o rifiutata con un problema chiaro', () => {
  const carica = env => config.carica({ envProcesso: Object.assign({ ORBIT_ENV_FILE: 'C:\\inesistente\\.env', ORBIT_DATA_DIR: path.join(BASE, 'dati') }, env), envFile: 'C:\\inesistente\\.env' });
  assert.equal(carica({}).settings.areaBozze, '');
  assert.equal(carica({ ORBIT_AREA_BOZZE: 'progetti/Orbit/bozze' }).settings.areaBozze, 'progetti/Orbit/bozze');
  for (const x of ['../fuori', '.obsidian', 'C:\\Windows']) {
    const c = carica({ ORBIT_AREA_BOZZE: x });
    assert.equal(c.settings.areaBozze, '', x);
    assert.ok(c.problemi.some(p => p.code === 'AREA_BOZZE'), x);
  }
});

test('il vault sintetico non cambia durante le prove di sola lettura', async () => {
  const prima = snapshot();
  const { app } = ambiente({ risposte: ['<orbit_strumento nome="obsidian.cerca_note">{"query": "autovalori"}</orbit_strumento>', 'Trovata: corsi/autovalori.md.'] });
  await chiedi(app, 'Cerca i miei appunti sugli autovalori');
  assert.deepEqual(snapshot(), prima);
});

test('area bozze: crea=nega resta negato anche dentro l\'area, e bozza=nega non rende l\'area piu restrittiva', async () => {
  const { app } = ambiente({ crea: 'nega' });
  const r = await app.integrazioni.esegui('obsidian', 'crea_nota', { percorso: 'Bozze/n1', contenuto: '# n1' });
  assert.equal(r.codice, 'NEGATA'); assert.ok(!esiste('Bozze/n1.md'));
  const b = ambiente({ crea: 'consenti' });
  b.app.permessi.impostaLivello('obsidian', 'bozza', 'nega');
  const r2 = await b.app.integrazioni.esegui('obsidian', 'crea_nota', { percorso: 'Bozze/n2', contenuto: '# n2' });
  assert.equal(r2.ok, true);
  fs.rmSync(path.join(V, 'Bozze'), { recursive: true, force: true });
});

test('una bozza di mail non e una scrittura nel vault e il suo testo non viene cancellato', async () => {
  assert.equal(rilevaScritturaNota('scrivimi una bozza di mail per il prof'), false);
  const { app } = ambiente({ abilita: false, risposte: ['Ho preparato la bozza della mail:\nGentile professore, vorrei un ricevimento.\nCordiali saluti, Marco'] });
  const { r } = await chiedi(app, 'scrivimi una bozza di mail per il prof');
  assert.match(r.testo, /Gentile professore/); assert.match(r.testo, /Cordiali saluti/);
  const t = A.togliDichiarazioniScrittura('Ho preparato la bozza della mail:\nCorpo.\nNon ho creato la nota perche manca la cartella. La Repubblica e stata creata nel 1946.');
  assert.equal(t.rimosse, true);
  assert.match(t.testo, /Corpo\./); assert.match(t.testo, /Non ho creato la nota/); assert.match(t.testo, /Repubblica/);
});

test('junction dentro l\'area: la categoria B vale solo se la destinazione reale resta nell\'area', async (t) => {
  const j = path.join(V, 'Bozze', 'fuga'), ok = path.join(V, 'Bozze', 'interna'), pendente = path.join(V, 'Bozze', 'pendente');
  fs.mkdirSync(path.join(V, 'Bozze', 'reale'), { recursive: true });
  try { fs.symlinkSync(path.join(V, 'corsi'), j, 'junction'); fs.symlinkSync(path.join(V, 'Bozze', 'reale'), ok, 'junction'); fs.symlinkSync(path.join(BASE, 'non-esiste'), pendente, 'junction'); } catch (e) { return t.skip('junction non creabili in questo ambiente'); }
  try {
    const { app } = ambiente({ crea: 'conferma' });
    const via = async percorso => {
      const conferme = [];
      const r = await app.integrazioni.esegui('obsidian', 'crea_nota', { percorso, contenuto: '# x' }, { onConferma: i => { conferme.push(i); setImmediate(() => app.permessi.rispondi(i.id, false)); } });
      return { r, conferme };
    };
    for (const p of ['Bozze/fuga/uscita', 'Bozze/fuga/nuova/uscita', 'Bozze/pendente/x']) {
      const { r, conferme } = await via(p);
      assert.equal(conferme.length, 1, p); assert.equal(r.ok, false, p);
    }
    assert.ok(!esiste('corsi/uscita.md') && !esiste('corsi/nuova/uscita.md'));
    const buona = await via('Bozze/interna/ok');
    assert.equal(buona.conferme.length, 0); assert.equal(buona.r.categoria, 'B');
  } finally {
    for (const x of [j, ok, pendente]) { try { fs.rmdirSync(x); } catch (e) { /* assente */ } }
    fs.rmSync(path.join(V, 'Bozze'), { recursive: true, force: true });
  }
});

test('recupero: la riformulazione conserva #tag, tag: e cartella:', () => {
  assert.equal(A.queryAlternativa('dimmi tutto sulla matrice inversa con Cramer #fam cartella:corsi'), 'matrice inversa #fam cartella:corsi');
  assert.equal(A.queryAlternativa('matrici #fam'), null);
});

test('area che e essa stessa una junction verso un\'altra cartella: nessuna categoria B', async (t) => {
  const area = path.join(V, 'Bozze');
  try { fs.symlinkSync(path.join(V, 'corsi'), area, 'junction'); } catch (e) { return t.skip('junction non creabili in questo ambiente'); }
  try {
    const { app } = ambiente({ crea: 'conferma' });
    const conferme = [];
    await app.integrazioni.esegui('obsidian', 'crea_nota', { percorso: 'Bozze/x', contenuto: '# x' }, { onConferma: i => { conferme.push(i); setImmediate(() => app.permessi.rispondi(i.id, false)); } });
    assert.equal(conferme.length, 1); assert.ok(!esiste('corsi/x.md'));
  } finally { fs.rmdirSync(area); }
});

test('una nota dichiarata creata senza blocco, con un altro salvataggio fallito, non resta dichiarata', async () => {
  const { app } = ambiente({ area: '', risposte: ['Ho creato la nota sulle matrici in corsi.\n<orbit_ricorda nota="cervello/x" sezione="S">fatto di prova</orbit_ricorda>'] });
  app.permessi.impostaLivello('obsidian', 'crea', 'nega');
  const { r } = await chiedi(app, 'Crea una nota in corsi con il riassunto sulle matrici');
  assert.doesNotMatch(r.testo, /Ho creato la nota/);
  assert.ok(!esiste('corsi/matrici-riassunto.md'));
});

test('esiti delle scritture: successo completo, fallimento completo, successo parziale', async () => {
  const due = 'Ho creato le due bozze.\n' + nota('Bozze/Uno', '# Uno') + '\n' + nota('Bozze/Due', '# Due');
  const tutte = await chiedi(ambiente({ risposte: [due] }).app, 'Crea due bozze');
  assert.match(tutte.r.testo, /Nota creata: `Bozze\/Uno\.md`/); assert.match(tutte.r.testo, /Nota creata: `Bozze\/Due\.md`/);
  assert.doesNotMatch(tutte.r.testo, /solo in parte|Non sono riuscito/);
  fs.rmSync(path.join(V, 'Bozze'), { recursive: true, force: true });

  const nessuna = ambiente({ crea: 'nega', risposte: [due] }); nessuna.app.permessi.impostaLivello('obsidian', 'bozza', 'nega');
  const n = await chiedi(nessuna.app, 'Crea due bozze');
  assert.doesNotMatch(n.r.testo, /Ho creato|Nota creata|solo in parte/);
  assert.equal((n.r.testo.match(/Non sono riuscito a creare/g) || []).length, 2);

  const mista = ambiente({ risposte: ['Ho creato le due bozze.\n' + nota('Bozze/Uno', '# Uno') + '\n' + nota('corsi/Fuori', '# Fuori')] });
  const p = await chiedi(mista.app, 'Crea due bozze', { approva: false });
  assert.match(p.r.testo, /Nota creata: `Bozze\/Uno\.md`/);
  assert.match(p.r.testo, /Non sono riuscito a creare `corsi\/Fuori`/);
  assert.match(p.r.testo, /solo in parte: 1 scritture su 2/);
  assert.doesNotMatch(p.r.testo, /Ho creato le due/);
  assert.ok(esiste('Bozze/Uno.md')); assert.ok(!esiste('corsi/Fuori.md'));
  assert.equal(mista.provider.conteggio('produttore'), 1);
  assert.equal(mista.app.audit.elenca().filter(a => a.azione === 'crea_nota' && a.esito === 'completata').length, 1);
  assert.equal(p.conferme.length, 1);
  fs.rmSync(path.join(V, 'Bozze'), { recursive: true, force: true });
});
