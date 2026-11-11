'use strict';
// Gmail, SOLA LETTURA (ambito gmail.readonly). Solo richieste GET: cercare per metadati, leggere un messaggio, ricostruire una conversazione.
// Non esiste nessuna funzione per inviare, eliminare, archiviare, spostare, segnare come letto o cambiare etichette e impostazioni,
// e gli allegati non si scaricano mai (si riportano solo nome, tipo e dimensione).
// Il contenuto delle mail e un DATO non attendibile: puo contenere istruzioni ostili e nessuno le esegue.
const { ErroreGoogle } = require('./oauth');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_RISULTATI = 20, MAX_TESTO_MSG = 12000, MAX_TESTO_THREAD = 30000, MAX_MSG_THREAD = 15;

// ---------- MIME ----------
function b64url(s) { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function decodifica(buf, charset) {
  const c = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(/^(us-ascii|ascii)$/.test(c) ? 'utf-8' : c, { fatal: false }).decode(buf); } catch (e) { return buf.toString('utf8'); }
}
function charsetDa(headers) { const ct = intestazione(headers, 'Content-Type') || ''; const m = ct.match(/charset="?([^";\s]+)"?/i); return m ? m[1] : 'utf-8'; }
function intestazione(headers, nome) { const h = (headers || []).find(x => x.name && x.name.toLowerCase() === nome.toLowerCase()); return h ? h.value : null; }

