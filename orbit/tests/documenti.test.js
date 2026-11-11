'use strict';
// Incremento 2: documenti locali. Percorsi, link, file sensibili, limiti, formati e permessi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Storage } = require('../storage/db');
const { AuditLogger } = require('../integrations/audit');
const { PermissionManager } = require('../integrations/permessi');
const { IntegrationManager } = require('../integrations/registry');
const { creaIntegrazioneDocumenti, impostaCartelle, cartelleAutorizzate } = require('../integrations/documenti');
const { GuardiaPercorsi } = require('../integrations/documenti/percorsi');

function crc32(buf) { let c, crc = ~0; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function zip(voci) {   // archivio ZIP minimo (deflate) per i test
  const locali = [], centrali = []; let off = 0;
  for (const [nome, dati] of Object.entries(voci)) {
    const raw = Buffer.from(dati), comp = zlib.deflateRawSync(raw), n = Buffer.from(nome), crc = crc32(raw);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc, 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locali.push(l, n, comp); centrali.push(c, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrali), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(voci).length, 8); e.writeUInt16LE(Object.keys(voci).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locali, cd, e]);
}

function ambiente() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-doc-'));
  const radice = path.join(base, 'autorizzata'), fuori = path.join(base, 'fuori');
  fs.mkdirSync(path.join(radice, 'FAM'), { recursive: true }); fs.mkdirSync(path.join(radice, 'node_modules'), { recursive: true }); fs.mkdirSync(fuori);
  fs.writeFileSync(path.join(radice, 'FAM', 'appunti matrice inversa.txt'), 'La matrice inversa esiste se il determinante e diverso da zero.');
  fs.writeFileSync(path.join(radice, 'FAM', 'esercizi.md'), '# Esercizi\nCalcola la matrice inversa di A.');
  fs.writeFileSync(path.join(radice, 'FAM', 'tesi.docx'), zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Spazi vettoriali &amp; sottospazi</w:t></w:r></w:p><w:p><w:r><w:t>Base e dimensione</w:t></w:r></w:p></w:body></w:document>' }));
  fs.writeFileSync(path.join(radice, '.env'), 'CHIAVE=segreta');
  fs.writeFileSync(path.join(radice, 'password.txt'), 'hunter2');
  fs.writeFileSync(path.join(radice, 'id_rsa'), 'chiave privata');
  fs.writeFileSync(path.join(radice, 'node_modules', 'x.txt'), 'matrice inversa nascosta');
  fs.writeFileSync(path.join(radice, 'rotto.docx'), 'non sono uno zip');
  fs.writeFileSync(path.join(radice, 'binario.txt'), Buffer.from([1, 2, 0, 3, 4]));
  fs.writeFileSync(path.join(radice, 'video.mp4'), 'x');
  fs.writeFileSync(path.join(fuori, 'segreto.txt'), 'matrice inversa fuori dalla cartella');
  const storage = new Storage(':memory:');
  const audit = new AuditLogger({ storage });
  const permessi = new PermissionManager({ storage, audit });
  const mgr = new IntegrationManager({ permessi, audit });
  mgr.registra(creaIntegrazioneDocumenti({ storage }));
  impostaCartelle(storage, [radice]);
  permessi.impostaAbilitata('documenti', true);
  const pulisci = () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignora */ } };
  return { base, radice, fuori, storage, audit, permessi, mgr, pulisci, esegui: (s, p) => mgr.esegui('documenti', s, p) };
}

test('documenti: legge testo e DOCX dentro la cartella autorizzata', async () => {
  const a = ambiente();
  try {
    const t = await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'FAM', 'esercizi.md') });
    assert.equal(t.ok, true); assert.match(t.risultato.testo, /Calcola la matrice/);
    const d = await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'FAM', 'tesi.docx') });
    assert.equal(d.ok, true); assert.match(d.risultato.testo, /Spazi vettoriali & sottospazi\nBase e dimensione/);
  } finally { a.pulisci(); }
});

test('documenti: traversal, percorsi relativi, di rete, flussi NTFS e nulli sono respinti', async () => {
  const a = ambiente();
  try {
    const cattivi = [path.join(a.radice, 'FAM', '..', '..', 'fuori', 'segreto.txt'), 'FAM\\esercizi.md', '\\\\server\\share\\x.txt', path.join(a.radice, 'esercizi.md:stream'), path.join(a.radice, 'a\u0000b.txt'), path.join(a.radice, 'a?.txt'), path.join(a.fuori, 'segreto.txt'), 'C:\\Windows\\win.ini'];
    for (const p of cattivi) { const r = await a.esegui('leggi_documento', { percorso: p }); assert.equal(r.ok, false, 'doveva fallire: ' + JSON.stringify(p)); }
    // Un prefisso uguale non basta: "autorizzata-altro" non e dentro "autorizzata".
    const gemella = a.radice + '-altro'; fs.mkdirSync(gemella); fs.writeFileSync(path.join(gemella, 'x.txt'), 'x');
    assert.equal((await a.esegui('leggi_documento', { percorso: path.join(gemella, 'x.txt') })).ok, false);
  } finally { a.pulisci(); }
});

