'use strict';
// Catalogo e copertura: solo dati sintetici in una cartella temporanea, mai il vault reale.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { leggiSnapshot } = require('../reader');
const { pianifica, verificaPiano } = require('../planner');

const SORGENTI = ['Ricette', 'Idee', 'Film', 'Libri'];
function prepara(catalogo = {}, { cartella = true, sorgenti = Object.fromEntries(SORGENTI.map(s => [s, '- voce ' + s + '\n'])) } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-catalogo-sintetico-'));
  fs.mkdirSync(path.join(r, 'to sort')); if (cartella) fs.mkdirSync(path.join(r, 'liste'));
  for (const [n, t] of Object.entries(catalogo)) fs.writeFileSync(path.join(r, n), t);
  for (const [n, t] of Object.entries(sorgenti)) fs.writeFileSync(path.join(r, 'to sort', n + '.md'), t);
  const s = leggiSnapshot({ radice: r, autorizzati: ['liste'], creaIn: ['liste'], verificaReparse: () => false });
  return { r, s, crea: Object.fromEntries(s.sorgenti.map(x => [x.percorso, 'liste'])) };
}
const valuta = rel => ({ candidati }) => ({ valutazioni: candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: rel })) });
const esiti = p => p.decisioni.map(d => d.esito);

test('catalogo consultato, nessuna nota equivalente: CREATE per tutte e quattro, senza conferma di catalogo', async () => {
  const { s, crea } = prepara({ 'liste/Altro.md': '# Altro\n- x\n' });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.deepEqual(esiti(p), ['CREATE', 'CREATE', 'CREATE', 'CREATE']); assert.equal(p.operazioni.length, 4);
  assert.deepEqual(verificaPiano(p, s), { valido: true, motivi: [] });
  assert.ok(p.operazioni.every(o => o.destinazione.percorso.startsWith('liste/') && o.content === s.sorgenti.find(x => x.percorso === o.sorgente.percorso).testo));
});

test('note di catalogo con parsing parziale non rendono incompleto tutto il catalogo', async () => {
  const { s, crea } = prepara({ 'liste/Cod.md': '# Codice\n    ```js\n- x\n', 'liste/Altro.md': '# Altro\n- x\n' });
  assert.ok(s.copertura.problemi.some(x => x.code === 'MARKDOWN_PARZIALMENTE_SUPPORTATO' && x.percorso === 'liste/Cod.md'));
  assert.equal(s.copertura.completa, true);
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.deepEqual(esiti(p), ['CREATE', 'CREATE', 'CREATE', 'CREATE']);
});

test('nota equivalente con parsing parziale: mai MERGE, CONFIRM', async () => {
  const { s, crea } = prepara({ 'liste/Film.md': '# Film\n    ```js\n- vecchio\n' }, { sorgenti: { Film: '- Dune\n' } });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('equivalente') });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0);
});

test('MERGE con equivalente certo resta possibile e verificato', async () => {
  const { s, crea } = prepara({ 'liste/Film da vedere.md': '# Film da vedere\n- Matrix\n' }, { sorgenti: { 'Film da guardare': '- Dune\n' } });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('equivalente') });
  assert.equal(p.decisioni[0].esito, 'MERGE'); assert.equal(p.operazioni[0].aggiunte[0].content, '- Dune');
  assert.deepEqual(verificaPiano(p, s), { valido: true, motivi: [] });
});

test('equivalenti ambigui: CONFIRM', async () => {
  const { s, crea } = prepara({ 'liste/Film da vedere.md': '# Film da vedere\n- Matrix\n', 'liste/Film da guardare ora.md': '# Film da guardare ora\n- Alien\n' }, { sorgenti: { 'Film da guardare': '- Dune\n' } });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('equivalente') });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0);
});

