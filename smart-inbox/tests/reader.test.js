'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const guard = require('./guard.cjs');
const before = guard.accessiDati();
const { leggiSnapshot, descrivi } = require('../reader');
const { relativo, protetto, chiave, sha } = require('../policy');
const { parseFrontmatter, sezioniNota } = require('../../memoria/analisi');
const importReads = guard.accessiDati() - before;
const radice = name => path.join(guard.root, 'data', name);
const leggi = (name, extra = {}) => leggiSnapshot({ radice: radice(name), autorizzati: ['liste'], creaIn: ['liste'], verificaReparse: guard.verificaReparse, ...extra });

test('TS1: import senza letture di dati, configurazione, SQLite o app', () => {
  assert.equal(importReads, 0);
  assert.ok(!Object.keys(require.cache).some(p => /[\\/](?:orbit|config\.js|profilo\.js|indice\.js)(?:[\\/]|$)/.test(path.relative(path.join(guard.root, 'repo'), p))));
  guard.attendiDiniego(() => require('node:sqlite'));
  guard.attendiDiniego(() => require('../../orbit/config'));
});

test('TS1: root esplicita e attributi Windows obbligatori senza fallback operativo', () => {
  assert.throws(() => leggiSnapshot(), { code: 'RADICE_ESPLICITA_RICHIESTA' });
  assert.throws(() => leggiSnapshot({ radice: 'relativa', autorizzati: ['liste'] }), { code: 'RADICE_ESPLICITA_RICHIESTA' });
  assert.throws(() => leggiSnapshot({ radice: radice('film'), autorizzati: ['liste'] }), { code: 'VERIFICA_REPARSE_WINDOWS_RICHIESTA' });
  assert.throws(() => leggi('film', { autorizzati: ['scadenze'] }), { code: 'AMBITO_PROTETTO' });
  assert.throws(() => leggi('film', { limiti: { maxBytes: 0 } }), { code: 'LIMITI_NON_VALIDI' });
});

for (const p of ['../x.md', '/x.md', String.raw`\\server\share\note.md`, 'C:\\x.md', 'a/x.md:stream', 'a/../x.md', 'a//x.md',
  'a/CON.md', 'a/LPT¹.md', 'a/x. ', 'a/NUL.txt', 'a/%2e%2e/x.md']) {
  test('TS1: percorso non sicuro rifiutato: ' + JSON.stringify(p), () => assert.throws(() => relativo(p), { code: 'PERCORSO_NON_SICURO' }));
}

test('TS1: policy centrale blocca aree operative e tecniche anche con case diverso', () => {
  for (const p of ['Scadenze/A.md', 'progetti/Orbit/bug.md', '.claude/skills/inbox/SKILL.md',
    'skills/a.md', 'config/a.md', 'orbit/public/a.md', 'memoria/a.md', 'a/credentials.json', 'a/indice.sqlite', 'a/.env']) assert.ok(protetto(p), p);
  assert.equal(relativo('liste\\Film è.md'), 'liste/Film è.md');
  assert.equal(chiave('é.md'), chiave('e\u0301.md')); assert.equal(chiave('FILM.md'), chiave('film.md'));
});

test('TS1: titolo da filename, frontmatter, alias, sezioni, link e SHA256 byte originali', () => {
  const s = leggi('metadati'); assert.equal(s.copertura.completa, true);
  assert.equal(s.sorgenti[0].titolo, 'È vuota'); assert.equal(s.sorgenti[0].testo, '');
  const n = s.catalogo[0]; assert.equal(n.titolo, 'Scuola'); assert.deepEqual(n.alias, ['École', 'Scuola serale']);
  assert.ok(n.sezioni.some(x => x.titolo === 'Programma'));
  assert.deepEqual(n.link.map(l => l.destinazione), ['Viaggi', 'note/Italia.md']);
  const bytes = fs.readFileSync(path.join(radice('metadati'), n.percorso));
  assert.equal(n.sha256, sha(bytes));
  assert.ok(Object.isFrozen(s) && Object.isFrozen(n));
});

