'use strict';
// Google, passo 2: OAuth centralizzato in sola lettura. Solo mock: nessuna chiamata a Google, nessun dato reale.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoogleAuth, AMBITI } = require('../integrations/google/oauth');
const { appProva, MockProvider } = require('./helpers');

const CAL = AMBITI[0], MAIL = AMBITI[1];
const SEGRETI = ['CLIENT-ID-FINTO.apps.googleusercontent.com', 'SEGRETO-CLIENT-FINTO', 'ACCESS-FINTO-1', 'REFRESH-FINTO-1', 'ACCESS-FINTO-2'];
const fintaCifratura = { nome: 'finta', cifra: async t => Buffer.from(t).toString('base64').split('').reverse().join(''), decifra: async b => Buffer.from(b.split('').reverse().join(''), 'base64').toString('utf8') };

function ambiente({ rispostaToken, clientValido = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-goog-'));
  if (clientValido) fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: SEGRETI[0], project_id: 'prova', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', client_secret: SEGRETI[1], redirect_uris: ['http://localhost'] } }));
  const chiamate = []; const t = { ora: 1_000_000 };
  const fetchFn = async (url, init) => {
    const corpo = Object.fromEntries(new URLSearchParams(init.body));
    chiamate.push({ url, corpo });
    if (url.endsWith('/revoke')) return { ok: true, json: async () => ({}) };
    const r = rispostaToken ? rispostaToken(corpo, chiamate.length) : { access_token: 'ACCESS-FINTO-1', refresh_token: 'REFRESH-FINTO-1', expires_in: 3600, scope: CAL + ' ' + MAIL };
    return { ok: !r.error, json: async () => r };
  };
  let urlAutorizzazione = null;
  const auth = new GoogleAuth({ dir, cifratura: fintaCifratura, fetchFn, orologio: () => t.ora, timeoutLoginMs: 400,
    apriBrowser: url => { urlAutorizzazione = url; } });
  const accedi = async (override = {}) => {   // simula il ritorno dal browser: richiesta locale al redirect, come farebbe Google
    for (let i = 0; i < 50 && !urlAutorizzazione; i++) await new Promise(r => setTimeout(r, 10));
    const u = new URL(urlAutorizzazione);
    const redirect = u.searchParams.get('redirect_uri');
    const q = new URLSearchParams({ code: 'CODICE-FINTO', state: u.searchParams.get('state') }); for (const [k, v] of Object.entries(override)) v === null ? q.delete(k) : q.set(k, v);
    return fetch(redirect + '/?' + q.toString());
  };
  return { dir, auth, chiamate, t, accedi, url: () => urlAutorizzazione, pulisci: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const tuttoTesto = dir => fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

test('collegamento: URL con PKCE, solo ambiti di sola lettura, state, loopback; scambio del codice con verifier', async () => {
  const a = ambiente();
  try {
    const p = a.auth.collega(); await a.accedi(); await p;
    const u = new URL(a.url());
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.deepEqual(u.searchParams.get('scope').split(' ').sort(), [CAL, MAIL].sort());
    assert.ok(AMBITI.every(x => /\.readonly$/.test(x)));
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.ok(u.searchParams.get('code_challenge').length >= 40); assert.ok(u.searchParams.get('state').length >= 24);
    assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
    const scambio = a.chiamate[0];
    assert.equal(scambio.corpo.grant_type, 'authorization_code'); assert.equal(scambio.corpo.code, 'CODICE-FINTO'); assert.ok(scambio.corpo.code_verifier.length >= 43);
    const s = await a.auth.stato(); assert.equal(s.collegato, true); assert.match(s.messaggio, /sola lettura/);
  } finally { a.pulisci(); }
});

test('segreti: il token sta cifrato su disco, e client secret e token non compaiono nello stato ne negli errori', async () => {
  const a = ambiente();
  try {
    const p = a.auth.collega(); await a.accedi(); await p;
    const su = tuttoTesto(a.dir);
    assert.ok(fs.existsSync(path.join(a.dir, 'token.dpapi')));
    assert.ok(!fs.readFileSync(path.join(a.dir, 'token.dpapi'), 'utf8').includes('REFRESH-FINTO-1'));
    assert.ok(!JSON.stringify(await a.auth.stato()).match(/FINTO/));
    assert.equal(await a.auth.accessToken(), 'ACCESS-FINTO-1');   // il token si legge solo da accessToken(), mai dallo stato
    for (const s of SEGRETI.slice(2)) assert.ok(!su.includes(s) || s === 'x');
  } finally { a.pulisci(); }
});

test('ambiti: se Google concede permessi diversi (di piu o di meno) il token NON si salva e viene revocato', async () => {
  for (const scope of [CAL, CAL + ' ' + MAIL + ' https://www.googleapis.com/auth/gmail.send', MAIL + ' https://mail.google.com/']) {
    const a = ambiente({ rispostaToken: () => ({ access_token: 'ACCESS-FINTO-1', refresh_token: 'REFRESH-FINTO-1', expires_in: 3600, scope }) });
    try {
      const p = a.auth.collega().catch(e => e); await a.accedi(); const e = await p;
      assert.equal(e.codice, 'AMBITI'); assert.ok(!fs.existsSync(path.join(a.dir, 'token.dpapi')));
      assert.ok(a.chiamate.some(c => c.url.endsWith('/revoke')), 'revoca immediata');
      assert.ok(!String(e.message).match(/FINTO/));
    } finally { a.pulisci(); }
  }
});

test('sicurezza del flusso: state sbagliato ignorato, annullamento, timeout, code mancante', async () => {
  let a = ambiente();
  try {
    const p = a.auth.collega().catch(e => e);
    const r = await a.accedi({ state: 'falso' }); assert.match(await r.text(), /non valida/);   // una richiesta locale estranea non conclude il collegamento
    await a.accedi();
    assert.equal((await p).collegato, true);
  } finally { a.pulisci(); }
  a = ambiente();
  try { const p = a.auth.collega().catch(e => e); await a.accedi({ error: 'access_denied', code: null }); assert.equal((await p).codice, 'ANNULLATO'); } finally { a.pulisci(); }
  a = ambiente();
  try { const e = await a.auth.collega().catch(x => x); assert.equal(e.codice, 'TIMEOUT'); assert.ok(!fs.existsSync(path.join(a.dir, 'token.dpapi'))); } finally { a.pulisci(); }
});

test('rinnovo automatico: access token riusato finche valido, rinnovato alla scadenza con una sola richiesta, mai due in parallelo', async () => {
  const a = ambiente({ rispostaToken: (c, n) => c.grant_type === 'refresh_token' ? { access_token: 'ACCESS-FINTO-2', expires_in: 3600, scope: CAL + ' ' + MAIL } : { access_token: 'ACCESS-FINTO-1', refresh_token: 'REFRESH-FINTO-1', expires_in: 3600, scope: CAL + ' ' + MAIL } });
  try {
    const p = a.auth.collega(); await a.accedi(); await p;
    assert.equal(await a.auth.accessToken(), 'ACCESS-FINTO-1'); assert.equal(a.chiamate.length, 1);
    a.t.ora += 3600 * 1000 - 30000;     // mancano 30 s: da rinnovare
    const [x, y] = await Promise.all([a.auth.accessToken(), a.auth.accessToken()]);
    assert.equal(x, 'ACCESS-FINTO-2'); assert.equal(y, 'ACCESS-FINTO-2');
    assert.equal(a.chiamate.filter(c => c.corpo.grant_type === 'refresh_token').length, 1);
    assert.equal(a.chiamate.at(-1).corpo.refresh_token, 'REFRESH-FINTO-1');
  } finally { a.pulisci(); }
});

test('errori di autenticazione: invalid_grant cancella il token e chiede di ricollegare; senza collegamento errore chiaro', async () => {
  const a = ambiente({ rispostaToken: c => c.grant_type === 'refresh_token' ? { error: 'invalid_grant', error_description: 'Token has been expired or revoked. REFRESH-FINTO-1' } : { access_token: 'ACCESS-FINTO-1', refresh_token: 'REFRESH-FINTO-1', expires_in: 3600, scope: CAL + ' ' + MAIL } });
  try {
    assert.equal((await a.auth.accessToken().catch(e => e)).codice, 'NON_COLLEGATO');
    const p = a.auth.collega(); await a.accedi(); await p;
    a.t.ora += 7200 * 1000;
    const e = await a.auth.accessToken().catch(x => x);
    assert.equal(e.codice, 'TOKEN_REVOCATO'); assert.ok(!String(e.message).match(/FINTO/));
    assert.ok(!fs.existsSync(path.join(a.dir, 'token.dpapi')));
    assert.equal((await a.auth.stato()).collegato, false);
  } finally { a.pulisci(); }
});

test('revoca: scollega revoca su Google e cancella il token locale, anche se Google non risponde', async () => {
  const a = ambiente();
  try {
    const p = a.auth.collega(); await a.accedi(); await p;
    const r = await a.auth.scollega();
    assert.equal(r.collegato, false); assert.equal(r.revocatoSuGoogle, true);
    assert.ok(a.chiamate.some(c => c.url.endsWith('/revoke') && c.corpo.token === 'REFRESH-FINTO-1'));
    assert.ok(!fs.existsSync(path.join(a.dir, 'token.dpapi')));
  } finally { a.pulisci(); }
  const b = ambiente();
  try {
    const p = b.auth.collega(); await b.accedi(); await p;
    b.auth.fetch = async () => { throw new Error('rete assente'); };
    const r = await b.auth.scollega(); assert.equal(r.revocatoSuGoogle, false); assert.ok(!fs.existsSync(path.join(b.dir, 'token.dpapi')));
  } finally { b.pulisci(); }
});

test('client.json: assente, non desktop o con token_uri non Google vengono rifiutati con messaggi che non rivelano contenuti', async () => {
  const a = ambiente({ clientValido: false });
  try {
    assert.equal((await a.auth.stato()).clientPresente, false);
    assert.equal((await a.auth.collega().catch(e => e)).codice, 'CLIENT_ASSENTE');
    fs.writeFileSync(path.join(a.dir, 'client.json'), JSON.stringify({ web: { client_id: 'x', client_secret: 'SEGRETO-WEB' } }));
    const e1 = await a.auth.collega().catch(e => e); assert.equal(e1.codice, 'CLIENT_NON_VALIDO'); assert.ok(!e1.message.includes('SEGRETO-WEB'));
    fs.writeFileSync(path.join(a.dir, 'client.json'), JSON.stringify({ installed: { client_id: 'x', client_secret: 'y', token_uri: 'https://evil.example/token' } }));
    assert.equal((await a.auth.collega().catch(e => e)).codice, 'CLIENT_NON_VALIDO');
  } finally { a.pulisci(); }
});

test('app: integrazione google registrata, spenta di default, senza strumenti di lettura/scrittura ancora; il modello non puo collegare ne scollegare', async () => {
  const app = appProva({ provider: new MockProvider() });
  const el = await app.integrazioni.elenca(); const g = el.find(i => i.id === 'google');
  assert.ok(g); assert.equal(g.abilitata, false);
  assert.deepEqual(g.strumenti.map(s => [s.nome, s.livello]), [['elenca_eventi', 'lettura'], ['cerca_mail', 'lettura'], ['leggi_mail', 'lettura'], ['leggi_conversazione', 'lettura']]);   // solo lettura: niente che scriva, invii o elimini
  assert.equal(typeof app.google.collega, 'function');
  assert.ok(!app.integrazioni.catalogo().some(c => c.integrazione === 'google'));   // spenta: nessuno strumento esposto
});