test('documenti: una junction o un link verso l\'esterno non permette di uscire', async () => {
  const a = ambiente();
  try {
    const link = path.join(a.radice, 'scorciatoia');
    try { fs.symlinkSync(a.fuori, link, 'junction'); } catch (e) { return; }   // piattaforma senza link: niente da provare
    assert.equal((await a.esegui('leggi_documento', { percorso: path.join(link, 'segreto.txt') })).ok, false);
    assert.equal((await a.esegui('elenca_cartella', { cartella: link })).ok, false);
    const ric = await a.esegui('cerca_contenuto', { query: 'fuori dalla cartella' });
    assert.equal(ric.ok, true); assert.equal(ric.risultato.trovati.length, 0);
    const nomi = await a.esegui('cerca_file', { query: 'segreto' });
    assert.equal(nomi.risultato.trovati.length, 0);
  } finally { a.pulisci(); }
});

test('documenti: file e cartelle sensibili non si leggono ne si trovano, anche per nome esatto', async () => {
  const a = ambiente();
  try {
    for (const f of ['.env', 'password.txt', 'id_rsa']) assert.equal((await a.esegui('leggi_documento', { percorso: path.join(a.radice, f) })).ok, false, f);
    assert.equal((await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'node_modules', 'x.txt') })).ok, false);
    const l = await a.esegui('elenca_cartella', { cartella: a.radice });
    const nomi = l.risultato.voci.map(v => v.nome);
    for (const vietato of ['.env', 'password.txt', 'id_rsa', 'node_modules']) assert.ok(!nomi.includes(vietato), vietato);
    const c = await a.esegui('cerca_contenuto', { query: 'matrice inversa' });
    assert.ok(c.risultato.trovati.every(x => !/node_modules|fuori/.test(x.percorso)));
    assert.equal(c.risultato.trovati.length, 2);   // appunti ed esercizi (node_modules e la cartella esterna restano fuori)
  } finally { a.pulisci(); }
});

test('documenti: formati non leggibili, file corrotti e binari danno errori chiari', async () => {
  const a = ambiente();
  try {
    assert.match((await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'video.mp4') })).errore, /Formato non leggibile/);
    assert.match((await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'rotto.docx') })).errore, /non leggibile|valido/);
    assert.match((await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'binario.txt') })).errore, /binario/);
    assert.equal((await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'non-esiste.txt') })).ok, false);
    assert.equal((await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'FAM') })).ok, false);
    // i file media si trovano per nome ma non si leggono
    assert.equal((await a.esegui('cerca_file', { query: 'video' })).risultato.trovati.length, 1);
  } finally { a.pulisci(); }
});

test('documenti: limiti di risultati e di dimensione', async () => {
  const a = ambiente();
  try {
    const cart = path.join(a.radice, 'molti'); fs.mkdirSync(cart);
    for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(cart, 'doc' + i + '.txt'), 'x');
    const r = await a.esegui('cerca_file', { query: 'doc' });
    assert.equal(r.risultato.trovati.length, 50); assert.equal(r.risultato.completa, false);
    const grande = path.join(a.radice, 'grande.txt'); fs.writeFileSync(grande, 'a'.repeat(300000));
    const g = await a.esegui('leggi_documento', { percorso: grande });
    assert.equal(g.risultato.troncato, true); assert.equal(g.risultato.testo.length, 200000);
  } finally { a.pulisci(); }
});

test('documenti: senza cartelle autorizzate o disabilitata non legge nulla; i parametri extra sono respinti', async () => {
  const a = ambiente();
  try {
    assert.equal((await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'FAM', 'esercizi.md'), scrivi: true })).codice, 'PARAMETRI');
    a.permessi.impostaAbilitata('documenti', false);
    assert.equal((await a.esegui('cerca_file', { query: 'esercizi' })).codice, 'DISABILITATA');
    a.permessi.impostaAbilitata('documenti', true);
    impostaCartelle(a.storage, []);
    assert.equal((await a.esegui('cerca_file', { query: 'esercizi' })).codice, 'NON_CONFIGURATA');
    assert.deepEqual(Object.keys((await a.mgr.elenca()).find(i => i.id === 'documenti').strumenti.map(s => s.livello).reduce((o, l) => (o[l] = 1, o), {})), ['lettura']);   // solo lettura
  } finally { a.pulisci(); }
});

test('documenti: le cartelle da autorizzare vengono validate (no disco intero, no relative, no rete)', () => {
  const s = new Storage(':memory:');
  assert.throws(() => impostaCartelle(s, ['C:\\']));
  assert.throws(() => impostaCartelle(s, ['Documenti']));
  assert.throws(() => impostaCartelle(s, ['\\\\server\\cartella']));
  assert.throws(() => impostaCartelle(s, [os.tmpdir() + '\\..\\x']));
  assert.deepEqual(impostaCartelle(s, [os.tmpdir(), os.tmpdir().toUpperCase()]).length, 1);
  assert.equal(cartelleAutorizzate(s).length, 1);
  assert.equal(new GuardiaPercorsi([]).radiciRisolte().length, 0);
});

test('documenti: ogni lettura finisce nell\'audit senza contenuti ne percorsi completi dei file', async () => {
  const a = ambiente();
  try {
    await a.esegui('leggi_documento', { percorso: path.join(a.radice, 'FAM', 'esercizi.md') });
    const righe = JSON.stringify(a.audit.elenca(50));
    assert.ok(!righe.includes('Calcola la matrice'));
    assert.ok(righe.includes('documenti') && righe.includes('completata'));
  } finally { a.pulisci(); }
});
