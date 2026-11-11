'use strict';
// Test di integrazione: provider Claude Code (con un falso `claude`), server Orbit, persistenza, configurazione e sicurezza.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const log = require('../log');
const { ClaudeCodeProvider, ambientePulito, costruisciPrompt } = require('../ai/providers/claude-code');
const { Storage } = require('../storage/db');
const { creaApp } = require('../app');
const { creaServer } = require('../server');
const { settingsProva, MockProvider, appProva, chiedi } = require('./helpers');
const CS = require('../public/core-state');
const MD = require('../public/markdown');

const FALSO = path.join(__dirname, 'fake-claude.js');
function provaProvider(envExtra = {}, opzioni = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fake-'));
  const logFile = path.join(dir, 'chiamate.jsonl');
  const envBase = Object.assign({}, process.env, { ORBIT_FAKE_LOG: logFile }, envExtra);
  const p = new ClaudeCodeProvider(Object.assign({ bin: process.execPath, binArgs: [FALSO], cwd: path.join(dir, 'cwd'), envBase }, opzioni));
  const chiamate = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { p, chiamate, dir };
}
const RICH = { model: 'haiku', system: 'Istruzioni di sistema', messages: [{ role: 'user', content: 'ciao' }], maxTokens: 200 };

// ---------- provider Claude Code ----------
test('provider: usa solo claude -p con il login dell abbonamento, senza --bare, strumenti spenti e modello come alias', async () => {
  const { p, chiamate } = provaProvider();
  const r = await p.complete(RICH);
  assert.match(r.text, /falso Claude Code/);
  const c = chiamate().find(x => x.comando === 'p');
  assert.ok(!c.args.includes('--bare'));
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'haiku');
  assert.equal(c.args[c.args.indexOf('--tools') + 1], '');
  assert.ok(c.args.includes('--no-session-persistence') && c.args.includes('--strict-mcp-config') && c.args.includes('--disable-slash-commands'));
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.match(c.stdin, /Istruzioni di sistema/);
  assert.ok(c.cwd.endsWith('cwd'));            // cartella neutra, non il vault
});

test('provider: variabili API e provider cloud sono rimosse dall ambiente del processo figlio', async () => {
  const { p, chiamate } = provaProvider({ ANTHROPIC_API_KEY: 'sk-ant-finta', ANTHROPIC_AUTH_TOKEN: 'x', ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'tok', AWS_BEARER_TOKEN_BEDROCK: 'b' });
  await p.complete(RICH);
  await p.verificaSessione({ forza: true });
  for (const c of chiamate()) assert.deepEqual(c.variabiliApi, [], 'il figlio non deve vedere variabili API: ' + c.comando);
  const { rimosse } = ambientePulito({ ANTHROPIC_API_KEY: 'a', PATH: 'p', ANTHROPIC_FOUNDRY_API_KEY: 'b', CLAUDE_CODE_USE_VERTEX: '1' });
  assert.deepEqual(rimosse.sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_USE_VERTEX']);
});

test('provider: token e costo reali dall output di Claude Code, costo solo come equivalente non addebitato', async () => {
  const { p } = provaProvider();
  const r = await p.complete(RICH);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 25 });     // input + cache creata + cache letta
  assert.equal(r.model, 'claude-haiku-finto');
  assert.equal(r.costoEquivalente, 0.002);
  assert.equal(r.stopReason, 'end_turn');
});

test('provider: limiti dell abbonamento raggiunti, login mancante, modello non disponibile e output rotto', async () => {
  const casi = { limite: 'LIMITE_ABBONAMENTO', nologin: 'NOT_LOGGED_IN', modello: 'MODEL_NOT_FOUND', rotto: 'BAD_RESPONSE' };
  for (const [modo, codice] of Object.entries(casi)) {
    const { p } = provaProvider({ ORBIT_FAKE_MODE: modo });
    await assert.rejects(p.complete(RICH), e => { assert.equal(e.code, codice); return true; }, modo);
  }
  const { p } = provaProvider({ ORBIT_FAKE_MODE: 'limite' });
  await assert.rejects(p.complete(RICH), e => e.fatal === true && !e.retryable);      // niente insistenza sui limiti
});

test('provider: risposta troncata segnalata come max_tokens', async () => {
  const { p } = provaProvider({ ORBIT_FAKE_MODE: 'tronca' });
  assert.equal((await p.complete(RICH)).stopReason, 'max_tokens');
});

test('provider: timeout e interruzione dall utente uccidono il processo', async () => {
  const { p } = provaProvider({ ORBIT_FAKE_MODE: 'lento' });
  await assert.rejects(p.complete(Object.assign({}, RICH, { timeoutMs: 300 })), e => e.code === 'TIMEOUT');
  const c = new AbortController(); setTimeout(() => c.abort(), 200);
  await assert.rejects(p.complete(Object.assign({}, RICH, { signal: c.signal })), e => e.code === 'ABORTED');
});

test('provider: nome del modello con caratteri speciali rifiutato (niente iniezione nella shell)', async () => {
  const { p, chiamate } = provaProvider();
  await assert.rejects(p.complete(Object.assign({}, RICH, { model: 'haiku & calc' })), e => e.code === 'MODEL_NOT_FOUND');
  assert.equal(chiamate().length, 0);
});

