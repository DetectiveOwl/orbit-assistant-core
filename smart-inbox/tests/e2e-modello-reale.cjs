'use strict';
// Verifica LIMITATA con il modello REALE (Claude Code con l'abbonamento, nessuna API a consumo) su dati SINTETICI: catalogo di N note (default 13; 50 per i lotti), 4 sorgenti piccole,
// orchestratore + bridge reali, nessuna risposta simulata. Nessun contenuto personale esce: stage, vault e dati sono temporanei.
// Misura: chiamate al modello, confronti, token se disponibili, tempo, risposte valide/incerte, valuta_piano, file creati.
// Uso: $env:SMART_INBOX_PWSH=...; $env:SMART_INBOX_SCRIPT_MANIFEST_SHA256=...; node smart-inbox/tests/e2e-modello-reale.cjs [N]   (consuma alcune chiamate dell'abbonamento)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { scriviMarker } = require('../perimetro');
const { creaIntegrazioneSmartInbox } = require('../../orbit/integrations/smartinbox');
const { creaApp } = require('../../orbit/app');
const config = require('../../orbit/config');
const { Storage } = require('../../orbit/storage/db');
if (!process.env.SMART_INBOX_PWSH) throw new Error('SMART_INBOX_PWSH richiesto');
const N = Number(process.argv[2] || 13), base = fs.realpathSync(os.tmpdir()), h = n => crypto.randomBytes(n).toString('hex'), creati = [];
// Contenuti sintetici PLAUSIBILI e diversi tra loro (un modello vero deve poter giudicare che sono note distinte dalle quattro sorgenti).
const TEMI = {
  giardinaggio: ['Annaffiare i pomodori la sera, non nelle ore calde.', 'Potare il basilico per farlo ramificare.', 'Concimare le rose a fine inverno.', 'Rinvasare il limone in primavera.'],
  'bilancio domestico': ['Registrare le spese fisse il primo del mese.', 'Mettere da parte il dieci per cento dello stipendio.', 'Controllare gli abbonamenti inutilizzati.', 'Confrontare le tariffe della luce ogni anno.'],
  allenamento: ['Corsa leggera di trenta minuti il martedi.', 'Esercizi di mobilita al mattino.', 'Scheda di forza a corpo libero il sabato.', 'Riposo completo la domenica.'],
  'cucina regionale': ['Ragu alla bolognese con cottura lenta di tre ore.', 'Pesto genovese nel mortaio con il basilico fresco.', 'Cacio e pepe con pecorino romano grattugiato fine.', 'Risotto alla milanese con lo zafferano.'],
  fotografia: ['Regola dei terzi per comporre i paesaggi.', 'Scattare nell ora blu dopo il tramonto.', 'Usare un treppiede per le lunghe esposizioni.', 'Sviluppare i file raw con contrasto moderato.'],
  viaggi: ['Prenotare i treni con due mesi di anticipo.', 'Portare solo un bagaglio a mano.', 'Lista dei musei con ingresso gratuito la prima domenica.', 'Tenere copia digitale dei documenti.'],
  lettura: ['Finire un romanzo al mese.', 'Annotare le citazioni a margine.', 'Alternare saggistica e narrativa.', 'Rileggere i classici in estate.'],
  musica: ['Esercizi di scale sulla chitarra ogni sera.', 'Imparare tre accordi nuovi a settimana.', 'Ascoltare un album intero senza interruzioni.', 'Registrare le prove con il telefono.'],
  'manutenzione auto': ['Controllare la pressione delle gomme ogni mese.', 'Tagliando ogni quindicimila chilometri.', 'Sostituire le spazzole tergicristallo in autunno.', 'Verificare il livello dell olio.'],
  astronomia: ['Osservare Giove con il binocolo nelle sere limpide.', 'Consultare la mappa del cielo del mese.', 'Allontanarsi dalle luci della citta.', 'Annotare le fasi della luna.'],
  falegnameria: ['Levigare con grana crescente prima di verniciare.', 'Misurare due volte, tagliare una.', 'Usare la colla vinilica per i giunti.', 'Affilare lo scalpello prima di ogni lavoro.'],
  meteorologia: ['Leggere le carte di pressione prima di uscire.', 'Controllare il vento in quota per i voli.', 'Annotare le temperature minime in giardino.', 'Confrontare piu previsioni prima di partire.']
};
const ARG = Object.keys(TEMI);
const nota = (k, n = 2100) => { const arg = ARG[k % ARG.length], fr = TEMI[arg]; let t = '# Nota ' + String(k).padStart(3, '0') + ' ' + arg + '\n\n'; for (let i = 0; t.length < n; i++) t += '- ' + fr[(i + k) % fr.length] + ' (voce ' + k + '.' + i + ')\n'; return t.slice(0, n - 1) + '\n'; };
const SORGENTI = { 'Film da vedere': '# Film da vedere\n- Dune\n- Alien\n', 'Informazioni Ipad': '# Informazioni Ipad\nModello sintetico, 64 GB.\n', 'Opening scacchi': '# Opening scacchi\n- Italiana\n- Siciliana\n', 'Serie TV da vedere': '# Serie TV da vedere\n- Dark\n- Severance\n' };

