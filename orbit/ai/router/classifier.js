'use strict';
// RequestClassifier: classificazione deterministica, senza chiamate AI. Usa segnali sul contenuto della
// richiesta (tipo di compito, struttura, vincoli, rischio), non la lunghezza: un testo lungo da riformattare
// resta semplice, una domanda breve come "dimostra che..." resta difficile.
const { estraiEspressione, calcoloRapido } = require('../quality/aritmetica');
const { paroleCorsoRe } = require('../../../memoria/profilo');
const { risolviRiferimento } = require('./continuita');

const RE = {
  chitchat: /^(?:(?:(?:ciao|ehi|hey|salve|buongiorno|buonasera|buonanotte)(?:\s+orbit)?|grazie|ok|okay|perfetto|va bene|a dopo|come (?:stai|va)(?:\s+oggi)?|tutto (?:bene|a posto)|come te la passi|chi sei)(?:[\s,.!?;:]+|$))+$/i,
  memory: /\b(appunt\w*|vault|obsidian|dispens\w*|parzial\w*|scadenz\w*|piano di studio|miei progetti|mio progetto|ho scritto|le mie note|mie note|nelle note|nei miei)\b/i,
  // Tre intenti diversi che prima stavano in un'unica regex (causa dell'errore "quando e il parziale" = "piano della giornata"):
  //  - pianoGiorno: cosa fare / studiare in un giorno -> servono il piano di studio, lo stato e l'ultimo piano salvato;
  //  - statoStudio: a che punto sono, quanto manca -> stato di avanzamento (parziali) piu la ricerca normale;
  //  - dataEvento: quando e/ho un esame, parziale, scadenza -> ricerca mirata della data, senza allegare il piano intero.
  pianoGiorno: /\b(cosa (devo|dovrei|posso|faccio|studio|studiare|c'e da) (fare|studiare)?\s*(oggi|domani|stasera|questa settimana)|cosa (devo|dovrei) fare|(piano|programma|priorit\w+|agenda) (di|per|del|della) (oggi|domani|giornata|settimana)|da dove (parto|comincio|inizio))\b/i,
  statoStudio: /\b(a che punto sono|quanto (mi )?manca|sono (avanti|indietro)|cosa mi manca da)\b/i,
  dataEvento: /\b(quando|che giorno|in che data|a che ora|che data)\b[^?.!]{0,40}\b(esam\w*|parzial\w*|scadenz\w*|consegn\w*|prova|test|appello|itiner\w*)\b/i,
  // "e il test?", "e la data?": seguito di una conversazione; senza conversazione l'oggetto non si puo ricavare.
  seguito: /^\s*e\s+(il|la|lo|i|gli|le|l'|per|del|della|quell\w*)\s*[\p{L}\p{N}']+\s*\??\s*$/iu,
  // Parole di corso in piu (sigle dei propri corsi) si aggiungono con ORBIT_PAROLE_CORSO, vedi memoria/profilo.js.
  corso: new RegExp('\\b(' + ['analisi\\s*1', 'algebra', 'geometria', 'corso', 'esame', 'parziale', ...paroleCorsoRe()].join('|') + ')\\b', 'i'),
  summary: /\b(riassum\w*|sintetizz\w*|riepilog\w*|in breve)\b/i,
  transform: /\b(traduc\w*|riscriv\w*|correggi\w*|formatta\w*|converti\w*|trasforma\w*|rendi\w* (piu|più)|riformula\w*|parafras\w*|semplifica\w*)\b/i,
  extraction: /\b(estrai\w*|estrarre|elenca\w* (tutt\w+|le|i|gli)|trova\w* (tutt\w+|le date|i nomi))\b/i,
  planning: /\b(pianific\w*|organizza\w*|programma\w* (la|le|il)|roadmap|strategia|priorit\w+|piano (di|per|della|del)|cosa (devo )?studiare)\b/i,
  analysis: /\b(analizz\w*|confronta\w*|valuta\w*|pro e contro|vantaggi|differenz\w*|perch[eé]|spiega\w*|approfondisci\w*|ragion\w*|come mai)\b/i,
  math: /\b(calcola\w*|risolv\w*|integra\w*|deriva\w*|dimostra\w*|determina\w*|rango|sviluppa\w*|equazione|equazioni|studia\w* (la|il) (funzione|serie))\b/i,
  matTema: /\b(integral\w*|derivat\w*|limit\w*|matric\w*|matrice|autovalor\w*|autovettor\w*|determinant\w*|sistema lineare|rouch[eè]|teorema|serie|successione|polinomi\w*|vettor\w*|spazio vettoriale|autospazi\w*|base)\b/i,
  code: /```|\b(codice|funzione|bug|script|python|javascript|typescript|sql|compila\w*|algoritmo|stack trace|eccezione|regex)\b/i,
  passoPasso: /\b(passo passo|dettagliat\w*|approfondit\w*|rigoros\w*|a fondo|nel dettaglio)\b/i,
  dimostrazione: /\b(dimostra\w*|dimostrazione|teorema|lemma)\b/i,
  vincoli: /\b(senza|almeno|al massimo|entro|solo se|tranne|esattamente|non pi[uù] di|in modo che)\b/gi,
  trade: /\b(trade-?off|e se|oppure|meglio|alternativ\w*|conviene)\b/i,
  rischioAlto: /\b(medic\w*|farmac\w*|dosagg\w*|legal\w*|contratt\w*|invest\w*|trade republic|azioni|criptovalut\w*|fiscal\w*|tasse|bonifico|pagament\w*)\b/i,
  tierEsplicito: /\b(usa|usando|con|chiedi a|passa a)\s+(?:il modello\s+)?(opus|sonnet|haiku)\b/i,
  deittico: /^\s*(fallo|fai(lo)?|continua|vai|quello|quella|questo|questa|lo stesso|come sopra|e quello|e poi)\b/i,
  senzaMateriale: /\b(questo|questa|il seguente|la seguente|qui sotto|il testo|l'articolo|il paragrafo)\b/i,
  json: /\bjson\b/i
};

const BASE = { chitchat: 0, extraction: 1, transform: 1, summary: 1, qa: 1, memory: 1, planning: 3, analysis: 3, math: 2, code: 3 };

const parole = t => (t.match(/[\p{L}\p{N}']+/gu) || []).length;
const domandeIn = t => (t.match(/\?/g) || []).length;

// Restituisce soltanto identificatori diagnostici, mai il testo della richiesta.
function rilevaRischio(testo, contesto = '', operativaRisolta = false) {
  const msg = String(testo || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase();
  const dominio = (msg + '\n' + String(contesto)).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (RE.rischioAlto.test(msg)) return { rischio: 'high', regola: 'high-preesistente' };
  // Una citazione interamente delimitata da trasformare e materiale, non un consiglio operativo.
  if (/^(?:traduci(?: in [\p{L}]+)?|correggi|riscrivi|riformula|riassumi)\s*:\s*(?:"[^"\n]+"|«[^»\n]+»|“[^”\n]+”)\s*[.!]?\s*$/u.test(msg)) {
    return { rischio: 'low', regola: null };
  }
  // shortcut: lessico mirato italiano; ampliare soltanto con casi operativi riprodotti e relativi negativi.
  const salute = /\b(ibuprofene|paracetamolo|tachipirina|aspirina|melatonina|pillol[ae]|compress[ae]|sonnifer[oi])\b(?!\.[a-z0-9])/.test(dominio);
  const richiesta = operativaRisolta || domandeIn(msg) > 0 || /\b(quant[oaie]|che|qual[ei]|come|posso|possiamo|devo|dovrei|si puo|conviene|e se|consigli\w*|(?:e|sarebbe) (?:sicuro|sicura|prudente|possibile|consigliabile))\b/.test(msg);
  const assunzione = /\b(prend\w*|assum\w*|us(?:are|o)|scegli(?:ere)?|scelgo|consigli\w*|aument\w*|rid(?:uc|ur)\w*|smett\w*|sospend\w*|combin\w*|mescol\w*)\b/.test(msg);
  const quantita = /\bquant[oaie]\b[^?.!;\n]{0,60}\b(mg|milligrammi|al giorno|al di|ogni|ore)\b/.test(msg);
  if (salute && richiesta && (assunzione || quantita)) return { rischio: 'high', regola: 'salute-assunzione-scelta' };
  const capitale = /\b(risparmi|capitale|portafoglio|soldi|denaro|stipendio|pensione)\b/.test(dominio);
  const asset = /\b(etf|btc|bitcoin|obbligazion[ei]|fond[oi] pensione|fond[oi] indicizzat[oi])\b/.test(dominio);
  const allocazione = /\b(distribuis\w*|distribu\w*|ripart\w*|alloc\w*|divid\w*|mettere|metto|destin\w*|compr\w*|acquist\w*|vend\w*|spost\w*|percentual\w*)\b/.test(msg);
  if (richiesta && asset && allocazione && (capitale || /\b(compr\w*|acquist\w*|vend\w*)\b/.test(msg))) {
    return { rischio: 'high', regola: 'finanza-allocazione-scelta' };
  }
  return { rischio: 'low', regola: null };
}

// In una conversazione personale la risposta puo dipendere dagli appunti anche se la domanda non li nomina: si cerca nel vault
// (gratis, ricerca locale) per tutto tranne saluti, codice, calcoli e testi incollati da trasformare.
function cercaDi(categoria, nParole, aritmetica) {
  if (aritmetica || ['chitchat', 'code', 'math'].includes(categoria)) return false;
  if (['transform', 'summary', 'extraction'].includes(categoria) && nParole > 25) return false;
  return true;
}

// messaggio: testo; storia: numero di messaggi precedenti nella conversazione; opzioni.haVault: la memoria e disponibile.
function classifica(messaggio, { storia = 0, haVault = true, rischiStoria = new Map() } = {}) {
  const msg = String(messaggio || '').trim();
  const segnali = [];
  const nParole = parole(msg);
  const numeroStoria = Array.isArray(storia) ? storia.length : storia;
  const riferimento = risolviRiferimento(msg, storia);
  const rischioLocale = rilevaRischio(msg);

  const tierM = msg.match(RE.tierEsplicito);
  const tierEsplicito = tierM ? tierM[2].toLowerCase() : null;
  if (tierEsplicito) segnali.push('modello richiesto: ' + tierEsplicito);

  const rapido = calcoloRapido(msg);
  const espressione = rapido?.espressione || estraiEspressione(msg);
  const fuoriEspressione = espressione ? msg.replace(/[\d(][\d\s.,()+\-*/^×÷:%x]*[\d)]/g, ' ') : msg;
  const aritmeticaPura = !!rapido || (!!espressione && parole(fuoriEspressione) <= 6 && !RE.math.test(msg) && !RE.matTema.test(msg) && !RE.code.test(msg) &&
    /^(?:quanto fa\s+)?[\d\s.,()+\-*/^×÷:%x]+\??$/i.test(msg));

  // Tipo di compito, in ordine di specificita.
  let categoria = 'qa';
  if (RE.chitchat.test(msg) && nParole <= 8 && !RE.memory.test(msg) && rischioLocale.rischio !== 'high') categoria = 'chitchat';
  else if (aritmeticaPura) categoria = 'math';
  else if (RE.transform.test(msg)) categoria = 'transform';
  else if (RE.summary.test(msg)) categoria = 'summary';
  else if (RE.extraction.test(msg)) categoria = 'extraction';
  else if (RE.code.test(msg)) categoria = 'code';
  else if (RE.math.test(msg) || espressione && RE.analysis.test(msg)) categoria = 'math';
  else if (RE.planning.test(msg) || RE.pianoGiorno.test(msg) || RE.statoStudio.test(msg)) categoria = 'planning';
  else if (RE.analysis.test(msg)) categoria = 'analysis';
  else if (RE.memory.test(msg)) categoria = 'memory';
  else if (RE.matTema.test(msg)) categoria = 'math';
  segnali.push('categoria: ' + categoria);

  const dataEvento = haVault && RE.dataEvento.test(msg);
  const pianoGiorno = haVault && !dataEvento && RE.pianoGiorno.test(msg);
  const statoStudio = haVault && !pianoGiorno && RE.statoStudio.test(msg);
  const richiamaVault = haVault && (pianoGiorno || statoStudio || dataEvento || RE.memory.test(msg) || (RE.corso.test(msg) && categoria !== 'chitchat'));
  // Domanda "ampia" (passo 3 della memoria): chiede una spiegazione, un quadro d'insieme o piu cose insieme, quindi puo servire
  // contesto da piu sezioni. Si guarda la struttura (categoria, piu domande, piu richieste coordinate), non una sola parola.
  const ampia = ['analysis', 'summary', 'planning'].includes(categoria) || domandeIn(msg) >= 2 ||
    /\b(cosa (devo|dovrei|c'?e da|bisogna|serve) sapere|dimmi tutto|tutto (su|quello)|panoramica|in generale|quadro (generale|completo)|cosa sai|cosa so)\b/i.test(msg) ||
    /\b(oltre a|inoltre|sia\b[^?]{1,60}\bsia|confronta|differenz\w*)\b/i.test(msg);
  // Conserva il fallback di contesto dei turni brevi, senza usarlo per risolvere riferimenti o propagare rischio.
  const serveStoria = ['chiaro', 'ambiguo', 'non_valutato'].includes(riferimento.stato)
    || numeroStoria > 0 && nParole <= 6 && categoria !== 'chitchat' && !aritmeticaPura && riferimento.stato !== 'cambio_argomento';

  // Complessita: punteggio da segnali di struttura, non dalla lunghezza.
  let punti = BASE[categoria];
  const domande = (msg.match(/\?/g) || []).length;
  if (domande >= 2) { punti += 1; segnali.push('piu domande'); }
  if (RE.passoPasso.test(msg)) { punti += 1; segnali.push('richiede dettaglio o passaggi'); }
  if (RE.dimostrazione.test(msg)) { punti += 2; segnali.push('dimostrazione'); }
  if ((msg.match(/^\s*(\d+[.)]|[-*])\s+/gm) || []).length >= 3) { punti += 1; segnali.push('piu sotto-richieste'); }
  if ((msg.match(RE.vincoli) || []).length >= 3) { punti += 1; segnali.push('molti vincoli'); }
  if (RE.trade.test(msg) && categoria !== 'chitchat') { punti += 1; segnali.push('valutazione di alternative'); }
  if (aritmeticaPura) { punti -= 1; segnali.push('aritmetica verificabile in locale'); }
  const complessita = punti <= 1 ? 'low' : punti <= 3 ? 'medium' : 'high';

  let rischio = 'low';
  if (rischioLocale.rischio === 'high') { rischio = 'high'; segnali.push('rischio: ' + rischioLocale.regola); }
  else if (['math', 'code', 'planning'].includes(categoria) || richiamaVault) rischio = 'medium';
  riferimento.necessari = [...riferimento.candidati];
  if (Array.isArray(storia)) for (const indice of riferimento.candidati) {
    let precedente = rischiStoria.get(indice);
    if (!precedente) {
      precedente = classifica(storia[indice].contenuto, { storia: storia.slice(0, indice), haVault, rischiStoria });
      rischiStoria.set(indice, precedente);
    }
    riferimento.necessari.push(...precedente.riferimento.necessari);
    const operativo = rilevaRischio(msg, storia[indice].contenuto + '\n' + storia[indice + 1].contenuto, riferimento.operativa === true);
    const r = operativo.rischio === 'high' || rilevaRischio(storia[indice + 1].contenuto).rischio === 'high' ? 'high' : precedente.rischio;
    if (r === 'high') segnali.push('rischio: antecedente-high');
    if (['low', 'medium', 'high'].indexOf(r) > ['low', 'medium', 'high'].indexOf(rischio)) rischio = r;
  }
  riferimento.necessari = [...new Set(riferimento.necessari)];
  if (riferimento.candidati.length) segnali.push('riferimento conversazionale: ' + riferimento.stato);

  // Ambiguita: solo quando manca davvero l'oggetto della richiesta e non c'e contesto da cui ricavarlo.
  let ambigua = false, motivoAmbiguita = null;
  if (numeroStoria === 0) {
    if ((RE.deittico.test(msg) && nParole <= 5) || RE.seguito.test(msg)) { ambigua = true; motivoAmbiguita = 'La richiesta si riferisce a qualcosa di cui non ho il contesto (per esempio quale test o quale data).'; }
    else if (['summary', 'transform', 'extraction'].includes(categoria) && nParole <= 8 && RE.senzaMateriale.test(msg) && !richiamaVault) {
      ambigua = true; motivoAmbiguita = 'Manca il testo su cui lavorare: incollalo nel messaggio o dimmi quale nota usare.';
    } else if (categoria === 'qa' && nParole <= 2 && !/\?/.test(msg) && !espressione) {
      ambigua = true; motivoAmbiguita = 'La richiesta e troppo generica per rispondere in modo utile.';
    }
  }
  if (['assente', 'ambiguo'].includes(riferimento.stato)) {
    ambigua = true;
    motivoAmbiguita = riferimento.stato === 'assente'
      ? 'Non ho un antecedente disponibile per questo riferimento. Indica il tema o incolla il testo da usare.'
      : 'Ci sono piu referenti possibili. Indica quale tema o elemento vuoi riprendere.';
  }

  return {
    categoria, complessita, punti, rischio, ambigua, motivoAmbiguita,
    richiamaVault, pianoGiorno, statoStudio, dataEvento, ampia, cercaNelVault: haVault && !richiamaVault && cercaDi(categoria, nParole, !!espressione), serveStoria, tierEsplicito,
    espressione: aritmeticaPura ? espressione : null,
    attesoJson: RE.json.test(msg) && /\b(formato|in|come|restituisci|rispondi)\b/i.test(msg),
    segnali, riferimento
  };
}

module.exports = { classifica, rilevaRischio };
