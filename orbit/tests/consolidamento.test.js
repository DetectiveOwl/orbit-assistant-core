'use strict';
// Consolidamento dopo una validazione interna (documento non pubblicato): controllo "non rimandare" basato sullo stato reale, niente commenti sul vault
// nelle risposte pubbliche, calendario completo (pagine, 62 giorni, duplicati, giorni mirati), retry limitato per errori temporanei.
// Solo mock e provider finti: nessuna rete, nessun modello reale.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cons-'));
const V = path.join(BASE, 'vault');
const scrivi = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
fs.mkdirSync(path.join(V, '.obsidian'), { recursive: true });
scrivi('cervello/INDEX.md', '# Cervello\n\n- [[chi-sono]]\n');
scrivi('cervello/persona/chi-sono.md', '# Chi sono\n\nStudente.\n');
scrivi('note/matrici.md', '# Matrici\n\n## Inversa\n\nLa matrice inversa si calcola con Gauss-Jordan.\n');
process.env.ORBIT_VAULT_PATH = V; process.env.ORBIT_INDEX_DIR = path.join(BASE, 'indice');

const memoria = require('../../memoria/memoria');
const { rimandaLettura, controlla } = require('../ai/quality/deterministic');
const SISTEMA_VERIFICA = fs.readFileSync(require.resolve('../ai/quality/gate'), 'utf8');
const { creaCalendario } = require('../integrations/google/calendario');
const { costruisciBlocco, estraiDate } = require('../ai/router/strumenti');
const { catalogo } = require('../ai/router/strumenti-dinamici');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const { MockProvider, settingsProva } = require('./helpers');
memoria.avvia();

function ambiente({ risposte = ['Risposta.'], esiti = {} } = {}) {
  const chiamate = [];
  const provider = new MockProvider({ produttore: ({ n }) => ({ text: risposte[Math.min(n - 1, risposte.length - 1)] }) });
  const app = creaApp({ settings: settingsProva({ settings: { dataDir: path.join(BASE, 'dati') } }), provider, storage: new Storage(':memory:'), memoria, attendiFn: () => Promise.resolve() });
  for (const id of ['web', 'google']) app.permessi.impostaAbilitata(id, true);
  for (const [id, integr] of app.integrazioni.integrazioni) {
    if (integr.prerequisiti) integr.prerequisiti = async () => ({ ok: true });
    for (const [nome, st] of Object.entries(integr.strumenti)) st.esegui = async p => {
      chiamate.push({ nome: id + '.' + nome, params: p });
      if (esiti[id + '.' + nome]) return esiti[id + '.' + nome](p);
      if (nome === 'cerca_web') return { testo: 'Partite: 21 ottobre a Miami, 25 ottobre contro Toronto.', fonti: ['https://www.nba.com/x'] };
      return { dal: p.da, al: p.a || p.da, fuso: 'Europe/Rome', calendari: ['principale'], nonLetti: [], eventi: [], totale: 0, nonMostrati: 0, completo: true, altri: false, avviso: 'ok' };
    };
  }
  const eventi = [];
  const prompt = (i = 0) => { const p = provider.chiamate.filter(c => c.ruolo === 'produttore')[i]; return p ? p.messages.slice(-1)[0].content : ''; };
  return { app, provider, chiamate, eventi, prompt, chiedi: q => app.orchestrator.elabora({ messaggio: q, onEvent: e => eventi.push(e) }), produttori: () => provider.chiamate.filter(c => c.ruolo === 'produttore').length };
}
const blocco = (nome, params) => '<orbit_strumento nome="' + nome + '">' + JSON.stringify(params) + '</orbit_strumento>';

