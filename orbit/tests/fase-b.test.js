'use strict';
// Fase B: Orbit senza la vecchia HUD (porta 4777), skill piano-oggi nel backend, retrieval unico per chat, MCP e strumenti Obsidian.
// Vault temporaneo, memoria vera, provider finto: nessuna chiamata a modelli, vault personale mai toccato.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RADICE = path.join(__dirname, '..', '..');              // .orbit-hud
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fb-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
const leggi = p => fs.readFileSync(path.join(V, p), 'utf8');
const { oraDiRoma } = require('../ai/context');
const OGGI = oraDiRoma();
const ieri = (() => { const d = new Date(OGGI + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const giorno = d => ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'][new Date(d + 'T12:00:00Z').getUTCDay()] + ' ' + new Date(d + 'T12:00:00Z').getUTCDate();

fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
scrivi('.claude/skills/piano-oggi/SKILL.md', '---\nname: piano-oggi\ndescription: prova\n---\n## 1. Controlla dove sono arrivato\nISTRUZIONE-DELLA-SKILL: massimo 3 priorita.\n');
scrivi('cervello/INDEX.md', '# Cervello\n\n- [[chi-sono]]\n');
scrivi('scadenze/piano-di-studio.md', '# Piano\n\n## Come funziona il piano\n\nSi studia dopo le lezioni.\n\n## Piano giorno per giorno\n\n| Giorno | Ore | Cosa |\n| :-- | :-- | :-- |\n| ' + giorno(OGGI) + ' | 3h | RIGA-DI-OGGI A4 |\n');
scrivi('scadenze/parziali.md', '# Parziali\n\n## Stato del ripasso\n\n| Sigla | Stato |\n| :-- | :-- |\n| A4 | da fare |\n\n## Registro\n\n- nulla\n');
// piano di ieri nel formato della vecchia HUD (senza frontmatter): non si tocca e resta leggibile
const PIANO_IERI = 'In pari col piano.\nNiente cambiato.\n\n**A3** matrice inversa, 2h.\n';
scrivi('outputs/piano-' + ieri + '.md', PIANO_IERI);
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

const memoria = require('../../memoria/memoria');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const { creaServer } = require('../server');
const { MockProvider, settingsProva } = require('./helpers');
const pianoOggi = require('../skills/piano-oggi');
memoria.avvia();

function app(produttore) {
  const provider = new MockProvider({ produttore });
  const a = creaApp({ settings: settingsProva({ settings: { dataDir: path.join(BASE, 'dati') } }), provider, storage: new Storage(':memory:'), memoria, attendiFn: () => Promise.resolve() });
  a.permessi.impostaAbilitata('obsidian', true); a.permessi.impostaLivello('obsidian', 'crea', 'consenti');
  return { a, provider };
}

// ---------- vecchia HUD ----------
test('la vecchia HUD non c\'e piu e nessun file di Orbit dipende dalla porta 4777', () => {
  for (const f of ['server.js', 'index.html', 'claude-settings.json', 'avvia-hud.bat']) assert.equal(fs.existsSync(path.join(RADICE, f)), false, f);
  const sorgenti = [];
  (function giro(d) { for (const v of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, v.name); if (v.isDirectory()) { if (!['node_modules', 'tests', 'vendor'].includes(v.name)) giro(p); } else if (/\.(js|bat|json|html)$/.test(v.name)) sorgenti.push(p); } })(RADICE);
  for (const f of sorgenti) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\b4777\b|claude-settings\.json|mcp-config\.json/, f);
  assert.match(fs.readFileSync(path.join(RADICE, 'avvia-orbit.bat'), 'utf8'), /node server\.js/);   // dentro orbit/
});

test('la nuova Orbit si avvia senza la HUD: stato, memoria e chat rispondono', async () => {
  const { a } = app(() => 'Ciao Marco.');
  const server = creaServer(a, { port: 0 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; server.close();
  const s2 = creaServer(a, { port }); await new Promise(r => s2.listen(port, '127.0.0.1', r));
  try {
    const st = await (await fetch('http://localhost:' + port + '/api/status')).json();
    assert.equal(st.memoria.ok, true); assert.ok(st.memoria.note >= 4);
    const r = await fetch('http://localhost:' + port + '/api/chat', { method: 'POST', headers: { 'X-Orbit': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'ciao Orbit' }) });
    assert.equal(r.status, 200); assert.match(await r.text(), /Ciao Marco/);
    assert.equal((await fetch('http://localhost:' + port + '/')).status, 200);       // interfaccia nuova (public/index.html)
  } finally { s2.closeAllConnections(); await new Promise(r => s2.close(r)); }
});

// ---------- retrieval unico ----------
test('strumenti Obsidian di Orbit: ricerca per sezioni; nota intera solo se richiesta esplicitamente', async () => {
  const { a } = app(() => 'x');
  const cerca = await a.integrazioni.esegui('obsidian', 'cerca_note', { query: 'stato del ripasso A4' });
  assert.equal(cerca.ok, true); assert.equal(cerca.risultato.risultati[0].percorso, 'scadenze/parziali.md');
  assert.equal(cerca.risultato.risultati[0].sezione, 'Parziali > Stato del ripasso');
  const sez = await a.integrazioni.esegui('obsidian', 'leggi_nota', { percorso: 'parziali', sezione: 'Stato del ripasso' });
  assert.equal(sez.risultato.intera, false); assert.deepEqual(sez.risultato.sezioni.map(s => s.sezione), ['Parziali > Stato del ripasso']);
  assert.doesNotMatch(JSON.stringify(sez.risultato.sezioni), /Registro/);
  const intera = await a.integrazioni.esegui('obsidian', 'leggi_nota', { percorso: 'scadenze/parziali.md' });
  assert.equal(intera.risultato.intera, true); assert.match(intera.risultato.contenuto, /## Registro/);
  const perTag = memoria.cercaNote('tag:inesistente prova');                         // i filtri di tag passano dalla ricerca per note
  assert.ok(Array.isArray(perTag));
});

test('server MCP: si avvia da solo e usa lo stesso retrieval (cerca_note per sezioni, leggi_nota intera o per sezione)', async () => {
  const p = spawn(process.execPath, [path.join(RADICE, 'memoria', 'mcp.js')], { env: Object.assign({}, process.env, { ORBIT_VAULT_PATH: V, ORBIT_INDEX_DIR: path.join(BASE, 'indice-mcp') }), stdio: ['pipe', 'pipe', 'pipe'] });
  const risposte = new Map(); let buf = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); risposte.set(r.id, r); } });
  const chiedi = (id, method, params) => new Promise((ok, ko) => {
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const t0 = Date.now(); const giro = () => risposte.has(id) ? ok(risposte.get(id)) : Date.now() - t0 > 15000 ? ko(new Error('timeout ' + method)) : setTimeout(giro, 20); giro();
  });
  try {
    const init = await chiedi(1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'orbit-memoria');
    const lista = await chiedi(2, 'tools/list', {});
    assert.deepEqual(lista.result.tools.map(t => t.name), ['cerca_note', 'leggi_nota', 'elenca_note', 'stato_memoria']);
    assert.ok(lista.result.tools[1].inputSchema.properties.sezione);
    const cerca = JSON.parse((await chiedi(3, 'tools/call', { name: 'cerca_note', arguments: { query: 'stato del ripasso A4' } })).result.content[0].text);
    assert.equal(cerca[0].percorso, 'scadenze/parziali.md'); assert.equal(cerca[0].motore, 'sezioni');
    const sez = JSON.parse((await chiedi(4, 'tools/call', { name: 'leggi_nota', arguments: { percorso: 'scadenze/parziali.md', query: 'registro' } })).result.content[0].text);
    assert.deepEqual(sez.sezioni.map(s => s.sezione), ['Parziali > Registro']);
    const intera = JSON.parse((await chiedi(5, 'tools/call', { name: 'leggi_nota', arguments: { percorso: 'scadenze/parziali.md' } })).result.content[0].text);
    assert.match(intera.contenuto, /## Stato del ripasso[\s\S]*## Registro/);
  } finally { p.kill(); }
});

