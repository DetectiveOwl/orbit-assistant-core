'use strict';
// Incremento 3: scrittura controllata nel vault Obsidian (su vault finti in cartelle temporanee, mai sul vault vero).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../storage/db');
const { AuditLogger } = require('../integrations/audit');
const { PermissionManager } = require('../integrations/permessi');
const { IntegrationManager } = require('../integrations/registry');
const { creaIntegrazioneObsidian } = require('../integrations/obsidian');
const { Vault, cercaSegreti, segmentiNota } = require('../integrations/obsidian/scrittura');

function ambiente() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-obs-'));
  const vault = path.join(base, 'vault'), dati = path.join(base, 'dati'), fuori = path.join(base, 'fuori');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true }); fs.mkdirSync(path.join(vault, 'corsi', 'FAM'), { recursive: true }); fs.mkdirSync(dati); fs.mkdirSync(fuori);
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{"x":1}');
  fs.writeFileSync(path.join(vault, 'corsi', 'FAM', 'matrici.md'), '# Matrici\n\nLa matrice inversa esiste se det != 0.\n\n## Esercizi\n\n- uno\n- due\n\n## Teoria\n\nTesto di teoria.\n');
  fs.writeFileSync(path.join(vault, 'win.md'), '# Win\r\n\r\nRiga con CRLF.\r\n');
  fs.writeFileSync(path.join(fuori, 'x.md'), 'fuori');
  const memoria = { config: { vaultPath: vault }, stato: () => ({ ok: true }), cerca: () => [], leggiNota: p => ({ percorso: p, titolo: p, tag: [], linkUscenti: [], backlink: [], contenuto: fs.readFileSync(path.join(vault, p), 'utf8') }), elencaNote: () => ({ note: [] }) };
  const storage = new Storage(':memory:'); const audit = new AuditLogger({ storage });
  const permessi = new PermissionManager({ storage, audit });
  const mgr = new IntegrationManager({ permessi, audit });
  mgr.registra(creaIntegrazioneObsidian({ memoria, datiDir: dati }));
  permessi.impostaAbilitata('obsidian', true);
  const v = new Vault({ vaultPath: vault, datiDir: dati });
  return { base, vault, dati, fuori, v, mgr, permessi, audit, pulisci: () => fs.rmSync(base, { recursive: true, force: true }), leggi: r => fs.readFileSync(path.join(vault, r), 'utf8') };
}

