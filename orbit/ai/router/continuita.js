'use strict';
const { turniStoria } = require('../context');
const norm = t => String(t).normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase().trim();
const CAMBIO = /^(?:cambiamo argomento|cambio di argomento|nuovo argomento|ora parliamo di|passiamo a)\b/;
const MATERIALE = /^(?:traduci(?: (?:questo|il seguente) (?:testo|paragrafo))?(?: in [\p{L}]+)?|(?:correggi|riscrivi|riformula|parafrasa|riassumi|sintetizza)(?: (?:questo|il seguente) (?:testo|paragrafo))?)\s*:\s*\S/iu;
const RIFERIMENTO = /^(?:(?:ora|adesso|poi)\s+)?(?:riassumilo|riassumila|sintetizzalo|riscrivilo|correggilo|traducilo|riformulalo|semplificalo|semplificala|approfondiscilo|approfondiscila|spiegamelo|spiegamela|fallo|falla|falli|falle|failo|faila|continua|lo stesso|come sopra)\b|^(?:questo|questa|quello|quella)(?=\s*(?:[?.!]|$|di prima\b))|^fai\s*[?.!]*$|^(?:e\s+)?(?:quale conviene|qual e la differenza|qual e la fonte|anche l'altro|anche l'altra|fammi un esempio)\s*[?.!]*$|^(?:e\s+)?(?:quello|quella) di prima\b|^e\s+(?:il|la|lo|i|gli|le|l'|per|del|della)\s*[\p{L}\p{N}']+\s*[?.!]*$|^(?:(?:ora|adesso|poi)\s+)?(?:riassumi|sintetizza|traduci|correggi|riscrivi|riformula|semplifica|approfondisci)\s+(?:questo|questa|la risposta|il testo precedente)\b/u;
const STOP = new Set('a al agli alla alle allo ai di del dei degli della delle dello in il la lo le gli un una e o che quello quella prima precedente tema argomento'.split(' '));
const ANAFORA_OPERATIVA = /^(?:(?:ora|adesso|poi|e se)\s+)?(?:(?:posso|devo|dovrei|(?:e|sarebbe) (?:sicuro|sicura|prudente|possibile|consigliabile))\s+)?(?:(?:aumentar|ridur|prender|assumer|sospender|smetter|comprar|vender)(?:lo|la|li|le|ne)\b|(?:ne|lo|la|li|le)\s+(?:prend\w*|assum\w*|compr\w*|vend\w*)\b)/;
const chiavi = t => (norm(t).match(/[\p{L}]{3,}/gu) || []).filter(x => !STOP.has(x)).map(x => x.slice(0, 6));

function risolviRiferimento(testo, storia) {
  const msg = norm(testo);
  if (CAMBIO.test(msg)) return { stato: 'cambio_argomento', candidati: [] };
  if (MATERIALE.test(msg)) return { stato: 'autonoma', candidati: [] };
  const tema = msg.match(/^(?:tornando|riguardo) (?:a|al|ai|agli|alla|alle|allo|all')\s*([^,;:?!]+)[,;:]?/);
  const precedenteEsplicito = /^(?:(?:ora|adesso|poi)\s+)?(?:riassumi|sintetizza|traduci|correggi|riscrivi|riformula|semplifica|approfondisci|spiega)[^:]*\b(?:precedente|di prima|come sopra)\b/.test(msg)
    || /^(?:quali note|quali fonti|che fonti)[^?]*\b(?:consultato|usato|rispondermi)\b/.test(msg);
  const anafora = ANAFORA_OPERATIVA.test(msg);
  if (!tema && !precedenteEsplicito && !anafora && !RIFERIMENTO.test(msg)) return { stato: 'autonoma', candidati: [] };
  if (!Array.isArray(storia)) return { stato: storia > 0 ? 'non_valutato' : 'assente', candidati: [] };
  const turni = turniStoria(storia).filter(t => storia[t.indice + 1].verifica !== 'CHIARIMENTO');
  if (!turni.length) return { stato: 'assente', candidati: [] };
  if (!tema && turni.at(-1).indice + 2 !== storia.length) return { stato: 'assente', candidati: [] };
  let candidati;
  if (tema) {
    const parole = chiavi(tema[1]);
    candidati = turni.filter(t => parole.length && parole.every(p => chiavi(t.domanda).includes(p)));
  } else if (/\bdi prima\b/.test(msg)) candidati = turni;
  else candidati = turni.slice(-1);
  if (!candidati.length) return { stato: 'assente', candidati: [] };
  const indici = candidati.map(t => t.indice);
  // Un pronome singolare non sceglie da solo tra elementi elencati o confrontati.
  const plurali = /\b(confront\w*|due|tre|entrambi|opzioni|alternative|elenca|lista)\b|(?:^|\n)\s*(?:[-*]|\d+[.)])\s|\b(?:un|una|il|la)\b[^.!?\n]{1,60}\s+e\s+(?:un|una|il|la)\b/m;
  const singolare = anafora || /\b(quello|quella|questo|questa|l'altro|l'altra)\b/.test(msg);
  const confronto = /^(?:e\s+)?(?:quale conviene|qual e la differenza)\s*[?.!]*$/.test(msg);
  const ambiguo = candidati.length > 1 || singolare && candidati.some(t => plurali.test(norm(t.domanda + '\n' + t.risposta))
    || anafora && /\b(?:oppure|o)\b/.test(norm(t.domanda + '\n' + t.risposta)))
    || confronto && !candidati.some(t => plurali.test(norm(t.domanda + '\n' + t.risposta)));
  return { stato: ambiguo ? 'ambiguo' : 'chiaro', candidati: indici, indice: ambiguo ? null : indici[0], operativa: anafora && !ambiguo };
}

module.exports = { risolviRiferimento };
