'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { analizzaNota, sezioniNota } = require('../memoria/analisi');
const { bloccante, VERSIONE, chiave, relativo, protetto, sotto, sha, impronta, congela, errore } = require('./policy');

function intestazione(line) {
  const h = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/);
  if (h) h[2] = h[2].replace(/(?:[ \t]+|^)#+[ \t]*$/, '').replace(/[ \t]+$/, '');
  return h;
}

function descrivi(testo, percorso, hash) {
  const a = analizzaNota(testo, percorso);
  const base = testo.length - a.corpo.length, unita = [], headings = [];
  let fence = null, codeStart = 0, before = '', h1 = null, markdownLimitato = false;
  for (const m of a.corpo.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)) {
    if (!m[0]) continue;
    const eol = m[0].endsWith('\r\n') ? '\r\n' : m[0].endsWith('\n') ? '\n' : '';
    const line = eol ? m[0].slice(0, -eol.length) : m[0], start = base + m.index;
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        unita.push({ content: testo.slice(codeStart, start + line.length), start: codeStart, end: start + line.length,
          section: headings.map(h => h.title), kind: 'code', before, eol }); fence = null; before = '';
      }
      continue;
    }
    const f = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = f[1]; codeStart = start; continue; }
    if (/^\s*(`{3,}|~{3,})/.test(line)) markdownLimitato = true;
    if (!line.trim()) { before += m[0]; continue; }
    const h = intestazione(line);
    if (h) {
      if (h[1] === '#' && h1 === null) h1 = h[2];
      const principale = typeof a.frontmatter.title === 'string' && a.frontmatter.title.trim() ? a.frontmatter.title : h1 || a.nomeFile;
      if (h[1] === '#' && a.corpo.slice(0, m.index).trim() === '' && chiave(h[2]) === chiave(principale)) { before = ''; continue; }
      while (headings.length && headings.at(-1).level >= h[1].length) headings.pop();
      headings.push({ level: h[1].length, title: h[2] });
    }
    unita.push({ content: line, start, end: start + line.length, section: headings.map(x => x.title), kind: h ? 'heading' : 'text', before, eol });
    before = '';
  }
  if (fence) unita.push({ content: testo.slice(codeStart), start: codeStart, end: testo.length,
    section: headings.map(h => h.title), kind: 'code', before, eol: '' });
  const titolo = typeof a.frontmatter.title === 'string' && a.frontmatter.title.trim() ? a.frontmatter.title : h1 || a.nomeFile;
  const chunks = []; let offset = 0;
  for (const u of unita.filter(u => u.kind === 'code')) {
    chunks.push(testo.slice(offset, u.start), u.content.replace(/[^\r\n]/g, ' ')); offset = u.end;
  }
  chunks.push(testo.slice(offset));
  // Il parser condiviso riceve codice oscurato a lunghezza invariata: titoli e link del codice restano dati.
  const senzaCodice = chunks.join(''), metadata = analizzaNota(senzaCodice, percorso);
  const sezioni = sezioniNota(senzaCodice), gerarchia = [];
  // L'adapter TS rilegge le intestazioni originali: il parser condiviso tronca anche hash letterali.
  for (const s of sezioni.filter(s => s.livello)) {
    const h = intestazione(senzaCodice.slice(s.inizio, s.fine).split(/\r?\n/, 1)[0]);
    if (!h) { markdownLimitato = true; continue; }
    while (gerarchia.length && gerarchia.at(-1).livello >= s.livello) gerarchia.pop();
    s.titolo = h[2]; gerarchia.push(s);
    s.percorso = gerarchia.map(s => s.titolo).join(' > ');
  }
  const fm = testo.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)/);
  const yamlLimitato = /^\uFEFF?---(?:\r?\n|$)/.test(testo) && (!fm || fm[1].split(/\r?\n/).some(l => {
    if (!l.trim() || /^\s*#/.test(l)) return false;
    const m = l.match(/^([\w-]+):\s*(.*)$/) || l.match(/^\s*-\s+(.*)$/);
    if (!m) return true;
    const value = m.at(-1).trim();
    return ['__proto__', 'constructor', 'prototype'].includes(m[1]) || /^[|>&*!{]/.test(value)
      || /"[^"]*,[^"]*"|'[^']*,[^']*'/.test(value);
  }));
  const problemiParsing = [...(yamlLimitato ? ['YAML_PARZIALMENTE_SUPPORTATO'] : []), ...(markdownLimitato ? ['MARKDOWN_PARZIALMENTE_SUPPORTATO'] : [])];
  return { percorso, sha256: hash, testo, titolo, nomeFile: a.nomeFile, alias: a.alias, frontmatter: a.frontmatter,
    sezioni, link: metadata.link, unita, parsingCompleto: problemiParsing.length === 0, problemiParsing };
}

function leggiSnapshot({ radice, autorizzati, creaIn = [], limiti = {}, verificaReparse } = {}) {
  if (typeof radice !== 'string' || !path.isAbsolute(radice)) throw errore('RADICE_ESPLICITA_RICHIESTA');
  if (/^(?:\\\\|\/\/)/.test(radice)) throw errore('RADICE_DI_RETE_O_DISPOSITIVO');
  relativo(radice.slice(path.parse(radice).root.length));
  if (!Array.isArray(autorizzati) || !autorizzati.length || !Array.isArray(creaIn)) throw errore('AMBITO_ESPLICITO_RICHIESTO');
  const roots = autorizzati.map(relativo), dirsCreate = creaIn.map(relativo);
  if (roots.some(p => protetto(p) || sotto(p, 'to sort')) || dirsCreate.some(p => protetto(p) || !roots.some(a => sotto(p, a)))) throw errore('AMBITO_PROTETTO');
  if (process.platform === 'win32' && typeof verificaReparse !== 'function') throw errore('VERIFICA_REPARSE_WINDOWS_RICHIESTA');
  const caps = { maxNote: 1000, maxFileBytes: 524288, maxBytes: 8388608, maxEntries: 10000, maxDepth: 16, ...limiti };
  if (Object.values(caps).some(n => !Number.isSafeInteger(n) || n < 1)) throw errore('LIMITI_NON_VALIDI');
  const root = path.resolve(radice), sources = [], catalogo = [], cartelle = [], problemi = [], seen = new Map();
  let bytes = 0, entries = 0;
  const inside = p => { const r = path.relative(root, p); return r === '' || !r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r); };
  function ispeziona(p) {
    const st = fs.lstatSync(p, { bigint: true });
    if (st.isSymbolicLink()) throw errore('LINK_O_REPARSE');
    if (process.platform === 'win32') {
      const rp = verificaReparse(p);
      if (typeof rp !== 'boolean') throw errore('VERIFICA_REPARSE_INCOMPLETA');
      if (rp) throw errore('LINK_O_REPARSE');
    }
    return st;
  }
  const parents = [];
  for (let p = root; ; p = path.dirname(p)) { parents.push(p); if (p === path.dirname(p)) break; }
  for (const p of parents.reverse()) ispeziona(p);
  if (!ispeziona(root).isDirectory()) throw errore('RADICE_NON_DIRECTORY');
  const physical = fs.realpathSync.native(root);
  function sicuro(rel) {
    relativo(rel);
    let current = root, st;
    for (const component of rel.split('/')) { current = path.join(current, component); st = ispeziona(current); }
    if (!inside(fs.realpathSync.native(current))) throw errore('FUORI_RADICE');
    return { file: current, st };
  }
  function issue(percorso, code) { problemi.push({ percorso, code }); }
  function visit(rel, source, depth = 0) {
    if (++entries > caps.maxEntries || depth > caps.maxDepth) { issue(rel, 'LIMITE_SCANSIONE'); return; }
    try {
      relativo(rel);
      if (protetto(rel)) throw errore('DESTINAZIONE_PROTETTA');
      const key = chiave(rel);
      if (seen.has(key)) { if (seen.get(key) !== rel) issue(rel, 'COLLISIONE_PERCORSO'); return; }
      seen.set(key, rel);
      const { file, st } = sicuro(rel);
      if (st.isDirectory()) {
        if (!source) cartelle.push({ percorso: rel, identita: String(st.dev) + ':' + String(st.ino) });
        const before = st;
        for (const name of fs.readdirSync(file).sort()) {
          if (entries >= caps.maxEntries) { issue(rel, 'LIMITE_SCANSIONE'); break; }
          visit(rel + '/' + name, source, depth + 1);
        }
        const after = ispeziona(file);
        if (before.mtimeNs !== after.mtimeNs || before.ino !== after.ino || before.dev !== after.dev) issue(rel, 'DIRECTORY_CAMBIATA');
        return;
      }
      if (!/\.md$/i.test(rel)) return;
      if (!st.isFile() || st.nlink !== 1n) throw errore('FILE_NON_REGOLARE_O_HARDLINK');
      if (catalogo.length + sources.length >= caps.maxNote || st.size > BigInt(caps.maxFileBytes) || bytes + Number(st.size) > caps.maxBytes) throw errore('LIMITE_LETTURA');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let buffer;
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const current = sicuro(rel).st;
        if (opened.ino !== st.ino || opened.dev !== st.dev || current.ino !== opened.ino || current.dev !== opened.dev) throw errore('FILE_CAMBIATO');
        if (opened.size > BigInt(caps.maxFileBytes) || bytes + Number(opened.size) > caps.maxBytes) throw errore('LIMITE_LETTURA');
        buffer = Buffer.alloc(Number(opened.size) + 1);
        let n = 0, got;
        while (n < buffer.length && (got = fs.readSync(fd, buffer, n, buffer.length - n, null)) > 0) n += got;
        const after = fs.fstatSync(fd, { bigint: true });
        if (n !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw errore('LETTURA_PARZIALE_O_CAMBIATA');
        const end = sicuro(rel).st;
        if (end.ino !== opened.ino || end.dev !== opened.dev || end.mtimeNs !== after.mtimeNs) throw errore('FILE_CAMBIATO');
        buffer = buffer.subarray(0, n); bytes += n;
      } finally { fs.closeSync(fd); }
      const testo = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      const note = descrivi(testo, rel, sha(buffer));
      for (const code of note.problemiParsing) if (source || code !== 'YAML_PARZIALMENTE_SUPPORTATO') issue(rel, code);   // un append non riscrive il frontmatter dei bersagli
      (source ? sources : catalogo).push(note);
    } catch (e) { issue(rel, e.code || 'LETTURA_FALLITA'); }
  }
  visit('to sort', true);
  for (const p of [...new Set(roots)].sort()) visit(p, false);
  for (const p of dirsCreate) if (!cartelle.some(d => d.percorso === p)) issue(p, 'CARTELLA_CREAZIONE_ASSENTE');
  const snapshot = { schema: VERSIONE, rootId: sha(physical), autorizzati: roots, creaIn: dirsCreate, sorgenti: sources, catalogo,
    cartelle, copertura: { completa: !problemi.some(p => bloccante(p, dirsCreate)), ambito: 'solo-percorsi-autorizzati', problemi, bytes, entries, limiti: caps } };
  snapshot.impronta = impronta(snapshot);
  return congela(snapshot);
}

module.exports = { leggiSnapshot, descrivi };