test('provider: la conversazione precedente e il messaggio corrente restano distinti nel prompt', () => {
  const t = costruisciPrompt({ system: 'S', messages: [{ role: 'user', content: 'uno' }, { role: 'assistant', content: 'due' }, { role: 'user', content: 'tre' }] });
  assert.match(t, /<istruzioni>\nS\n<\/istruzioni>/);
  assert.match(costruisciPrompt({ system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 400 }), /entro circa 220 parole/);
  assert.match(t, /Utente: uno\n\nOrbit: due/);
  assert.match(t, /<messaggio_corrente>\ntre\n<\/messaggio_corrente>/);
});

test('sessione: Orbit parte solo se Claude Code usa il login claude.ai, mai chiave API o provider cloud', async () => {
  const ok = provaProvider();
  const s = await ok.p.verificaSessione({ forza: true });
  assert.equal(s.ok, true); assert.equal(s.dettagli.piano, 'pro');
  for (const tipo of ['api', 'bedrock', 'fuori', 'rotto']) {
    const { p } = provaProvider({ ORBIT_FAKE_AUTH: tipo });
    const r = await p.verificaSessione({ forza: true });
    assert.equal(r.ok, false, tipo);
    assert.ok(r.errore.length > 10);
  }
});

test('sessione: con un login non da abbonamento nessuna richiesta arriva a Claude e l errore e chiaro', async () => {
  const { p, chiamate } = provaProvider({ ORBIT_FAKE_AUTH: 'api' });
  const app = creaApp({ settings: settingsProva(), provider: p, storage: new Storage(':memory:') });
  const { r } = await chiedi(app, 'ciao Orbit, come stai oggi?');
  assert.equal(r.ok, false); assert.equal(r.codice, 'NON_ABBONAMENTO');
  assert.match(r.errore, /abbonamento|claude\.ai/i);
  assert.equal(chiamate().filter(c => c.comando === 'p').length, 0);
});

