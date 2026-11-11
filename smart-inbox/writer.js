'use strict';
const { verificaPiano } = require('./planner');
const { descrivi } = require('./reader');
const { bloccante, canonico, impronta, sha, congela, relativo, protetto, destinazione, cartellaDaCreare, errore } = require('./policy');

// Applicazione parziale (solo se la richiede l'host): sottoinsieme di operazioni CREATE/MERGE che il CODICE dimostra indipendente dalle decisioni in sospeso.
// Escluse: CONFIRM e BLOCK; ogni decisione legata a una esclusa (legatoA, in entrambe le direzioni: due note potenzialmente equivalenti restano entrambe in sospeso);
// le operazioni che `ammetti` (regole di autorizzazione dell'host) non consente. Il piano resta quello originale e interamente verificato (stesso hash).
function seleziona(piano, ammetti) {
  const escluse = new Map(), segna = (d, tipo) => { if (!escluse.has(d.id)) escluse.set(d.id, { id: d.id, sorgente: d.sorgente.percorso, esito: d.esito, tipo, motivi: d.motivi || [] }); };
  for (const d of piano.decisioni) if (d.esito === 'CONFIRM' || d.esito === 'BLOCK') segna(d, d.esito === 'BLOCK' ? 'bloccata' : 'ambigua');
  for (const op of piano.operazioni) {
    const d = piano.decisioni.find(x => x.id === op.inputId);
    if (!escluse.has(d.id) && !ammetti(op, piano)) segna(d, 'non_autorizzata');
  }
  for (let cambiato = true; cambiato;) {   // chiusura sui legami: se una decisione e esclusa lo sono anche quelle legate ad essa, e viceversa
    cambiato = false;
    for (const d of piano.decisioni) {
      const legate = d.legatoA || [];
      if (!escluse.has(d.id) && legate.some(id => escluse.has(id))) { segna(d, 'dipendente'); cambiato = true; }
      if (escluse.has(d.id)) for (const id of legate) { const x = piano.decisioni.find(y => y.id === id); if (x && !escluse.has(id)) { segna(x, 'dipendente'); cambiato = true; } }
    }
  }
  return escluse;
}

