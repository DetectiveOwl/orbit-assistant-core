'use strict';
// Benchmark della memoria di Orbit, ripetibile. Lavora SEMPRE su una copia del vault in una cartella temporanea,
// con un indice separato: il vault vero non viene mai scritto. Stampa solo percorsi, conteggi e tempi, mai il contenuto delle note.
//
// Uso:  node orbit/tools/bench-memoria.js [--dataset privato|pubblico] [--codice <cartella con memoria/ e orbit/>] [--json <file>]
//   --dataset sceglie le domande e il vault: "privato" (predefinito) usa il dataset originale in privato/benchmark e il vault personale,
//   "pubblico" usa il vault inventato in esempi/benchmark. Il privato non e mai sostituito in silenzio dal pubblico (vedi dataset.js).
//   --codice permette di misurare una versione precedente del codice (baseline) con le stesse query e condizioni.
//
// Metriche: richiamo e precisione delle note inviate (rispetto alle note attese fissate qui sotto), token stimati del contesto
// (caratteri / 3,5, la stessa stima di Orbit), token stimati delle evidenze date al verificatore, file e byte letti, latenze,
// cache fredda/calda, invalidazione dopo modifica, rinomina ed eliminazione.
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const CODICE = path.resolve(arg('--codice') || path.join(__dirname, '..', '..'));
let DATASET;
try { DATASET = require('./dataset').carica(require('./dataset').nomeScelto()); } catch (e) { process.stderr.write('Errore: ' + e.message + '\n'); process.exit(2); }
const ORIG = DATASET.vaultOrigine;
process.stderr.write('Dataset: ' + DATASET.nome + ' (' + DATASET.file + ')\n');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-bench-'));
const COPIA = path.join(BASE, 'vault'), INDICE = path.join(BASE, 'indice');

// Copia del vault: tutte le note e gli allegati, escluse le cartelle tecniche col punto.
(function copia(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const v of fs.readdirSync(src, { withFileTypes: true })) {
    if (v.isDirectory()) { if (!v.name.startsWith('.') && v.name !== 'node_modules') copia(path.join(src, v.name), path.join(dst, v.name)); }
    else if (v.isFile()) fs.copyFileSync(path.join(src, v.name), path.join(dst, v.name));
  }
})(ORIG, COPIA);
fs.mkdirSync(path.join(COPIA, '.obsidian'), { recursive: true });
process.env.ORBIT_VAULT_PATH = COPIA; process.env.ORBIT_INDEX_DIR = INDICE;

// Conteggio delle letture di file del vault (solo dentro la copia).
const leggiOrig = fs.readFileSync; let letture = 0, byteLetti = 0;
const dentro = p => path.resolve(String(p)).toLowerCase().startsWith(COPIA.toLowerCase());
fs.readFileSync = function (p, ...r) { const out = leggiOrig.call(this, p, ...r); if (typeof p === 'string' && dentro(p)) { letture++; byteLetti += out.length || 0; } return out; };
const ora = () => Number(process.hrtime.bigint()) / 1e6;
const misura = fn => { letture = 0; byteLetti = 0; const t0 = ora(); const r = fn(); return { r, ms: ora() - t0, letture, byteLetti }; };
const attendi = ms => { const t = Date.now() + ms; while (Date.now() < t) { /* attesa attiva: l'indice non riscansiona prima di 1,5 s */ } };
const tok = s => Math.ceil(String(s || '').length / 3.5);

const memoria = require(path.join(CODICE, 'memoria', 'memoria'));
const { classifica } = require(path.join(CODICE, 'orbit', 'ai', 'router', 'classifier'));
const { costruisci } = require(path.join(CODICE, 'orbit', 'ai', 'context'));
let evidenze = null; try { evidenze = require(path.join(CODICE, 'orbit', 'ai', 'quality', 'gate')).selezionaEvidenze || null; } catch (e) { /* versione senza selezione */ }

// Query e note attese: lette dal dataset scelto (fissate PRIMA delle correzioni, stesse dell'audit). L'atteso e un giudizio umano sulle note che contengono la risposta.
const QUERY = DATASET.query;

const out = { dataset: DATASET.nome, codice: CODICE, vault: {}, indicizzazione: {}, invalidazione: {}, query: [], cache: {} };
const md = []; (function scan(d) { for (const v of fs.readdirSync(d, { withFileTypes: true })) { if (v.isDirectory()) { if (!v.name.startsWith('.')) scan(path.join(d, v.name)); } else if (/\.md$/.test(v.name)) md.push(path.join(d, v.name)); } })(COPIA);
out.vault = { note: md.length, byte: md.reduce((s, f) => s + fs.statSync(f).size, 0) };

