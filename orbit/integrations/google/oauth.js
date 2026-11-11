'use strict';
// OAuth 2.0 per app desktop (PKCE, redirect su loopback) di Google, CENTRALIZZATO: Calendar e Gmail usano questo modulo e nessun altro.
// Ambiti: SOLO sola lettura (calendar.readonly, gmail.readonly). Qualsiasi ambito in piu o in meno nel token emesso fa rifiutare il collegamento.
// Segreti: client.json e il token stanno in %LOCALAPPDATA%\Orbit\google (fuori dal vault, fuori da Git); il token e cifrato con DPAPI.
// Nessuna funzione di questo modulo stampa, registra o restituisce client secret, access token o refresh token: gli errori contengono
// soltanto codici e messaggi fissi. Non si chiede mai di incollare password o token in chat: l'utente accede nella pagina di Google.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const AMBITI = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.readonly'];
const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const REVOKE_URI = 'https://oauth2.googleapis.com/revoke';
const ATTESA_LOGIN_MS = 5 * 60 * 1000;

class ErroreGoogle extends Error { constructor(codice, msg) { super(msg); this.name = 'ErroreGoogle'; this.codice = codice; } }
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class GoogleAuth {
  // dir: cartella dei segreti. cifratura: { cifra, decifra }. fetchFn e apriBrowser sono iniettabili per i test.
  constructor({ dir, cifratura, fetchFn = fetch, apriBrowser = () => {}, orologio = Date.now, timeoutLoginMs = ATTESA_LOGIN_MS }) {
    this.dir = dir; this.cifratura = cifratura; this.fetch = fetchFn; this.apriBrowser = apriBrowser; this.ora = orologio; this.timeoutLoginMs = timeoutLoginMs;
    this.fileClient = path.join(dir, 'client.json'); this.fileToken = path.join(dir, 'token.dpapi');
    this.cache = null; this.rinnovo = null; this.login = null;
  }

  // ---- client OAuth (letto, mai restituito) ----
  _client() {
    let j;
    try { j = JSON.parse(fs.readFileSync(this.fileClient, 'utf8')); } catch (e) { throw new ErroreGoogle('CLIENT_ASSENTE', 'Manca il file del client OAuth (client.json) in ' + this.dir + '.'); }
    const c = j && j.installed;
    if (!c || !c.client_id || !c.client_secret) throw new ErroreGoogle('CLIENT_NON_VALIDO', 'Il file client.json non e un client OAuth per applicazione desktop (manca la sezione "installed").');
    if (c.token_uri && c.token_uri !== TOKEN_URI) throw new ErroreGoogle('CLIENT_NON_VALIDO', 'Il client OAuth punta a un indirizzo di token non Google: rifiutato.');
    return { id: c.client_id, secret: c.client_secret, progetto: c.project_id || null };
  }
  clientPresente() { try { this._client(); return true; } catch (e) { return false; } }

  // ---- token cifrato ----
  async _leggiToken() {
    if (this.cache) return this.cache;
    let b64; try { b64 = fs.readFileSync(this.fileToken, 'utf8'); } catch (e) { return null; }
    try { this.cache = JSON.parse(await this.cifratura.decifra(b64)); } catch (e) { throw new ErroreGoogle('TOKEN_ILLEGGIBILE', 'Il token salvato non si puo leggere (altro utente Windows o file danneggiato): ricollega Google.'); }
    return this.cache;
  }
  async _salvaToken(t) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileToken, await this.cifratura.cifra(JSON.stringify(t)), { encoding: 'utf8', mode: 0o600 });
    this.cache = t;
  }
  _cancellaToken() { this.cache = null; try { fs.unlinkSync(this.fileToken); } catch (e) { /* gia assente */ } }

  // Un token vale solo se contiene ESATTAMENTE gli ambiti di sola lettura richiesti.
  static verificaAmbiti(scope) {
    const dati = new Set(String(scope || '').split(/\s+/).filter(Boolean));
    const mancanti = AMBITI.filter(a => !dati.has(a));
    const extra = [...dati].filter(a => !AMBITI.includes(a) && !/^(openid|email|profile)$/.test(a));
    return { ok: !mancanti.length && !extra.length, mancanti: mancanti.map(a => a.split('/').pop()), extra: extra.map(a => a.split('/').pop()) };
  }

  async _richiestaToken(corpo) {
    let r, j;
    try {
      r = await this.fetch(TOKEN_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(corpo).toString() });
      j = await r.json();
    } catch (e) { throw new ErroreGoogle('RETE', 'Non riesco a contattare Google (controlla la connessione).'); }
    if (!r.ok || j.error) {
      const e = String(j && j.error || 'errore').slice(0, 40);
      throw new ErroreGoogle(e === 'invalid_grant' ? 'TOKEN_REVOCATO' : 'AUTORIZZAZIONE', e === 'invalid_grant' ? 'L\'accesso a Google e scaduto o e stato revocato: serve ricollegare.' : 'Google ha rifiutato la richiesta (' + e + ').');
    }
    return j;
  }

  // ---- stato (senza segreti) ----
  async stato() {
    const base = { clientPresente: this.clientPresente(), cartella: this.dir, collegato: false, ambiti: AMBITI.map(a => a.split('/').pop()), cifratura: this.cifratura.nome || 'cifratura' };
    if (!base.clientPresente) return Object.assign(base, { messaggio: 'client OAuth mancante' });
    try {
      const t = await this._leggiToken();
      if (!t) return Object.assign(base, { messaggio: 'non collegato' });
      const v = GoogleAuth.verificaAmbiti(t.scope);
      return Object.assign(base, { collegato: v.ok, messaggio: v.ok ? 'collegato (sola lettura)' : 'ambiti non validi: ricollega', scadeIl: new Date(t.scadenza).toISOString() });
    } catch (e) { return Object.assign(base, { messaggio: e.message }); }
  }

  // ---- collegamento: l'utente accede nella pagina di Google, nessuna password passa da Orbit ----
  async collega() {
    if (this.login) return this.login;       // un solo collegamento alla volta
    this.login = this._collega().finally(() => { this.login = null; });
    return this.login;
  }
  async _collega() {
    const c = this._client();
    const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(24));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    let chiudi = () => {};
    const codice = await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/') { res.writeHead(404).end(); return; }
        const fine = (ok, msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>Orbit</title><body style="font-family:system-ui;padding:3em;text-align:center"><h2>' + msg + '</h2><p>Puoi chiudere questa scheda e tornare a Orbit.</p>'); };
        if (u.searchParams.get('state') !== state) { fine(false, 'Richiesta non valida.'); return; }          // altre richieste locali non fermano il collegamento
        if (u.searchParams.get('error')) { fine(false, 'Collegamento annullato.'); chiudi(); reject(new ErroreGoogle('ANNULLATO', 'Collegamento a Google annullato.')); return; }
        const code = u.searchParams.get('code');
        if (!code) { fine(false, 'Richiesta non valida.'); return; }
        fine(true, 'Orbit e collegato a Google (sola lettura).'); chiudi(); resolve(code);
      });
      const timer = setTimeout(() => { chiudi(); reject(new ErroreGoogle('TIMEOUT', 'Collegamento scaduto: nessun accesso completato entro 5 minuti.')); }, this.timeoutLoginMs);
      if (timer.unref) timer.unref();
      chiudi = () => { clearTimeout(timer); try { srv.close(); srv.closeAllConnections && srv.closeAllConnections(); } catch (e) { /* gia chiuso */ } };
      srv.on('error', () => { chiudi(); reject(new ErroreGoogle('RETE', 'Non riesco ad aprire la porta locale per il collegamento.')); });
      srv.listen(0, '127.0.0.1', () => {
        const redirect = 'http://127.0.0.1:' + srv.address().port;
        this._redirect = redirect;
        const url = AUTH_URI + '?' + new URLSearchParams({ client_id: c.id, redirect_uri: redirect, response_type: 'code', scope: AMBITI.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
        try { this.apriBrowser(url); } catch (e) { chiudi(); reject(new ErroreGoogle('BROWSER', 'Non riesco ad aprire il browser.')); }
      });
    });
    const j = await this._richiestaToken({ code: codice, client_id: c.id, client_secret: c.secret, redirect_uri: this._redirect, grant_type: 'authorization_code', code_verifier: verifier });
    const v = GoogleAuth.verificaAmbiti(j.scope);
    if (!v.ok) {
      // Token emesso con ambiti diversi da quelli voluti: non si salva e si revoca subito.
      try { await this._revocaRemoto(j.refresh_token || j.access_token); } catch (e) { /* si e comunque rifiutato */ }
      throw new ErroreGoogle('AMBITI', 'Google ha concesso permessi diversi da quelli richiesti' + (v.mancanti.length ? ' (mancano: ' + v.mancanti.join(', ') + ')' : '') + (v.extra.length ? ' (in piu: ' + v.extra.join(', ') + ')' : '') + ': collegamento rifiutato.');
    }
    if (!j.refresh_token) throw new ErroreGoogle('AUTORIZZAZIONE', 'Google non ha emesso un refresh token: ripeti il collegamento.');
    await this._salvaToken({ access: j.access_token, refresh: j.refresh_token, scope: j.scope, scadenza: this.ora() + (j.expires_in || 3600) * 1000 });
    return { collegato: true };
  }

  // ---- access token sempre valido, con rinnovo automatico ----
  async accessToken() {
    const t = await this._leggiToken();
    if (!t) throw new ErroreGoogle('NON_COLLEGATO', 'Google non e collegato: usa "Collega Google" nelle impostazioni.');
    if (!GoogleAuth.verificaAmbiti(t.scope).ok) throw new ErroreGoogle('AMBITI', 'Il token salvato non ha gli ambiti di sola lettura attesi: ricollega Google.');
    if (t.scadenza - this.ora() > 60000) return t.access;
    if (!this.rinnovo) {
      this.rinnovo = (async () => {
        const c = this._client();
        let j;
        try { j = await this._richiestaToken({ client_id: c.id, client_secret: c.secret, refresh_token: t.refresh, grant_type: 'refresh_token' }); }
        catch (e) { if (e.codice === 'TOKEN_REVOCATO') this._cancellaToken(); throw e; }
        const nuovo = Object.assign({}, t, { access: j.access_token, scadenza: this.ora() + (j.expires_in || 3600) * 1000 }, j.refresh_token ? { refresh: j.refresh_token } : {});
        if (j.scope && !GoogleAuth.verificaAmbiti(j.scope).ok) throw new ErroreGoogle('AMBITI', 'Google ha cambiato gli ambiti del token: ricollega.');
        await this._salvaToken(nuovo);
        return nuovo.access;
      })().finally(() => { this.rinnovo = null; });
    }
    return this.rinnovo;
  }

  // ---- revoca ----
  async _revocaRemoto(token) {
    if (!token) return;
    await this.fetch(REVOKE_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
  }
  async scollega() {
    const t = await this._leggiToken().catch(() => null);
    let remoto = true;
    if (t) { try { await this._revocaRemoto(t.refresh || t.access); } catch (e) { remoto = false; } }
    this._cancellaToken();
    return { collegato: false, revocatoSuGoogle: remoto };
  }
}

module.exports = { GoogleAuth, ErroreGoogle, AMBITI };