test('errore reale di catalogazione (file non leggibile): CATALOGO_INCOMPLETO con codice visibile, nessun CREATE', async () => {
  const { s, crea } = prepara({ 'liste/Grande.md': 'x'.repeat(600000) });
  assert.equal(s.copertura.completa, false);
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.ok(p.decisioni.every(d => d.esito === 'CONFIRM' && d.motivi[0] === 'CATALOGO_INCOMPLETO'));
  assert.ok(p.decisioni[0].problemiCatalogo.some(x => x.percorso === 'liste/Grande.md' && x.code === 'LIMITE_LETTURA')); assert.equal(p.operazioni.length, 0);
});

test('protezione da duplicati: stesso contenuto con titolo diverso e nota gia presente non crea', async () => {
  const { s, crea } = prepara({ 'liste/Ricette.md': '# Ricette\n- voce Ricette\n' }, { sorgenti: { Ricette: '- voce Ricette\n' } });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.notEqual(p.decisioni[0].esito, 'CREATE'); assert.equal(p.operazioni.length, 0);
});

test('cartella di creazione assente: motivo dedicato, non CATALOGO_INCOMPLETO (il Safe Writer non crea cartelle)', async () => {
  const { s, crea } = prepara({}, { cartella: false });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.ok(p.decisioni.every(d => d.esito === 'CONFIRM' && d.motivi[0] === 'CARTELLA_DESTINAZIONE_ASSENTE')); assert.equal(p.operazioni.length, 0);
  assert.equal(s.copertura.completa, true);   // coerente con il writer: nessuna nota nascosta, nessun CREATE pianificato
});

test('verificaPiano rifiuta MERGE su bersaglio con parsing parziale', async () => {
  const { s, crea } = prepara({ 'liste/Film da vedere.md': '# Film da vedere\n- Matrix\n' }, { sorgenti: { 'Film da guardare': '- Dune\n' } });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('equivalente') });
  const falso = JSON.parse(JSON.stringify(s)); falso.copertura.problemi.push({ percorso: 'liste/Film da vedere.md', code: 'MARKDOWN_PARZIALMENTE_SUPPORTATO' });
  assert.equal(verificaPiano(p, falso).valido, false);
});

// --- create_dir: cartella assente di creaIn, creata nello stesso piano e nella stessa conferma ---
const { prepara: anteprima } = require('../writer');
const { impronta } = require('../policy');
function conCartella({ creaInDir = 'liste/nuova', crea = true, sorgenti, extra = {} } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-mkdir-sintetico-'));
  for (const d of ['to sort', 'liste']) fs.mkdirSync(path.join(r, d));
  if (crea) fs.mkdirSync(path.join(r, creaInDir), { recursive: true });
  for (const [n, t] of Object.entries(extra)) fs.writeFileSync(path.join(r, n), t);
  for (const [n, t] of Object.entries(sorgenti || Object.fromEntries(SORGENTI.map(s => [s, '- voce ' + s + '\n'])))) fs.writeFileSync(path.join(r, 'to sort', n + '.md'), t);
  const s = leggiSnapshot({ radice: r, autorizzati: ['liste'], creaIn: [creaInDir], verificaReparse: () => false });
  return { r, s, crea: Object.fromEntries(s.sorgenti.map(x => [x.percorso, creaInDir])) };
}
const riGenera = body => { const h = impronta(body); return { ...body, id: 'piano-' + h.slice(0, 24), impronta: h }; };

test('create_dir: cartella assente con genitore esistente: CREATE, mkdirs nell\'anteprima, nessuna seconda conferma', async () => {
  const { s, crea } = conCartella({ crea: false });
  assert.equal(s.copertura.completa, true);
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.deepEqual(esiti(p), ['CREATE', 'CREATE', 'CREATE', 'CREATE']); assert.deepEqual(p.cartelleDaCreare, ['liste/nuova']);
  assert.deepEqual(verificaPiano(p, s), { valido: true, motivi: [] });
  const a = anteprima(p, s);
  assert.deepEqual(a.spec.mkdirs.map(m => m.path), ['liste/nuova']);   // una sola cartella, nella stessa preview (stesso hash) del piano
  assert.ok(a.spec.outputs.every(o => o.kind === 'create' && o.path.startsWith('liste/nuova/')));
});

