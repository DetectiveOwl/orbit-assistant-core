'use strict';
// Confronti a lotti: cataloghi sintetici da 8 a 50 note, orchestratore + bridge Windows REALI, modello finto ONESTO (giudica solo su testi completi, equivalente se le righe elenco coincidono).
// Verifica la copertura completa (un duplicato nell'ultimo lotto non produce mai CREATE), i limiti (testo lungo, illeggibile, risposta non valida, annullamento, budget),
// il riuso dello stato fra richieste, la ripetizione e la concorrenza. Stampa anche chiamate/confronti/tempi per catalogo (benchmark con modello finto: misura il solo flusso).
// Uso (Windows): $env:SMART_INBOX_PWSH='<pwsh.exe 7.6.7>'; $env:SMART_INBOX_SCRIPT_MANIFEST_SHA256=(node smart-inbox/integrita.js --pin); node smart-inbox/tests/e2e-lotti.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { scriviMarker } = require('../perimetro');
const { creaIntegrazioneSmartInbox } = require('../../orbit/integrations/smartinbox');
const { creaApp } = require('../../orbit/app');
const { Storage } = require('../../orbit/storage/db');
const { OrbitError } = require('../../orbit/ai/errors');
const { MockProvider, settingsProva } = require('../../orbit/tests/helpers');
if (!process.env.SMART_INBOX_PWSH) throw new Error('SMART_INBOX_PWSH richiesto');
const base = fs.realpathSync(os.tmpdir()), h = n => crypto.randomBytes(n).toString('hex'), esiti = [], creati = [], bench = [];
const verifica = (nome, ok, extra) => { esiti.push((ok ? 'OK   ' : 'FAIL ') + nome); if (!ok) console.log('FAIL', nome, JSON.stringify(extra, null, 1).slice(0, 2000)); };
const SORGENTI = { 'Film da vedere': '# Film da vedere\n- Dune\n- Alien\n', 'Informazioni Ipad': '# Informazioni Ipad\nModello sintetico, 64 GB.\n', 'Opening scacchi': '# Opening scacchi\n- Italiana\n- Siciliana\n', 'Serie TV da vedere': '# Serie TV da vedere\n- Dark\n- Severance\n' };
const ATTESE = ['Informazioni Ipad.md', 'Opening scacchi.md'];   // Film e Serie TV sono equivalenti fra loro: restano entrambe in sospeso
const ARGOMENTI = ['giardinaggio', 'bilancio domestico', 'allenamento', 'cucina regionale', 'fotografia', 'viaggi', 'lettura', 'musica', 'manutenzione auto', 'astronomia', 'falegnameria', 'meteorologia'];
const nota = (k, n = 2100) => { const arg = ARGOMENTI[k % ARGOMENTI.length]; let t = '# Nota ' + String(k).padStart(3, '0') + ' ' + arg + '\n\n'; for (let i = 0; t.length < n; i++) t += '- Appunto ' + k + '.' + i + ' su ' + arg + ': dettaglio specifico numero ' + (k * 31 + i) + ' della serie ' + k + '.\n'; return t.slice(0, n - 1) + '\n'; };

