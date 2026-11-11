'use strict';
// Regressione del bug reale "tutte le note in ASSENZA_NON_DIMOSTRATA": catalogo con note di dimensioni REALI (1-4 KB), 4 sorgenti piccole, orchestratore + bridge reali.
// Il modello e un finto ONESTO: giudica 'distinta' una coppia solo se ha ricevuto il testo COMPLETO di sorgente e candidato (come farebbe un modello vero),
// altrimenti 'incerta'. Cosi il test non dipende da una risposta precompilata: fallisce se il contratto dei testi tra i componenti e violato.
// Uso (Windows): $env:SMART_INBOX_PWSH='<pwsh.exe 7.6.7>'; $env:SMART_INBOX_SCRIPT_MANIFEST_SHA256=(node smart-inbox/integrita.js --pin); node smart-inbox/tests/e2e-valutazione.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { scriviMarker } = require('../perimetro');
const { creaIntegrazioneSmartInbox } = require('../../orbit/integrations/smartinbox');
const { creaApp } = require('../../orbit/app');
const { Storage } = require('../../orbit/storage/db');
const { MockProvider, settingsProva } = require('../../orbit/tests/helpers');
if (!process.env.SMART_INBOX_PWSH) throw new Error('SMART_INBOX_PWSH richiesto');
const base = fs.realpathSync(os.tmpdir()), h = n => crypto.randomBytes(n).toString('hex'), esiti = [], creati = [];
const verifica = (nome, ok, extra) => { esiti.push((ok ? 'OK   ' : 'FAIL ') + nome); if (!ok) console.log('FAIL', nome, JSON.stringify(extra, null, 1).slice(0, 2500)); };

// Catalogo reale-simile (13 note nelle cartelle autorizzate, 0.1-6.8 KB, mediana ~1.8 KB, come il vault vero): testo sintetico, nessun contenuto personale.
const DIMENSIONI = { 'cervello/INDEX': 1278, 'cervello/da-completare': 3735, 'cervello/persona/chi-sono': 1354, 'cervello/persona/interessi': 1834, 'cervello/persona/stile-di-lavoro': 2502,
  'cervello/vita/orbit': 3183, 'cervello/vita/progetti': 1433, 'cervello/vita/routine-settimanale': 1986, 'cervello/vita/setup-tecnico': 1430, 'cervello/vita/universita': 2160,
  'cervello/vita/voce-orbit-elevenlabs': 6806, 'Notion/Migration': 110, 'progetti/Piano sintetico': 1500 };
const corpo = (titolo, n) => { let t = '# ' + titolo + '\n\n'; for (let i = 0; t.length < n; i++) t += '- Voce sintetica numero ' + i + ' della nota ' + titolo + ' con testo di riempimento senza significato.\n'; return t.slice(0, n - 1) + '\n'; };
const SORGENTI = { 'Film da vedere': '# Film da vedere\n- Dune\n- Alien\n', 'Informazioni Ipad': '# Informazioni Ipad\nModello sintetico, 64 GB.\n', 'Opening scacchi': '# Opening scacchi\n- Italiana\n- Siciliana\n', 'Serie TV da vedere': '# Serie TV da vedere\n- Dark\n- Severance\n' };

