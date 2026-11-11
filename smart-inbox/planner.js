'use strict';
const { bloccante, cartellaDaCreare, PARSING_LIMITATO, VERSIONE, chiave, relativo, protetto, sotto, destinazione, sha, impronta, congela, errore } = require('./policy');

const titolo = s => chiave(s).replace(/\bguardare\b/g, 'vedere').replace(/\s+/g, ' ').trim();
const ref = n => ({ percorso: n.percorso, sha256: n.sha256 });
const unitKey = u => JSON.stringify([u.section, u.content.replace(/\r\n/g, '\n')]);
const stato = t => /\b(?:gi[aà] vist[oi]|visti|completati|terminati)\b/i.test(t) ? 'completato'
  : /\bda (?:vedere|guardare|fare|leggere)\b/i.test(t) ? 'da-fare' : '';
const nomi = n => [n.titolo, n.nomeFile, ...n.alias];
const stati = n => [...new Set(nomi(n).map(stato).filter(Boolean))];
const identita = (a, b) => titolo(a.titolo) === titolo(b.titolo);
const indizio = (a, b) => nomi(a).some(x => nomi(b).some(y => titolo(x) === titolo(y)));
const compatibili = (a, b) => stati(a).length <= 1 && stati(b).length <= 1 && (stati(a)[0] || '') === (stati(b)[0] || '')
  && /\bnon\b/i.test(a.titolo) === /\bnon\b/i.test(b.titolo);