// ---------- 1. controllo "non rimandare" ----------
test('non_rimanda: un\'offerta facoltativa dopo aver soddisfatto la richiesta e valida; un rinvio di cio che era chiesto no', () => {
  const offerta = 'Ecco le partite: 21 ottobre a Miami. Se vuoi, posso controllare il tuo calendario per vedere se quel giorno hai impegni.';
  // richiesta pubblica, web eseguito: l'offerta del calendario e in piu -> nessun errore
  assert.equal(rimandaLettura(offerta, { richiesta: 'Cerca online le prossime partite dei Celtics.', stato: { eseguitiOk: ['web.cerca_web'] } }), null);
  // richiesta mista, il calendario era chiesto ma non e stato letto: offrirlo invece di farlo e un errore
  assert.ok(rimandaLettura(offerta, { richiesta: 'Che impegni ho nei giorni in cui giocano i Celtics?', stato: { eseguitiOk: ['web.cerca_web'] } }));
  // richiesta mista, calendario letto davvero: l'offerta (per esempio di riprovare) non e un errore
  assert.equal(rimandaLettura(offerta, { richiesta: 'Che impegni ho nei giorni in cui giocano i Celtics?', stato: { eseguitiOk: ['web.cerca_web', 'google.elenca_eventi'] } }), null);
  // domanda sulle note soddisfatta con la memoria: "posso anche cercare sul web se ti serve" e un'offerta in piu
  assert.equal(rimandaLettura('Nelle note non c\'e nulla. Posso anche cercare i Celtics sul web, se ti serve.', { richiesta: 'Che cosa ho scritto sui Celtics nelle mie note?', stato: { eseguitiOk: [] } }), null);
  // domanda su un dato aggiornato senza nessuna ricerca: offrire la ricerca invece di farla e un errore
  assert.ok(rimandaLettura('Non so il prezzo di oggi. Vuoi che cerchi online?', { richiesta: 'Quanto costa adesso un iPhone 17?', stato: { eseguitiOk: [] } }));
  // l'invito a riformulare resta sempre un errore, anche se qualcosa e stato eseguito
  assert.ok(rimandaLettura('Prova a scrivere: cerca online le partite.', { richiesta: 'Quando giocano i Celtics?', stato: { eseguitiOk: ['web.cerca_web'] } }));
  // proposte di scrittura: mai un errore
  assert.equal(rimandaLettura('Se vuoi lo salvo nelle tue note.', { richiesta: 'Quando giocano i Celtics?', stato: { eseguitiOk: [] } }), null);
  // errore reale dello strumento: dirlo e offrire di riprovare va bene
  const piano = { categoria: 'qa', verifica: { modo: 'deterministico', controlli: ['non_rimanda'], strumenti: { disponibili: ['web.cerca_web'], errori: 1, eseguitiOk: [] } } };
  assert.equal(controlla({ testo: 'La ricerca non e riuscita. Vuoi che riprovi a cercare online?', piano, richiesta: 'Quanto costa adesso un iPhone 17?' }).esito, 'PASS');
});

test('nessuna escalation su un\'offerta facoltativa dopo una ricerca riuscita (era il caso A1 e A6 della validazione)', async () => {
  const a = ambiente({ risposte: ['Le prossime: 21 ottobre a Miami e 25 ottobre contro Toronto (fonte: https://www.nba.com/x). Se vuoi, posso controllare il tuo calendario Google per vedere se in quei giorni hai impegni.'] });
  const r = await a.chiedi('Cerca online le prossime partite dei Celtics.');
  assert.equal(r.verifica, 'PASS'); assert.equal(a.produttori(), 1); assert.equal(r.escalation || 0, 0);
  assert.equal(a.eventi.some(e => e.tipo === 'esito_verifica' && e.status === 'FAIL'), false);
});

test('escalation ancora attiva quando Orbit evita una lettura eseguibile, e il tentativo dopo usa lo strumento', async () => {
  const a = ambiente({ risposte: ['Non ho il prezzo di oggi. Vuoi che cerchi online?', blocco('web.cerca_web', { domanda: 'prezzo iPhone 17 oggi' }), 'Oggi intorno agli 899 euro (fonte: https://www.nba.com/x).'] });
  const r = await a.chiedi('Quanto costa adesso un iPhone 17?');
  assert.ok(a.eventi.some(e => e.tipo === 'esito_verifica' && e.status === 'FAIL'));
  assert.ok(a.chiamate.some(c => c.nome === 'web.cerca_web')); assert.match(r.testo, /899/);
});

