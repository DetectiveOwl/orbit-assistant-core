'use strict';
// Scenario combinato reparse + autonomia con bridge REALE (pwsh) su vault TEMPORANEO di tipo reale: solo dati sintetici, nessuna finestra deve comparire.
// Uso (Windows): $env:SMART_INBOX_PWSH='<pwsh.exe 7.6.7 pinnato>'; $env:SMART_INBOX_SCRIPT_MANIFEST_SHA256=(node smart-inbox/integrita.js --pin); node smart-inbox/tests/e2e-combinato.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { scriviMarker } = require('../perimetro');
const { creaIntegrazioneSmartInbox } = require('../../orbit/integrations/smartinbox');
if (!process.env.SMART_INBOX_PWSH) throw new Error('SMART_INBOX_PWSH richiesto');
const base = fs.realpathSync(os.tmpdir()), h = n => crypto.randomBytes(n).toString('hex'), esiti = [], creati = [];
const verifica = (nome, ok, extra) => { esiti.push((ok ? 'OK   ' : 'FAIL ') + nome); if (!ok) console.log(nome, JSON.stringify(extra && extra.decisioni ? { applicato: extra.applicato, esito: extra.esito, inSospeso: extra.inSospeso, decisioni: extra.decisioni.map(d => [d.sorgente.percorso, d.esito, d.motivi]) } : extra).slice(0, 1500)); };

// Cinque note con nomi non ASCII (trattino lungo, apostrofo tipografico, accenti) come nel caso reale; tre stanno in Polimi/Databases/Notes.
const NOTION = ['Introduzione agli algoritmi – Schema.md', 'Introduzione al C – Schema.md', 'Polimi/Databases/Notes/Rappresentazione dell’informazione.md',
  'Polimi/Databases/Notes/Strutture di controllo.md', 'Polimi/Databases/Notes/Tipi di dato e array à.md'];
const TO_SORT = { 'Film da vedere': '# Film da vedere\n- Dune\n- Alien\n', 'Informazioni Ipad': '# Informazioni Ipad\nModello sintetico, 64 GB.\n',
  'Opening scacchi': '# Opening scacchi\n- Italiana\n- Siciliana\n', 'Serie TV da vedere': '# Serie TV da vedere\n- Dark\n- Severance\n' };

function nuovo({ sorgenti = TO_SORT, extra = {} } = {}) {
  const vault = path.join(base, 'vault-' + h(4)), stage = path.join(base, 'orbit-smart-inbox-real-' + h(16));
  creati.push(vault, stage);
  for (const d of ['home', 'tmp', 'technical/v']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  for (const d of ['to sort', 'cervello', 'smart inbox', 'Notion/Polimi/Databases/Notes', 'progetti/Orbit']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  for (const [n, t] of Object.entries(sorgenti)) fs.writeFileSync(path.join(vault, 'to sort', n + '.md'), t);
  for (const n of NOTION) fs.writeFileSync(path.join(vault, 'Notion', n), '# ' + path.basename(n, '.md') + '\nAppunti sintetici.\n');
  fs.writeFileSync(path.join(vault, 'progetti', 'Orbit', 'Nota riservata.md'), '# Riservata\nContenuto sintetico di area riservata.\n');
  for (const [p, t] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(vault, p)), { recursive: true }); fs.writeFileSync(path.join(vault, p), t); }
  scriviMarker(stage, vault);
  return { vault, stage, ctx: { stage, vault, technical: 'technical/v' } };
}
const ambitoDi = (A, patch = {}) => ({ context: A.ctx, autorizzati: ['cervello', 'smart inbox', 'Notion', 'progetti'], creaIn: ['smart inbox'], creaDefault: 'smart inbox', autoApplica: true, ...patch });
const scritti = A => fs.readdirSync(path.join(A.vault, 'smart inbox'));
const snapshotVault = A => { const o = {}; const w = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) w(p); else o[path.relative(A.vault, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } }; w(A.vault); return o; };
// Come l'orchestratore: prepara, poi valutazione del modello (qui deterministica: stesso titolo = equivalente, altrimenti distinta), poi il codice applica se tutto e autorizzato.
const titolo = p => path.basename(p, '.md').toLowerCase();
const comando = async (A, patch, ctxId = 'e2e', relazione = (s, c) => (titolo(s) === titolo(c) ? 'equivalente' : 'distinta')) => {
  const si = creaIntegrazioneSmartInbox({ ambito: ambitoDi(A, patch) }), ctx = { conversazione: ctxId };
  const p = await si.strumenti.prepara.esegui({}, ctx);
  if (p.esito || !p.richiesteSemantiche.some(q => q.candidati.length)) return p;
  const valutazioni = JSON.stringify(p.richiesteSemantiche.map(q => ({ sorgente: { percorso: q.sorgente.percorso, sha256: q.sorgente.sha256 },
    valutazioni: q.candidati.map(n => ({ percorso: n.percorso, sha256: n.sha256, relazione: relazione(q.sorgente.percorso, n.percorso) })) })));
  return si.strumenti.valuta_piano.esegui({ piano: p.piano, valutazioni }, ctx);
};