test('create_dir: cartella gia esistente: nessuna cartella da creare', async () => {
  const { s, crea } = conCartella({ crea: true });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.deepEqual(p.cartelleDaCreare, []); assert.deepEqual(anteprima(p, s).spec.mkdirs, []);
});

test('create_dir: genitore assente o catena di cartelle: CONFIRM, nessuna creazione', async () => {
  for (const dir of ['liste/a/b', 'altra']) {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-mkdir-sintetico-'));
    for (const d of ['to sort', 'liste']) fs.mkdirSync(path.join(r, d));
    fs.writeFileSync(path.join(r, 'to sort', 'Ricette.md'), '- x\n');
    const aut = dir === 'altra' ? ['liste', 'altra'] : ['liste'];
    const s = leggiSnapshot({ radice: r, autorizzati: aut, creaIn: [dir], verificaReparse: () => false });
    const p = await pianifica(s, { creaIn: { 'to sort/Ricette.md': dir }, valuta: valuta('distinta') });
    assert.equal(p.decisioni[0].esito === 'CREATE', false, dir); assert.deepEqual(p.cartelleDaCreare, []); assert.equal(p.operazioni.length, 0);
  }
});

test('create_dir: traversal, cartelle fuori ambito e creaIn non autorizzate rifiutate dal reader', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-mkdir-sintetico-'));
  for (const d of ['to sort', 'liste', 'altro']) fs.mkdirSync(path.join(r, d));
  for (const dir of ['liste/../fuori', '../fuori', 'altro/nuova', 'to sort/nuova', 'cervello/nuova', 'liste/.nascosta']) {
    assert.throws(() => leggiSnapshot({ radice: r, autorizzati: ['liste'], creaIn: [dir], verificaReparse: () => false }), e => !!e.code, dir);
  }
});

test('create_dir: piano manomesso (cartelle in piu, fuori ambito o non usate) rifiutato anche con hash ricalcolato', async () => {
  const { s, crea } = conCartella({ crea: false });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  const { id, impronta: h, ...body } = p;
  for (const lista of [['liste/nuova', 'liste/altra'], ['../fuori'], ['liste'], [], ['liste/nuova', 'liste/nuova']]) {
    const falso = riGenera({ ...JSON.parse(JSON.stringify(body)), cartelleDaCreare: lista });
    assert.equal(verificaPiano(falso, s).valido, false, JSON.stringify(lista));
    assert.throws(() => anteprima(falso, s));
  }
});

test('create_dir: junction al posto della cartella di creazione: catalogo incompleto, nessun CREATE', async () => {
  const fuori = fs.mkdtempSync(path.join(os.tmpdir(), 'si-fuori-sintetico-'));
  const { r, s: s0 } = conCartella({ crea: false });
  fs.symlinkSync(fuori, path.join(r, 'liste', 'nuova'), 'junction');
  const s = leggiSnapshot({ radice: r, autorizzati: ['liste'], creaIn: ['liste/nuova'], verificaReparse: () => false });
  assert.ok(s.copertura.problemi.some(x => x.code === 'LINK_O_REPARSE')); assert.equal(s.copertura.completa, false);
  const p = await pianifica(s, { creaIn: Object.fromEntries(s.sorgenti.map(x => [x.percorso, 'liste/nuova'])), valuta: valuta('distinta') });
  assert.ok(p.decisioni.every(d => d.esito === 'CONFIRM')); assert.equal(p.operazioni.length, 0); assert.deepEqual(p.cartelleDaCreare, []);
  assert.deepEqual(fs.readdirSync(fuori), []); assert.ok(s0);   // niente scritto fuori dal perimetro
});

test('create_dir: creaIn che differisce solo per maiuscole da una cartella esistente non e "da creare"', async () => {
  const { r } = conCartella({ creaInDir: 'liste/nuova', crea: true });
  const s = leggiSnapshot({ radice: r, autorizzati: ['liste'], creaIn: ['liste/Nuova'], verificaReparse: () => false });
  const p = await pianifica(s, { creaIn: Object.fromEntries(s.sorgenti.map(x => [x.percorso, 'liste/Nuova'])), valuta: valuta('distinta') });
  assert.deepEqual(p.cartelleDaCreare, []);   // su NTFS 'Nuova' e 'nuova' sono la stessa cartella: nessun mkdir
});