test('sessione: flusso completo di Orbit con il falso Claude Code, nessuna variabile API vista dal figlio', async () => {
  const { p, chiamate } = provaProvider({ ANTHROPIC_API_KEY: 'sk-ant-finta' });
  const app = creaApp({ settings: settingsProva({ limiti: { verificaAI: 'auto' } }), provider: p, storage: new Storage(':memory:') });
  const { r } = await chiedi(app, 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.');
  assert.equal(r.ok, true);
  assert.equal(r.verifica, 'PASS');
  assert.equal(r.metriche.chiamate, 1);
  assert.ok(chiamate().every(c => c.variabiliApi.length === 0));
  assert.equal(app.registry.modello('haiku'), 'mock-haiku-1');
});

// ---------- registro modelli ----------
test('modelli: senza API si usano gli alias di Claude Code, oppure i nomi che imposti tu', async () => {
  const { p } = provaProvider();
  const app = creaApp({ settings: settingsProva({ env: { ORBIT_MODEL_HAIKU: '', ORBIT_MODEL_SONNET: '', ORBIT_MODEL_OPUS: 'opus-personalizzato' } }), provider: p, storage: new Storage(':memory:') });
  await app.registry.inizializza();
  assert.equal(app.registry.modello('haiku'), 'haiku');
  assert.equal(app.registry.modello('sonnet'), 'sonnet');
  assert.equal(app.registry.riepilogo().tiers.opus.id, 'opus-personalizzato');
});

test('modelli: un modello rifiutato da Claude Code viene escluso e si passa a un altro livello', async () => {
  const provider = new MockProvider({ produttore: ({ model }) => { if (model === 'mock-haiku-1') { const { OrbitError } = require('../ai/errors'); throw new OrbitError('MODEL_NOT_FOUND', 'no'); } return 'Risposta in italiano da un altro livello.'; } });
  const app = appProva({ provider });
  const { r } = await chiedi(app, 'Riassumi in breve: i vettori formano uno spazio.');
  assert.equal(r.verifica, 'PASS');
  assert.equal(app.registry.modello('haiku') === 'mock-haiku-1', false);
});

// ---------- configurazione ----------
test('config: nessuna chiave API richiesta e variabili API trovate nell ambiente vengono segnalate e ignorate', () => {
  const { settings, problemi } = config.carica({ envProcesso: { ANTHROPIC_API_KEY: 'sk-ant-xyz', ANTHROPIC_BASE_URL: 'https://x', ORBIT_DATA_DIR: os.tmpdir() }, envFile: 'C:\\inesistente\\.env' });
  assert.ok(!('apiKey' in settings));
  assert.deepEqual(settings.chiaviIgnorate.sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
  const p = problemi.find(x => x.code === 'API_ENV_IGNORATE');
  assert.ok(p && !p.message.includes('sk-ant-xyz'));        // il valore non compare mai
  assert.ok(!problemi.some(x => x.level === 'error'));
  assert.ok(!JSON.stringify(config.pubblica(settings)).includes('sk-ant'));
});

test('config: parsing del file .env facoltativo, il processo ha la precedenza', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# commento\nORBIT_MODEL_HAIKU=h-1 # nota\nORBIT_MAX_ESCALATIONS=1\nORBIT_AI_VERIFY=sempre\n');
  const { settings } = config.carica({ envProcesso: { ORBIT_ENV_FILE: file, ORBIT_DATA_DIR: dir, ORBIT_MODEL_HAIKU: 'h-processo' }, envFile: file });
  assert.equal(settings.modelli.haiku, 'h-processo');
  assert.equal(settings.limiti.maxEscalation, 1);
  assert.equal(settings.limiti.verificaAI, 'sempre');
  assert.equal(config.carica({ envProcesso: { ORBIT_DATA_DIR: dir }, envFile: 'C:\\inesistente\\.env' }).settings.limiti.verificaAI, 'auto');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config: valori non validi segnalati con messaggi comprensibili, .env e dati nel vault vietati', () => {
  const vault = require('../../memoria/config').vaultPath;
  const { settings, problemi } = config.carica({ envProcesso: { ORBIT_MAX_ESCALATIONS: 'tanti', ORBIT_DATA_DIR: path.join(vault, 'dati-orbit'), ORBIT_ENV_FILE: path.join(vault, '.env') }, envFile: path.join(vault, '.env') });
  const codici = problemi.map(p => p.code);
  assert.ok(codici.includes('BAD_NUMBER'));
  assert.ok(codici.includes('ENV_IN_VAULT')); assert.ok(codici.includes('DATA_IN_VAULT'));
  assert.equal(settings.limiti.maxEscalation, 2);   // valore di riserva sicuro
});

test('config: nessuna impostazione di prezzi o budget in dollari', () => {
  const { settings } = config.carica({ envProcesso: { ORBIT_PRICE_HAIKU: '1,5', ORBIT_BUDGET_USD_REQUEST: '3', ORBIT_DATA_DIR: os.tmpdir() }, envFile: 'C:\\inesistente\\.env' });
  assert.ok(!('prezzi' in settings));
  assert.ok(!('budgetUsdRichiesta' in settings.limiti));
});

test('consumo: il contatore blocca Orbit prima di consumare i limiti dell abbonamento', async () => {
  const provider = new MockProvider({ produttore: () => 'Risposta in italiano di prova per la richiesta.' });
  const app = appProva({ provider, settings: settingsProva({ limiti: { chiamatePerOra: 3 } }) });
  const a = await chiedi(app, 'Riassumi in breve: i vettori formano uno spazio.');     // 2 chiamate (produzione e verifica)
  assert.equal(a.r.ok, true);
  const b = await chiedi(app, 'Riassumi in breve: le matrici rappresentano trasformazioni.');
  assert.equal(b.r.ok, true);                                                         // parte la produzione (3a chiamata)
  assert.equal(b.r.verifica, 'NON_VERIFICATA');                                      // la verifica non parte: limite orario raggiunto
  const c = await chiedi(app, 'Riassumi in breve: gli autovalori sono radici del polinomio caratteristico.');
  assert.equal(c.r.ok, false); assert.equal(c.r.codice, 'LIMITE_CONSUMO');
  assert.match(c.r.errore, /abbonamento/);
  assert.equal(provider.chiamate.length, 3);
});

test('log: le chiavi vengono oscurate', () => {
  assert.ok(!log.ripulisci('errore con sk-ant-api03-ABCDEF123 dentro').includes('ABCDEF'));
  assert.ok(!log.ripulisci('x-api-key: segretissimo').includes('segretissimo'));
});

// ---------- persistenza ----------
test('storage: la cronologia sopravvive alla riapertura del database e si puo eliminare', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'));
  const file = path.join(dir, 'orbit.sqlite');
  let s = new Storage(file);
  const c = s.creaConversazione('Prova');
  s.aggiungiMessaggio({ conversazione: c.id, ruolo: 'user', contenuto: 'ciao' });
  s.aggiungiMessaggio({ conversazione: c.id, ruolo: 'assistant', contenuto: 'ciao a te', verifica: 'PASS', fonti: [{ percorso: 'a.md', titolo: 'A' }] });
  s.impostaPreferenza('tema', 'scuro');
  s.chiudi();
  s = new Storage(file);
  const m = s.messaggi(c.id);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map(x => x.ruolo), ['user', 'assistant']);
  assert.equal(m[1].fonti[0].percorso, 'a.md');
  assert.equal(s.preferenza('tema'), 'scuro');
  assert.equal(s.elencaConversazioni().length, 1);
  assert.equal(s.eliminaConversazione(c.id), true);
  assert.equal(s.messaggi(c.id).length, 0);        // messaggi eliminati a cascata
  s.chiudi();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('storage: la diagnostica non contiene il testo dell utente e registra metriche reali', async () => {
  const app = appProva();
  const { r } = await chiedi(app, 'Riassumi in breve: la password segreta della mia tesi e pippo123');
  const rec = app.storage.richiesta(r.richiesta);
  assert.ok(!JSON.stringify(rec).includes('pippo123'));
  assert.equal(rec.chiamate, 2);
  assert.equal(rec.token_in, 200); assert.equal(rec.token_out, 100);   // 2 chiamate da 100/50 restituiti dal mock
  assert.equal(rec.costo, null);                                       // il provider non ha riportato nessun equivalente: non si inventa
  assert.equal(rec.chiamateDettaglio.length, 2);
});

test('usage: il costo e solo l equivalente a listino riportato da Claude Code, mai inventato', async () => {
  const provider = new MockProvider({ produttore: () => ({ text: 'Risposta in italiano di prova per la richiesta.', costoEquivalente: 0.01 }), verificatore: () => ({ text: JSON.stringify({ status: 'PASS', reason: 'ok', failed_criteria: [], evidence: [], correction_instructions: '', confidence: 0.9 }), costoEquivalente: 0.004 }) });
  const app = appProva({ provider });
  const { r } = await chiedi(app, 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.');
  assert.ok(Math.abs(r.metriche.costo - 0.014) < 1e-12);
  assert.equal(r.metriche.costoStimato, true);
});

test('verifica AI: in modalita auto parte solo dove serve, in modalita sempre su ogni risposta', async () => {
  const semplice = 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.';
  const auto = appProva({ settings: settingsProva({ limiti: { verificaAI: 'auto' } }) });
  const a = await chiedi(auto, semplice);
  assert.equal(a.r.metriche.chiamate, 1);                       // una sola chiamata: controlli locali bastano
  assert.equal(a.r.piano.verifica.modo, 'deterministico');
  const sempre = appProva({ settings: settingsProva({ limiti: { verificaAI: 'sempre' } }) });
  assert.equal((await chiedi(sempre, semplice)).r.metriche.chiamate, 2);
  const rischio = await chiedi(auto, 'Che dosaggio di farmaco devo prendere per il mal di testa?');
  assert.equal(rischio.r.piano.verifica.modo, 'semantico');     // rischio alto: la verifica AI parte anche in auto
});

test('usage: limite giornaliero di token blocca nuove richieste con messaggio chiaro', async () => {
  const app = appProva({ settings: settingsProva({ limiti: { limiteGiornalieroToken: 250 } }) });
  const a = await chiedi(app, 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.');
  assert.equal(a.r.ok, true);                         // 300 token usati
  const b = await chiedi(app, 'Riassumi in breve: i vettori sono elementi di uno spazio vettoriale.');
  assert.equal(b.r.ok, false); assert.equal(b.r.codice, 'BUDGET');
  assert.match(b.r.errore, /giornaliero/);
});

// ---------- efficienza ----------
test('efficienza: domanda autonoma non invia la cronologia, ma un seguito si', async () => {
  const provider = new MockProvider({ produttore: () => 'Risposta in italiano di prova per la richiesta.' });
  const app = appProva({ provider });
  const a = await chiedi(app, 'Riassumi in breve: i vettori formano uno spazio.');
  await chiedi(app, 'Riassumi in breve: le matrici rappresentano trasformazioni lineari.', { conversazioneId: a.r.conversazioneId });
  const prod = provider.chiamate.filter(c => c.ruolo === 'produttore');
  assert.equal(prod[1].messages.length, 1);           // nessuna storia: il messaggio e autonomo e lungo
  await chiedi(app, 'Spiegamelo in modo piu semplice', { conversazioneId: a.r.conversazioneId });
  const terzo = provider.chiamate.filter(c => c.ruolo === 'produttore')[2];
  assert.ok(terzo.messages.length >= 3);               // il seguito usa il contesto pertinente
  assert.equal(terzo.messages[0].role, 'user');
  const ambiguo = await chiedi(app, 'e quella di prima?', { conversazioneId: a.r.conversazioneId });
  assert.equal(ambiguo.r.verifica, 'CHIARIMENTO');
  assert.equal(provider.conteggio('produttore'), 3);
});

test('efficienza: calcolo semplice, una sola chiamata AI e nessun verificatore', async () => {
  const provider = new MockProvider({ produttore: () => 'Il risultato di 12*(3+4) e 84.' });
  const app = appProva({ provider });
  const { r } = await chiedi(app, 'quanto fa 12*(3+4)?');
  assert.equal(r.verifica, 'PASS');
  assert.equal(r.metriche.chiamate, 1);
  assert.equal(provider.conteggio('verificatore'), 0);
  assert.equal(provider.chiamate[0].model, 'mock-haiku-1');
});

test('efficienza: risultato aritmetico sbagliato, escalation guidata dal controllo locale', async () => {
  const provider = new MockProvider({ produttore: ({ model }) => (model === 'mock-haiku-1' ? 'Il risultato e 80.' : 'Il risultato di 12*(3+4) e 84.') });
  const app = appProva({ provider });
  const { r } = await chiedi(app, 'quanto fa 12*(3+4)?');
  assert.equal(r.verifica, 'PASS'); assert.equal(r.escalation, 1);
  assert.equal(provider.conteggio('verificatore'), 0);   // nessun verificatore AI, bastano i controlli locali
});

test('efficienza: nessun ciclo infinito anche con produttore e verificatore sempre in disaccordo', async () => {
  const provider = new MockProvider({ produttore: () => 'Una risposta in italiano che non convince.', verificatore: () => ({ status: 'FAIL', reason: 'no', failed_criteria: ['x'] }) });
  const app = appProva({ provider, settings: settingsProva({ limiti: { maxTentativi: 10, maxEscalation: 5 } }) });
  await chiedi(app, 'Riassumi in breve: i vettori formano uno spazio.');
  assert.ok(provider.conteggio('produttore') <= 4);      // haiku, sonnet, opus + un mirato
});

test('memoria: note del vault passate come dati, fonti riportate e note inventate respinte', async () => {
  const memoria = { contestoPerDomanda: () => ({ testo: '<nota percorso="corsi/FAM/rouche.md" titolo="Rouche">Contenuto: il rango decide la risolubilita.</nota>', fonti: [{ percorso: 'corsi/FAM/rouche.md', titolo: 'Rouche' }] }) };
  const provider = new MockProvider({
    produttore: ({ model, n }) => (n === 1 ? 'Dalle note: vedi corsi/FAM/inventata.md per i dettagli, tutto scritto in italiano chiaro.' : 'Dalle note (corsi/FAM/rouche.md) il rango decide la risolubilita del sistema.')
  });
  const app = appProva({ provider, memoria });
  const { r } = await chiedi(app, 'Cosa dicono i miei appunti di FAM su Rouche?');
  assert.equal(r.verifica, 'PASS');
  assert.equal(r.fonti[0].percorso, 'corsi/FAM/rouche.md');
  assert.equal(r.escalation, 1);                         // la nota inventata ha fatto fallire il controllo locale
  const primo = provider.chiamate[0];
  assert.match(primo.messages[primo.messages.length - 1].content, /<contesto_vault>[\s\S]*DATI/);
  assert.match(app.storage.messaggi(r.conversazioneId).pop().fonti[0].titolo, /Rouche/);
});

test('memoria: vault non disponibile, la chat prosegue e lo dichiara', async () => {
  const memoria = { contestoPerDomanda: () => ({ testo: '[Memoria di Orbit: il vault Obsidian non e disponibile]', fonti: [], errore: 'vault assente' }) };
  const app = appProva({ memoria });
  const { r, eventi } = await chiedi(app, 'Cosa dicono i miei appunti di FAM su Rouche?');
  assert.equal(r.ok, true);
  assert.equal(eventi.find(e => e.tipo === 'contesto_pronto').avvisoMemoria, 'vault assente');
});

// ---------- interfaccia: macchina a stati e markdown ----------
test('Orbit Core: gli stati seguono solo gli eventi reali del backend', () => {
  let s = CS.iniziale();
  const vai = (tipo, extra) => { s = CS.riduci(s, Object.assign({ tipo }, extra || {})); return s.nome; };
  assert.equal(vai('avviata'), 'thinking');
  assert.equal(vai('instradata'), 'thinking');
  assert.equal(vai('esecuzione'), 'executing');
  assert.equal(vai('verifica'), 'quality_checking');
  assert.equal(vai('esito_verifica'), 'quality_checking');   // l'esito da solo non cambia stato
  assert.equal(vai('escalation'), 'escalating');
  assert.equal(vai('tentativo'), 'executing');
  assert.equal(vai('verifica'), 'quality_checking');
  assert.equal(vai('finale'), 'responding');                 // la risposta e visibile nel contenitore
  assert.equal(s.rispostaAperta, true);
  assert.equal(vai('locale:chiudi_risposta'), 'idle');
  assert.equal(vai('errore', { messaggio: 'x' }), 'error');
  assert.equal(vai('locale:errore_chiuso'), 'idle');
  assert.equal(vai('evento_sconosciuto'), 'idle');
});

test('Orbit Core: il recupero dalle note esiste solo se il backend sta davvero cercando nel vault', () => {
  let s = CS.iniziale();
  s = CS.riduci(s, { tipo: 'avviata' });
  s = CS.riduci(s, { tipo: 'contesto', vault: false });
  assert.equal(s.nome, 'thinking');                          // nessuna ricerca nelle note: niente rete di memoria
  s = CS.riduci(s, { tipo: 'contesto_pronto', fonti: [] });
  assert.equal(s.nome, 'thinking');
  s = CS.riduci(CS.iniziale(), { tipo: 'avviata' });
  s = CS.riduci(s, { tipo: 'contesto', vault: true });
  assert.equal(s.nome, 'retrieving'); assert.deepEqual(s.note, []);
  s = CS.riduci(s, { tipo: 'contesto_pronto', fonti: [{ percorso: 'a.md', titolo: 'Matrici' }, { percorso: 'b.md' }] });
  assert.equal(s.nome, 'retrieving');
  assert.deepEqual(s.note, ['Matrici', 'b.md']);             // solo le note realmente recuperate
  s = CS.riduci(s, { tipo: 'instradata', tier: 'sonnet' });
  assert.equal(s.nome, 'thinking');                          // in attesa del modello: non si dice piu di cercare nelle note
  s = CS.riduci(s, { tipo: 'esecuzione', tier: 'sonnet' });
  assert.equal(s.nome, 'executing');
});

test('Orbit Core: microfono, voce, pausa e risposta aperta non interferiscono con un elaborazione in corso', () => {
  let s = CS.iniziale();
  s = CS.riduci(s, { tipo: 'locale:mic_avvio' }); assert.equal(s.nome, 'listening');
  s = CS.riduci(s, { tipo: 'locale:mic_fine' }); assert.equal(s.nome, 'idle');
  s = CS.riduci(s, { tipo: 'locale:invio' }); assert.equal(s.nome, 'thinking');
  s = CS.riduci(s, { tipo: 'locale:voce_inizio' }); assert.equal(s.nome, 'thinking');
  s = CS.riduci(s, { tipo: 'locale:pausa' }); assert.equal(s.nome, 'thinking');            // la pausa non interrompe un lavoro in corso
  s = CS.riduci(s, { tipo: 'finale' }); assert.equal(s.nome, 'responding');
  s = CS.riduci(s, { tipo: 'locale:voce_inizio' }); assert.equal(s.nome, 'speaking');
  s = CS.riduci(s, { tipo: 'locale:voce_fine' }); assert.equal(s.nome, 'responding');       // a risposta ancora aperta si torna alla risposta
  s = CS.riduci(s, { tipo: 'locale:chiudi_risposta' }); assert.equal(s.nome, 'idle');
  s = CS.riduci(s, { tipo: 'locale:pausa' }); assert.equal(s.nome, 'paused');
  s = CS.riduci(s, { tipo: 'locale:riprendi' }); assert.equal(s.nome, 'idle');
  assert.equal(CS.riduci(CS.iniziale(), { tipo: 'strumento', nome: 'calendario' }).nome, 'tools');
  const senzaEtichetta = CS.STATI.filter(x => !(x in CS.ETICHETTE));
  assert.deepEqual(senzaEtichetta, []);
});

test('Orbit Core: errore e interruzione chiudono lo stato di elaborazione e non lo lasciano bloccato', () => {
  let s = CS.riduci(CS.iniziale(), { tipo: 'locale:invio' });
  s = CS.riduci(s, { tipo: 'esecuzione' }); assert.equal(s.attiva, true);
  s = CS.riduci(s, { tipo: 'errore', messaggio: 'giu' }); assert.equal(s.nome, 'error'); assert.equal(s.attiva, false);
  s = CS.riduci(CS.riduci(CS.iniziale(), { tipo: 'locale:invio' }), { tipo: 'interrotta' });
  assert.equal(s.nome, 'idle'); assert.equal(s.attiva, false); assert.equal(s.rispostaAperta, false);
});

test('backend: gli eventi del contesto dicono se la ricerca nel vault avviene davvero e quali note sono state recuperate', async () => {
  const memoria = { contestoPerDomanda: () => ({ testo: '<nota percorso="corsi/FAM/rouche.md" titolo="Rouche">x</nota>', fonti: [{ percorso: 'corsi/FAM/rouche.md', titolo: 'Rouche' }] }) };
  const con = await chiedi(appProva({ memoria }), 'Cosa dicono i miei appunti di FAM su Rouche?');
  const c1 = con.eventi.find(e => e.tipo === 'contesto'), p1 = con.eventi.find(e => e.tipo === 'contesto_pronto');
  assert.equal(c1.vault, true);
  assert.deepEqual(p1.fonti, [{ percorso: 'corsi/FAM/rouche.md', titolo: 'Rouche' }]);
  const senza = await chiedi(appProva({ memoria }), 'ciao, come stai?');
  assert.equal(senza.eventi.find(e => e.tipo === 'contesto').vault, false);
  const nessuna = await chiedi(appProva(), 'Cosa dicono i miei appunti di FAM su Rouche?');          // vault non configurato
  assert.equal(nessuna.eventi.find(e => e.tipo === 'contesto').vault, false);
});

test('markdown: nessun HTML del modello arriva al DOM e i link pericolosi non diventano link', () => {
  const sporco = '<script>alert(1)</script> **grassetto** [clic](javascript:alert(1)) [ok](https://esempio.it/a?b=1&c=2) <img src=x onerror=alert(1)>';
  const h = MD.render(sporco);
  assert.ok(!/<script|<img|href="javascript/i.test(h));
  assert.ok(h.includes('<strong>grassetto</strong>'));
  assert.ok(h.includes('href="https://esempio.it/a?b=1&amp;c=2"'));
  assert.ok(h.includes('rel="noopener noreferrer"'));
  assert.equal(MD.render('```js\n<b>x</b>\n```'), '<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  assert.equal(MD.perVoce('**ciao** `x` [link](http://a.it)'), 'ciao x link');
});

// ---------- server HTTP ----------
async function conServer(fn, { app } = {}) {
  const a = app || appProva({ provider: new MockProvider({ produttore: () => 'Risposta in italiano dal server di prova.' }) });
  const server = creaServer(a, { port: 0 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.close();           // ricrea con la porta vera (la verifica dell'host usa la porta)
  const s2 = creaServer(a, { port });
  await new Promise(r => s2.listen(port, '127.0.0.1', r));
  const base = 'http://localhost:' + port;
  try { await fn({ base, app: a, port }); } finally { s2.closeAllConnections(); await new Promise(r => s2.close(r)); }
}
const H = { 'X-Orbit': '1', 'Content-Type': 'application/json' };

function eventiSse(testo) {
  return testo.split('\n\n').map(b => b.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)));
}

test('server: pagina, intestazioni di sicurezza e stato senza segreti', async () => {
  await conServer(async ({ base }) => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const html = await r.text();
    assert.ok(!/<script>[^<]/.test(html));           // nessuno script inline
    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(st.abbonamento.ok, true);
    assert.ok(!JSON.stringify(st).includes('sk-ant'));
    assert.equal(st.memoria.solaLettura, true);
  });
});

test('server: host e origin non locali sono rifiutati, le POST richiedono l intestazione di Orbit', async () => {
  await conServer(async ({ base, port }) => {
    const r1 = await fetch(base + '/api/status', { headers: { Origin: 'http://sito-cattivo.example' } });
    assert.equal(r1.status, 403);
    const r2 = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"ciao"}' });
    assert.equal(r2.status, 403);
    const r3 = await fetch(base + '/api/chat', { method: 'POST', headers: { 'X-Orbit': '1', 'Content-Type': 'text/plain' }, body: 'ciao' });
    assert.equal(r3.status, 403);
    const http = require('http');
    const codice = await new Promise(res => { http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: 'attaccante.example' } }, x => { x.resume(); res(x.statusCode); }); });
    assert.equal(codice, 403);
  });
});

test('server: chat in streaming con eventi reali, poi cronologia persistente', async () => {
  await conServer(async ({ base }) => {
    const r = await fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'Riassumi in breve: i vettori formano uno spazio.' }) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const ev = eventiSse(await r.text());
    const tipi = ev.map(e => e.tipo);
    assert.ok(tipi.indexOf('instradata') > -1 && tipi.indexOf('esecuzione') > tipi.indexOf('instradata') && tipi.indexOf('verifica') > tipi.indexOf('esecuzione'));
    const fin = ev.find(e => e.tipo === 'finale');
    assert.equal(fin.verifica, 'PASS');
    assert.match(fin.testo, /server di prova/);
    const lista = await (await fetch(base + '/api/conversations')).json();
    assert.equal(lista.length, 1);
    const c = await (await fetch(base + '/api/conversations/' + lista[0].id)).json();
    assert.deepEqual(c.messaggi.map(m => m.ruolo), ['user', 'assistant']);
    const diag = await (await fetch(base + '/api/diagnostics')).json();
    assert.equal(diag.richieste.length, 1);
    const det = await (await fetch(base + '/api/diagnostics/' + diag.richieste[0].id)).json();
    assert.equal(det.chiamateDettaglio.length, 2);
    const del = await fetch(base + '/api/conversations/' + lista[0].id, { method: 'DELETE', headers: H });
    assert.equal(del.status, 200);
    assert.equal((await (await fetch(base + '/api/conversations')).json()).length, 0);
  });
});

