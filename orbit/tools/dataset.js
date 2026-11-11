'use strict';
// Dataset dei benchmark della memoria. Due dataset, sempre distinti in modo esplicito:
//   privato   domande e risposte attese ORIGINALI, scritte sul vault personale dell'utente. Sta in privato/benchmark/dataset.json
//             (escluso da Git) e si confronta con le misurazioni storiche. Il vault e quello reale (copiato in una cartella
//             temporanea: l'originale non viene mai scritto) oppure ORBIT_VAULT_ORIGINALE.
//   pubblico  domande e risposte su un vault INVENTATO (esempi/benchmark/vault): gira su qualunque PC, senza dati personali.
// Se il dataset privato non c'e, non si ripiega mai in silenzio su quello pubblico: si ferma con un messaggio chiaro.
const fs = require('fs');
const path = require('path');
const { trovaVault, RADICE_REPO } = require('../../memoria/profilo');

const NOMI = ['privato', 'pubblico'];
const arg = (n, argv = process.argv) => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : null; };

function fileDataset(nome) {
  if (nome === 'privato') return process.env.ORBIT_BENCH_PRIVATO || path.join(RADICE_REPO, 'privato', 'benchmark', 'dataset.json');
  return path.join(RADICE_REPO, 'esempi', 'benchmark', 'dataset.json');
}

// Il dataset predefinito e il privato (come prima della preparazione del repository): chi non lo ha deve scegliere "pubblico" a mano.
function nomeScelto(argv = process.argv) { return arg('--dataset', argv) || 'privato'; }

function carica(nome) {
  if (!NOMI.includes(nome)) throw new Error('Dataset "' + nome + '" sconosciuto: usa --dataset privato oppure --dataset pubblico.');
  const file = fileDataset(nome);
  let testo;
  try { testo = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new Error(nome === 'privato'
      ? 'Dataset PRIVATO non disponibile (' + file + '). Non lo sostituisco con quello pubblico: per la demo su dati inventati usa --dataset pubblico.'
      : 'Dataset pubblico non trovato (' + file + '): il repository e incompleto?');
  }
  const d = JSON.parse(testo);
  if (!Array.isArray(d.query) || !Array.isArray(d.domande)) throw new Error('Dataset ' + nome + ' non valido (' + file + '): servono "query" e "domande".');
  const vaultOrigine = nome === 'privato'
    ? path.resolve(process.env.ORBIT_VAULT_ORIGINALE || trovaVault().percorso)
    : path.resolve(path.dirname(file), d.vault || 'vault');
  if (!fs.existsSync(vaultOrigine)) throw new Error('Vault del dataset ' + nome + ' non trovato: ' + vaultOrigine + (nome === 'privato' ? '. Imposta ORBIT_VAULT_ORIGINALE.' : '.'));
  return {
    nome, file, vaultOrigine,
    notaProva: d.notaProva || 'cervello/persona/interessi.md',
    cacheQuery: d.cacheQuery || d.query[0][1],
    query: d.query,
    domande: d.domande.map(x => Object.assign({}, x, { fatti: (x.fatti || []).map(f => new RegExp(f.source, f.flags)) }))
  };
}

module.exports = { carica, nomeScelto, fileDataset, NOMI };