function nuovo() {
  const vault = path.join(base, 'vault-' + h(4)), stage = path.join(base, 'orbit-smart-inbox-real-' + h(16));
  creati.push(vault, stage);
  for (const d of ['home', 'tmp', 'technical/v']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  for (const d of ['to sort', 'smart inbox', 'cervello/persona', 'cervello/vita', 'Notion', 'progetti/Orbit']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  for (const [n, t] of Object.entries(SORGENTI)) fs.writeFileSync(path.join(vault, 'to sort', n + '.md'), t);
  const catalogo = {};
  for (const [n, dim] of Object.entries(DIMENSIONI)) { const titolo = n.replace(/^.*\//, ''); catalogo[titolo] = corpo(titolo, dim); fs.writeFileSync(path.join(vault, n + '.md'), catalogo[titolo]); }
  fs.writeFileSync(path.join(vault, 'progetti/Orbit/Riservata.md'), '# Riservata\nArea riservata di Orbit.\n');
  scriviMarker(stage, vault);
  return { vault, stage, ctx: { stage, vault, technical: 'technical/v' }, catalogo };
}
const inbox = A => fs.readdirSync(path.join(A.vault, 'smart inbox')).sort();

// Esegue UNA richiesta «Organizza to sort» con catalogo reale-simile. extra: note aggiuntive del catalogo; formato(json): come il modello incarta la risposta.
async function prova({ extra = {}, formato = j => j, modelloRotto = false } = {}) {
  const A = nuovo();
  for (const [n, dim] of Object.entries(extra)) { const titolo = n.replace(/^.*\//, ''); A.catalogo[titolo] = corpo(titolo, dim); fs.mkdirSync(path.dirname(path.join(A.vault, n + '.md')), { recursive: true }); fs.writeFileSync(path.join(A.vault, n + '.md'), A.catalogo[titolo]); }
  const ambito = { context: A.ctx, autorizzati: ['cervello', 'Notion', 'progetti', 'smart inbox'], creaIn: ['smart inbox'], creaDefault: 'smart inbox', autoApplica: true, autoOperazioni: ['create'], autoCartelle: ['smart inbox'] };
  const stat = { valutazioni: 0, coppie: 0, complete: 0, incomplete: 0, risposte: [], prompt: '', problemiFormato: 0 };
  const provider = new MockProvider({ produttore: ({ messages }) => {
    const prompt = messages.at(-1).content;
    if (prompt.includes('<dati_note>')) {
      stat.valutazioni++;
      if (modelloRotto) return 'Non riesco a produrre il JSON richiesto.';
      let dati; try { dati = JSON.parse(prompt.match(/<dati_note>\n([\s\S]*?)\n<\/dati_note>/)[1]); } catch { stat.problemiFormato++; return 'non so'; }
      return formato(JSON.stringify(dati.sorgenti.map(q => ({ i: q.i, valutazioni: dati.candidati.filter(c => !(q.salta || []).includes(c.j)).map(c => {
        const intero = c.testo !== undefined && c.testo === A.catalogo[c.titolo] && !c.tagliato, sorgenteOk = Object.values(SORGENTI).includes(q.sorgente);
        stat.coppie++; if (intero && sorgenteOk) stat.complete++; else stat.incomplete++;
        return { j: c.j, relazione: intero && sorgenteOk ? 'distinta' : 'incerta' };
      }) }))));
    }
    stat.prompt = prompt; const m = prompt.match(/"riepilogo":\s*"((?:[^"\\]|\\.)*)"/g);
    const testo = m ? JSON.parse('{' + m.at(-1) + '}').riepilogo : 'Nessun riepilogo.'; stat.risposte.push(testo); return testo;
  } });
  const storage = new Storage(':memory:');
  const settings = settingsProva({ settings: { dataDir: fs.mkdtempSync(path.join(base, 'orbit-val-dati-')) }, limiti: { maxRetryApi: 0 } }); creati.push(settings.dataDir);
  const a = creaApp({ settings, provider, storage, memoria: { leggiNota() { throw new Error('x'); }, contestoPerDomanda() { throw new Error('x'); } },
    smartInbox: creaIntegrazioneSmartInbox({ ambito }), tts: {}, voce: {}, cifratura: {}, attendiFn: () => Promise.resolve() });
  a.permessi.impostaAbilitata('smartinbox', true);
  const r = await a.orchestrator.elabora({ messaggio: 'Organizza to sort' });
  const audit = a.audit.elenca(200); a.storage.chiudi();
  return { A, stat, r, audit };
}

async function scenari() {
  // 1. Catalogo reale-simile, modello onesto: i testi arrivano completi e le 2 note indipendenti vengono create.
  let { A, stat, r, audit } = await prova();
  verifica('richiesta completata', r.ok === true, r);
  verifica('la valutazione semantica e stata eseguita (una chiamata al modello)', stat.valutazioni === 1, stat);
  verifica('CONTRATTO DEI TESTI: il modello riceve il testo COMPLETO di ogni coppia sorgente/candidato', stat.coppie > 0 && stat.incomplete === 0, { coppie: stat.coppie, complete: stat.complete, incomplete: stat.incomplete });
  verifica('valuta_piano e stato eseguito dall\'orchestratore', audit.some(e => e.azione === 'valuta_piano' && e.esito === 'completata'), audit.map(e => e.azione));
  verifica('FILE EFFETTIVAMENTE CREATI: le 2 note indipendenti (Film e Serie TV restano in sospeso perche equivalenti tra loro)', JSON.stringify(inbox(A)) === JSON.stringify(['Informazioni Ipad.md', 'Opening scacchi.md']), inbox(A));
  verifica('niente ASSENZA_NON_DIMOSTRATA nel riepilogo', !/ASSENZA_NON_DIMOSTRATA/.test(stat.risposte.at(-1) || ''), stat.risposte);

  // 2. Risposta del modello incartata in testo e blocco di codice: viene comunque letta.
  ({ A, stat, r } = await prova({ formato: j => 'Ecco le valutazioni richieste:\n```json\n' + j + '\n```\nSpero siano utili.' }));
  verifica('risposta con testo e blocco di codice attorno al JSON: valutazioni lette, 2 note create', JSON.stringify(inbox(A)) === JSON.stringify(['Informazioni Ipad.md', 'Opening scacchi.md']), { inbox: inbox(A), risposte: stat.risposte });

  // 3. Risposta del modello non valida: nessuna scrittura e il MOTIVO REALE arriva al modello finale (non resta muto).
  ({ A, stat, r, audit } = await prova({ modelloRotto: true }));
  verifica('modello che non produce JSON: nessuna nota scritta', inbox(A).length === 0, inbox(A));
  verifica('modello che non produce JSON: il motivo tecnico e comunicato al modello finale', /valutazione semantica automatica NON e stata completata[^<]*non e un array JSON valido/.test(stat.prompt), stat.prompt.slice(0, 600));
  verifica('modello che non produce JSON: valuta_piano non eseguito', !audit.some(e => e.azione === 'valuta_piano'), audit.map(e => e.azione));

  // 4. Nota del catalogo piu lunga del tetto di lettura: il confronto resta incerto per il VERO motivo (testo troppo lungo) e nulla viene scritto.
  ({ A, stat, r } = await prova({ extra: { 'cervello/vita/z-lunga': 30000 } }));
  verifica('nota del catalogo oltre il tetto: nessuna scrittura (distinta non vale su un testo tagliato)', inbox(A).length === 0, inbox(A));
  verifica('nota oltre il tetto: il modello finale riceve il limite tecnico reale (percorso e tetto)', /limite tecnico dei testi[^<]*z-lunga\.md piu lunga di 24000/.test(stat.prompt), stat.prompt.slice(0, 500));

}
scenari().catch(e => verifica('esecuzione', false, e.stack || e.code || e.message)).finally(() => {
  for (const p of creati) fs.rmSync(p, { recursive: true, force: true });
  console.log(esiti.join('\n')); process.exitCode = esiti.some(l => l.startsWith('FAIL')) ? 1 : 0;
});