test('TS1: junction e antenati reparse non sono seguiti dal reader', () => {
  const beforeReads = guard.letture(); const s = leggi('link');
  assert.equal(s.copertura.completa, false); assert.ok(s.copertura.problemi.some(x => x.code === 'LINK_O_REPARSE'));
  assert.equal(s.sorgenti.length, 0); assert.ok(!guard.letture().slice(beforeReads.length).some(p => p.endsWith('Segreto.md')));
  assert.throws(() => leggi('antenato'), { code: 'LINK_O_REPARSE' });
});

test('TS1: reparse non riconosciuto come symlink rifiutato dalla verifica nativa iniettata', () => {
  const s = leggi('film', { verificaReparse: p => p.endsWith('Film da guardare.md') || guard.verificaReparse(p) });
  assert.equal(s.copertura.completa, false); assert.ok(s.copertura.problemi.some(x => x.code === 'LINK_O_REPARSE'));
  assert.throws(() => leggi('film', { verificaReparse: () => undefined }), { code: 'VERIFICA_REPARSE_INCOMPLETA' });
});

test('TS1: root sintetica fuori dal recinto e filesystem di scrittura sono bloccati', () => {
  guard.attendiDiniego(() => fs.readFileSync(guard.root + '-outside-synthetic/secret.md'));
  guard.attendiDiniego(() => fs.writeFileSync(path.join(radice('film'), 'proibito.md'), 'x'));
  guard.attendiDiniego(() => require('node:child_process'));
  guard.attendiDiniego(() => require('node:http'));
  guard.attendiDiniego(() => fetch('https://example.invalid'));
});

for (const [name, code] of [['senzaInbox', 'ENOENT'], ['collisione', 'COLLISIONE_PERCORSO'], ['yaml', 'YAML_PARZIALMENTE_SUPPORTATO'],
  ['utf8', 'ERR_ENCODING_INVALID_ENCODED_DATA'], ['lettura', 'EACCES'], ['parziale', 'LETTURA_PARZIALE_O_CAMBIATA'], ['fenceNonSupportato', 'MARKDOWN_PARZIALMENTE_SUPPORTATO']]) {
  test('TS1: copertura incompleta esplicita: ' + name, () => {
    const s = leggi(name); assert.equal(s.copertura.completa, ['YAML_PARZIALMENTE_SUPPORTATO', 'MARKDOWN_PARZIALMENTE_SUPPORTATO'].includes(code)); assert.ok(s.copertura.problemi.some(p => p.code === code), JSON.stringify(s.copertura.problemi));
  });
}

test('TS1: limiti non producono hash di prefissi spacciati per note complete', () => {
  const s = leggi('film', { limiti: { maxFileBytes: 5 } });
  assert.equal(s.copertura.completa, false); assert.equal(s.sorgenti.length + s.catalogo.length, 0);
  assert.ok(s.copertura.problemi.every(p => p.code === 'LIMITE_LETTURA'));
  assert.equal(leggi('film', { limiti: { maxEntries: 1 } }).copertura.completa, false);
});

test('TS1: non legge note non autorizzate o contenuti protetti annidati', () => {
  const start = guard.letture().length, s = leggi('esclusi');
  assert.equal(s.copertura.completa, false); assert.equal(s.catalogo.length, 0);
  assert.ok(!guard.letture().slice(start).some(p => /Segreto|Profilo/.test(p)));
});

test('TS1: regressione parser condiviso puro, senza modificare memoria/analisi', () => {
  const src = '---\naliases: [Uno, Due]\n---\n# Titolo\nprima\n## Seconda\npoi\n';
  assert.deepEqual(parseFrontmatter(src).dati.aliases, ['Uno', 'Due']);
  for (const s of sezioniNota(src)) assert.ok(src.slice(s.inizio, s.fine).trim());
});

