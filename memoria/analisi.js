'use strict';
// Estrae da una nota Markdown le informazioni utili alla ricerca, senza modificarla:
// frontmatter YAML, tag, intestazioni, wikilink [[...]] ed embed ![[...]].

// Parser YAML minimo: copre il frontmatter tipico di Obsidian (chiave: valore, liste "- x" e [a, b]).
// Se una riga non e riconosciuta viene ignorata, il file originale resta comunque la fonte.
function parseFrontmatter(src) {
  const m = src.match(/^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!m) return { dati: {}, corpo: src };
  const dati = {};
  let chiave = null;
  for (const riga of m[1].split(/\r?\n/)) {
    if (!riga.trim() || riga.trim().startsWith('#')) continue;
    const item = riga.match(/^\s*-\s+(.*)$/);
    if (item && chiave) {
      if (!Array.isArray(dati[chiave])) dati[chiave] = dati[chiave] ? [dati[chiave]] : [];
      dati[chiave].push(pulisci(item[1]));
      continue;
    }
    const kv = riga.match(/^([^\s:#][^:]*):\s*(.*)$/);
    if (!kv) continue;
    chiave = kv[1].trim();
    const v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) dati[chiave] = v.slice(1, -1).split(',').map(pulisci).filter(Boolean);
    else dati[chiave] = v === '' ? '' : pulisci(v);
  }
  return { dati, corpo: src.slice(m[0].length) };
}

function pulisci(v) {
  v = String(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

// I tag in una stringa si separano anche con spazi, gli alias solo con virgole.
function comeLista(v, separatore = /[,\s]+/) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(separatore).map(s => s.trim()).filter(Boolean);
}

// Toglie blocchi di codice e codice inline, dove # e [[ non sono tag o link.
function senzaCodice(testo) {
  return testo.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

function analizzaNota(src, percorso) {
  const { dati, corpo } = parseFrontmatter(src);
  const pulito = senzaCodice(corpo);

  const tag = new Set();
  for (const t of comeLista(dati.tags).concat(comeLista(dati.tag))) tag.add(t.replace(/^#/, '').toLowerCase());
  const reTag = /(^|[\s(,;])#([\p{L}\p{N}_\/-]+)/gu;
  for (const riga of pulito.split('\n')) {
    if (/^\s{0,3}#{1,6}\s/.test(riga)) continue;      // un titolo Markdown non e un tag
    let m;
    while ((m = reTag.exec(riga))) if (/[\p{L}_\/-]/u.test(m[2])) tag.add(m[2].toLowerCase());
  }

  const intestazioni = [];
  for (const m of pulito.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) intestazioni.push(m[1].replace(/\*\*/g, '').trim());

  const link = [];
  for (const m of pulito.matchAll(/(!?)\[\[([^\]\|#\^]*)(#[^\]\|]*)?(?:\|([^\]]*))?\]\]/g)) {
    const destinazione = m[2].trim();
    if (destinazione) link.push({ destinazione, sezione: (m[3] || '').slice(1), embed: m[1] === '!' });
  }
  // Link Markdown classici a file locali, es. [testo](cartella/nota.md)
  for (const m of pulito.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)) {
    let dest = m[2];
    try { dest = decodeURI(dest); } catch (e) { /* lascia il link com'e */ }
    if (/^[a-z]+:/i.test(dest) || dest.startsWith('#')) continue;
    link.push({ destinazione: dest.split('#')[0], sezione: (dest.split('#')[1] || ''), embed: m[1] === '!' });
  }

  const nomeFile = percorso.split('/').pop().replace(/\.md$/i, '');
  const titolo = (typeof dati.title === 'string' && dati.title) ? dati.title : nomeFile;
  const alias = comeLista(dati.aliases, /,/).concat(comeLista(dati.alias, /,/));

  return { titolo, nomeFile, alias, frontmatter: dati, tag: [...tag], intestazioni, link, corpo };
}

// Sezioni della nota: una per intestazione (piu l'eventuale testo prima della prima intestazione), con la posizione
// esatta nel file originale (inizio, fine) e il percorso delle intestazioni ("Piano > Settimana 2").
// Servono a recuperare solo la parte utile di una nota; il testo vero si rilegge sempre dal file con queste posizioni.
function sezioniNota(src) {
  const { corpo } = parseFrontmatter(src);
  const base = src.length - corpo.length;
  const righe = corpo.split('\n');
  const titoli = [];             // { livello, titolo, inizio }
  let pos = 0, inCodice = false;
  for (const r of righe) {
    if (/^\s*(```|~~~)/.test(r)) inCodice = !inCodice;
    const m = !inCodice && r.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) titoli.push({ livello: m[1].length, titolo: m[2].replace(/\*\*/g, '').replace(/[*_`]/g, '').trim(), inizio: base + pos });
    pos += r.length + 1;
  }
  const fineFile = src.length;
  const out = [];
  const primo = titoli.length ? titoli[0].inizio : fineFile;
  if (src.slice(base, primo).trim()) out.push({ livello: 0, titolo: '', percorso: '', inizio: base, fine: primo });
  const pila = [];
  titoli.forEach((t, i) => {
    while (pila.length && pila[pila.length - 1].livello >= t.livello) pila.pop();
    pila.push(t);
    out.push({ livello: t.livello, titolo: t.titolo, percorso: pila.map(x => x.titolo).join(' > '), inizio: t.inizio, fine: i + 1 < titoli.length ? titoli[i + 1].inizio : fineFile });
  });
  return out;
}

module.exports = { analizzaNota, parseFrontmatter, sezioniNota };
