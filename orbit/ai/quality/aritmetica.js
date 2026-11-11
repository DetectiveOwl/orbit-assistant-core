'use strict';
// Calcolo aritmetico sicuro (parser ricorsivo, nessun eval) per verificare in locale i risultati numerici.

function tokenizza(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if (!/^\d+(\.\d+)?$|^\.\d+$/.test(raw)) return null;
      out.push({ t: 'n', v: Number(raw) });
      i = j; continue;
    }
    if (c === '*' && src[i + 1] === '*') { out.push({ t: 'op', v: '^' }); i += 2; continue; }
    if ('+-*/^%()'.includes(c)) { out.push({ t: c === '(' || c === ')' ? c : 'op', v: c }); i++; continue; }
    return null;
  }
  return out;
}

// Restituisce un numero finito oppure null se l'espressione non e valida.
function valuta(src) {
  const tk = tokenizza(src);
  if (!tk || !tk.length) return null;
  let p = 0;
  const peek = () => tk[p];
  function primario() {
    const x = peek();
    if (!x) throw new Error('fine');
    if (x.t === 'n') { p++; return x.v; }
    if (x.t === 'op' && (x.v === '-' || x.v === '+')) { p++; const v = potenza(); return x.v === '-' ? -v : v; }
    if (x.t === '(') { p++; const v = somma(); if (!peek() || peek().t !== ')') throw new Error('parentesi'); p++; return v; }
    throw new Error('token');
  }
  function potenza() {
    const base = primario();
    const x = peek();
    if (x && x.t === 'op' && x.v === '^') { p++; return Math.pow(base, potenza()); }
    return base;
  }
  function prodotto() {
    let v = potenza();
    for (;;) {
      const x = peek();
      if (x && x.t === 'op' && (x.v === '*' || x.v === '/' || x.v === '%')) {
        p++; const r = potenza();
        if (x.v === '*') v *= r; else if (x.v === '/') { if (r === 0) throw new Error('div0'); v /= r; } else v %= r;
      } else return v;
    }
  }
  function somma() {
    let v = prodotto();
    for (;;) {
      const x = peek();
      if (x && x.t === 'op' && (x.v === '+' || x.v === '-')) { p++; const r = prodotto(); v = x.v === '+' ? v + r : v - r; } else return v;
    }
  }
  try {
    const v = somma();
    if (p !== tk.length || !Number.isFinite(v)) return null;
    return v;
  } catch (e) { return null; }
}

// Cerca nel testo un'espressione aritmetica (es. "quanto fa 12*(3+4)?") e la normalizza.
function estraiEspressione(testo) {
  const m = String(testo).match(/[\d(][\d\s.,()+\-*/^×÷:%]*[\d)]/g);
  if (!m) return null;
  let migliore = null;
  for (const raw of m) {
    let s = raw.trim().replace(/×/g, '*').replace(/÷|:/g, '/').replace(/(\d)\s*x\s*(\d)/gi, '$1*$2');
    s = s.replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2').replace(/,/g, '.');   // 1.000 -> 1000, 3,5 -> 3.5
    if (!/[+\-*/^%]/.test(s.replace(/^-/, ''))) continue;
    if (valuta(s) == null) continue;
    if (!migliore || s.length > migliore.length) migliore = s;
  }
  return migliore;
}

// Controlla se il risultato compare nel testo, con virgola o punto decimale e senza separatore delle migliaia.
function risultatoPresente(testo, valore) {
  const arrotondato = Math.round(valore * 1e6) / 1e6;
  const forme = new Set([String(arrotondato), String(arrotondato).replace('.', ',')]);
  const intero = Number.isInteger(arrotondato) ? String(arrotondato) : null;
  if (intero && intero.replace('-', '').length > 3) {
    const migliaia = (sep) => intero.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    forme.add(migliaia('.'));
    forme.add(migliaia(','));
  }
  const pulito = String(testo).replace(/ /g, ' ');
  for (const f of forme) {
    const re = new RegExp('(^|[^\\d.,])' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\d]|[.,]\\d)');
    if (re.test(pulito)) return true;
  }
  return false;
}

// Una sola operazione con operandi espliciti: nessuna parola residua puo riferirsi a note, storia o spiegazioni.
function calcoloRapido(testo) {
  let s = String(testo).trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’]/g, "'");
  if (s.length > 120) return null;
  s = s.replace(/[?.]$/, '').trim();
  const prodotto = s.match(/^qual(?: e| e'|'e) il prodotto (?:tra|di) (.+) e (.+)$/);
  if (prodotto) s = prodotto[1] + '*' + prodotto[2];
  else s = s.replace(/^(?:quanto fa|calcola)\s+/, '');
  s = s.replace(/\b(per|moltiplicato per|diviso|piu|meno)\b/g, op => ({ per: '*', 'moltiplicato per': '*', diviso: '/', piu: '+', meno: '-' })[op])
    .replace(/[x×]/g, '*').replace(/[÷:]/g, '/');
  const m = s.match(/^([+-]?\s*\d+(?:[.,]\d{1,6})?)\s*([+*/-])\s*([+-]?\s*\d+(?:[.,]\d{1,6})?)$/);
  if (!m) return null;
  // Il punto con tre cifre puo indicare migliaia: non scegliere un significato per l'utente.
  if (/\d+\.\d{3}(?!\d)/.test(s)) return null;
  const a = m[1].replace(/\s/g, '').replace(',', '.'), b = m[3].replace(/\s/g, '').replace(',', '.');
  // shortcut: due operandi entro 999999999 e sei decimali, ampliare solo con certificazione e pronuncia altrettanto testate.
  if (Math.abs(Number(a)) > 999999999 || Math.abs(Number(b)) > 999999999) return null;
  const espressione = a + m[2] + b, valore = valuta(espressione);
  if (valore === null || Math.abs(valore) > 999999999) return null;
  const risultato = valore.toFixed(6).replace(/\.?0+$/, '') || '0';
  // Certifica con interi esatti il testo che verra mostrato: niente arrotondamenti silenziosi o perdita di precisione IEEE-754.
  const scala = 1000000n;
  const intero = n => {
    const [i, d = ''] = n.replace(/^[+-]/, '').split('.');
    return (n.startsWith('-') ? -1n : 1n) * BigInt(i + d.padEnd(6, '0'));
  };
  const x = intero(a), y = intero(b), z = intero(risultato);
  const valido = { '+': z === x + y, '-': z === x - y, '*': z * scala === x * y, '/': y !== 0n && z * y === x * scala }[m[2]];
  if (!valido) return null;
  return { espressione, risultato: risultato === '-0' ? '0' : risultato };
}

module.exports = { valuta, estraiEspressione, risultatoPresente, calcoloRapido };