function riferimenti(n) {
  const extra = ['target', 'destination', 'destinazione'].flatMap(k => typeof n.frontmatter[k] === 'string' ? [n.frontmatter[k]] : []);
  const diretti = [...n.testo.matchAll(/(?:scadenze|progetti[\\/]Orbit)[\\/][^\s\]<>"')]+/gi)].map(m => m[0]);
  const markdown = [...n.testo.matchAll(/!?\[[^\]]*\]\(([^)\r\n]+)\)/g)].map(m => m[1].trim()).filter(p => !/^(?:https?:|mailto:|#)/i.test(p));
  return [...n.link.map(l => l.destinazione), ...extra, ...diretti, ...markdown];
}
function candidati(source, catalogo) {
  const words = new Set(titolo(source.titolo).match(/[\p{L}\p{N}]{3,}/gu) || []);
  const links = riferimenti(source).map(chiave);
  return catalogo.map(n => {
    const exact = identita(source, n), hint = indizio(source, n);
    const direct = links.some(l => l === chiave(n.percorso) || l === chiave(n.percorso.replace(/\.md$/i, '')) || l === chiave(n.nomeFile));
    const overlap = (titolo(n.titolo).match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => words.has(w)).length;
    return { nota: n, identitaSupportata: exact, indizioIdentita: exact || hint || direct, peso: exact ? 100 : direct ? 90 : hint ? 80 : overlap };
  }).sort((a, b) => b.peso - a.peso || a.nota.percorso.localeCompare(b.nota.percorso));
}
function confrontaCreazione(source, file, precedenti) {
  let identica = null, primo = null;
  const legati = [];   // tutte le creazioni precedenti con cui questa nota e potenzialmente equivalente: restano tutte in sospeso insieme ad essa
  for (const p of precedenti) {
    const stessoTesto = source.testo === p.sorgente.testo;
    const unitaComuni = source.unita.some(u => p.sorgente.unita.some(v => unitKey(u) === unitKey(v)));
    if (stessoTesto || unitaComuni || chiave(file) === chiave(p.destinazione.percorso) || candidati(source, [p.sorgente])[0].peso > 0) {
      if (stessoTesto && chiave(file.slice(0, file.lastIndexOf('/'))) === chiave(p.destinazione.percorso.slice(0, p.destinazione.percorso.lastIndexOf('/')))
        && identita(source, p.sorgente) && compatibili(source, p.sorgente)) identica = p;
      else { primo ||= p; legati.push(p.id); }
    }
  }
  if (primo) return { esito: 'CONFIRM', precedente: primo, legati: identica ? [...legati, identica.id] : legati };
  return identica ? { esito: 'NOOP', precedente: identica } : null;
}
function conflitto(a, b) {
  if (a.kind === 'code' || b.kind === 'code' || JSON.stringify(a.section) !== JSON.stringify(b.section)) return false;
  const checkbox = u => u.content.match(/^\s*[-*+] \[([ xX-])\]\s+(.+)$/);
  const x = checkbox(a), y = checkbox(b);
  if (x && y && x[2] === y[2] && x[1].toLowerCase() !== y[1].toLowerCase()) return true;
  const clean = s => s.replace(/^\s*[-*+]\s+/, '').trim();
  const aa = clean(a.content), bb = clean(b.content);
  return /^(?:non|not|mai)\s+/i.test(aa) !== /^(?:non|not|mai)\s+/i.test(bb)
    && aa.replace(/^(?:non|not|mai)\s+/i, '').toLowerCase() === bb.replace(/^(?:non|not|mai)\s+/i, '').toLowerCase();
}
// Cartelle da creare nello stesso piano: le sole directory (assenti) delle create_note, ordinate e senza duplicati.
const dirDaCreare = (operazioni, snapshot) => [...new Set(operazioni.filter(o => o.tipo === 'create_note').map(o => o.destinazione.percorso.slice(0, o.destinazione.percorso.lastIndexOf('/')))
  .filter(d => cartellaDaCreare(d, snapshot)))].sort();
function verificaSnapshot(s) {
  const { impronta: hash, ...body } = s;
  if (s.schema !== VERSIONE || impronta(body) !== hash) throw errore('SNAPSHOT_ALTERATO');
  const keys = new Set();
  for (const n of [...s.sorgenti, ...s.catalogo]) {
    if (relativo(n.percorso) !== n.percorso || protetto(n.percorso) || sha(Buffer.from(n.testo, 'utf8')) !== n.sha256
      || keys.has(chiave(n.percorso))) throw errore('SNAPSHOT_NON_VALIDO');
    keys.add(chiave(n.percorso));
  }
}

// Lotti di confronto: tutto il catalogo, in ordine stabile, in gruppi di al piu `maxCandidati` note e LOTTO_CARATTERI caratteri di testo (una nota piu grande sta da sola).
// Ogni sorgente viene confrontata con OGNI lotto: l'assenza si dimostra solo con la copertura completa; un lotto mancante o incerto lascia CONFIRM.
const LOTTO_CARATTERI = 30000, MAX_LOTTI = 12;
function dividiInLotti(catalogo, maxNote) {
  const lotti = []; let corrente = [], caratteri = 0;
  for (const n of [...catalogo].sort((a, b) => (a.percorso < b.percorso ? -1 : a.percorso > b.percorso ? 1 : 0))) {
    if (corrente.length && (corrente.length >= maxNote || caratteri + n.testo.length > LOTTO_CARATTERI)) { lotti.push(corrente); corrente = []; caratteri = 0; }
    corrente.push(n); caratteri += n.testo.length;
  }
  if (corrente.length) lotti.push(corrente);
  return lotti;
}

async function pianifica(snapshot, { valuta = null, creaIn = {}, maxCandidati = 8, maxChiamate = 4, maxCaratteri = 24000, timeoutMs = 2500 } = {}) {
  verificaSnapshot(snapshot);
  if ([maxCandidati, maxChiamate, maxCaratteri, timeoutMs].some(v => !Number.isSafeInteger(v) || v < 1)
    || maxCandidati > 40 || maxChiamate > 1000 || maxCaratteri > 100000 || timeoutMs > 30000) throw errore('LIMITI_SEMANTICI_NON_VALIDI');
  const decisioni = [], operazioni = [], riservati = new Map(), nuovi = [], riservatiDa = new Map();
  const limitate = new Set(snapshot.copertura.problemi.filter(p => PARSING_LIMITATO.includes(p.code)).map(p => p.percorso));
  // Una cartella di creazione assente non rende incompleto il catalogo (non contiene note): e un problema della sola destinazione.
  const assenti = new Set(snapshot.creaIn.filter(c => !snapshot.cartelle.some(d => d.percorso === c)));
  const bloccanti = snapshot.copertura.problemi.filter(p => bloccante(p, snapshot.creaIn));
  // Aree riservate non confrontate (non bloccanti): restano nella decisione, cosi l'utente vede cosa l'assenza NON copre.
  const esclusi = snapshot.copertura.problemi.filter(p => p.code === 'DESTINAZIONE_PROTETTA' && !bloccante(p, snapshot.creaIn)).map(p => p.percorso).slice(0, 50);
  let chiamate = 0;
  const lotti = dividiInLotti(snapshot.catalogo, maxCandidati), percorsiCatalogo = snapshot.catalogo.map(n => n.percorso);
  for (const source of snapshot.sorgenti) {
    const ranked = candidati(source, snapshot.catalogo);
    const d = { id: 'input-' + impronta(ref(source)).slice(0, 16), sorgente: ref(source), esito: 'CONFIRM',
      candidati: ranked.filter(c => c.peso > 0).map(c => ref(c.nota)), valutati: [], motivi: [], conferme: [], ...(esclusi.length ? { esclusiPerPolicy: esclusi } : {}) };
    const decide = (esito, motivo) => { d.esito = esito; d.motivi.push(motivo); };
    const forbidden = riferimenti(source).some(p => protetto(p));
    if (forbidden) decide('BLOCK', 'RIFERIMENTO_PROTETTO_O_NON_SICURO');
    else if (bloccanti.length) { decide('CONFIRM', 'CATALOGO_INCOMPLETO'); d.problemiCatalogo = bloccanti.slice(0, 50); d.problemiCatalogoTotale = bloccanti.length; }
    else if (limitate.has(source.percorso)) decide('CONFIRM', 'SORGENTE_PARSING_LIMITATO');
    else {
      const plausible = ranked.filter(c => c.indizioIdentita && compatibili(source, c.nota));
      let target = null, assenza = snapshot.catalogo.length === 0;
      if (plausible.length > 1) decide('CONFIRM', 'PIU_DESTINAZIONI_PLAUSIBILI');
      else if (plausible.some(c => limitate.has(c.nota.percorso))) decide('CONFIRM', 'NOTA_CATALOGO_PARSING_LIMITATO');
      else if (plausible.length === 1 && plausible[0].identitaSupportata && source.unita.every(u => plausible[0].nota.unita.some(v => unitKey(u) === unitKey(v)))) {
        decide('NOOP', 'CONTENUTO_ESATTO_GIA_PRESENTE'); d.destinazione = ref(plausible[0].nota);
      } else if (!assenza && valuta && lotti.length > MAX_LOTTI) {
        decide('CONFIRM', 'CATALOGO_OLTRE_I_LIMITI_DI_CONFRONTO');
      } else if (!assenza && valuta && chiamate + lotti.length <= maxChiamate) {
        // Tutti i lotti o nessuno: una copertura parziale non dimostra nulla. I lotti si valutano in ordine; la prima anomalia chiude il confronto con CONFIRM.
        const checked = new Set(), equivalent = [], righe = [];
        for (const [k, lotto] of lotti.entries()) {
          const offerti = lotto.map(n => ranked.find(c => c.nota.percorso === n.percorso));
          const input = { sorgente: source, candidati: lotto, lotto: k, lotti: lotti.length, catalogoPercorsi: percorsiCatalogo,
            copertura: { catalogo: snapshot.catalogo.length, offerti: lotto.length, esaustiva: true }, signal: null };
          if (source.testo.length + lotto.reduce((n, x) => n + x.testo.length, 0) > maxCaratteri) { decide('CONFIRM', 'LIMITE_CONTESTO_SEMANTICO'); break; }
          chiamate++;
          const controller = new AbortController(); input.signal = controller.signal;
          let timer;
          try {
            const raw = await Promise.race([Promise.resolve().then(() => valuta(congela(input))), new Promise((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(errore('TIMEOUT_SEMANTICO')); }, timeoutMs);
            })]);
            if (JSON.stringify(raw).length > 32768 || !raw || !Array.isArray(raw.valutazioni)
              || Object.keys(raw).some(k => !['valutazioni', 'limiti'].includes(k))) throw errore('RISPOSTA_SEMANTICA_NON_VALIDA');
            const delLotto = new Set();
            for (const row of raw.valutazioni) {
              if (typeof row.percorso !== 'string' || protetto(row.percorso)) throw errore('PROPOSTA_PROTETTA');
              const candidate = offerti.find(c => c && c.nota.percorso === row.percorso && c.nota.sha256 === row.sha256);
              if (!candidate || checked.has(row.percorso) || !['equivalente', 'distinta', 'incerta'].includes(row.relazione)
                || Object.keys(row).some(k => !['percorso', 'sha256', 'relazione', 'motivo', 'confidence'].includes(k))) throw errore('PROPOSTA_FUORI_CONTRATTO');
              checked.add(row.percorso); delLotto.add(row.percorso); righe.push(row);
              d.valutati.push({ ...ref(candidate.nota), relazione: row.relazione });
              if (row.relazione === 'equivalente') equivalent.push(candidate);
            }
            if (delLotto.size !== lotto.length) { decide('CONFIRM', 'VALUTAZIONE_PARZIALE'); break; }
          } catch (e) { decide(['PROPOSTA_PROTETTA', 'PROPOSTA_FUORI_CONTRATTO'].includes(e.code) ? 'BLOCK' : 'CONFIRM', e.code || 'VALUTAZIONE_FALLITA'); break; }
          finally { clearTimeout(timer); }
        }
        if (!d.motivi.length) {
          if (checked.size !== snapshot.catalogo.length) decide('CONFIRM', 'VALUTAZIONE_PARZIALE');
          else if (equivalent.length === 1 && equivalent[0].identitaSupportata && compatibili(source, equivalent[0].nota)
            && righe.every(r => r.relazione !== 'incerta')) target = equivalent[0].nota;
          else if (equivalent.length) decide('CONFIRM', 'EQUIVALENZA_NON_SUPPORTATA_O_AMBIGUA');
          else assenza = righe.every(r => r.relazione === 'distinta') && plausible.length === 0;
        }
      } else if (!assenza) decide('CONFIRM', valuta ? 'BUDGET_SEMANTICO_ESAURITO' : 'SEMANTICA_NON_DISPONIBILE');
      if (target && limitate.has(target.percorso)) { target = null; decide('CONFIRM', 'NOTA_CATALOGO_PARSING_LIMITATO'); }
      if (target && d.esito !== 'BLOCK') {
        if (!destinazione(target.percorso, snapshot)) decide('BLOCK', 'DESTINAZIONE_NON_AUTORIZZATA');
        else {
          d.destinazione = ref(target);
          const previous = riservati.get(target.percorso) || [], existing = [...target.unita, ...previous];
          if (riservatiDa.has(target.percorso)) d.legatoA = [...riservatiDa.get(target.percorso)];   // dipende da aggiunte gia pianificate sulla stessa nota
          const seen = new Set(existing.map(unitKey)), additions = [];
          for (const u of source.unita) if (!seen.has(unitKey(u))) { seen.add(unitKey(u)); additions.push(u); }
          if (additions.some((u, i) => [...existing, ...additions.slice(0, i)].some(v => conflitto(u, v)))) decide('CONFIRM', 'DIFFERENZA_DI_STATO_O_NEGAZIONE');
          else if (!additions.length) decide('NOOP', 'CONTENUTO_ESATTO_PRESENTE_O_GIA_PIANIFICATO');
          else {
            decide('MERGE', 'IDENTITA_SUPPORTATA_E_VALUTAZIONE_CONCORDE'); d.destinazione = ref(target);
            operazioni.push({ inputId: d.id, tipo: 'append_units', sorgente: ref(source), destinazione: ref(target),
              aggiunte: additions.map(u => ({ ...u, section: [...u.section] })) });
            riservati.set(target.percorso, [...previous, ...additions]); riservatiDa.set(target.percorso, [...(riservatiDa.get(target.percorso) || []), d.id]);
          }
        }
      } else if (assenza && !['BLOCK', 'NOOP'].includes(d.esito) && !d.motivi.length) {
        const dir = creaIn[source.percorso];
        if (typeof dir !== 'string') decide('CONFIRM', 'DESTINAZIONE_CREAZIONE_NON_CERTA');
        else {
          let file;
          try { file = relativo(dir + '/' + source.percorso.split('/').at(-1)); } catch { decide('BLOCK', 'PERCORSO_CREAZIONE_NON_SICURO'); }
          if (file && assenti.has(file.slice(0, file.lastIndexOf('/'))) && !cartellaDaCreare(file.slice(0, file.lastIndexOf('/')), snapshot)) decide('CONFIRM', 'CARTELLA_DESTINAZIONE_ASSENTE');   // genitore assente: nessuna creazione a catena
          else if (file && !destinazione(file, snapshot, true)) decide('BLOCK', 'DESTINAZIONE_CREAZIONE_NON_AUTORIZZATA');
          else if (file) {
            const planned = confrontaCreazione(source, file, nuovi);
            if ([...snapshot.catalogo, ...snapshot.cartelle].some(n => chiave(n.percorso) === chiave(file))) decide('CONFIRM', 'NOME_GIA_PRESENTE');
            else if (planned) {
              decide(planned.esito, planned.esito === 'NOOP' ? 'NOTA_IDENTICA_GIA_PIANIFICATA' : 'NUOVA_NOTA_POTENZIALMENTE_EQUIVALENTE');
              d.legatoA = planned.legati || [planned.precedente.id];   // vedi writer.seleziona: una nota potenzialmente equivalente a una creazione pianificata non e indipendente da essa
              if (planned.esito === 'NOOP') d.destinazione = planned.precedente.destinazione;
            }
            else {
              decide('CREATE', 'ASSENZA_VERIFICATA_NELL_AMBITO_E_DIRECTORY_ESISTENTE'); d.destinazione = { percorso: file, sha256: null };
              operazioni.push({ inputId: d.id, tipo: 'create_note', sorgente: ref(source), destinazione: d.destinazione, content: source.testo });
              nuovi.push({ sorgente: source, destinazione: d.destinazione, id: d.id });
            }
          }
        }
      }
      if (d.esito === 'CONFIRM' && !d.motivi.length) d.motivi.push('ASSENZA_NON_DIMOSTRATA');
    }
    if (['MERGE', 'CREATE', 'CONFIRM'].includes(d.esito)) d.conferme = ['consenso-utente', 'permessi-da-verificare-al-momento-dell-eventuale-esecuzione'];
    decisioni.push(d);
  }
  const body = { schema: VERSIONE, rootId: snapshot.rootId, snapshot: snapshot.impronta, cartelleDaCreare: dirDaCreare(operazioni, snapshot), sorgenti: snapshot.sorgenti.map(ref),
    catalogo: snapshot.catalogo.map(ref), cartelle: snapshot.cartelle, copertura: snapshot.copertura,
    semantica: { chiamate, maxChiamate, maxCandidati, maxCaratteri, timeoutMs, lotti: lotti.length, qualitaRealeNonVerificata: true }, decisioni, operazioni };
  const hash = impronta(body);
  return congela({ ...body, id: 'piano-' + hash.slice(0, 24), impronta: hash });
}