const ENTITA = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', egrave: 'è', eacute: 'é', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì', euro: '€', laquo: '«', raquo: '»', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '-', mdash: ', ' };
function htmlATesto(html) {
  return String(html)
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, url, t) => { const tt = t.replace(/<[^>]+>/g, '').trim(); return tt && tt !== url ? tt + ' (' + url + ')' : url; })
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(Math.min(parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10) || 32, 0x10FFFF)) : (ENTITA[e.toLowerCase()] !== undefined ? ENTITA[e.toLowerCase()] : m))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Percorre l'albero MIME: preferisce text/plain, altrimenti text/html convertito; elenca gli allegati senza leggerli.
function estraiCorpo(payload) {
  const testi = { plain: [], html: [] }, allegati = [];
  (function visita(p, profondita) {
    if (!p || profondita > 12) return;
    const mime = String(p.mimeType || '').toLowerCase();
    const nomeFile = p.filename || '';
    const disposizione = (intestazione(p.headers, 'Content-Disposition') || '').toLowerCase();
    if (nomeFile || disposizione.startsWith('attachment') || (p.body && p.body.attachmentId && !/^text\//.test(mime))) {
      allegati.push({ nome: (nomeFile || '(senza nome)').slice(0, 120), tipo: mime || 'sconosciuto', byte: (p.body && p.body.size) || 0 });
      return;                                   // mai scaricato, mai letto
    }
    if (p.parts && p.parts.length) { for (const s of p.parts) visita(s, profondita + 1); return; }
    if (!p.body || !p.body.data) return;
    const testo = decodifica(b64url(p.body.data), charsetDa(p.headers));
    if (mime === 'text/plain') testi.plain.push(testo);
    else if (mime === 'text/html') testi.html.push(htmlATesto(testo));
  })(payload, 0);
  const testo = (testi.plain.length ? testi.plain.join('\n\n') : testi.html.join('\n\n')).replace(/\r\n?/g, '\n').trim();
  return { testo, formato: testi.plain.length ? 'testo' : testi.html.length ? 'html' : 'vuoto', allegati };
}

// Toglie le parti citate delle risposte (righe con ">" e il blocco "Il giorno ... ha scritto:"), per i thread.
function senzaCitazioni(t) {
  const righe = t.split('\n'); const out = [];
  for (const r of righe) {
    if (/^\s*(Il giorno .{5,120} ha scritto:|On .{5,120} wrote:|-{2,}\s*Messaggio originale\s*-{2,}|-{2,}\s*Original Message\s*-{2,})/i.test(r)) break;
    if (/^\s*>/.test(r)) continue;
    out.push(r);
  }
  return out.join('\n').trim();
}

function meta(m) {
  const h = (m.payload && m.payload.headers) || [];
  return { id: m.id, conversazione: m.threadId, da: (intestazione(h, 'From') || '').slice(0, 200), a: (intestazione(h, 'To') || '').slice(0, 300), oggetto: (intestazione(h, 'Subject') || '(senza oggetto)').slice(0, 200),
    data: intestazione(h, 'Date') || (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null), anteprima: htmlATesto(m.snippet || '').slice(0, 220), nonLetta: (m.labelIds || []).includes('UNREAD') };
}

// ---------- query Gmail costruita da campi controllati ----------
const pulisciTermine = s => String(s || '').replace(/["\\(){}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const dataGmail = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.replace(/-/g, '/') : null;
function costruisciQuery({ mittente, destinatario, oggetto, parole, dopo, prima, cartella, nonLette }) {
  const q = [];
  const campo = (k, v) => { const t = pulisciTermine(v); if (t) q.push(k + ':' + (/\s/.test(t) ? '"' + t + '"' : t)); };
  campo('from', mittente); campo('to', destinatario); campo('subject', oggetto);
  if (parole) { const t = pulisciTermine(parole).replace(/\b(from|to|subject|in|is|label|has|after|before|older_than|newer_than|filename|cc|bcc|deliveredto|category|larger|smaller|rfc822msgid):/gi, '$1 '); if (t) q.push(t); }
  if (dataGmail(dopo)) q.push('after:' + dataGmail(dopo));
  if (dataGmail(prima)) q.push('before:' + dataGmail(prima));
  if (cartella === 'inviata') q.push('in:sent'); else if (cartella === 'tutte') q.push('in:anywhere -in:spam -in:trash'); else q.push('in:inbox');
  if (nonLette) q.push('is:unread');
  return q.join(' ');
}

function creaGmail({ auth, fetchFn = fetch }) {
  async function get(percorso, signal) {
    const token = await auth.accessToken();
    let r, j;
    try { r = await fetchFn(API + percorso, { headers: { Authorization: 'Bearer ' + token }, signal }); j = await r.json(); }
    catch (e) { if (signal && signal.aborted) throw e; throw new ErroreGoogle('RETE', 'Non riesco a contattare Gmail.'); }
    if (!r.ok) {
      const motivo = String(j && j.error && (j.error.errors && j.error.errors[0] && j.error.errors[0].reason || j.error.status) || r.status).slice(0, 40);
      if (r.status === 401) throw new ErroreGoogle('TOKEN_REVOCATO', 'Google ha rifiutato l\'accesso: ricollega Google dalle impostazioni.');
      if (/accessNotConfigured|SERVICE_DISABLED/.test(motivo) || (r.status === 403 && /PERMISSION_DENIED/.test(motivo))) throw new ErroreGoogle('API_NON_ABILITATA', 'Google ha negato l\'accesso a Gmail (' + motivo + '). Di solito vuol dire che la "Gmail API" non e abilitata nel progetto Google Cloud configurato: Console Google, API e servizi, Libreria, Gmail API, Abilita.');
      if (r.status === 403 && /insufficient/i.test(motivo)) throw new ErroreGoogle('AMBITI', 'Il collegamento non ha il permesso di lettura di Gmail: scollega e ricollega Google concedendo anche Gmail.');
      if (r.status === 404) throw new ErroreGoogle('NON_TROVATA', 'Mail o conversazione non trovata.');
      if (r.status === 429 || /rateLimit/i.test(motivo)) throw new ErroreGoogle('LIMITE', 'Gmail ha raggiunto un limite temporaneo: riprova tra poco.');
      throw new ErroreGoogle('API', 'Gmail ha risposto con un errore (' + motivo + ').');
    }
    return j;
  }
  const id = s => { if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(s || ''))) throw new Error('Identificativo non valido.'); return s; };

  async function leggiConversazione(conversazione, signal) {
    const t = await get('/threads/' + id(conversazione) + '?format=full', signal);
    const msgs = (t.messages || []).slice(-MAX_MSG_THREAD);
    let usati = 0; const messaggi = [];
    for (const m of msgs) {
      const c = estraiCorpo(m.payload);
      let testo = senzaCitazioni(c.testo);
      const spazio = Math.max(500, Math.min(MAX_TESTO_MSG, MAX_TESTO_THREAD - usati));
      const troncato = testo.length > spazio; if (troncato) testo = testo.slice(0, spazio);
      usati += testo.length;
      messaggi.push(Object.assign(meta(m), { testo, troncato, allegati: c.allegati }));
    }
    return { conversazione, messaggi, totali: (t.messages || []).length, omessi: Math.max(0, (t.messages || []).length - msgs.length) };
  }

  return {
    costruisciQuery,
    async cerca(p, { signal } = {}) {
      const q = costruisciQuery(p);
      const lista = await get('/messages?' + new URLSearchParams({ q, maxResults: String(Math.min(p.limite || 10, MAX_RISULTATI)) }), signal);
      const risultati = [];
      for (const x of lista.messages || []) {
        const m = await get('/messages/' + id(x.id) + '?' + new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'To'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'Date']]), signal);
        risultati.push(meta(m));
      }
      const out = { query: q, risultati, altri: !!lista.nextPageToken };
      if (p.apri_prima && risultati.length) out.primaConversazione = await leggiConversazione(risultati[0].conversazione, signal);
      return out;
    },
    async leggi({ id: mid }, { signal } = {}) {
      const m = await get('/messages/' + id(mid) + '?format=full', signal);
      const c = estraiCorpo(m.payload);
      const troncato = c.testo.length > MAX_TESTO_MSG;
      return Object.assign(meta(m), { testo: troncato ? c.testo.slice(0, MAX_TESTO_MSG) : c.testo, troncato, formato: c.formato, allegati: c.allegati });
    },
    async conversazione({ id: tid }, { signal } = {}) { return leggiConversazione(tid, signal); }
  };
}

module.exports = { creaGmail, estraiCorpo, htmlATesto, senzaCitazioni, costruisciQuery };
