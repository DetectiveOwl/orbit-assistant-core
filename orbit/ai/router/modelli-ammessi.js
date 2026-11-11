'use strict';
const TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);

function tierAmmessi(piano, disponibili = TIERS, esclusi = new Set()) {
  return TIERS.filter(t => disponibili.includes(t) && !esclusi.has(t) && (piano?.rischio !== 'high' || t === 'sonnet' || t === 'opus'));
}

function tierPiuVicino(desiderato, disponibili, piano, esclusi) {
  const ammessi = tierAmmessi(piano, disponibili, esclusi);
  if (ammessi.includes(desiderato)) return desiderato;
  const i = TIERS.indexOf(desiderato);
  return TIERS.slice(i + 1).find(t => ammessi.includes(t)) || TIERS.slice(0, i).reverse().find(t => ammessi.includes(t)) || null;
}

function famigliaModello(model, provider) {
  if (typeof model !== 'string') return null;
  const nome = model.toLowerCase();
  const m = nome.match(/^(haiku|sonnet|opus)$/) ||
    nome.match(/^claude-(?:\d+(?:-\d+)?-)?(haiku|sonnet|opus)(?:-\d+)*(?:-latest)?$/) ||
    (provider?.id === 'mock' && nome.match(/^mock-(haiku|sonnet|opus)-\d+$/));
  if (m) return m[1];
  const verifica = provider?.verificaModelli?.find(v => v.id === model && v.verificato === true && v.disponibile === true);
  return verifica && verifica.modelloEffettivo !== model ? famigliaModello(verifica.modelloEffettivo) : null;
}

function modelloAmmesso(piano, tier, model, provider) {
  return !!model && tierAmmessi(piano).includes(tier) && (piano?.rischio !== 'high' || ['sonnet', 'opus'].includes(famigliaModello(model, provider)));
}

function escludiModello(run, model, tier, registry) {
  (run.identificatoriIndisponibili ||= new Set()).add(model);
  (run.modelliIndisponibili ||= new Set()).add(tier);
  for (const t of TIERS) if (registry?.modello(t) === model) run.modelliIndisponibili.add(t);
}

module.exports = { TIERS, tierAmmessi, tierPiuVicino, modelloAmmesso, famigliaModello, escludiModello };