function verificaPiano(piano, snapshot) {
  const motivi = [];
  try {
    verificaSnapshot(snapshot);
    const { id, impronta: hash, ...body } = piano;
    if (hash !== impronta(body) || id !== 'piano-' + hash.slice(0, 24)) throw errore('PIANO_ALTERATO');
    if (piano.schema !== VERSIONE || piano.rootId !== snapshot.rootId || piano.snapshot !== snapshot.impronta) throw errore('PIANO_SCADUTO');
    const pending = new Map(), created = [];
    if (JSON.stringify(piano.cartelleDaCreare) !== JSON.stringify(dirDaCreare(piano.operazioni, snapshot))) throw errore('CARTELLE_DA_CREARE_NON_VALIDE');
    for (const op of piano.operazioni) {
      const source = snapshot.sorgenti.find(n => n.percorso === op.sorgente.percorso && n.sha256 === op.sorgente.sha256);
      const d = piano.decisioni.find(x => x.id === op.inputId && x.sorgente.percorso === source?.percorso);
      if (source && snapshot.copertura.problemi.some(p => PARSING_LIMITATO.includes(p.code) && p.percorso === source.percorso)) throw errore('SORGENTE_PARSING_LIMITATO');
      if (!source || !d || !['MERGE', 'CREATE'].includes(d.esito) || !d.conferme.includes('consenso-utente')
        || !destinazione(op.destinazione.percorso, snapshot, op.tipo === 'create_note')) throw errore('OPERAZIONE_NON_AUTORIZZATA');
      if (d.destinazione?.percorso !== op.destinazione.percorso || d.destinazione?.sha256 !== op.destinazione.sha256) throw errore('DESTINAZIONE_ALTERATA');
      if (op.tipo === 'create_note') {
        if (d.esito !== 'CREATE' || op.content !== source.testo || op.destinazione.sha256 !== null
          || op.destinazione.percorso.split('/').at(-1) !== source.percorso.split('/').at(-1)
          || confrontaCreazione(source, op.destinazione.percorso, created)
          || [...snapshot.catalogo, ...snapshot.cartelle].some(n => chiave(n.percorso) === chiave(op.destinazione.percorso))) throw errore('CREAZIONE_NON_VALIDA');
        created.push({ sorgente: source, destinazione: op.destinazione });
      } else if (op.tipo === 'append_units') {
        const target = snapshot.catalogo.find(n => n.percorso === op.destinazione.percorso && n.sha256 === op.destinazione.sha256);
        if (d.esito !== 'MERGE' || !target || snapshot.copertura.problemi.some(p => PARSING_LIMITATO.includes(p.code) && p.percorso === target.percorso) || !compatibili(source, target) || !candidati(source, [target])[0].identitaSupportata) throw errore('MERGE_NON_VALIDO');
        const existing = [...target.unita, ...(pending.get(target.percorso) || [])];
        for (const u of op.aggiunte) {
          if (!source.unita.some(x => impronta(x) === impronta(u)) || source.testo.slice(u.start, u.end) !== u.content) throw errore('CONTENUTO_NON_ORIGINALE');
          if (existing.some(v => unitKey(v) === unitKey(u) || conflitto(u, v))) throw errore('DUPLICAZIONE_O_CONFLITTO');
          existing.push(u);
        }
        pending.set(target.percorso, existing.slice(target.unita.length));
      } else throw errore('OPERAZIONE_SCONOSCIUTA');
    }
    for (const d of piano.decisioni.filter(d => d.esito === 'NOOP')) {
      const source = snapshot.sorgenti.find(n => n.percorso === d.sorgente.percorso && n.sha256 === d.sorgente.sha256);
      if (!source || !d.destinazione) throw errore('NOOP_NON_VALIDO');
      if (d.destinazione.sha256 === null) {
        const target = created.find(p => p.destinazione.percorso === d.destinazione.percorso);
        if (!target || confrontaCreazione(source, d.destinazione.percorso, [target])?.esito !== 'NOOP') throw errore('NOOP_NON_VALIDO');
      } else {
        const target = snapshot.catalogo.find(n => n.percorso === d.destinazione.percorso && n.sha256 === d.destinazione.sha256);
        if (!target || !identita(source, target) || !compatibili(source, target)
          || !source.unita.every(u => [...target.unita, ...(pending.get(target.percorso) || [])].some(v => unitKey(u) === unitKey(v)))) throw errore('NOOP_NON_VALIDO');
      }
    }
    return { valido: true, motivi };
  } catch (e) { return { valido: false, motivi: [e.code || 'PIANO_NON_VALIDO'] }; }
}

module.exports = { candidati, pianifica, verificaPiano };