test('crea: nuova nota con frontmatter, tag, cartelle nuove; mai sovrascrive', () => {
  const a = ambiente();
  try {
    const r = a.v.crea({ percorso: 'corsi/Analisi/limiti', contenuto: '# Limiti\n\nVedi [[matrici]].', tag: ['#Analisi', 'limiti'] });
    assert.equal(r.percorso, 'corsi/Analisi/limiti.md'); assert.equal(r.nuovaCartella, true);
    const t = a.leggi('corsi/Analisi/limiti.md');
    assert.match(t, /^---\ntags: \[analisi, limiti\]\ncreata: \d{4}-\d{2}-\d{2}\norigine: Orbit\n---\n\n# Limiti/);
    assert.throws(() => a.v.crea({ percorso: 'corsi/Analisi/limiti.md', contenuto: 'altro' }), /Esiste gia/);
    assert.match(a.leggi('corsi/Analisi/limiti.md'), /Vedi \[\[matrici\]\]/);
  } finally { a.pulisci(); }
});

test('percorsi: .obsidian, punti, traversal, assoluti, nomi riservati e caratteri vietati sono respinti', () => {
  const a = ambiente();
  try {
    for (const p of ['.obsidian/app', '.obsidian/x.md', 'corsi/.nascosta/x', '../fuori/x', 'corsi/../../x', 'C:\\Windows\\x.md', '\\\\server\\x', '//server/x', 'con.md', 'a<b.md', 'a|b', 'x\u0000y', '', '   ', 'a/b/c/d/e/f/g/h/i.md'])
      assert.throws(() => a.v.crea({ percorso: p, contenuto: 'ciao' }), undefined, JSON.stringify(p));
    assert.ok(!fs.existsSync(path.join(a.base, 'x.md')));
    assert.deepEqual(segmentiNota('Corsi\\FAM\\nota'), ['Corsi', 'FAM', 'nota.md']);
  } finally { a.pulisci(); }
});

test('percorsi: una junction nel vault verso l\'esterno non permette di scrivere fuori', () => {
  const a = ambiente();
  try {
    try { fs.symlinkSync(a.fuori, path.join(a.vault, 'scorciatoia'), 'junction'); } catch (e) { return; }
    assert.throws(() => a.v.crea({ percorso: 'scorciatoia/nuova', contenuto: 'x' }), /esce dal vault/);
    assert.throws(() => a.v.amplia({ percorso: 'scorciatoia/x', testo: 'y' }), /esce dal vault/);
    assert.equal(fs.readFileSync(path.join(a.fuori, 'x.md'), 'utf8'), 'fuori');
    assert.deepEqual(fs.readdirSync(a.fuori), ['x.md']);
  } finally { a.pulisci(); }
});

test('segreti: chiavi, token, password e carte non entrano mai nel vault', () => {
  const a = ambiente();
  try {
    for (const t of ['la mia chiave ' + 'sk-' + 'ant-api03-abcdefghijklmnop', 'password: hunter22', 'token=abc123def456', 'ghp_abcdefghijklmnopqrstuvwxyz0123', '-----BEGIN RSA PRIVATE KEY-----', 'carta 4111 1111 1111 1111', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'])
      assert.ok(cercaSegreti(t), t);
    assert.equal(cercaSegreti('La password dimenticata si recupera dal portale. Il token e un gettone.'), null);
    assert.throws(() => a.v.crea({ percorso: 'segreti', contenuto: 'api_key = abcdefghijkl' }), /segreti/);
    assert.throws(() => a.v.amplia({ percorso: 'win', testo: 'password: hunter22' }), /segreti/);
    assert.ok(!fs.existsSync(path.join(a.vault, 'segreti.md')));
  } finally { a.pulisci(); }
});

test('amplia: aggiunge in fondo, in una sezione o i collegamenti; il testo esistente resta identico e c\'e il backup', () => {
  const a = ambiente();
  try {
    const orig = a.leggi('corsi/FAM/matrici.md');
    const r1 = a.v.amplia({ percorso: 'corsi/FAM/matrici', testo: 'Nota aggiunta in fondo.' });
    assert.ok(fs.existsSync(r1.backup)); assert.equal(fs.readFileSync(r1.backup, 'utf8'), orig);
    assert.ok(!r1.backup.startsWith(a.vault));
    assert.equal(a.leggi('corsi/FAM/matrici.md'), orig + '\nNota aggiunta in fondo.\n');
    const r2 = a.v.amplia({ percorso: 'corsi/FAM/matrici.md', sezione: 'Esercizi', testo: '- tre' });
    assert.match(a.leggi('corsi/FAM/matrici.md'), /- uno\n- due\n- tre\n\n## Teoria/);
    a.v.amplia({ percorso: 'corsi/FAM/matrici.md', sezione: 'Nuova sezione', testo: 'contenuto' });
    assert.match(a.leggi('corsi/FAM/matrici.md'), /\n## Nuova sezione\n\ncontenuto\n$/);
    const r3 = a.v.amplia({ percorso: 'corsi/FAM/matrici.md', collegamenti: ['[[Analisi 1]]', 'Spazi vettoriali', 'Analisi 1'] });
    assert.deepEqual(r3.collegamentiAggiunti, ['Analisi 1', 'Spazi vettoriali']);
    assert.match(a.leggi('corsi/FAM/matrici.md'), /## Collegamenti\n\n- \[\[Analisi 1\]\]\n- \[\[Spazi vettoriali\]\]\n$/);
    assert.throws(() => a.v.amplia({ percorso: 'corsi/FAM/matrici.md', collegamenti: ['Analisi 1'] }), /gia/);
    // il testo originale e sempre contenuto per intero, nello stesso ordine
    let t = a.leggi('corsi/FAM/matrici.md'); let i = 0;
    for (const riga of orig.split('\n')) { const j = t.indexOf(riga, i); assert.ok(j >= 0, riga); i = j + riga.length; }
  } finally { a.pulisci(); }
});

test('amplia: righe CRLF conservate, frontmatter intoccato, nota inesistente respinta, nota cambiata nel frattempo rifiutata', () => {
  const a = ambiente();
  try {
    a.v.amplia({ percorso: 'win', testo: 'aggiunta' });
    const t = fs.readFileSync(path.join(a.vault, 'win.md'), 'utf8');
    assert.ok(t.startsWith('# Win\r\n\r\nRiga con CRLF.\r\n')); assert.ok(!/[^\r]\n/.test(t));
    fs.writeFileSync(path.join(a.vault, 'fm.md'), '---\ntags: [a]\n---\n\n# T\n');
    a.v.amplia({ percorso: 'fm', testo: 'x' });
    assert.ok(a.leggi('fm.md').startsWith('---\ntags: [a]\n---\n\n# T\n'));
    assert.throws(() => a.v.amplia({ percorso: 'non-esiste', testo: 'x' }), /non trovata/i);
    assert.throws(() => a.v.amplia({ percorso: '.obsidian/app.json', testo: 'x' }));
    assert.equal(fs.readFileSync(path.join(a.vault, '.obsidian', 'app.json'), 'utf8'), '{"x":1}');
    // la nota cambia mentre Orbit la elabora (l'utente la sta scrivendo): nessuna scrittura
    const orig = fs.readFileSync;
    let n = 0; fs.readFileSync = function (p, ...r) { if (String(p).endsWith('win.md') && ++n === 2) fs.writeFileSync(p, orig.call(this, p, 'utf8') + 'modificata da Marco\n'); return orig.call(this, p, ...r); };
    try { assert.throws(() => a.v.amplia({ percorso: 'win', testo: 'altro' }), /cambiata/); } finally { fs.readFileSync = orig; }
    assert.match(a.leggi('win.md'), /modificata da Marco/); assert.ok(!/altro/.test(a.leggi('win.md')));
  } finally { a.pulisci(); }
});

test('permessi: crea e amplia chiedono conferma finche non scegli, riscrivere ed eliminare chiedono SEMPRE conferma e non si possono sbloccare', async () => {
  const a = ambiente();
  try {
    const es = (s, p, o) => a.mgr.esegui('obsidian', s, p, o);
    assert.equal((await es('crea_nota', { percorso: 'x', contenuto: 'ciao' })).codice, 'CONFERMA_RICHIESTA');
    assert.equal((await es('amplia_nota', { percorso: 'win', testo: 'x' })).codice, 'CONFERMA_RICHIESTA');
    assert.ok(!fs.existsSync(path.join(a.vault, 'x.md')));
    a.permessi.impostaLivello('obsidian', 'crea', 'consenti'); a.permessi.impostaLivello('obsidian', 'amplia', 'consenti');
    assert.equal((await es('crea_nota', { percorso: 'x', contenuto: 'ciao' })).ok, true);
    assert.equal((await es('amplia_nota', { percorso: 'x', testo: 'piu' })).ok, true);
    assert.throws(() => a.permessi.impostaLivello('obsidian', 'modifica', 'consenti'));
    assert.throws(() => a.permessi.impostaLivello('obsidian', 'irreversibile', 'consenti'));
    assert.equal((await es('riscrivi_nota', { percorso: 'x', contenuto: 'nuovo' })).codice, 'CONFERMA_RICHIESTA');
    assert.equal((await es('elimina_nota', { percorso: 'x' })).codice, 'CONFERMA_RICHIESTA');
    assert.ok(fs.existsSync(path.join(a.vault, 'x.md')));
    assert.match(a.leggi('x.md'), /ciao/);
    // conferma specifica: eliminare con conferma -> cestino, non distruzione
    const info = (await es('elimina_nota', { percorso: 'x' })).conferma;
    a.permessi.rispondi(info.id, true);
    const r = await es('elimina_nota', { percorso: 'x' }, { confermaId: info.id });
    assert.equal(r.ok, true); assert.ok(!fs.existsSync(path.join(a.vault, 'x.md')));
    assert.match(fs.readFileSync(r.risultato.cestino, 'utf8'), /ciao/);
    // l'audit non contiene il contenuto delle note
    assert.ok(!JSON.stringify(a.audit.elenca(100)).includes('ciao'));
  } finally { a.pulisci(); }
});

test('riscrivi: con conferma sostituisce, con backup del testo precedente', async () => {
  const a = ambiente();
  try {
    const orig = a.leggi('win.md');
    const r = a.v.riscrivi({ percorso: 'win', contenuto: '# Nuovo\n\nTutto nuovo.' });
    assert.equal(fs.readFileSync(r.backup, 'utf8'), orig);
    assert.equal(a.leggi('win.md'), '# Nuovo\n\nTutto nuovo.\n');
  } finally { a.pulisci(); }
});

test('vault: la cartella dei dati non puo stare dentro il vault', () => {
  const a = ambiente();
  try { assert.throws(() => new Vault({ vaultPath: a.vault, datiDir: path.join(a.vault, 'dati') }), /dentro il vault/); } finally { a.pulisci(); }
});