// Indicizzazione e invalidazione
let m = misura(() => memoria.avvia()); out.indicizzazione.fredda_ms = +m.ms.toFixed(1);
attendi(1600); m = misura(() => memoria.controlla()); out.indicizzazione.incrementale_ms = +m.ms.toFixed(1); out.indicizzazione.incrementale_letture = m.letture;
const notaProva = path.join(COPIA, ...DATASET.notaProva.split('/')), salvata = leggiOrig.call(fs, notaProva, 'utf8');
const cerca = q => memoria.cerca(q).map(r => r.percorso);
cerca('parolatestbench');                                  // scalda l'eventuale cache su una query che poi deve cambiare
fs.appendFileSync(notaProva, '\n- parolatestbench\n'); attendi(1600);
m = misura(() => memoria.controlla()); out.indicizzazione.dopo_modifica_ms = +m.ms.toFixed(1);
out.invalidazione.modifica = cerca('parolatestbench').includes(DATASET.notaProva);
const rinominata = path.join(path.dirname(notaProva), 'bench-rinominata.md'); fs.renameSync(notaProva, rinominata); attendi(1600); memoria.controlla();
const dopo = cerca('parolatestbench'); out.invalidazione.rinomina = dopo.includes(DATASET.notaProva.replace(/[^/]+$/, 'bench-rinominata.md')) && !dopo.includes(DATASET.notaProva);
fs.unlinkSync(rinominata); attendi(1600); memoria.controlla();
out.invalidazione.eliminazione = cerca('parolatestbench').length === 0;
fs.writeFileSync(notaProva, salvata); attendi(1600); memoria.controlla();

// Query
for (const [tipo, q, atteso] of QUERY) {
  const cls = classifica(q, { storia: 0, haVault: true });
  const c = misura(() => costruisci({ messaggio: q, storia: [], classificazione: cls, memoria, maxInputToken: 12000 }));
  // Una richiesta ambigua non arriva al contesto: l'orchestratore chiede un chiarimento senza chiamare il modello.
  const fonti = cls.ambigua ? [] : c.r.fonti.map(f => f.percorso);
  const inviate = cls.ambigua ? [] : [...new Set((c.r.messaggi.at(-1).content.match(/<nota percorso="([^"]+)"/g) || []).map(x => x.slice(16, -1)))];
  const contenuto = c.r.messaggi.at(-1).content;
  const prof = (contenuto.match(/<profilo_utente>[\s\S]*?<\/profilo_utente>/) || [''])[0];
  const blocVault = (contenuto.match(/<contesto_vault>[\s\S]*?<\/contesto_vault>/) || [''])[0];
  // Evidenze al verificatore: candidato SIMULATO (inizio della prima nota attesa, o "non lo so"): stima, non una chiamata reale.
  const candidato = atteso.length ? leggiOrig.call(fs, path.join(COPIA, atteso[0]), 'utf8').replace(/^---[\s\S]*?---\s*/, '').slice(0, 500) : 'Nel vault non c\'e questa informazione.';
  const testoFonti = c.r.testoFonti || '';
  const perVerifica = evidenze ? evidenze(testoFonti, { candidato, richiesta: q }) : testoFonti.slice(0, 26000);
  const recuperate = inviate.filter(p => !/<profilo_utente>/.test('') && !prof.includes('percorso="' + p + '"'));
  const utili = fonti.filter(f => atteso.includes(f));
  out.query.push({
    tipo, query: q, ambigua: !!cls.ambigua, pianoGiorno: !!cls.pianoGiorno,
    fonti, noteInviate: recuperate.length, sezioniInviate: cls.ambigua ? 0 : (blocVault.match(/<sezione /g) || []).length,
    richiamo: atteso.length ? +(atteso.filter(a => fonti.includes(a)).length / atteso.length).toFixed(2) : null,
    precisione: fonti.length ? +(utili.length / fonti.length).toFixed(2) : (atteso.length ? 0 : 1),
    token: { profilo: tok(prof), note: tok(blocVault), messaggio: cls.ambigua ? 0 : tok(contenuto), verificatore: cls.ambigua ? 0 : tok(perVerifica) },
    ms: +c.ms.toFixed(1), letture: c.letture, byteLetti: c.byteLetti
  });
}

// Cache fredda e calda sulla stessa query
const qc = DATASET.cacheQuery;
const f1 = misura(() => memoria.cerca(qc)), f2 = misura(() => memoria.cerca(qc));
out.cache = { fredda_ms: +f1.ms.toFixed(2), calda_ms: +f2.ms.toFixed(2), letture_fredda: f1.letture, letture_calda: f2.letture };

// Riepilogo
const media = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const conAtteso = out.query.filter(x => x.richiamo !== null);
out.riepilogo = {
  dataset: DATASET.nome,
  richiamo: +media(conAtteso.map(x => x.richiamo)).toFixed(2),
  precisione: +media(out.query.map(x => x.precisione)).toFixed(2),
  token_messaggio_medi: Math.round(media(out.query.map(x => x.token.messaggio))),
  token_messaggio_max: Math.max(...out.query.map(x => x.token.messaggio)),
  token_note_medi: Math.round(media(out.query.map(x => x.token.note))),
  token_verificatore_medi: Math.round(media(out.query.map(x => x.token.verificatore))),
  note_inviate_medie: +media(out.query.map(x => x.noteInviate)).toFixed(2),
  sezioni_inviate_medie: +media(out.query.map(x => x.sezioniInviate)).toFixed(2),
  ms_medi: +media(out.query.map(x => x.ms)).toFixed(1),
  byte_letti_medi: Math.round(media(out.query.map(x => x.byteLetti))),
  senza_risposta_note_inviate: out.query.filter(x => x.tipo.startsWith('senza risposta') && !x.richiamo || x.tipo === 'ambigua').map(x => x.noteInviate)
};
fs.readFileSync = leggiOrig;
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* temporanea */ }
const json = JSON.stringify(out, null, 1);
if (arg('--json')) fs.writeFileSync(arg('--json'), json);
process.stdout.write(JSON.stringify(out.riepilogo, null, 1) + '\n');