// Il risultato e una anteprima di byte, non una conferma. Il chiamante fidato deve mostrarla prima di autorizzarla.
function prepara(piano, snapshot, { ammetti = null } = {}) {
  const checked = verificaPiano(piano, snapshot);
  if (!checked.valido || !snapshot.copertura.completa || piano.decisioni.length !== snapshot.sorgenti.length) throw errore('PIANO_NON_APPLICABILE');
  for (const n of [...snapshot.sorgenti, ...snapshot.catalogo]) {
    if (canonico(n) !== canonico(descrivi(n.testo, n.percorso, n.sha256))) throw errore('METADATI_SNAPSHOT_ALTERATI');
  }
  if (!ammetti && piano.decisioni.some(d => !['CREATE', 'MERGE', 'NOOP'].includes(d.esito))) throw errore('PIANO_RICHIEDE_REVISIONE');
  const sospese = ammetti ? seleziona(piano, ammetti) : new Map();
  const applicabili = piano.decisioni.filter(d => ['CREATE', 'MERGE', 'NOOP'].includes(d.esito));   // le altre non si applicano e non si esaminano
  const decided = new Set(), ids = new Set();
  for (const d of applicabili) {
    if (!snapshot.sorgenti.some(n => n.percorso === d.sorgente?.percorso && n.sha256 === d.sorgente.sha256)
      || d.id !== 'input-' + impronta(d.sorgente).slice(0, 16) || decided.has(d.sorgente.percorso) || ids.has(d.id)
      || piano.operazioni.filter(o => o.inputId === d.id).length !== (d.esito === 'NOOP' ? 0 : 1)) throw errore('PIANO_INCOMPLETO');
    const source = snapshot.sorgenti.find(n => n.percorso === d.sorgente.percorso);
    const target = snapshot.catalogo.find(n => n.percorso === d.destinazione?.percorso);
    // La deduplica piatta non rappresenta genitori o continuazioni: controllare anche le unita omesse dal piano.
    if (d.esito !== 'CREATE' && [source, target].some(n => n?.unita.some(u => /^[ \t]+\S/m.test(u.content)))) throw errore('STRUTTURA_ANNIDATA_NON_SUPPORTATA');
    decided.add(d.sorgente.percorso); ids.add(d.id);
  }
  const inputs = snapshot.sorgenti.map(n => {
    if (protetto(n.percorso) || relativo(n.percorso) !== n.percorso || !n.percorso.startsWith('to sort/') || !/\.md$/i.test(n.percorso)) throw errore('INPUT_NON_AUTORIZZATO');
    return { path: n.percorso, hash: n.sha256, key: sha(n.percorso) };
  });
  const grouped = new Map();
  for (const op of piano.operazioni) {
    if (sospese.has(op.inputId)) continue;
    const source = snapshot.sorgenti.find(n => n.percorso === op.sorgente.percorso);
    if (!destinazione(op.destinazione.percorso, snapshot, op.tipo === 'create_note')) throw errore('DESTINAZIONE_NON_AUTORIZZATA');
    let output = grouped.get(op.destinazione.percorso);
    if (op.tipo === 'create_note') {
      if (output) throw errore('CREAZIONE_DUPLICATA');
      const bytes = Buffer.from(source.testo, 'utf8');
      output = { path: op.destinazione.percorso, key: sha(op.destinazione.percorso), kind: 'create', before: null,
        after: sha(bytes), data: bytes.toString('base64'), operationIds: [op.inputId] };
    } else {
      const target = snapshot.catalogo.find(n => n.percorso === op.destinazione.percorso);
      if (op.aggiunte.some(u => u.kind !== 'text' || u.section.length) || target.unita.some(u => u.kind !== 'text' || u.section.length)
        || target.sezioni.some(s => s.livello > 1) || Object.keys(source.frontmatter).some(k => !(k in target.frontmatter) || canonico(source.frontmatter[k]) !== canonico(target.frontmatter[k]))) throw errore('MERGE_STRUTTURA_NON_SUPPORTATA');
      output ||= { path: target.percorso, key: sha(target.percorso), kind: 'append', before: target.sha256, beforeLength: Buffer.byteLength(target.testo),
        after: null, data: '', operationIds: [] };
      let addition = Buffer.from(output.data, 'base64').toString('utf8');
      for (const u of op.aggiunte) {
        if (!/^[ \t\r\n]*$/.test(u.before) || !['', '\n', '\r\n'].includes(u.eol)) throw errore('FORMATO_AGGIUNTA_NON_VALIDO');
        const prefix = target.testo + addition;
        if (prefix.length && !/[\r\n]$/.test(prefix) && !/^[\r\n]/.test(u.before)) addition += target.testo.includes('\r\n') ? '\r\n' : '\n';
        addition += u.before + u.content + u.eol;
      }
      output.data = Buffer.from(addition).toString('base64');output.after = sha(Buffer.from(target.testo + addition));output.operationIds.push(op.inputId);
    }
    grouped.set(output.path, output);
  }
  // create_dir: solo cartelle assenti di creaIn, con genitore esistente, usate da almeno una nuova nota di questo piano. Il motore nativo le ricontrolla.
  const mkdirs = piano.cartelleDaCreare.filter(d => !ammetti || [...grouped.values()].some(o => o.kind === 'create' && o.path.startsWith(d + '/') && !o.path.slice(d.length + 1).includes('/'))).map(d => {
    if (relativo(d) !== d || protetto(d) || !cartellaDaCreare(d, snapshot) || ![...grouped.values()].some(o => o.kind === 'create' && o.path.startsWith(d + '/') && !o.path.slice(d.length + 1).includes('/'))) throw errore('CARTELLA_DA_CREARE_NON_AUTORIZZATA');
    return { path: d, key: sha(d) };
  });
  // Aree escluse per policy (progetti/Orbit): non catalogate ma presenti sul disco, quindi devono comparire tra i nomi attesi della cartella che le contiene.
  const escluse = snapshot.copertura.problemi.filter(p => p.code === 'DESTINAZIONE_PROTETTA' && !bloccante(p, snapshot.creaIn)).map(p => ({ percorso: p.percorso }));
  const spec = { version: 1, plan: piano.impronta, snapshot: snapshot.impronta, rootId: snapshot.rootId, inputs,
    catalog: snapshot.catalogo.map(n => ({ path: n.percorso, hash: n.sha256 })),
    directories: snapshot.cartelle.map(d => ({ path: d.percorso, inode: d.identita.split(':').at(-1),
      children: [...snapshot.cartelle, ...snapshot.catalogo, ...escluse].filter(n => n.percorso.slice(0, n.percorso.lastIndexOf('/')) === d.percorso).map(n => n.percorso.split('/').at(-1)).sort() })),
    mkdirs, outputs: [...grouped.values()],
    ...(sospese.size ? { sospese: [...sospese.values()].map(({ id, sorgente, esito, tipo }) => ({ id, sorgente, esito, tipo })) } : {}) };
  return congela({ spec, impronta: impronta(spec) });
}