// ---------- skill piano-oggi ----------
test('piano-oggi: riconosciuta solo su richiesta esplicita', () => {
  for (const t of ['piano-oggi', '/piano-oggi', 'fammi il piano di oggi', 'preparami il piano della giornata']) assert.equal(pianoOggi.rileva(t), true, t);
  for (const t of ['cosa devo fare oggi?', 'cosa studio oggi', 'non fare il piano di oggi', 'scrivi una nota sul piano di studio']) assert.equal(pianoOggi.rileva(t), false, t);
});

test('piano-oggi dalla nuova Orbit: istruzioni della skill dal vault, estratto del piano, niente calendario, piano salvato in outputs/', async () => {
  const PIANO = 'In pari col piano.\nNessun cambiamento.\n\n**A4** spazi vettoriali, 3h, pagine 25-30.';
  const { a, provider } = app(() => 'Ecco il piano di oggi: A4 per tre ore.\n<orbit_piano>\n' + PIANO + '\n</orbit_piano>');
  let calendario = 0;
  a.permessi.impostaAbilitata('google', true); a.google.accessToken = async () => 'T';
  a.integrazioni.integrazioni.get('google').strumenti.elenca_eventi.esegui = async () => { calendario++; return { eventi: [] }; };
  const r = await a.orchestrator.elabora({ messaggio: 'piano-oggi' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const prompt = provider.chiamate.find(c => c.ruolo === 'produttore').messages.slice(-1)[0].content;
  assert.match(prompt, /<skill_piano_oggi data="\d{4}-\d{2}-\d{2}">/); assert.match(prompt, /ISTRUZIONE-DELLA-SKILL/);
  assert.match(prompt, /RIGA-DI-OGGI A4/); assert.match(prompt, /A4 \| da fare/);
  assert.equal(calendario, 0);
  const salvato = leggi('outputs/piano-' + OGGI + '.md');
  assert.match(salvato, /^---\ntags: \[piano\]\ncreata: \d{4}-\d{2}-\d{2}\norigine: Orbit\n---\n\nIn pari col piano\.\nNessun cambiamento\./);
  assert.match(r.testo, new RegExp('Piano salvato in `outputs/piano-' + OGGI + '\\.md`')); assert.doesNotMatch(r.testo, /orbit_piano/);
  assert.equal(leggi('outputs/piano-' + ieri + '.md'), PIANO_IERI);                 // i piani esistenti non si toccano

  // seconda richiesta: il piano di oggi esiste gia -> non si rigenera e non si sovrascrive
  const b = app(() => 'Il piano di oggi e gia salvato: A4.\n<orbit_piano>\nPIANO-RIGENERATO\n</orbit_piano>');
  const r2 = await b.a.orchestrator.elabora({ messaggio: 'fammi il piano di oggi' });
  assert.equal(r2.ok, true); assert.doesNotMatch(leggi('outputs/piano-' + OGGI + '.md'), /PIANO-RIGENERATO/);
  assert.match(b.provider.chiamate.find(c => c.ruolo === 'produttore').messages.slice(-1)[0].content, /Il piano di oggi esiste gia/);
});

test('piani in outputs/: quello salvato da Orbit e quello vecchio senza frontmatter si leggono e si ritrovano', async () => {
  const { a, provider } = app(() => 'Oggi A4, come nel piano (outputs/piano-' + OGGI + '.md).');
  await a.orchestrator.elabora({ messaggio: 'cosa devo fare oggi?' });
  const prompt = provider.chiamate.find(c => c.ruolo === 'produttore').messages.slice(-1)[0].content;
  assert.match(prompt, new RegExp('<nota percorso="outputs/piano-' + OGGI + '\\.md"[\\s\\S]*spazi vettoriali'));
  assert.doesNotMatch(prompt, /<skill_piano_oggi/);                                  // "cosa devo fare oggi" non rigenera il piano
  assert.ok(memoria.cercaNote('spazi vettoriali pagine 25').some(x => x.percorso === 'outputs/piano-' + OGGI + '.md'));
  assert.ok(memoria.cercaNote('matrice inversa').some(x => x.percorso === 'outputs/piano-' + ieri + '.md'));
  assert.match(memoria.leggiNota('outputs/piano-' + ieri + '.md').contenuto, /^In pari col piano/);
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice aperto */ } });