// ---------- 2. vault nelle risposte pubbliche ----------
test('domande pubbliche: istruzione a non commentare il vault; domande personali: nessuna istruzione, controlli sulla memoria invariati', async () => {
  const a = ambiente({ risposte: ['Il 21 ottobre a Miami.'] });
  await a.chiedi('Quando giocano i Celtics?');
  assert.match(a.prompt(), /<fonti_richiesta>Questa domanda riguarda dati pubblici/); assert.doesNotMatch(a.prompt(), /<contesto_vault>/);
  const b = ambiente({ risposte: ['Si calcola con Gauss-Jordan (note/matrici.md).'] });
  await b.chiedi('cosa dicono le mie note sulla matrice inversa?');
  assert.doesNotMatch(b.prompt(), /<fonti_richiesta>/); assert.match(b.prompt(), /<contesto_vault>[\s\S]*Gauss-Jordan/);
  assert.match(b.prompt(), /nelle parti del vault che ho letto non c'e/);              // regola delle assenze per le domande personali
  // domanda non riconosciuta come pubblica dalle regole, ma il modello cerca sul web: nota aggiunta dopo la ricerca
  const c = ambiente({ risposte: [blocco('web.cerca_web', { domanda: 'prezzo iPhone 17 oggi' }), 'Circa 899 euro.'] });
  await c.chiedi('Quanto costa adesso un iPhone 17?');
  assert.doesNotMatch(c.prompt(0), /<fonti_richiesta>/); assert.match(c.prompt(1), /<fonti_richiesta>/);
  // il verificatore applica la regola delle assenze solo alle richieste personali
  assert.match(SISTEMA_VERIFICA, /vale SOLO quando la richiesta riguarda le note, la memoria o i dati personali/);
  assert.match(SISTEMA_VERIFICA, /assenza non verificata/);
});

// ---------- 3. calendario completo ----------
function evento(i, giorno, extra = {}) {
  return Object.assign({ id: 'e' + i, iCalUID: 'uid' + i + '@google.com', summary: 'Evento ' + i, start: { dateTime: giorno + 'T' + String(8 + (i % 10)).padStart(2, '0') + ':00:00+02:00' }, end: { dateTime: giorno + 'T' + String(9 + (i % 10)).padStart(2, '0') + ':00:00+02:00' } }, extra);
}
const giornoN = n => { const d = new Date('2026-10-12T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// calendario principale: 300 eventi su 2 pagine; calendario condiviso: 3 eventi di cui 2 duplicati del principale (stesso iCalUID)
function calendarioFinto({ errori = [], pagineMax } = {}) {
  const richieste = [];
  const principale = Array.from({ length: 300 }, (_, i) => evento(i, giornoN(i % 60)));
  const condiviso = [evento(1, giornoN(1)), evento(2, giornoN(2)), evento(999, giornoN(10), { summary: 'Solo condiviso' }), { id: 'multi', summary: 'Viaggio', start: { date: giornoN(20) }, end: { date: giornoN(23) } }];
  const fetchFn = async url => {
    richieste.push(url);
    const e = errori.shift();
    if (e === 'rete') throw new Error('ECONNRESET');
    if (typeof e === 'number') return { ok: false, status: e, json: async () => ({ error: { status: e === 401 ? 'UNAUTHENTICATED' : 'ERR' } }) };
    const u = new URL(url);
    if (/calendarList/.test(url)) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'principale', summary: 'principale', primary: true }, { id: 'condiviso', summary: 'condiviso', selected: true }] }) };
    const cal = decodeURIComponent(u.pathname.split('/')[4]);
    const pagina = Number(u.searchParams.get('pageToken') || 0);
    const tutti = cal === 'principale' ? principale : condiviso;
    const items = tutti.slice(pagina * 250, pagina * 250 + 250);
    const next = (pagina + 1) * 250 < tutti.length && (!pagineMax || pagina + 1 < pagineMax) ? String(pagina + 1) : undefined;
    return { ok: true, status: 200, json: async () => ({ items, nextPageToken: next }) };
  };
  return { cal: creaCalendario({ auth: { accessToken: async () => 'T' }, fetchFn, attendiFn: async () => {} }), richieste };
}