test('server: validazione degli input e errori centralizzati', async () => {
  await conServer(async ({ base }) => {
    const r1 = await fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 42 }) });
    assert.equal(r1.status, 400);
    const r2 = await fetch(base + '/api/chat', { method: 'POST', headers: H, body: '{non json' });
    assert.equal(r2.status, 400);
    const r3 = await fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'x'.repeat(50000) }) });
    assert.equal(r3.status, 413);
    const r4 = await fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: '   ' }) });
    const ev = eventiSse(await r4.text());
    assert.equal(ev[ev.length - 1].tipo, 'errore');
    const r5 = await fetch(base + '/api/preferences', { method: 'PUT', headers: H, body: JSON.stringify({ chiave_strana: 'x' }) });
    assert.equal(r5.status, 400);
    const r6 = await fetch(base + '/api/preferences', { method: 'PUT', headers: H, body: JSON.stringify({ tema: 'scuro', modalita: 'voce' }) });
    assert.equal((await r6.json()).tema, 'scuro');
    assert.equal((await fetch(base + '/api/conversations/conv_zzzz')).status, 404);
    assert.equal((await fetch(base + '/../../etc/passwd')).status, 404);
  });
});

test('server: limite di richieste al minuto', async () => {
  const app = appProva({ settings: settingsProva({ limiti: { richiestePerMinuto: 2 } }), provider: new MockProvider({ produttore: () => 'Risposta in italiano di prova.' }) });
  await conServer(async ({ base }) => {
    const manda = () => fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'ciao Orbit' }) }).then(async r => { await r.text(); return r.status; });
    assert.equal(await manda(), 200); assert.equal(await manda(), 200); assert.equal(await manda(), 429);
  }, { app });
});