// --- Regressione "Organizza to sort" bloccato: reparse incompleto su note con nomi non ASCII + sottoalbero protetto in una radice autorizzata ---
const { errore } = require('../policy');
const NOTION = [
  'Notion/Introduzione agli algoritmi – Schema.md', 'Notion/Introduzione al C – Schema.md',
  'Notion/Polimi/Databases/Notes/Rappresentazione dell’informazione – Schema.md', 'Notion/Polimi/Databases/Notes/Strutture di controllo – Schema.md',
  'Notion/Polimi/Databases/Notes/Tipi di dato e array – Schema.md'];
function vaultNotion({ incompleti = [], extra = {}, sorgenti, protettoOrbit = true } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-catalogo-sintetico-'));
  for (const d of ['to sort', 'smart inbox', 'Notion/Polimi/Databases/Notes', 'progetti']) fs.mkdirSync(path.join(r, d), { recursive: true });
  if (protettoOrbit) { fs.mkdirSync(path.join(r, 'progetti/Orbit')); fs.writeFileSync(path.join(r, 'progetti/Orbit/Segreto.md'), 'CONTENUTO_SINTETICO_NON_LEGGERE\n'); }
  fs.writeFileSync(path.join(r, 'progetti/Altro progetto.md'), '# Altro progetto\n- x\n');
  for (const n of NOTION) fs.writeFileSync(path.join(r, n), '# ' + path.basename(n, '.md') + '\n- schema sintetico\n');
  for (const [n, t] of Object.entries(extra)) fs.writeFileSync(path.join(r, n), t);
  const src = sorgenti || { 'Film da vedere': '- Dune\n', 'Informazioni Ipad': '- Ipad 10\n', 'Opening scacchi': '- Italiana\n', 'Serie TV da vedere': '- Severance\n' };
  for (const [n, t] of Object.entries(src)) fs.writeFileSync(path.join(r, 'to sort', n + '.md'), t);
  const letti = [];
  const s = leggiSnapshot({ radice: r, autorizzati: ['Notion', 'progetti', 'smart inbox'], creaIn: ['smart inbox'],
    verificaReparse: p => { if (incompleti.some(i => p.endsWith(i.split('/').join(path.sep)))) throw errore('VERIFICA_REPARSE_INCOMPLETA'); letti.push(p); return false; } });
  return { r, s, crea: Object.fromEntries(s.sorgenti.map(x => [x.percorso, 'smart inbox'])) };
}

test('reparse: cinque note Notion non verificabili e catalogo cosi: CONFIRM globale con dipendenza esplicita (tutti i problemi, non i primi 5)', async () => {
  const { s, crea } = vaultNotion({ incompleti: NOTION });
  assert.equal(s.copertura.completa, false);
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.ok(p.decisioni.every(d => d.esito === 'CONFIRM' && d.motivi[0] === 'CATALOGO_INCOMPLETO'));
  const d = p.decisioni[0];
  assert.deepEqual(d.problemiCatalogo.map(x => x.percorso).sort(), [...NOTION].sort()); assert.ok(d.problemiCatalogo.every(x => x.code === 'VERIFICA_REPARSE_INCOMPLETA'));
  assert.equal(d.problemiCatalogoTotale, 5); assert.equal(p.operazioni.length, 0);
});

test('reparse: piu di 5 problemi sono tutti riportati (nessun taglio che nasconda la causa)', async () => {
  const extra = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['Notion/Extra – ' + i + '.md', '# x\n']));
  const { s, crea } = vaultNotion({ extra, incompleti: [...NOTION, ...Object.keys(extra)] });
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  assert.equal(p.decisioni[0].problemiCatalogoTotale, 17); assert.equal(p.decisioni[0].problemiCatalogo.length, 17);
});