function nuovo(N, extra = {}, sorgenti = SORGENTI) {
  const vault = path.join(base, 'vault-' + h(4)), stage = path.join(base, 'orbit-smart-inbox-real-' + h(16)), catalogo = {};
  creati.push(vault, stage);
  for (const d of ['home', 'tmp', 'technical/v']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  for (const d of ['to sort', 'smart inbox', 'cervello/vita']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  for (const [n, t] of Object.entries(sorgenti)) fs.writeFileSync(path.join(vault, 'to sort', n + '.md'), t);
  for (let k = 0; k < N; k++) { const t = nota(k); catalogo['Nota ' + String(k).padStart(3, '0') + ' ' + ARGOMENTI[k % ARGOMENTI.length]] = t; fs.writeFileSync(path.join(vault, 'cervello/vita/n' + String(k).padStart(3, '0') + '.md'), t); }
  for (const [rel, testo] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), testo); catalogo[testo.match(/^# (.+)$/m)[1]] = testo; }
  scriviMarker(stage, vault);
  return { vault, stage, catalogo, ctx: { stage, vault, technical: 'technical/v' } };
}
const inbox = A => fs.readdirSync(path.join(A.vault, 'smart inbox')).sort();
const righeElenco = t => new Set(String(t).split('\n').filter(l => l.startsWith('- ')));
const uguali = (a, b) => a.size > 0 && a.size === b.size && [...a].every(x => b.has(x));

// Un'applicazione con modello finto onesto. opzioni: hook(nChiamata, dati) -> undefined | { risposta } | { errore } | { abort }, limiti, soloApp.
function avvia(A, { hook = null, limiti = {}, patchIntegrazione = null } = {}) {
  const ambito = { context: A.ctx, autorizzati: ['cervello', 'smart inbox'], creaIn: ['smart inbox'], creaDefault: 'smart inbox', autoApplica: true, autoOperazioni: ['create'], autoCartelle: ['smart inbox'] };
  const stat = { chiamate: 0, coppie: 0, incomplete: 0, caratteri: 0, prompt: '', risposte: [] };
  const provider = new MockProvider({ produttore: ({ messages }) => {
    const prompt = messages.at(-1).content;
    if (prompt.includes('<dati_note>')) {
      stat.chiamate++; stat.caratteri += prompt.length;
      const dati = JSON.parse(prompt.match(/<dati_note>\n([\s\S]*?)\n<\/dati_note>/)[1].replace(/\\u003c/g, '<'));
      const h2 = hook && hook(stat.chiamate, dati); if (h2 && h2.errore) throw h2.errore; if (h2 && h2.abort) h2.abort();
      // Consumo come con Claude Code reale (misurato: ~35000 caratteri = ~20000 token in ingresso, ~1100 in uscita), cosi il budget della richiesta si comporta come in produzione.
      const conUso = testo => ({ text: testo, usage: { inputTokens: Math.round(prompt.length / 1.75), outputTokens: 1100 } });
      if (h2 && h2.risposta !== undefined) return conUso(h2.risposta);
      return conUso(JSON.stringify(dati.sorgenti.map(q => ({ i: q.i, valutazioni: dati.candidati.filter(c => !(q.salta || []).includes(c.j)).map(c => {
        const intero = c.testo !== undefined && c.testo === A.catalogo[c.titolo] && !c.tagliato;
        stat.coppie++; if (!intero) stat.incomplete++;
        return { j: c.j, relazione: !intero ? 'incerta' : uguali(righeElenco(q.sorgente), righeElenco(c.testo)) ? 'equivalente' : 'distinta' };
      }) }))));
    }
    stat.prompt = prompt; const m = prompt.match(/"riepilogo":\s*"((?:[^"\\]|\\.)*)"/g);
    const testo = m ? JSON.parse('{' + m.at(-1) + '}').riepilogo : 'Nessun riepilogo.'; stat.risposte.push(testo); return testo;
  } });
  const storage = new Storage(':memory:');
  const settings = settingsProva({ settings: { dataDir: fs.mkdtempSync(path.join(base, 'orbit-lotti-dati-')) }, limiti: { maxRetryApi: 0, budgetTokenRichiesta: 600000, budgetTokenTentativo: 60000, ...limiti } }); creati.push(settings.dataDir);
  const si = creaIntegrazioneSmartInbox({ ambito }); if (patchIntegrazione) patchIntegrazione(si);
  const a = creaApp({ settings, provider, storage, memoria: { leggiNota() { throw new Error('x'); }, contestoPerDomanda() { throw new Error('x'); } }, smartInbox: si, tts: {}, voce: {}, cifratura: {}, attendiFn: () => Promise.resolve() });
  a.permessi.impostaAbilitata('smartinbox', true);
  return { a, stat, chiudi: () => storage.chiudi() };
}
const chiedi = async (app, signal) => { const t0 = Date.now(); const r = await app.a.orchestrator.elabora({ messaggio: 'Organizza to sort', signal }); return { r, ms: Date.now() - t0, audit: app.a.audit.elenca(2000) }; };
const hasValuta = audit => audit.some(e => e.azione === 'valuta_piano' && e.esito === 'completata');

async function scenari() {
  // 1. Scala: 8, 13, 20, 21, 50 note. Sempre le 2 note indipendenti create, copertura completa, un solo prompt per lotto.
  for (const N of [8, 13, 20, 21, 50]) {
    const A = nuovo(N), app = avvia(A), { r, ms, audit } = await chiedi(app);
    const lotti = app.a.orchestrator ? null : null; void lotti;
    verifica(N + ' note: richiesta completata e valuta_piano eseguito', r.ok === true && hasValuta(audit), { ok: r.ok });
    verifica(N + ' note: create esattamente le 2 note indipendenti', JSON.stringify(inbox(A)) === JSON.stringify(ATTESE), inbox(A));
    verifica(N + ' note: ogni confronto ha ricevuto testi completi (nessun taglio, nessuna coppia incerta)', app.stat.coppie > 0 && app.stat.incomplete === 0, { coppie: app.stat.coppie, incomplete: app.stat.incomplete });
    verifica(N + ' note: nessun ASSENZA_NON_DIMOSTRATA / VALUTAZIONE_PARZIALE nel riepilogo', !/ASSENZA_NON_DIMOSTRATA|VALUTAZIONE_PARZIALE|OLTRE_I_LIMITI/.test(app.stat.risposte.at(-1) || ''), app.stat.risposte);
    bench.push({ note: N, chiamateModello: app.stat.chiamate, confronti: app.stat.coppie, promptKB: Math.round(app.stat.caratteri / 1024), ms });
    app.chiudi();
  }

  // 2. Duplicato nell'ULTIMO lotto (nota che ordina per ultima, titolo diverso, stesse righe della sorgente): mai CREATE per quella sorgente.
  {
    const A = nuovo(50, { 'cervello/vita/zz-ultima.md': '# Aperture\n- Italiana\n- Siciliana\n' }), app = avvia(A), { r } = await chiedi(app);
    verifica('duplicato nell\'ultimo lotto (50 note): Opening scacchi NON viene creata', r.ok === true && !inbox(A).includes('Opening scacchi.md'), inbox(A));
    verifica('duplicato nell\'ultimo lotto: le altre note indipendenti si creano (Informazioni Ipad)', inbox(A).includes('Informazioni Ipad.md'), inbox(A));
    verifica('duplicato nell\'ultimo lotto: la nota gia presente e dichiarata nel riepilogo come in sospeso', /Opening scacchi\.md/.test(app.stat.risposte.at(-1) || '') && /sospeso|conferma/i.test(app.stat.risposte.at(-1) || ''), app.stat.risposte);
    app.chiudi();
  }

  // 3. Testo lungo (oltre il tetto di lettura): nessun confronto dichiarato distinto, nessuna scrittura, motivo reale al modello.
  {
    const A = nuovo(21, { 'cervello/vita/z-lunga.md': '# Lunga\n' + '- riga di prova numero uno\n'.repeat(1700) }), app = avvia(A), { r } = await chiedi(app);
    verifica('testo lungo (21 note): nessuna nota scritta', r.ok === true && inbox(A).length === 0, inbox(A));
    verifica('testo lungo: il limite tecnico reale arriva al modello finale', /limite tecnico dei testi[^<]*piu lunga di 24000/.test(app.stat.prompt), app.stat.prompt.slice(0, 300));
    app.chiudi();
  }

  // 4. Candidato non leggibile: valutazione non completata col motivo vero, nessuna scrittura.
  {
    const A = nuovo(21); let n = 0;
    const app = avvia(A, { patchIntegrazione: si => { const e = si.strumenti.materiale.esegui; si.strumenti.materiale.esegui = async (p, ctx) => { if (p.nota === 3 && ++n > 0 && p.indice === 0) throw new Error('lettura guasta'); return e(p, ctx); }; } });
    const { r, audit } = await chiedi(app);
    verifica('candidato non leggibile: nessuna scrittura e valuta_piano non eseguito', r.ok === true && inbox(A).length === 0 && !hasValuta(audit), { inbox: inbox(A), valuta: hasValuta(audit) });
    verifica('candidato non leggibile: il motivo e comunicato', /non leggibile/.test(app.stat.prompt), app.stat.prompt.slice(0, 300));
    app.chiudi();
  }

  // 5. Valutazione fallita all'ultimo lotto, poi RIPETIZIONE: riparte dai lotti mancanti (stato conservato) e completa.
  {
    const A = nuovo(50); let primoGiro = true;
    const app = avvia(A, { hook: (n) => (primoGiro && n === 3 ? { risposta: 'Non riesco a rispondere in JSON.' } : undefined) });
    const r1 = await chiedi(app), chiamate1 = app.stat.chiamate;
    verifica('valutazione fallita al lotto 3: nessuna scrittura e valuta_piano non eseguito', inbox(A).length === 0 && !hasValuta(r1.audit), { inbox: inbox(A) });
    verifica('valutazione fallita: il motivo indica il lotto e che i precedenti restano valutati', /lotto 3 di \d+[^<]*non e un array JSON valido[^<]*precedenti restano valutati/.test(app.stat.prompt), app.stat.prompt.slice(0, 400));
    primoGiro = false;
    const r2 = await chiedi(app), chiamate2 = app.stat.chiamate - chiamate1;
    verifica('ripetizione: completa e crea le 2 note indipendenti', r2.r.ok === true && JSON.stringify(inbox(A)) === JSON.stringify(ATTESE), inbox(A));
    verifica('ripetizione: riparte dal lotto fallito (meno chiamate del giro completo, i lotti 1-2 non si rifanno)', chiamate2 < chiamate1 + 1 && chiamate2 <= 2 && chiamate2 >= 1, { chiamate1, chiamate2 });
    const stato = inbox(A).length;
    const r3 = await chiedi(app), chiamate3 = app.stat.chiamate - chiamate1 - chiamate2;
    verifica('terza richiesta identica: nessuna duplicazione e nessun nuovo confronto delle coppie gia note', JSON.stringify(inbox(A)) === JSON.stringify(ATTESE) && inbox(A).length === stato && chiamate3 <= 4, { chiamate3 });
    bench.push({ note: '50 (ripetizione)', chiamateModello: chiamate3, confronti: '-', promptKB: '-', ms: r3.ms });
    app.chiudi();
  }

  // 6. Annullamento durante il confronto.
  {
    const A = nuovo(50), ac = new AbortController();
    const app = avvia(A, { hook: n => (n === 2 ? { abort: () => ac.abort() } : undefined) });
    const { r, audit } = await chiedi(app, ac.signal);
    verifica('annullamento al lotto 2: nessuna scrittura e valuta_piano non eseguito', inbox(A).length === 0 && !hasValuta(audit), { inbox: inbox(A), ok: r.ok });
    verifica('annullamento: la richiesta risulta interrotta', r.ok === false, { ok: r.ok, codice: r.codice });
    app.chiudi();
  }

  // 7. Budget di token esaurito durante i lotti: si ferma con il motivo, nessuna scrittura, i lotti fatti restano per la richiesta successiva.
  {
    const A = nuovo(50), app = avvia(A, { limiti: { budgetTokenRichiesta: 60000, budgetTokenTentativo: 30000 } });
    const { r, audit } = await chiedi(app);
    verifica('budget di token esaurito a meta (dopo almeno un lotto): nessuna scrittura e motivo dichiarato', r.ok === true && app.stat.chiamate >= 1 && app.stat.chiamate < 4 && inbox(A).length === 0 && !hasValuta(audit) && /budget di token/.test(app.stat.prompt), { chiamate: app.stat.chiamate, inbox: inbox(A), prompt: app.stat.prompt.slice(0, 300) });
    // con piu budget la stessa richiesta riparte dai lotti mancanti e completa
    app.a.settings.limiti.budgetTokenRichiesta = 300000; app.a.settings.limiti.budgetTokenTentativo = 60000;
    const c1 = app.stat.chiamate, r2 = await chiedi(app);
    verifica('budget: la richiesta successiva (piu budget) riparte dai lotti mancanti e crea le 2 note', r2.r.ok === true && JSON.stringify(inbox(A)) === JSON.stringify(ATTESE) && app.stat.chiamate - c1 === 4 - c1, { c1, totale: app.stat.chiamate, inbox: inbox(A) });
    app.chiudi();
  }

  // 7b. Catalogo oltre il massimo di lotti (200 note): nessun confronto parziale, motivo vero del limite, nessuna chiamata al modello.
  {
    const A = nuovo(0), app = avvia(A);
    for (let k = 0; k < 200; k++) fs.writeFileSync(path.join(A.vault, 'cervello/vita/m' + String(k).padStart(3, '0') + '.md'), '# Mini ' + k + '\n- voce ' + k + '\n');
    const { r } = await chiedi(app);
    verifica('catalogo oltre i lotti massimi (200 note): nessuna scrittura, motivo CATALOGO_OLTRE_I_LIMITI_DI_CONFRONTO, nessuna chiamata al modello',
      r.ok === true && inbox(A).length === 0 && app.stat.chiamate === 0 && /CATALOGO_OLTRE_I_LIMITI_DI_CONFRONTO/.test(app.stat.risposte.at(-1) || ''), { inbox: inbox(A), chiamate: app.stat.chiamate, risposta: app.stat.risposte });
    app.chiudi();
  }

  // 7c. Molte sorgenti x molti lotti (8 sorgenti distinte x 3 lotti = 24 richieste, oltre le 20 del vecchio limite di materiale/prepara): copertura completa e tutte le note si creano.
  {
    const titoli = ['Zebra', 'Quarzo', 'Lampone', 'Cometa', 'Bussola', 'Tramonto', 'Violino', 'Arcipelago'], molte = {};
    titoli.forEach((t, k) => { molte[t] = '# ' + t + '\n- voce unica ' + t.toLowerCase() + ' numero ' + (k + 700) + '\n'; });
    const A = nuovo(40, {}, molte), app = avvia(A), { r, audit } = await chiedi(app);
    verifica('8 sorgenti x 40 note (24 richieste): valutazione completa, valuta_piano eseguito, 8 note create', r.ok === true && hasValuta(audit) && JSON.stringify(inbox(A)) === JSON.stringify(titoli.map(t => t + '.md').sort()), { inbox: inbox(A), prompt: app.stat.prompt.slice(0, 300) });
    verifica('8 sorgenti x 40 note: un solo prompt per lotto, testi completi', app.stat.chiamate === 3 && app.stat.incomplete === 0, { chiamate: app.stat.chiamate, incomplete: app.stat.incomplete });
    bench.push({ note: '40 x 8 sorgenti', chiamateModello: app.stat.chiamate, confronti: app.stat.coppie, promptKB: Math.round(app.stat.caratteri / 1024), ms: 0 });
    app.chiudi();
  }

  // 7d. 20 sorgenti distinte x 20 note (2 lotti, 40 richieste): il risultato di prepara/valuta_piano resta sotto il limite e si creano tutte e 20.
  {
    const nomi = ['Zebra', 'Quarzo', 'Lampone', 'Cometa', 'Bussola', 'Tramonto', 'Violino', 'Arcipelago', 'Delfino', 'Fontana', 'Granito', 'Himalaya', 'Inchiostro', 'Giaguaro', 'Kiwi', 'Labirinto', 'Mandorla', 'Nebbia', 'Oasi', 'Pergamena'], venti = {};
    nomi.forEach((t, k) => { venti[t] = '# ' + t + '\n- voce unica ' + t.toLowerCase() + ' numero ' + (k + 900) + ' con testo di una certa lunghezza per riempire la nota creata dalla sorgente\n'; });
    const A = nuovo(20, {}, venti), app = avvia(A), { r, audit } = await chiedi(app);
    verifica('20 sorgenti x 20 note: valutazione completa, valuta_piano eseguito, 20 note create', r.ok === true && hasValuta(audit) && JSON.stringify(inbox(A)) === JSON.stringify(nomi.map(t => t + '.md').sort()), { inbox: inbox(A).length, errori: audit.filter(e => e.esito === 'errore').map(e => [e.azione, e.dettaglio]), valuta: hasValuta(audit), prompt: (app.stat.prompt.match(/<smart_inbox_valutazione>[^<]*/) || [''])[0].slice(0, 400) });
    app.chiudi();
  }

  // 7e. 20 sorgenti con 10 duplicati nel catalogo: il riepilogo verificato arriva INTERO al modello (in testa al risultato, non tagliato dal limite di 8000 caratteri).
  {
    const nomi = ['Zebra', 'Quarzo', 'Lampone', 'Cometa', 'Bussola', 'Tramonto', 'Violino', 'Arcipelago', 'Delfino', 'Fontana', 'Granito', 'Himalaya', 'Inchiostro', 'Giaguaro', 'Kiwi', 'Labirinto', 'Mandorla', 'Nebbia', 'Oasi', 'Pergamena'], venti = {}, dup = {};
    nomi.forEach((t, k) => { venti[t] = '# ' + t + '\n- voce unica ' + t.toLowerCase() + ' numero ' + (k + 900) + '\n'; });
    nomi.slice(0, 10).forEach((t, k) => { dup['cervello/vita/zdup-' + k + '.md'] = '# Doppione ' + k + '\n- voce unica ' + t.toLowerCase() + ' numero ' + (k + 900) + '\n'; });
    const A = nuovo(20, dup, venti), app = avvia(A), { r, audit } = await chiedi(app), ris = app.stat.risposte.at(-1) || '';
    verifica('20 sorgenti, 10 con duplicato: create le 10 senza duplicato, nessuna dei duplicati', r.ok === true && hasValuta(audit) && JSON.stringify(inbox(A)) === JSON.stringify(nomi.slice(10).map(t => t + '.md').sort()), { inbox: inbox(A) });
    verifica('20 sorgenti, 10 duplicati: il riepilogo verificato arriva intero al modello (Create 10 note + 10 in sospeso)', /Create 10 note/.test(ris) && /In sospeso/.test(ris) && nomi.slice(0, 10).every(t => ris.includes(t + '.md')), ris.slice(0, 300));
    app.chiudi();
  }

  // 7f. Catalogo vuoto, 20 sorgenti: nessuna richiesta semantica, l'applicazione avviene gia in prepara e il riepilogo arriva intero (anche qui in testa al risultato).
  {
    const nomi = ['Zebra', 'Quarzo', 'Lampone', 'Cometa', 'Bussola', 'Tramonto', 'Violino', 'Arcipelago', 'Delfino', 'Fontana', 'Granito', 'Himalaya', 'Inchiostro', 'Giaguaro', 'Kiwi', 'Labirinto', 'Mandorla', 'Nebbia', 'Oasi', 'Pergamena'], venti = {};
    nomi.forEach((t, k) => { venti[t] = '# ' + t + '\n- voce unica ' + t.toLowerCase() + ' numero ' + (k + 900) + ' con testo di una certa lunghezza per riempire la nota creata dalla sorgente\n'; });
    const A = nuovo(0, {}, venti), app = avvia(A), { r } = await chiedi(app), ris = app.stat.risposte.at(-1) || '';
    verifica('catalogo vuoto, 20 sorgenti: create tutte e 20 gia in prepara, senza chiamate al modello', r.ok === true && app.stat.chiamate === 0 && JSON.stringify(inbox(A)) === JSON.stringify(nomi.map(t => t + '.md').sort()), { inbox: inbox(A).length, chiamate: app.stat.chiamate });
    verifica('catalogo vuoto, 20 sorgenti: il riepilogo verificato arriva intero al modello (Create 20 note)', /Create 20 note/.test(ris) && nomi.every(t => ris.includes(t + '.md')), ris.slice(0, 200));
    app.chiudi();
  }

  // 8. Richieste concorrenti sullo stesso vault: nessuna duplicazione ne sovrascrittura.
  {
    const A = nuovo(21), app = avvia(A), prima = fs.readdirSync(path.join(A.vault, 'cervello/vita')).length;
    const [x, y] = await Promise.all([chiedi(app), chiedi(app)]);
    verifica('richieste concorrenti: esattamente le 2 note indipendenti, nessuna copia', JSON.stringify(inbox(A)) === JSON.stringify(ATTESE) && fs.readdirSync(path.join(A.vault, 'cervello/vita')).length === prima, inbox(A));
    verifica('richieste concorrenti: entrambe terminano senza errori', x.r.ok === true && y.r.ok === true, { x: x.r.ok, y: y.r.ok });
    app.chiudi();
  }
}
scenari().catch(e => verifica('esecuzione', false, e.stack || e.code || e.message)).finally(() => {
  for (const p of creati) fs.rmSync(p, { recursive: true, force: true });
  console.log(esiti.join('\n'));
  console.log('\nBENCHMARK (modello finto: solo il flusso)\nnote | chiamate modello | confronti | prompt totale KB | ms\n' + bench.map(b => [b.note, b.chiamateModello, b.confronti, b.promptKB, b.ms].join(' | ')).join('\n'));
  process.exitCode = esiti.some(l => l.startsWith('FAIL')) ? 1 : 0;
});