test('server: la chiusura della connessione interrompe la richiesta lato backend', async () => {
  let abortito = false;
  const provider = new MockProvider({ produttore: async ({ req }) => { await new Promise(r => { req.signal.addEventListener('abort', () => { abortito = true; r(); }); setTimeout(r, 3000); }); return 'tardiva'; } });
  const app = appProva({ provider });
  await conServer(async ({ base }) => {
    const c = new AbortController();
    const p = fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'Riassumi in breve: i vettori formano uno spazio.' }), signal: c.signal }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    c.abort(); await p;
    await new Promise(r => setTimeout(r, 300));
    assert.equal(abortito, true);
  }, { app });
});

test('server: se Claude Code non usa l abbonamento lo stato e la chat lo dicono chiaramente', async () => {
  const provider = new MockProvider();
  provider.verificaSessione = async () => ({ ok: false, errore: 'Claude Code non usa il login dell\'abbonamento.', dettagli: { piano: null, metodo: 'api_key', provider: 'firstParty' } });
  const app = creaApp({ settings: settingsProva(), provider, storage: new Storage(':memory:') });
  await conServer(async ({ base }) => {
    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(st.abbonamento.ok, false);
    assert.match(st.abbonamento.errore, /abbonamento/);
    const r = await fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'ciao Orbit' }) });
    const ev = eventiSse(await r.text());
    assert.equal(ev.pop().codice, 'NON_ABBONAMENTO');
    assert.equal(provider.chiamate.length, 0);
  }, { app });
});