test('calendario: tutte le pagine, nessun duplicato, completezza dichiarata, eventi oltre il limite mostrato segnalati', async () => {
  const { cal, richieste } = calendarioFinto();
  const r = await cal.elencaEventi({ da: giornoN(0), a: giornoN(61) });
  assert.equal(r.totale, 302);                                    // 300 + "Solo condiviso" + "Viaggio" (i 2 duplicati contati una volta)
  assert.equal(r.completo, true); assert.equal(r.eventi.length, 150); assert.equal(r.nonMostrati, 152); assert.equal(r.altri, true);
  assert.equal(new Set(r.eventi.map(e => e.titolo + e.inizio)).size, r.eventi.length);
  assert.equal(richieste.filter(u => /principale\/events/.test(u)).length, 2);   // due pagine lette
  const b = costruisciBlocco([{ chiamata: { strumento: 'elenca_eventi', params: {} }, esito: { ok: true, risultato: r } }]);
  assert.match(b, /Mostrati 150 eventi su 302: gli altri esistono/);
  const tutti = { dal: giornoN(0), al: giornoN(6), fuso: 'Europe/Rome', calendari: ['principale'], nonLetti: [], eventi: [], totale: 0, nonMostrati: 0, completo: true, altri: false, avviso: 'ok' };
  assert.match(costruisciBlocco([{ chiamata: { strumento: 'elenca_eventi', params: {} }, esito: { ok: true, risultato: tutti } }]), /Elenco completo per il periodo richiesto/);
});

test('calendario: intervalli di 30 e 62 giorni accettati, 63 respinto; limite di pagine = lettura incompleta dichiarata', async () => {
  const { cal } = calendarioFinto();
  assert.equal((await cal.elencaEventi({ da: giornoN(0), a: giornoN(30) })).completo, true);
  assert.equal((await cal.elencaEventi({ da: giornoN(0), a: giornoN(62) })).completo, true);
  await assert.rejects(cal.elencaEventi({ da: giornoN(0), a: giornoN(63) }), /troppo ampio/);
  // un calendario con piu pagine del massimo consentito: si ferma e lo dice, mai "completo"
  const molti = Array.from({ length: 1200 }, (_, i) => evento(i, giornoN(i % 60)));
  const fetchFn = async url => { const u = new URL(url); if (/calendarList/.test(url)) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'p', summary: 'p', primary: true }] }) }; const p = Number(u.searchParams.get('pageToken') || 0); return { ok: true, status: 200, json: async () => ({ items: molti.slice(p * 250, p * 250 + 250), nextPageToken: String(p + 1) }) }; };
  const r = await creaCalendario({ auth: { accessToken: async () => 'T' }, fetchFn, attendiFn: async () => {} }).elencaEventi({ da: giornoN(0), a: giornoN(61) });
  assert.equal(r.completo, false); assert.match(r.motivoIncompleto, /limite di lettura/);
  assert.match(costruisciBlocco([{ chiamata: { strumento: 'elenca_eventi', params: {} }, esito: { ok: true, risultato: r } }]), /lettura INCOMPLETA[\s\S]*NON sono tutti gli impegni/);
});