(async () => {
  const vault = path.join(base, 'vault-' + h(4)), stage = path.join(base, 'orbit-smart-inbox-real-' + h(16)), dati = fs.mkdtempSync(path.join(base, 'orbit-real-dati-')), decoy = fs.mkdtempSync(path.join(base, 'orbit-real-vp-'));
  creati.push(vault, stage, dati, decoy);
  for (const d of ['home', 'tmp', 'technical/v']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  for (const d of ['to sort', 'smart inbox', 'cervello/vita']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  for (const [n, t] of Object.entries(SORGENTI)) fs.writeFileSync(path.join(vault, 'to sort', n + '.md'), t);
  for (let k = 0; k < N; k++) fs.writeFileSync(path.join(vault, 'cervello/vita/n' + String(k).padStart(3, '0') + '.md'), nota(k));
  scriviMarker(stage, vault);
  const ambito = { context: { stage, vault, technical: 'technical/v' }, autorizzati: ['cervello', 'smart inbox'], creaIn: ['smart inbox'], creaDefault: 'smart inbox', autoApplica: true, autoOperazioni: ['create'], autoCartelle: ['smart inbox'] };
  const { settings } = config.carica({ envProcesso: { ORBIT_ENV_FILE: 'C:\\inesistente\\.env', ORBIT_DATA_DIR: dati, ORBIT_VAULT_PATH: decoy, ORBIT_PROVIDERS: 'claude-code', ...(process.env.ORBIT_BUDGET_TOKENS_REQUEST ? { ORBIT_BUDGET_TOKENS_REQUEST: process.env.ORBIT_BUDGET_TOKENS_REQUEST, ORBIT_BUDGET_TOKENS_ATTEMPT: process.env.ORBIT_BUDGET_TOKENS_ATTEMPT || '40000' } : {}) }, envFile: 'C:\\inesistente\\.env' });
  const a = creaApp({ settings, storage: new Storage(':memory:'), memoria: null, smartInbox: creaIntegrazioneSmartInbox({ ambito }), tts: {}, voce: {}, cifratura: {}, attendiFn: () => Promise.resolve() });
  a.permessi.impostaAbilitata('smartinbox', true);
  const spia = [], avvolgi = f => async req => {
    const prompt = req.messages && req.messages.at(-1) && req.messages.at(-1).content || '';
    const eVal = /<dati_note>/.test(prompt), t0 = Date.now(), out = await f(req);
    spia.push({ valutazione: eVal, model: req.model, promptChars: prompt.length, rispostaChars: String(out.text || '').length, ms: Date.now() - t0, usage: out.usage || null, ...(eVal ? { risposta: String(out.text || ''), dati: JSON.parse(prompt.match(/<dati_note>\n([\s\S]*?)\n<\/dati_note>/)[1].replace(/\\u003c/g, '<')) } : {}) });
    return out;
  };
  const orig = a.provider.complete ? a.provider.complete.bind(a.provider) : null, origExec = a.provider.executeTask.bind(a.provider);
  if (orig) a.provider.complete = avvolgi(orig); a.provider.executeTask = avvolgi(origExec);
  // Fino a 4 richieste identiche finche non si scrive qualcosa: un catalogo grande puo richiedere piu giri per il budget di token (lo stato dei confronti si conserva).
  const giri = []; let r = null;
  for (let g = 1; g <= 4; g++) {
    const c0 = spia.length, t1 = Date.now(), tok0 = a.tracker.totaliRichiesta ? 0 : 0; void tok0;
    r = await a.orchestrator.elabora({ messaggio: 'Organizza to sort' });
    giri.push({ giro: g, ms: Date.now() - t1, chiamate: spia.length - c0, chiamateValutazione: spia.slice(c0).filter(c => c.valutazione).length, fileCreatiOra: fs.readdirSync(path.join(vault, 'smart inbox')).length });
    if (fs.readdirSync(path.join(vault, 'smart inbox')).length) break;
  }
  const ms = giri.reduce((n, g) => n + g.ms, 0);
  const val = spia.filter(c => c.valutazione), audit = a.audit.elenca(2000), rel = { equivalente: 0, distinta: 0, incerta: 0 };
  let valide = 0, illeggibili = 0;
  for (const c of val) {
    let righe = null; const t = c.risposta.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
    for (const x of [t, t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)]) { try { const v = JSON.parse(x); if (Array.isArray(v)) { righe = v; break; } } catch { /* prossimo */ } }
    if (!righe) { illeggibili++; continue; }
    for (const q of righe) for (const v of (q.valutazioni || [])) { valide++; if (rel[v.relazione] !== undefined) rel[v.relazione]++; }
  }
  const esito = {
    catalogoNote: N, richiestaOk: r.ok === true, tempoTotaleMs: ms, giri,
    chiamateTotali: spia.length, chiamateValutazione: val.length,
    confrontiInviati: val.reduce((n, c) => n + c.dati.sorgenti.reduce((m, q) => m + c.dati.candidati.length - (q.salta ? q.salta.length : 0), 0), 0), confrontiValutati: valide, relazioni: rel, rispostePerLotto: val.map(c => ({ model: c.model, promptChars: c.promptChars, rispostaChars: c.rispostaChars, ms: c.ms, usage: c.usage })),
    risposteIllegibili: illeggibili, valutaPianoEseguito: audit.some(e => e.azione === 'valuta_piano' && e.esito === 'completata'),
    fileCreati: fs.readdirSync(path.join(vault, 'smart inbox')).sort(), testoFinale: String(r.testo || '').slice(0, 500)
  };
  console.log(JSON.stringify(esito, null, 2));
  a.storage.chiudi();
})().catch(e => { console.log('ERRORE', e.stack || e.message); process.exitCode = 1; }).finally(() => { for (const p of creati) try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ACL del bridge: stage sintetico lasciato nel temp */ } });
