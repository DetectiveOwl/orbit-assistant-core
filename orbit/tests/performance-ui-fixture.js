'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CS = require('../public/core-state');
const MD = require('../public/markdown');
const OP = require('../public/performance');

// Esegue l'app reale con DOM, rete e orologio simulati: nessun modello, browser o timer reale.
function ambienteUI(sorgente = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), risposteApi = {}) {
  let ora = 0, n = 0;
  const timers = new Map(), raf = [], elementi = new Map(), richieste = [], stati = [];
  const elemento = id => {
    if (!elementi.has(id)) elementi.set(id, {
      id, hidden: true, value: '', textContent: '', get innerHTML() { return this._html || ''; }, set innerHTML(v) { this._html = v; this.children = []; }, dataset: {}, tagName: 'DIV', children: [],
      style: { setProperty() {} }, classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
      listeners: {}, eventi: {},
      addEventListener(nome, cb) {
        (this.eventi[nome] ||= new Set()).add(cb);
        this.listeners[nome] = e => { for (const f of [...this.eventi[nome]]) f(e); };
      },
      removeEventListener(nome, cb) { this.eventi[nome]?.delete(cb); },
      showModal() { this.open = true; },
      close(valore) { if (!this.open) return; this.open = false; if (valore !== undefined) this.returnValue = valore; Promise.resolve().then(() => this.listeners.close?.({})); },
      setAttribute() {}, getAttribute: () => null, appendChild(x) { this.children.push(x); }, append(...voci) { this.children.push(...voci); }, remove() {},
      querySelectorAll: () => [], querySelector: () => elemento('form'), focus() {}, contains: () => false, matches: () => false,
      scrollIntoView() {}, getBoundingClientRect: () => ({ width: 520, height: 220 }), getClientRects: () => [{}], scrollHeight: 220, clientHeight: 220
    });
    return elementi.get(id);
  };
  const documento = { hidden: false, getElementById: elemento, documentElement: elemento('html'), body: elemento('body'),
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: tag => Object.assign(elemento('nuovo_' + ++n), { tagName: tag.toUpperCase() }) };
  elemento('diagTabella').tBodies = [elemento('diagRighe')];
  elemento('auditTabella').tBodies = [elemento('auditRighe')];
  let finali = [], erroreStream = false;
  const chiamateApi = [];
  const fetch = async (url, init) => {
    chiamateApi.push({ url, init });
    if (url === '/api/chat') richieste.push(JSON.parse(init.body));
    if (typeof risposteApi[url] === 'function') return risposteApi[url](init);
    if (url in risposteApi) return { ok: true, json: async () => risposteApi[url] };
    if (url === '/api/chat') {
      const bytes = new TextEncoder().encode(finali.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
      let letta = false;
      return { ok: true, body: { getReader: () => ({ read: async () => {
        if (letta && erroreStream) throw new Error('Connessione simulata interrotta');
        return letta ? { done: true } : (letta = true, { done: false, value: bytes });
      } }) } };
    }
    if (url.startsWith('/api/performance/')) richieste.push(JSON.parse(init.body));
    return { ok: true, json: async () => url === '/api/status' ? { performanceTrace: true, preferenze: { modalita: 'testo' }, configurazione: [], modelli: [], memoria: { ok: false }, abbonamento: { ok: true }, oggi: {} } : [] };
  };
  const noop = () => {};
  const core = { imposta: s => stati.push({ ...s, ora }), apertura: noop, geometria: noop, livello: noop, movimento: noop, temaCambiato: noop, diagnostica: () => ({}), avanza: noop, forzaMovimento: noop };
  const sintesi = { locale: { disponibile: false }, supportata: false, haVoceItaliana: () => false, inCorso: () => false, ferma: noop, inizializza: async () => ({}), voci: () => [] };
  const riconoscimento = { supportato: false, attivo: () => false, ferma: noop };
  const attivazione = { attiva: () => false, supportata: false };
  const win = { OrbitCoreState: CS, OrbitMarkdown: MD, OrbitPerformance: OP, OrbitCore: { crea: () => core },
    OrbitVoice: { VOCE_LOCALE: '__locale__', creaRiconoscimento: () => riconoscimento, creaSintesiOrbit: () => sintesi,
      creaParolaDiAttivazione: (w, callbacks) => { attivazione.callbacks = callbacks; return attivazione; } }, document: documento, fetch,
    innerWidth: 1200, innerHeight: 900, performance: { now: () => ora }, addEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: cb => raf.push(cb), getComputedStyle: () => ({ opacity: '1', visibility: 'visible' }) };
  const setTimeout = (cb, ms) => { const id = ++n; timers.set(id, { cb, fine: ora + ms }); return id; };
  const avanza = ms => {
    const fine = ora + ms;
    for (;;) {
      const prossimo = [...timers].filter(([, t]) => t.fine <= fine).sort((a, b) => a[1].fine - b[1].fine)[0];
      if (!prossimo) break;
      timers.delete(prossimo[0]); ora = prossimo[1].fine; prossimo[1].cb();
    }
    ora = fine;
  };
  const inizio = Date.now();
  class DataSimulata extends Date { static now() { return inizio + ora; } }
  vm.runInNewContext(sorgente, { window: win, document: documento, navigator: { userAgent: 'Chrome/' }, Intl, AbortController, TextDecoder, Date: DataSimulata,
    fetch, setTimeout, clearTimeout: id => timers.delete(id), requestAnimationFrame: win.requestAnimationFrame, performance: win.performance });
  const scarica = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return { win, elementi, richieste, chiamateApi, sintesi, riconoscimento, attivazione, stati, avanza, scarica, get adesso() { return inizio + ora; },
    frame() { ora += 1000 / 60; for (const cb of raf.splice(0)) cb(ora); },
    async invia(eventi, errore = false, testo = 'Ciao') { finali = eventi; erroreStream = errore; elemento('input').value = testo; elemento('input').listeners.input?.({}); elemento('capsula').listeners.submit({ preventDefault: noop }); await scarica(); },
    get ora() { return ora; }
  };
}
module.exports = { ambienteUI };