// Aggiornato con le correzioni finali dell'integrazione Obsidian: "cosa devo fare oggi" riceve l'ESTRATTO del piano e dello stato,
// e un piano vecchio in outputs/ non entra se non e di oggi o di ieri. Senza la funzione di estratto non si mandano piu le note intere.
test('memoria: "cosa devo fare oggi" riceve l\'estratto del piano di studio e lo stato dei parziali, mai le note intere', async () => {
  const intere = { 'scadenze/piano-di-studio.md': 'NOTA-INTERA-PIANO', 'scadenze/parziali.md': 'NOTA-INTERA-PARZIALI', 'outputs/piano-2026-10-10.md': 'PIANO-VECCHIO' };
  const base = {
    contestoPerDomanda: () => ({ testo: '[Memoria di Orbit: nessuna nota del vault corrisponde a questa richiesta.]', fonti: [] }),
    leggiNota: p => { if (!intere[p]) throw new Error('assente'); return { percorso: p, titolo: p, contenuto: intere[p] }; },
    elencaNote: () => ({ note: [{ percorso: 'outputs/piano-2026-10-10.md' }, { percorso: 'corsi/x.md' }], allegati: [] })
  };
  const estratto = ({ soloStato }) => (soloStato ? [] : [{ percorso: 'scadenze/piano-di-studio.md', titolo: 'Piano di studio', parti: [{ sezione: 'Piano giorno per giorno', testo: '| Dom 11 ott | 4h FAM capitolo 3 |', estratto: true }] }])
    .concat([{ percorso: 'scadenze/parziali.md', titolo: 'Parziali', parti: [{ sezione: 'Stato del ripasso', testo: 'FAM 30 ottobre' }] }]);
  const provider = new MockProvider({ produttore: () => 'Oggi: 4h di FAM, capitolo 3 (scadenze/piano-di-studio.md).' });
  const app = appProva({ provider, memoria: Object.assign({ estrattoPianoGiorno: estratto }, base) });
  const { r } = await chiedi(app, 'cosa devo fare oggi');
  assert.equal(r.ok, true);
  assert.deepEqual(r.fonti.map(f => f.percorso).sort(), ['scadenze/parziali.md', 'scadenze/piano-di-studio.md']);
  const prompt = provider.chiamate[0].messages.slice(-1)[0].content;
  assert.match(prompt, /Dom 11 ott \| 4h FAM/); assert.match(prompt, /FAM 30 ottobre/);
  assert.doesNotMatch(prompt, /NOTA-INTERA|PIANO-VECCHIO/);
  // memoria senza estratto: resta solo la ricerca normale, niente ripiego sulle note intere
  const p2 = new MockProvider({ produttore: () => 'Nelle parti del vault che ho letto non c\'e il piano di oggi.' });
  await chiedi(appProva({ provider: p2, memoria: base }), 'cosa devo fare oggi');
  assert.doesNotMatch(p2.chiamate[0].messages.slice(-1)[0].content, /NOTA-INTERA|PIANO-VECCHIO/);
});