test('protetto: progetti/Orbit dentro una radice autorizzata non rende incompleto il catalogo, resta non letto, i casi sicuri si pianificano', async () => {
  const { s, crea } = vaultNotion({});
  assert.ok(s.copertura.problemi.some(x => x.code === 'DESTINAZIONE_PROTETTA' && x.percorso === 'progetti/Orbit'));   // la segnalazione resta visibile
  assert.equal(s.copertura.completa, true);
  assert.ok(!s.catalogo.some(n => /Segreto/.test(n.percorso) || /CONTENUTO_SINTETICO/.test(n.testo)), 'contenuto protetto mai letto');
  const p = await pianifica(s, { creaIn: crea, valuta: valuta('distinta') });
  // 'Film da vedere' e 'Serie TV da vedere' sono due note nuove con titoli simili: il planner chiede conferma su una delle due (protezione da duplicati, non un effetto del catalogo)
  assert.deepEqual(esiti(p), ['CREATE', 'CREATE', 'CREATE', 'CONFIRM']); assert.equal(p.decisioni[3].motivi[0], 'NUOVA_NOTA_POTENZIALMENTE_EQUIVALENTE');
  assert.ok(p.operazioni.every(o => o.destinazione.percorso.startsWith('smart inbox/')));
  const sicuri = vaultNotion({ sorgenti: { Ricette: '- pasta\n', Idee: '- app\n' } }), p2 = await pianifica(sicuri.s, { creaIn: sicuri.crea, valuta: valuta('distinta') });
  assert.deepEqual(verificaPiano(p2, sicuri.s), { valido: true, motivi: [] }); assert.equal(anteprima(p2, sicuri.s).spec.outputs.length, 2);   // il Safe Writer accetta il piano (completa=true)
});

test('protetto: un sorgente in to sort con percorso protetto resta bloccante (non viene saltato in silenzio)', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-catalogo-sintetico-'));
  for (const d of ['to sort', 'liste']) fs.mkdirSync(path.join(r, d));
  fs.mkdirSync(path.join(r, 'to sort/scadenze')); fs.writeFileSync(path.join(r, 'to sort/scadenze/Esami.md'), '# Esami\n'); fs.writeFileSync(path.join(r, 'to sort/Ricette.md'), '- x\n');
  const s = leggiSnapshot({ radice: r, autorizzati: ['liste'], creaIn: ['liste'], verificaReparse: () => false });
  assert.ok(s.copertura.problemi.some(x => x.code === 'DESTINAZIONE_PROTETTA' && x.percorso.startsWith('to sort/'))); assert.equal(s.copertura.completa, false);
});

test('reparse: stesso vault con nomi non ASCII verificati (bridge corretto): sicuro = CREATE, duplicato certo = NOOP, duplicato fra note non verificabili = CONFIRM', async () => {
  // 1) tutto verificato: Ricette/Idee senza duplicati si pianificano, Film da vedere gia presente identico e NOOP
  const extra = { 'Notion/Film da vedere.md': '# Film da vedere\n- Dune\n' };
  const ok = vaultNotion({ extra, sorgenti: { Ricette: '- pasta\n', Idee: '- app\n', 'Film da vedere': '- Dune\n' } });
  const p1 = await pianifica(ok.s, { creaIn: ok.crea, valuta: valuta('distinta') });
  const per = Object.fromEntries(p1.decisioni.map(d => [d.sorgente.percorso.split('/').pop(), d.esito]));
  assert.deepEqual(per, { 'Film da vedere.md': 'NOOP', 'Idee.md': 'CREATE', 'Ricette.md': 'CREATE' });
  assert.equal(p1.operazioni.filter(o => o.tipo === 'create_note').length, 2);
  // 2) un possibile duplicato proprio fra le note non verificabili: nessun CREATE ne MERGE, motivo e note elencati
  const dup = vaultNotion({ extra: { 'Notion/Serie TV da vedere – Schema.md': '# Serie TV da vedere\n- Severance\n' }, incompleti: ['Notion/Serie TV da vedere – Schema.md'],
    sorgenti: { 'Serie TV da vedere': '- Severance\n', Ricette: '- pasta\n' } });
  const p2 = await pianifica(dup.s, { creaIn: dup.crea, valuta: valuta('distinta') });
  assert.ok(p2.decisioni.every(d => d.esito === 'CONFIRM' && d.motivi[0] === 'CATALOGO_INCOMPLETO')); assert.equal(p2.operazioni.length, 0);
  assert.deepEqual(p2.decisioni[0].problemiCatalogo.map(x => x.percorso), ['Notion/Serie TV da vedere – Schema.md']);
});