// Confine di fiducia: issuer e backend appartengono all'host, mai al modello o al JSON di una richiesta.
function creaHost({ rootId, rootIdentity, backend, opzioni = {} }) {
  if (typeof rootId !== 'string' || !/^[0-9A-F]{8}:[0-9A-F]{16}$/.test(rootIdentity) || typeof backend !== 'function') throw errore('HOST_FIDATO_RICHIESTO');
  const permits = new WeakMap();
  function confermaDaHost(anteprima, { azione, operazioni = [], archivia = [], recupero = {} } = {}) {
    if (!['apply', 'inspect', 'recover', 'rollback'].includes(azione) || anteprima.spec.rootId !== rootId || impronta(anteprima.spec) !== anteprima.impronta) throw errore('AUTORIZZAZIONE_NON_VALIDA');
    const known = new Set(anteprima.spec.outputs.flatMap(o => o.operationIds)), sources = new Set(anteprima.spec.inputs.map(i => i.path));
    const outputKeys = new Set(anteprima.spec.outputs.map(o => o.key));
    if (operazioni.some(id => !known.has(id)) || archivia.some(p => !sources.has(p)) || Object.keys(recupero).some(k => !outputKeys.has(k))
      || Object.values(recupero).some(r => !r || !/^[0-9a-f]{64}$/.test(r.hash) || !/^[0-9A-F]{8}:[0-9A-F]{16}$/.test(r.fileId))) throw errore('AMBITO_AUTORIZZAZIONE_NON_VALIDO');
    const capability = Object.freeze(Object.create(null));
    permits.set(capability, { preview: anteprima.impronta, azione, operazioni: [...operazioni], archivia: [...archivia], recupero: JSON.parse(JSON.stringify(recupero)) });
    return capability;
  }
  async function esegui(piano, snapshot, capability) {
    const anteprima = prepara(piano, snapshot, opzioni), grant = permits.get(capability);
    if (!grant || grant.preview !== anteprima.impronta || anteprima.spec.rootId !== rootId) throw errore('CONFERMA_UTENTE_RICHIESTA');
    if (grant.azione !== 'inspect' && anteprima.spec.outputs.some(o => o.operationIds.some(id => !grant.operazioni.includes(id)))) throw errore('OPERAZIONE_NON_AUTORIZZATA');
    return backend(canonico({ spec: anteprima.spec, preview: anteprima.impronta, rootFileId: rootIdentity, action: grant.azione, archive: grant.archivia, recovery: grant.recupero }));
  }
  return Object.freeze({ confermaDaHost, esegui });
}

module.exports = { prepara, creaHost, seleziona };