test('provider: il tetto di output non scarta le risposte lunghe e l errore di lunghezza e riconosciuto', async () => {
  const { classificaErrore } = require('../ai/providers/claude-code');
  assert.equal(classificaErrore('API Error: Claude\'s response exceeded the 400 output token maximum.', 1).code, 'OUTPUT_TROPPO_LUNGO');
  const { p, chiamate } = provaProvider();
  await p.complete(Object.assign({}, RICH, { maxTokens: 400 }));
  assert.ok(chiamate().length >= 1);
});

test('voce: sceglie la voce italiana migliore e non legge mai l italiano con una voce straniera', () => {
  const V = require('../public/voice');
  const voci = [
    { name: 'Microsoft David Desktop', lang: 'en-US', localService: true },
    { name: 'Microsoft Elsa Desktop', lang: 'it-IT', localService: true },
    { name: 'Google italiano', lang: 'it-IT', localService: false },
    { name: 'Microsoft Isabella Online (Natural) - Italian (Italy)', lang: 'it-IT', localService: false }
  ];
  const dette = [];
  class Enunciato { constructor(t) { this.text = t; } }
  const mk = lista => ({ SpeechSynthesisUtterance: Enunciato, speechSynthesis: { getVoices: () => lista, cancel() {}, speak(u) { dette.push(u); setTimeout(() => u.onend && u.onend(), 0); } } });
  const s = V.creaSintesi(mk(voci));
  assert.deepEqual(s.voci().map(x => x.name), ['Microsoft Isabella Online (Natural) - Italian (Italy)', 'Google italiano', 'Microsoft Elsa Desktop']);
  assert.equal(s.haVoceItaliana(), true);
  s.parla('Prima frase. Seconda frase.', { velocita: '1.15' });
  assert.equal(dette.length, 2);
  assert.equal(dette[0].voice.name, 'Microsoft Isabella Online (Natural) - Italian (Italy)');
  assert.equal(dette[0].rate, 1.15);
  const solo = V.creaSintesi(mk([voci[0]]));            // solo una voce inglese, come su questo PC con Firefox
  assert.equal(solo.haVoceItaliana(), false);
  let errore = null; dette.length = 0;
  solo.parla('Ciao', { onErrore: m => { errore = m; } });
  assert.equal(dette.length, 0);                          // niente lettura con la voce sbagliata
  assert.match(errore, /nessuna voce italiana/i);
});