test('reparse: nessun MERGE su una nota non verificata, anche con valutazione "equivalente"', async () => {
  const x = vaultNotion({ extra: { 'Notion/Film da vedere – Schema.md': '# Film da vedere\n- Alien\n' }, incompleti: ['Notion/Film da vedere – Schema.md'], sorgenti: { 'Film da guardare': '- Dune\n' } });
  const p = await pianifica(x.s, { creaIn: x.crea, valuta: valuta('equivalente') });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.operazioni.length, 0);
});

for (const dir of ['Notion/Database', 'Notion/public', 'Notion/src']) test('protetto: cartella protetta per nome tecnico NON e una scorciatoia (' + dir + '): un duplicato li dentro mantiene CONFIRM', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-catalogo-sintetico-'));
  for (const d of ['to sort', 'smart inbox', dir]) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, dir, 'Film da vedere.md'), '# Film da vedere\n- Dune\n'); fs.writeFileSync(path.join(r, 'to sort/Film da vedere.md'), '# Film da vedere\n- Dune\n');
  const s = leggiSnapshot({ radice: r, autorizzati: ['Notion', 'smart inbox'], creaIn: ['smart inbox'], verificaReparse: () => false });
  assert.ok(s.copertura.problemi.some(x => x.code === 'DESTINAZIONE_PROTETTA' && x.percorso === dir)); assert.equal(s.copertura.completa, false);
  const p = await pianifica(s, { creaIn: { 'to sort/Film da vedere.md': 'smart inbox' }, valuta: valuta('equivalente') });
  assert.equal(p.decisioni[0].esito, 'CONFIRM'); assert.equal(p.decisioni[0].motivi[0], 'CATALOGO_INCOMPLETO'); assert.equal(p.operazioni.length, 0);
  assert.deepEqual(p.decisioni[0].problemiCatalogo.map(x => x.percorso), [dir]);
});

test('protetto: .md protetto per nome (token, secret) in una radice autorizzata resta bloccante', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-catalogo-sintetico-'));
  for (const d of ['to sort', 'smart inbox', 'Notion']) fs.mkdirSync(path.join(r, d));
  fs.writeFileSync(path.join(r, 'Notion/Token API.md'), '# Token\n'); fs.writeFileSync(path.join(r, 'to sort/Ricette.md'), '- x\n');
  const s = leggiSnapshot({ radice: r, autorizzati: ['Notion', 'smart inbox'], creaIn: ['smart inbox'], verificaReparse: () => false });
  assert.equal(s.copertura.completa, false);
});

test('protetto: progetti/Orbit non blocca, e le decisioni dichiarano cosa non e stato confrontato', async () => {
  const x = vaultNotion({ sorgenti: { Ricette: '- pasta\n' } });
  const s = leggiSnapshot({ radice: x.r, autorizzati: ['Notion', 'progetti', 'smart inbox'], creaIn: ['smart inbox'], verificaReparse: () => false });
  assert.equal(s.copertura.completa, true);
  const p = await pianifica(s, { creaIn: x.crea, valuta: valuta('distinta') });
  assert.equal(p.decisioni[0].esito, 'CREATE'); assert.deepEqual(p.decisioni[0].esclusiPerPolicy, ['progetti/Orbit']);
});

// pulizia delle cartelle temporanee sintetiche create da questi test
process.on('exit', () => { for (const d of fs.readdirSync(os.tmpdir())) if (/^si-(mkdir|fuori|catalogo)-sintetico-/.test(d)) { try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch {} } });