test('calendario: solo i giorni richiesti (richieste miste), con i giorni senza impegni e gli eventi di piu giorni', async () => {
  const { cal } = calendarioFinto();
  const r = await cal.elencaEventi({ da: giornoN(0), a: giornoN(61), giorni: [giornoN(10), giornoN(21), giornoN(61)] });
  assert.ok(r.eventi.every(e => [giornoN(10), giornoN(21), giornoN(61)].some(g => (e.inizio || '').startsWith(g)) || e.titolo === 'Viaggio'));
  assert.ok(r.eventi.some(e => e.titolo === 'Solo condiviso')); assert.ok(r.eventi.some(e => e.titolo === 'Viaggio'));   // Viaggio dal giorno 20 al 22
  assert.deepEqual(r.giorniSenzaEventi, [giornoN(61)]); assert.equal(r.completo, true);
  await assert.rejects(cal.elencaEventi({ da: giornoN(0), a: giornoN(10), giorni: [giornoN(20)] }), /dentro l'intervallo/);
  assert.deepEqual(estraiDate('Partite: mercoledi 21 ottobre a Miami; 25/10 contro Toronto; Nov 19 vs Knicks; dall 8 al 10 dicembre', '2026-10-12', '2026-12-12'),
    ['2026-10-21', '2026-10-25', '2026-11-19', '2026-12-08', '2026-12-09', '2026-12-10']);
  assert.deepEqual(estraiDate('nessuna data utile, articolo del 15 agosto', '2026-10-12', '2026-12-12'), []);
});

// ---------- 4. errori temporanei e permanenti ----------
test('calendario: retry limitato solo per errori temporanei (rete, 429, 5xx); mai per autorizzazione o parametri', async () => {
  let c = calendarioFinto({ errori: ['rete', 503] });
  let r = await c.cal.elencaEventi({ da: giornoN(0), a: giornoN(1) });
  assert.equal(r.retry, 2); assert.equal(r.completo, true);
  c = calendarioFinto({ errori: ['rete', 'rete', 'rete'] });
  await assert.rejects(c.cal.elencaEventi({ da: giornoN(0) }), e => e.codice === 'RETE');
  assert.equal(c.richieste.length, 3);                                              // 1 tentativo + 2 nuovi tentativi, poi basta
  c = calendarioFinto({ errori: [401] });
  await assert.rejects(c.cal.elencaEventi({ da: giornoN(0) }), e => e.codice === 'TOKEN_REVOCATO');
  assert.equal(c.richieste.length, 1);                                              // autorizzazione: nessun nuovo tentativo
  c = calendarioFinto({ errori: [429, 429, 429] });
  await assert.rejects(c.cal.elencaEventi({ da: giornoN(0) }), e => e.codice === 'LIMITE'); assert.equal(c.richieste.length, 3);
  c = calendarioFinto();
  await assert.rejects(c.cal.elencaEventi({ da: 'domani' })); assert.equal(c.richieste.length, 0);   // parametri: nessuna chiamata
  // il token che non si rinnova per un problema di rete si riprova; un token revocato no
  let n = 0;
  const auth = { accessToken: async () => { n++; if (n < 2) throw Object.assign(new Error('rete'), { codice: 'RETE' }); return 'T'; } };
  const ok = await creaCalendario({ auth, fetchFn: calendarioFinto().cal && (async url => ({ ok: true, status: 200, json: async () => (/calendarList/.test(url) ? { items: [] } : { items: [] }) })), attendiFn: async () => {} }).elencaEventi({ da: giornoN(0) });
  assert.equal(ok.retry, 1);
});

// ---------- 5. strumenti dinamici e permessi invariati ----------
test('strumenti dinamici: il calendario chiesto dal modello accetta i giorni; nessuno strumento di scrittura nel catalogo', async () => {
  const a = ambiente({ risposte: [blocco('google.elenca_eventi', { da: giornoN(0), a: giornoN(30), giorni: [giornoN(9)] }), 'Quel giorno sei libero.'] });
  await a.chiedi('sono libero il giorno della prossima partita dei Bulls che ho trovato prima?');
  assert.ok(a.chiamate.some(c => c.nome === 'google.elenca_eventi' && c.params.giorni && c.params.giorni[0] === giornoN(9)));
  const cat = catalogo(a.app.integrazioni);
  assert.equal(cat.some(c => /crea|amplia|riscrivi|elimina|invia/.test(c.nome)), false);
  assert.ok(cat.find(c => c.nome === 'google.elenca_eventi').campi.some(f => f.nome === 'giorni'));
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* indice aperto */ } });