async function scenari() {
  // 1. Il caso reale: quattro note in to sort, cinque Notion non ASCII, progetti/Orbit riservata.
  let A = nuovo(); const prima = snapshotVault(A);
  const r1 = await comando(A);
  const motivi = r1.decisioni.flatMap(d => d.motivi);
  verifica('nessun CATALOGO_INCOMPLETO con nomi non ASCII e progetti/Orbit', !motivi.includes('CATALOGO_INCOMPLETO') && r1.decisioni.length === 4, r1.decisioni);
  const escl = d => (d.esclusiPerPolicy || r1.esclusiPerPolicy || []).some(p => /^progetti\/Orbit$/i.test(p));   // nel risultato compatto l'elenco e al livello superiore
  verifica('progetti/Orbit dichiarato come escluso per policy (visibile al modello)', r1.decisioni.every(escl), { esclusiPerPolicy: r1.esclusiPerPolicy, d: r1.decisioni.map(d => d.esclusiPerPolicy) });
  console.log('INFO caso sintetico dei 4 file:', JSON.stringify(r1.decisioni.map(d => [d.sorgente.percorso.replace('to sort/', ''), d.esito, d.motivi])), 'applicato=' + r1.applicato);
  // Applicazione parziale: Film da vedere e Serie TV da vedere sono potenzialmente equivalenti e restano entrambe in sospeso; le altre due si scrivono davvero.
  const su = scritti(A).sort();
  verifica('parziale: scritte sul filesystem solo le 2 note indipendenti (Film e Serie TV restano in sospeso)', r1.applicato === true && r1.parziale === true && JSON.stringify(su) === JSON.stringify(['Informazioni Ipad.md', 'Opening scacchi.md'])
    && r1.inSospeso?.length === 2 && su.every(n => fs.readFileSync(path.join(A.vault, 'smart inbox', n), 'utf8') === TO_SORT[n.replace('.md', '')]), { applicato: r1.applicato, scritte: r1.scritte, inSospeso: r1.inSospeso, su });
  const dopo1 = snapshotVault(A);
  verifica('parziale: nessun altro file del vault modificato', Object.keys(prima).every(k => dopo1[k] === prima[k]) && Object.keys(dopo1).filter(k => !(k in prima)).length === 2, Object.keys(dopo1).filter(k => !(k in prima)));

  // 2. Note sicure e distinte: tutto CREATE, applicato dal solo comando, byte identici, sorgenti e Notion intatte.
  const sicure = { 'Informazioni Ipad': TO_SORT['Informazioni Ipad'], 'Opening scacchi': TO_SORT['Opening scacchi'], 'Ricetta carbonara': '# Ricetta carbonara\n- guanciale\n- uova\n' };
  A = nuovo({ sorgenti: sicure }); const p2 = snapshotVault(A);
  const r2 = await comando(A);
  const ok2 = r2.applicato === true && r2.esito.state === 'APPLIED' && r2.decisioni.every(d => d.esito === 'CREATE')
    && Object.entries(sicure).every(([n, t]) => fs.readFileSync(path.join(A.vault, 'smart inbox', n + '.md'), 'utf8') === t);
  const dopo = snapshotVault(A), cambiati = Object.keys(dopo).filter(k => !k.startsWith('smart inbox') && dopo[k] !== p2[k]);
  verifica('3 note sicure: CREATE applicate in automatico con i byte della sorgente', ok2, r2);
  verifica('sorgenti, Notion (nomi non ASCII) e progetti/Orbit non modificate', cambiati.length === 0 && Object.keys(p2).every(k => k in dopo), cambiati);
  verifica('stesso comando ripetuto: nessuna duplicazione (NOOP, nessuna nuova scrittura)', await comando(A, {}, 'e2e-bis').then(r => r.decisioni.every(d => d.esito === 'NOOP') && r.applicato === false && scritti(A).length === 3, () => false));

  // 3. Duplicato certo dentro Notion: NOOP, nessuna scrittura.
  A = nuovo({ sorgenti: { 'Opening scacchi': TO_SORT['Opening scacchi'] }, extra: { 'Notion/Opening scacchi.md': TO_SORT['Opening scacchi'] } });
  const r3 = await comando(A);
  verifica('duplicato identico gia presente: NOOP, nessuna copia', r3.decisioni[0].esito === 'NOOP' && scritti(A).length === 0 && r3.applicato === false, r3.decisioni);

  // 4. Catalogo davvero incompleto: cartella protetta per nome tecnico dentro una radice autorizzata.
  A = nuovo({ sorgenti: sicure, extra: { 'Notion/public/Nota.md': '# Nota\nTesto.\n' } });
  const r4 = await comando(A);
  verifica('cartella tecnica protetta (public): CATALOGO_INCOMPLETO, tutto CONFIRM, nessuna scrittura', r4.decisioni.every(d => d.esito === 'CONFIRM' && d.motivi.includes('CATALOGO_INCOMPLETO')) && scritti(A).length === 0 && r4.applicato === false, r4.decisioni);

  // 5. Revoca e operazioni non autorizzate.
  A = nuovo({ sorgenti: sicure });
  const r5 = await comando(A, { autoApplica: false });
  verifica('revoca: solo proposta, nessuna scrittura', r5.decisioni.every(d => d.esito === 'CREATE') && r5.esito === undefined && scritti(A).length === 0, r5);
  A = nuovo({ sorgenti: sicure }); fs.mkdirSync(path.join(A.vault, 'cervello'), { recursive: true });
  const r6 = await comando(A, { autoOperazioni: ['append'] });
  verifica('CREATE non autorizzata (solo append): proposta, nessuna scrittura', r6.decisioni.every(d => d.esito === 'CREATE') && r6.esito === undefined && scritti(A).length === 0, r6);
  A = nuovo({ sorgenti: sicure });
  const r7 = await comando(A, { creaIn: ['smart inbox', 'smart inbox/nuova'], creaDefault: 'smart inbox/nuova' });
  verifica('create_dir non autorizzato (default): proposta, cartella non creata', r7.decisioni.every(d => d.esito === 'CREATE') && r7.esito === undefined && !fs.existsSync(path.join(A.vault, 'smart inbox', 'nuova')), r7);
}
scenari().catch(e => verifica('esecuzione', false, e.code || e.message)).finally(() => {
  for (const p of creati) fs.rmSync(p, { recursive: true, force: true });
  console.log(esiti.join('\n')); process.exitCode = esiti.some(l => l.startsWith('FAIL')) ? 1 : 0;
});