for (const delimiter of ['`', '~']) test('TS1 audit: fence lungo atomico con delimitatori interni: ' + delimiter, () => {
  const open = delimiter.repeat(4), short = delimiter.repeat(3), wrong = delimiter === '`' ? '~~~~' : '````';
  const block = open + 'markdown\r\nprima 😀\r\n' + short + '\r\n# Titolo interno\r\n[[Altra nota]]\r\n' + wrong + '\r\n' + open + ' non-chiude\r\n- interno\r\n' + open + ' \t';
  const text = '# Codice\r\n\r\n' + block + '\r\n';
  const n = descrivi(text, 'to sort/Codice.md', sha(Buffer.from(text)));
  assert.equal(n.unita.length, 1); assert.equal(n.unita[0].kind, 'code');
  assert.equal(n.unita[0].content, block); assert.equal(text.slice(n.unita[0].start, n.unita[0].end), block);
  assert.equal(n.unita[0].eol, '\r\n'); assert.equal(n.parsingCompleto, true);
  assert.equal(n.titolo, 'Codice'); assert.equal(n.link.length, 0);
  assert.deepEqual(n.sezioni.map(s => s.titolo), ['Codice']);
});

test('TS1 audit: chiusura piu lunga valida e fence non chiuso resta atomico fino a EOF', () => {
  for (const block of ['````js\nvalore\n`````', '~~~~\nvalore\n~~~\nancora']) {
    const n = descrivi('# Codice\n' + block, 'to sort/Codice.md', sha(Buffer.from('# Codice\n' + block)));
    assert.equal(n.unita.length, 1); assert.equal(n.unita[0].content, block);
  }
});

test('TS1 audit: H1 solo nel fence non sostituisce il filename come titolo', () => {
  const text = '````md\n```\n# Titolo interno\n````\n';
  const n = descrivi(text, 'to sort/Codice.md', sha(Buffer.from(text)));
  assert.equal(n.titolo, 'Codice'); assert.equal(n.unita.length, 1); assert.equal(n.sezioni.length, 0);
});

for (const [line, expected] of [
  ['# C#', 'C#'], ['# C##', 'C##'], ['# Etichetta###', 'Etichetta###'],
  ['# Titolo ###', 'Titolo'], ['# C# ###', 'C#'], ['# C# ## testo#', 'C# ## testo#'],
  ['# Titolo \\#', 'Titolo \\#'], ['# A # B #', 'A # B'], ['# Titolo ### \t', 'Titolo']
]) test('TS1 hash: titolo letterale e chiusura Markdown coerenti: ' + JSON.stringify(line), () => {
  const n = descrivi(line, 'to sort/Nota.md', sha(Buffer.from(line)));
  assert.equal(n.titolo, expected); assert.equal(n.unita.length, 0);
  assert.equal(n.sezioni[0].titolo, expected); assert.equal(n.sezioni[0].percorso, expected);
  assert.equal(n.sezioni[0].inizio, 0); assert.equal(n.sezioni[0].fine, line.length);
});

test('TS1 hash: sezioni e unita mantengono i caratteri letterali e gli offset originali', () => {
  const text = '# Corso\r\n## C#\r\n- Dune\r\n### API## ###\r\n- note\r\n';
  const n = descrivi(text, 'to sort/Nota.md', sha(Buffer.from(text)));
  assert.deepEqual(n.sezioni.map(s => s.titolo), ['Corso', 'C#', 'API##']);
  assert.deepEqual(n.sezioni.map(s => s.percorso), ['Corso', 'Corso > C#', 'Corso > C# > API##']);
  assert.deepEqual(n.unita.at(-1).section, ['C#', 'API##']);
  for (const u of n.unita) assert.equal(text.slice(u.start, u.end), u.content);
});

test('TS1 hash: titolo frontmatter coerente o distinto non altera il contenuto H1', () => {
  for (const [title, count] of [['C#', 0], ['Corso', 1]]) {
    const text = '---\ntitle: ' + title + '\n---\n# C# ###\n';
    const n = descrivi(text, 'to sort/Nota.md', sha(Buffer.from(text)));
    assert.equal(n.titolo, title); assert.equal(n.unita.length, count); assert.equal(n.sezioni[0].titolo, 'C#');
    if (count) { assert.equal(n.unita[0].content, '# C# ###'); assert.deepEqual(n.unita[0].section, ['C#']); }
  }
});