test('voce: quando la risposta verra letta il modello scrive per l orecchio, in poche frasi, e i criteri non pretendono i percorsi', async () => {
  const note = { contestoPerDomanda: () => ({ testo: '<nota percorso="corsi/FAM/rouche.md" titolo="Rouche">Il rango decide.</nota>', fonti: [{ percorso: 'corsi/FAM/rouche.md', titolo: 'Rouche' }] }) };
  const provider = new MockProvider({ produttore: () => 'Il rango decide se il sistema ha soluzione. Lo trovi nelle tue note di FAM.' });
  const app = appProva({ provider, memoria: note });
  const parlato = await chiedi(app, 'Cosa dicono i miei appunti di FAM su Rouche?', { voce: true });
  const sistema = provider.chiamate[0].system;
  assert.match(sistema, /letta ad alta voce/);
  assert.match(sistema, /Mai percorsi di file/);
  assert.ok(provider.chiamate[0].maxTokens <= 350);
  assert.ok(parlato.r.piano.criteri.some(c => /senza leggere i percorsi/.test(c)));
  assert.ok(parlato.r.piano.criteri.some(c => /lettura ad alta voce/.test(c)));
  assert.ok(!parlato.r.piano.criteri.some(c => /Cita i percorsi/.test(c)));
  const scritto = await chiedi(app, 'Cosa dicono i miei appunti di FAM su Rouche?', { voce: false });
  assert.ok(!/letta ad alta voce/.test(provider.chiamate.filter(c => c.ruolo === 'produttore').pop().system));
  assert.ok(scritto.r.piano.criteri.some(c => /Cita i percorsi/.test(c)));
});
