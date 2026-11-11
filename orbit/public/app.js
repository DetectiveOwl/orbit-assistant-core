'use strict';
// Interfaccia di Orbit: un solo pallino. Tutto il resto (capsula di testo, risposta, menu, cronologia, diagnostica, impostazioni)
// compare solo quando serve. Lo stato mostrato arriva da eventi reali del backend (SSE) o da eventi locali di microfono, voce e interfaccia.
(function () {
  const $ = id => document.getElementById(id);
  const CS = window.OrbitCoreState, MD = window.OrbitMarkdown;
  const el = {
    orb: $('orb'), scena: $('scena'), nucleo: $('nucleo'), risposta: $('risposta'), rScorri: $('rScorri'), rDomanda: $('rDomanda'), rTesto: $('rTesto'), rMeta: $('rMeta'),
    rNav: $('rispostaNav'), rConta: $('rConta'), statoTesto: $('statoTesto'), statoDettaglio: $('statoDettaglio'), statoAzioni: $('statoAzioni'),
    capsula: $('capsula'), input: $('input'), btnMic: $('btnMic'), btnInvia: $('btnInvia'),
    btnVoceOnOff: $('btnVoceOnOff'), btnVoceStop: $('btnVoceStop'), suggerimento: $('suggerimentoVoce'),
    pannello: $('pannelloCronologia'), listaConv: $('listaConv'), cronologiaVuota: $('cronologiaVuota'), velo: $('veloCronologia'),
    avviso: $('avvisoConfig'), vistaDiag: $('vistaDiagnostica'), dlg: $('dlgImpostazioni')
  };

  const S = {
    conversazioneId: null, occupato: false, core: CS.iniziale(), mostrato: CS.iniziale(), trace: null, tracing: false,
    pref: { tema: 'scuro', modalita: 'mista', voceOn: '1', voceNome: '', voceVelocita: '1.5', parolaAttivazione: '0', movimento: 'auto' },
    ctrl: null, confermeCtrl: null, viaVoce: false, stato: null,
    risposte: [], indice: -1, aperta: false, daMostrare: false, domandaCorrente: '', timerLettura: 0, verifiche: []
  };
  const bozze = new Map();
  let bozzaCorrente = { testo: '', revisione: 0, fallite: [] }, selezioneConversazione = 0;
  bozze.set(null, bozzaCorrente);
  // Il contenitore non si nasconde a tempo: lo nasconde il nucleo quando la trasformazione inversa e davvero finita.
  const core = window.OrbitCore.crea({ svg: $('nucleoSvg'), canvas: $('rete'), radice: el.orb, scena: el.scena, corpo: $('corpo'), nucleo: el.nucleo, etichette: $('etichette'),
    suChiusa: () => { if (!S.aperta) el.risposta.hidden = true; } });
  const riconoscimento = window.OrbitVoice.creaRiconoscimento(window);
  const sintesi = window.OrbitVoice.creaSintesiOrbit(window);

  // Entrate e uscite interrompibili; le preferenze di movimento valgono per tutti i pannelli.
  const uscite = new WeakMap();
  function rivela(pannello) {
    const animazione = uscite.get(pannello);
    if (animazione) { uscite.delete(pannello); animazione.cancel(); }
    pannello.hidden = false;
  }
  function congeda(pannello, fine = () => { pannello.hidden = true; }) {
    if (uscite.has(pannello)) return;
    if (document.documentElement.classList.contains('movimento-ridotto') || !pannello.animate) return fine();
    const animazione = pannello.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
    uscite.set(pannello, animazione);
    animazione.finished.then(() => { if (uscite.get(pannello) !== animazione) return; uscite.delete(pannello); fine(); animazione.cancel(); }).catch(() => {});
  }
  function aggiornaSfondo() {
    const aperto = !el.pannello.hidden || !el.vistaDiag.hidden;
    [el.scena, $('appHeader')].forEach(x => { x.inert = aperto; });
  }
  $('oggiLabel').textContent = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Rome' }).format(new Date());
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  function scegliScheda(tab, focus = false) {
    tabs.forEach(b => { const attivo = b === tab; b.setAttribute('aria-selected', String(attivo)); b.tabIndex = attivo ? 0 : -1; });
    document.querySelectorAll('[data-settings-panel]').forEach(p => { p.hidden = p.dataset.settingsPanel !== tab.dataset.settingsTab; });
    if (focus) tab.focus();
  }
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => scegliScheda(b));
    b.addEventListener('keydown', e => {
      const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
      if (n >= 0) { e.preventDefault(); scegliScheda(tabs[n], true); }
    });
  });
  function filtraConversazioni() {
    const q = $('cercaConversazioni').value.trim().toLocaleLowerCase('it');
    let visibili = 0;
    el.listaConv.querySelectorAll('li').forEach(li => { li.hidden = !li.textContent.toLocaleLowerCase('it').includes(q); if (!li.hidden) visibili++; });
    el.cronologiaVuota.hidden = visibili > 0;
    el.cronologiaVuota.textContent = q ? 'Nessuna conversazione corrisponde alla ricerca.' : 'Le tue conversazioni cominciano qui. Aprine una nuova e ritrovala quando vuoi.';
  }
  $('cercaConversazioni').addEventListener('input', filtraConversazioni);
  document.addEventListener('keydown', e => {
    const pannello = !el.vistaDiag.hidden ? el.vistaDiag : !el.pannello.hidden ? el.pannello : null;
    if (!pannello || e.key !== 'Tab' || document.querySelector('dialog[open]')) return;
    const voci = [...pannello.querySelectorAll('button:not(:disabled), input, select, summary, [tabindex="0"]')].filter(x => x.getClientRects().length);
    if (e.shiftKey && document.activeElement === voci[0]) { e.preventDefault(); voci.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === voci.at(-1)) { e.preventDefault(); voci[0]?.focus(); }
  });

  /* ---------- rete ---------- */
  async function api(percorso, opzioni = {}) {
    const init = { method: opzioni.metodo || 'GET', headers: { 'X-Orbit': '1' } };
    if (opzioni.corpo !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opzioni.corpo); }
    const r = await fetch(percorso, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.errore || ('Errore ' + r.status));
    return j;
  }

  /* ---------- conferma coerente con il design ---------- */
  let codaConferme = Promise.resolve();
  function chiediConferma({ titolo, testo, conferma = 'Conferma', annulla = 'Annulla', signal, scade }) {
    const richiesta = codaConferme.then(() => new Promise(resolve => {
      if (signal?.aborted || (scade != null && Date.now() >= scade)) return resolve(false);
      const dlg = $('dlgConferma');
      $('confTitolo').textContent = titolo; $('confTesto').textContent = testo; $('confSi').textContent = conferma; $('confNo').textContent = annulla;
      let timer;
      const annullata = () => { if (dlg.open) dlg.close('no'); };
      const fine = () => {
        dlg.removeEventListener('close', fine); signal?.removeEventListener('abort', annullata); clearTimeout(timer);
        resolve(dlg.returnValue === 'si' && !signal?.aborted && (scade == null || Date.now() < scade));
      };
      dlg.addEventListener('close', fine); dlg.returnValue = 'no'; dlg.showModal(); $('confNo').focus();
      signal?.addEventListener('abort', annullata, { once: true });
      if (scade != null) timer = setTimeout(annullata, scade - Date.now());
    }));
    codaConferme = richiesta.catch(() => {});
    return richiesta;
  }

  /* ---------- Orbit Core: stato reale, animazioni interrompibili ---------- */
  function applica(nuovo) {
    S.mostrato = nuovo;
    core.imposta(nuovo);
    document.documentElement.dataset.statoApp = nuovo.nome;
    const etichetta = CS.ETICHETTE[nuovo.nome] || '';
    el.statoTesto.textContent = nuovo.nome === 'executing' && nuovo.tier ? etichetta + ' (' + nuovo.tier + ')' : etichetta;
    if (nuovo.nome === 'quality_checking') {
      const modo = S.verifiche.findLast(e => e.tipo === 'verifica')?.modo;
      el.statoTesto.textContent = modo === 'deterministico' ? 'Controllo locale' : 'Controllo della risposta';
    }
    el.statoDettaglio.textContent = nuovo.nome === 'retrieving' ? (nuovo.note.length ? nuovo.note.length + (nuovo.note.length === 1 ? ' nota trovata' : ' note trovate') : '')
      : (nuovo.nome === 'error' ? '' : (nuovo.dettaglio || (nuovo.modello && nuovo.attiva ? 'Modello: ' + nuovo.modello : '')));
    // La risposta compare quando lo stato "risposta" viene mostrato davvero: dopo la verifica, mai prima.
    if (S.daMostrare && nuovo.rispostaAperta) { S.daMostrare = false; mostraRisposta(S.risposte.length - 1); }
    if (!nuovo.rispostaAperta && S.aperta) nascondiRisposta();
    $('welcome').setAttribute('aria-hidden', String(nuovo.nome !== 'idle' || S.aperta));
    el.nucleo.setAttribute('aria-label', 'Orbit' + (etichetta ? ': ' + etichetta : '') + '. ' + (nuovo.nome === 'paused' ? 'Tocca per riprendere' : S.aperta ? 'Tocca per chiudere la risposta' : 'Tocca per scrivere'));
  }
  function evento(ev) { S.core = CS.riduci(S.core, ev); applica(S.core); }

  /* ---------- la risposta: il pallino si espande in un contenitore ---------- */
  const BADGE = { PASS: ['pass', 'Controllo superato'], FAIL: ['fail', 'Controllo non superato'], NON_VERIFICATA: ['nv', 'Verifica incompleta'], CHIARIMENTO: ['chiar', 'Serve un chiarimento'] };
  const ESITI = { PASS: 'superato', FAIL: 'non superato', ERROR: 'non disponibile', NEEDS_CLARIFICATION: 'serve un chiarimento' };
  function controlliRisposta(r) {
    const controlli = [], numero = n => Number.isSafeInteger(n) && n > 0 ? n : null;
    let ambito = null, pendente = null, passaggio = null, massimo = 0;
    const attribuisci = e => {
      const n = e.tentativo === undefined ? ambito?.tentativo ?? null : numero(e.tentativo);
      const coerente = e.tentativo === undefined || n !== null && (!ambito || n === ambito.tentativo);
      return { tentativo: coerente ? n : null, ambito: coerente ? ambito : null };
    };
    for (const e of r.verifiche || []) {
      if (e.tipo === 'tentativo') {
        let n = numero(e.tentativo);
        if (n !== null && (n < massimo || passaggio && (n <= passaggio.precedente || passaggio.a && e.tier !== passaggio.a))) n = null;
        ambito = { tentativo: n, tier: e.tier, passaggio: n !== null ? passaggio : null };
        massimo = Math.max(massimo, n || 0); passaggio = null; pendente = null;
      } else if (e.tipo === 'esecuzione') {
        if (!ambito || ambito.eseguito || controlli.at(-1)?.ambito === ambito || e.tier && ambito.tier && e.tier !== ambito.tier) ambito = null;
        else ambito.eseguito = true;
        pendente = null;
      } else if (e.tipo === 'escalation' || e.tipo === 'tentativo_mirato') {
        passaggio = { tipo: e.tipo, da: e.da, a: e.a, precedente: ambito?.tentativo ?? massimo };
        ambito = null; pendente = null;
      } else if (e.tipo === 'verifica') {
        const precedente = controlli.at(-1), attribuzione = attribuisci(e);
        pendente = { ...attribuzione, previsto: e.modo, modo: null, status: null,
          riverifica: ambito?.tentativo != null && attribuzione.tentativo !== null && precedente?.ambito === ambito && precedente.status === 'ERROR',
          passaggio: attribuzione.ambito?.passaggio };
        controlli.push(pendente);
      } else if (e.tipo === 'esito_verifica') {
        const attribuzione = attribuisci(e);
        let c = pendente;
        if (!c || e.tentativo !== undefined && (attribuzione.tentativo === null || attribuzione.tentativo !== c.tentativo)) {
          c = { ...attribuzione, status: null }; controlli.push(c);
        }
        c.status = e.status || 'SCONOSCIUTO';
        c.modo = e.semantico === true ? 'semantico' : e.status === 'ERROR' ? null
          : e.semantico === false || c.previsto === 'deterministico' ? 'deterministico' : null;
        pendente = null;
      }
    }
    if (!controlli.length && !r.daCronologia && r.verificaModo === 'deterministico') controlli.push({ modo: 'deterministico', status: r.verifica, tentativo: null });
    const ultimo = controlli.at(-1), finale = { PASS: 'PASS', FAIL: 'FAIL', CHIARIMENTO: 'NEEDS_CLARIFICATION' }[r.verifica];
    if (ambito?.tentativo != null && ultimo?.tentativo != null && ultimo.ambito === ambito && !pendente && ultimo.status === finale) ultimo.finale = true;
    return controlli;
  }
  function costruisciRisposta(r) {
    el.risposta.classList.toggle('errore', r.tipo === 'errore');
    el.rDomanda.textContent = r.domanda ? 'Hai chiesto: ' + r.domanda.slice(0, 160) + (r.domanda.length > 160 ? '...' : '') : '';
    el.rTesto.innerHTML = MD.render(r.testo);
    if (r.parziale) { const titolo = document.createElement('p'); titolo.textContent = 'Risposta parziale · non completata e non verificata'; const testo = document.createElement('div'); testo.innerHTML = MD.render(r.parziale); el.rTesto.append(titolo, testo); }
    el.rMeta.innerHTML = '';
    if (r.tipo !== 'errore') {
      const d = document.createElement('details'); d.className = 'verifica-badge';
      const b = document.createElement('summary');
      const corpo = document.createElement('div'); corpo.className = 'verifica-dettaglio'; corpo.tabIndex = 0; corpo.setAttribute('role', 'group'); corpo.setAttribute('aria-label', 'Dettagli della verifica');
      const nota = document.createElement('p'), lista = document.createElement('ol'); corpo.append(nota, lista);
      const aggiorna = () => {
        const controlli = controlliRisposta(r);
        const tipi = [...new Set(controlli.filter(c => ['PASS', 'FAIL', 'NEEDS_CLARIFICATION'].includes(c.status)).map(c => c.modo).filter(Boolean))];
        const tipo = tipi.length === 2 ? 'Verifica locale + AI' : tipi[0] === 'semantico' ? 'Verifica AI' : tipi[0] === 'deterministico' ? 'Verifica locale' : null;
        const badge = BADGE[r.verifica] || ['nv', 'Verifica non indicata'];
        b.className = 'badge ' + badge[0];
        b.textContent = r.verifica === 'PASS' && tipo && controlli.at(-1)?.status === 'PASS' ? tipo : badge[1];
        nota.textContent = 'Esito finale della risposta: ' + (ESITI[r.verifica] || (r.verifica === 'NON_VERIFICATA' ? 'verifica incompleta' : r.verifica === 'CHIARIMENTO' ? 'serve un chiarimento' : 'non comunicato')) + '. '
          + (tipo ? 'I controlli non garantiscono la correttezza di ogni informazione.' : 'Il tipo di verifica effettuata non e disponibile.')
          + (controlli.length > 1 ? ' Include i controlli precedenti in ordine cronologico.' : '');
        lista.innerHTML = '';
        for (const c of controlli) {
          const li = document.createElement('li');
          const nome = c.modo === 'deterministico' ? 'Controllo locale' : c.modo === 'semantico' ? 'Controllo AI'
            : c.previsto === 'semantico' ? 'Controllo AI richiesto' : 'Controllo di tipo non comunicato';
          const attribuzione = c.tentativo != null ? 'Tentativo ' + c.tentativo : 'Tentativo non attribuibile';
          const passaggio = c.passaggio?.tipo === 'escalation' ? 'Dopo escalation' + (c.passaggio.da && c.passaggio.a ? ' ' + c.passaggio.da + ' → ' + c.passaggio.a : '') + ' · '
            : c.passaggio?.tipo === 'tentativo_mirato' ? 'Dopo correzione mirata · ' : '';
          li.textContent = attribuzione + ' · ' + passaggio + (c.riverifica ? 'Riverifica · ' : '') + nome + ': ' + (ESITI[c.status] || 'esito non comunicato') + '.'
            + (c.finale ? ' Verifica finale.' : ' Esito del controllo, distinto dall’esito finale.'); lista.appendChild(li);
        }
      };
      aggiorna(); d.append(b, corpo); d.addEventListener('toggle', rifinisciDimensioni); el.rMeta.appendChild(d);
      if (r.richiesta) {
        const apri = document.createElement('button'); apri.type = 'button'; apri.className = 'badge'; apri.textContent = 'Dettagli della richiesta';
        apri.addEventListener('click', () => apriDiagnostica(r.richiesta)); corpo.appendChild(apri);
      }
      if (r.daCronologia && r.richiesta) {
        // Il modo salvato nella cronologia e il piano previsto, non la prova di un controllo eseguito.
        r.diagnosticaVerifica ||= api('/api/diagnostics/' + r.richiesta).then(x => {
          r.verifiche = (x.eventi || []).filter(e => ['tentativo', 'esecuzione', 'escalation', 'tentativo_mirato', 'verifica', 'esito_verifica'].includes(e.tipo));
        }).catch(() => {});
        r.diagnosticaVerifica.then(aggiorna);
      }
    }
    if (r.tipo !== 'errore' && sintesi.haVoceItaliana()) {
      const a = document.createElement('button'); a.type = 'button'; a.className = 'badge'; a.textContent = 'Ascolta'; a.addEventListener('click', () => parla(r.testo)); el.rMeta.appendChild(a);
    }
    if (r.fonti && r.fonti.length) { const f = document.createElement('span'); f.className = 'fonti'; f.textContent = 'Note: ' + r.fonti.map(x => x.titolo || x.percorso).join(', '); el.rMeta.appendChild(f); }
  }
  // Misura il contenitore con un clone fuori schermo: cosi l'espansione parte gia verso la dimensione giusta.
  function misura(r, larghezza) {
    const m = document.createElement('div'); m.className = 'risposta misura ' + (r.tipo === 'errore' ? 'errore' : ''); m.setAttribute('aria-hidden', 'true');
    m.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;opacity:1;width:' + larghezza + 'px;height:auto;inset:auto;';
    m.innerHTML = '<div class="risposta-testa"></div><div class="risposta-scorri"><p class="risposta-domanda">' + (r.domanda ? 'Hai chiesto: ' + MD.esc(r.domanda.slice(0, 160)) : '') + '</p><div class="risposta-testo">' + MD.render(r.testo) + '</div></div><div class="risposta-meta">x</div>';
    document.body.appendChild(m);
    const h = m.getBoundingClientRect().height; m.remove();
    return h;
  }
  // Le dimensioni sono solo OBIETTIVI: la forma ci arriva con la stessa simulazione del nucleo, anche a meta di un'altra transizione.
  function impostaDimensioni(alto, larghezza) {
    if (larghezza) S.larghezza = Math.round(larghezza);
    S.altoRisposta = alto;
    el.risposta.style.setProperty('--risposta-w', (S.larghezza || 520) + 'px');
    el.risposta.style.setProperty('--risposta-h', Math.round(alto) + 'px');
    core.geometria(S.larghezza || 520, Math.round(alto));
  }
  // A espansione finita si controlla il contenuto reale: se non ci sta tutto e c'e spazio, il contenitore cresce ancora un poco.
  function rifinisciDimensioni() {
    if (!S.aperta) return;
    const extra = el.rScorri.scrollHeight - el.rScorri.clientHeight;
    const max = Math.max(160, window.innerHeight - 330);
    if (extra > 2 && S.altoRisposta < max) impostaDimensioni(Math.min(max, S.altoRisposta + extra + 6));
  }
  function mostraRisposta(i) {
    const r = S.risposte[i]; if (!r) return;
    S.indice = i; S.aperta = true;
    document.documentElement.dataset.answer = 'true';
    costruisciRisposta(r);
    el.risposta.hidden = false;
    const larghezza = Math.min(window.innerWidth * 0.92, r.testo.length > 700 ? 680 : r.testo.length > 240 ? 600 : 520);
    impostaDimensioni(Math.max(160, Math.min(window.innerHeight - 330, misura(r, larghezza) + 30)), larghezza);
    el.orb.dataset.aperta = '1'; el.nucleo.setAttribute('aria-expanded', 'true'); core.apertura(true);
    el.rScorri.scrollTop = 0;
    el.rNav.hidden = S.risposte.length < 2;
    el.rConta.textContent = (i + 1) + ' / ' + S.risposte.length;
    $('rPrec').disabled = i <= 0; $('rSucc').disabled = i >= S.risposte.length - 1;
    riavviaTimerLettura();
    if (r.trace) { r.trace.marca('dom'); r.trace.dipinta(el.risposta, () => S.aperta && S.risposte[S.indice] === r); }
    setTimeout(rifinisciDimensioni, 800);
  }
  window.addEventListener('resize', () => { if (S.aperta) { const r = S.risposte[S.indice]; if (r) { const w = Math.min(window.innerWidth * .92, r.testo.length > 700 ? 680 : r.testo.length > 240 ? 600 : 520); impostaDimensioni(Math.max(160, Math.min(window.innerHeight - 330, misura(r, w) + 30)), w); } } });
  function nascondiRisposta() {
    S.aperta = false;
    document.documentElement.dataset.answer = 'false';
    el.orb.dataset.aperta = '0'; el.nucleo.setAttribute('aria-expanded', 'false');
    core.apertura(false);
    clearTimeout(S.timerLettura);
  }
  function chiudiRisposta() { if (!S.aperta) return; fermaVoce(); evento({ tipo: S.core.nome === 'error' ? 'locale:errore_chiuso' : 'locale:chiudi_risposta' }, true); if (S.aperta) nascondiRisposta(); }
  // Dopo due minuti senza interazione, e solo se Orbit non sta parlando, il contenitore torna pallino.
  function riavviaTimerLettura() {
    clearTimeout(S.timerLettura);
    S.timerLettura = setTimeout(() => {
      if (!S.aperta) return;
      if (sintesi.inCorso() || el.risposta.matches(':hover') || el.risposta.contains(document.activeElement)) return riavviaTimerLettura();
      chiudiRisposta();
    }, 120000);
  }
  el.risposta.addEventListener('pointermove', riavviaTimerLettura); el.risposta.addEventListener('wheel', riavviaTimerLettura, { passive: true });
  function aggiungiRisposta(r) { S.risposte.push(r); return S.risposte.length - 1; }

  /* ---------- capsula di testo ---------- */
  function apriCapsula() {
    if (S.core.nome === 'paused') return;
    el.capsula.hidden = false; el.input.focus(); adattaAltezza();
  }
  function chiudiCapsula() { salvaBozza(); el.capsula.hidden = true; adattaAltezza(); }
  function salvaBozza() {
    if (bozzaCorrente.testo !== el.input.value) { bozzaCorrente.testo = el.input.value; bozzaCorrente.revisione++; }
  }
  function cambiaBozza(id) {
    salvaBozza(); S.conversazioneId = id;
    if (!bozze.has(id)) bozze.set(id, { testo: '', revisione: 0, fallite: [] });
    bozzaCorrente = bozze.get(id); el.input.value = bozzaCorrente.testo; adattaAltezza(); aggiornaRecuperi();
  }
  function collegaConversazione(id, invio) {
    if (!id) return;
    if (!invio.conversazioneId) {
      bozze.set(id, invio.bozza); if (bozze.get(null) === invio.bozza) bozze.delete(null);
    }
    invio.conversazioneId = id; S.conversazioneId = id;
  }
  function aggiornaRecuperi() {
    const attivo = S.invio?.stato === 'in corso' && S.invio.bozza === bozzaCorrente ? S.invio : null;
    $('notaBozza').hidden = !attivo;
    $('notaBozza').textContent = attivo ? 'Richiesta in corso. Puoi scrivere il prossimo messaggio; non verrà inviato finché questa richiesta non termina.' : '';
    const box = $('recuperiTesti'); box.innerHTML = '';
    const testi = [...bozzaCorrente.fallite, ...(attivo ? [attivo] : [])]; $('recuperoBozza').hidden = !testi.length;
    for (const r of testi) {
      const articolo = document.createElement('article'), titolo = document.createElement('p'); titolo.textContent = r.stato === 'in corso' ? 'Testo inviato · richiesta in corso' : r.messaggio; articolo.appendChild(titolo);
      const originale = document.createElement('textarea'); originale.readOnly = true; originale.rows = 3; originale.value = r.originale; originale.setAttribute('aria-label', 'Testo originale della richiesta'); articolo.appendChild(originale);
      if (r.parziale) { const p = document.createElement('textarea'); p.readOnly = true; p.rows = 3; p.value = r.parziale; p.setAttribute('aria-label', 'Risposta parziale non completata'); articolo.appendChild(p); }
      if (r.stato !== 'in corso') {
        const recupera = document.createElement('button'); recupera.type = 'button'; recupera.className = 'btn-neu testo piccolo'; recupera.textContent = 'Recupera testo';
        recupera.addEventListener('click', () => {
          salvaBozza();
          if (bozzaCorrente.testo && bozzaCorrente.testo !== r.originale) { $('notaBozza').hidden = false; $('notaBozza').textContent = 'La bozza attuale ha la precedenza. Il testo originale resta qui, selezionabile e copiabile.'; originale.focus(); return; }
          el.input.value = r.originale; salvaBozza(); if (S.aperta) chiudiRisposta(); apriCapsula();
        }); articolo.appendChild(recupera);
      }
      box.appendChild(articolo);
    }
  }
  function fallisciInvio(invio, messaggio, interrotta = false, parziale = null) {
    if (invio.stato !== 'in corso') return;
    invio.stato = interrotta ? 'interrotta' : 'fallita'; invio.messaggio = messaggio; invio.parziale = parziale;
    invio.bozza.fallite.push(invio);
    if (bozzaCorrente === invio.bozza) salvaBozza();
    // Una modifica successiva, anche la cancellazione intenzionale, impedisce il ripristino automatico.
    if (!invio.bozza.testo && invio.bozza.revisione === invio.revisione) {
      invio.bozza.testo = invio.originale; invio.bozza.revisione++;
      if (bozzaCorrente === invio.bozza) { el.input.value = invio.originale; adattaAltezza(); }
    }
    aggiungiRisposta({ tipo: 'errore', testo: messaggio + '\n\nIl testo originale è conservato in “Testi delle richieste”. Nessun reinvio automatico.', parziale, domanda: invio.testo });
    S.daMostrare = true; evento({ tipo: 'errore', messaggio }); aggiornaRecuperi();
  }
  function parzialeStream(buf) {
    try { const riga = buf.split('\n').find(l => l.startsWith('data: ')), e = JSON.parse(riga.slice(6)); return e.tipo === 'finale' && typeof e.testo === 'string' ? e.testo : null; } catch (e) { return null; }
  }
  function adattaAltezza() { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 115) + 'px'; }
  // Il footer occupa spazio reale: anche un avviso vocale su piu righe resta sotto il campo.
  function misuraFooter() {
    document.documentElement.style.setProperty('--voice-footer-h', Math.ceil($('voiceFooter').getBoundingClientRect().height) + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(misuraFooter).observe($('voiceFooter'));
  window.addEventListener('resize', misuraFooter);
  misuraFooter();
  el.input.addEventListener('input', () => { salvaBozza(); adattaAltezza(); });
  el.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); invia(el.input.value, false); } });
  el.capsula.addEventListener('submit', e => { e.preventDefault(); invia(el.input.value, false); });

  /* ---------- invio e stream SSE ---------- */
  function impostaOccupato(v) {
    S.occupato = v; el.btnInvia.disabled = v; el.input.placeholder = v ? 'Bozza per il prossimo messaggio' : 'Scrivi a Orbit';
    aggiornaAscolto();
    el.statoAzioni.hidden = !v;
    el.btnMic.disabled = v || !modalitaMic();
    el.capsula.setAttribute('aria-busy', String(v));
  }

  async function invia(testo, viaVoce, tempiVoce = null) {
    const originale = testo || ''; testo = originale.trim();
    if (!testo || S.occupato || S.core.nome === 'paused') return;
    selezioneConversazione++; fermaVoce();
    const trace = S.trace = window.OrbitPerformance.crea(window, { attivo: S.tracing, voce: tempiVoce });
    S.viaVoce = !!viaVoce; S.domandaCorrente = testo; S.verifiche = [];
    if (!viaVoce) salvaBozza();
    const invio = S.invio = { originale, testo, bozza: bozzaCorrente, conversazioneId: S.conversazioneId, stato: 'in corso' };
    if (!viaVoce || !bozzaCorrente.testo) { el.input.value = ''; salvaBozza(); }
    invio.revisione = bozzaCorrente.revisione; chiudiCapsula(); aggiornaRecuperi();
    impostaOccupato(true); evento({ tipo: 'locale:invio' }, true);
    S.ctrl = new AbortController(); S.confermeCtrl = new AbortController();
    let concluso = false, buf = '';
    try {
      trace?.marca('inviata');
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orbit': '1' }, signal: S.ctrl.signal,
        body: JSON.stringify({ conversationId: invio.conversazioneId, message: testo, voice: vuoleParlare(viaVoce) })
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})), errore = new Error(j.errore || 'La richiesta non è stata accettata (' + r.status + ').'); errore.http = true; throw errore; }
      const reader = r.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (S.ctrl.signal.aborted) throw S.ctrl.signal.reason;
        if (done) { buf += dec.decode(); break; }
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const blocco = buf.slice(0, i); buf = buf.slice(i + 2);
          const riga = blocco.split('\n').find(l => l.startsWith('data: '));
          if (!riga) continue;
          let ev; try { ev = JSON.parse(riga.slice(6)); } catch (e) { continue; }
          if (!concluso && gestisciEvento(ev, testo, trace, invio)) concluso = true;
        }
      }
      if (!concluso) fallisciInvio(invio, 'La risposta non è stata completata. Controlla la cronologia prima di reinviare.', false, parzialeStream(buf));
    } catch (e) {
      if (!concluso) {
        const interrotta = e.name === 'AbortError';
        fallisciInvio(invio, interrotta ? 'Richiesta interrotta.' : e.http ? e.message : e.name === 'TimeoutError' ? 'La richiesta ha impiegato troppo tempo. Controlla la cronologia prima di reinviare.' : 'Connessione interrotta. Orbit potrebbe avere già elaborato la richiesta: controlla la cronologia prima di reinviare.', interrotta, parzialeStream(buf));
      }
    } finally {
      S.confermeCtrl.abort(); S.ctrl = null; S.invio = null; impostaOccupato(false); aggiornaRecuperi(); caricaCronologia();
    }
  }
  function erroreInterfaccia(messaggio) {
    aggiungiRisposta({ tipo: 'errore', testo: messaggio, domanda: S.domandaCorrente });
    S.daMostrare = true; evento({ tipo: 'errore', messaggio }, true);
  }

  // Restituisce true se l'evento chiude la richiesta.
  function gestisciEvento(ev, testoInviato, trace, invio) {
    if (['finale', 'errore', 'interrotta'].includes(ev.tipo)) S.confermeCtrl?.abort();
    switch (ev.tipo) {
      case 'conversazione': collegaConversazione(ev.conversazioneId, invio); break;
      case 'tentativo': case 'esecuzione': case 'escalation': case 'tentativo_mirato': case 'verifica': case 'esito_verifica':
        S.verifiche.push({ ...ev }); evento(ev); break;
      case 'finale':
        trace?.collega(ev.richiesta); trace?.marca('ricevuta');
        if (ev.verifica === 'PASS') trace?.marca('verificata');
        collegaConversazione(ev.conversazioneId, invio); invio.stato = 'completata';
        aggiungiRisposta({ tipo: 'risposta', testo: ev.testo, verifica: ev.verifica, verificaModo: ev.verificaModo, verifiche: S.verifiche.slice(), richiesta: ev.richiesta, fonti: ev.fonti, domanda: testoInviato, trace });
        S.daMostrare = true;
        evento(ev);
        if (ev.verifica === 'PASS' || ev.verifica === 'NON_VERIFICATA' || ev.verifica === 'FAIL') parlaAutomatico(ev.testo, ev.verifica === 'PASS' ? trace : null);
        return true;
      case 'errore':
        fallisciInvio(invio, ev.messaggio || 'La richiesta non è stata completata.'); verificaConfigurazione(); return true;
      case 'interrotta': fallisciInvio(invio, 'Richiesta interrotta.', true); return true;
      case 'conferma_richiesta': evento(ev, true); chiediConfermaOperazione(ev.conferma); break;
      default: evento(ev);
    }
    return false;
  }
  // Conferma specifica di UNA operazione: descrive cosa, dove e con quali conseguenze. La risposta arriva al server solo da qui.
  async function chiediConfermaOperazione(c) {
    const signal = S.confermeCtrl?.signal;
    const testo = c.descrizione + (c.destinazione ? '\n\nDove: ' + c.destinazione : '') + (c.conseguenze ? '\nConseguenze: ' + c.conseguenze : '') + '\n\nLa conferma vale solo per questa operazione e scade tra pochi minuti.';
    const ok = await chiediConferma({ titolo: 'Autorizzare questa operazione?', testo, conferma: 'Autorizza', annulla: 'Rifiuta', signal, scade: c.scade });
    if (signal?.aborted) return;
    if (c.scade != null && Date.now() >= c.scade) { el.suggerimento.textContent = 'La conferma e scaduta. Richiedi di nuovo l’operazione.'; return; }
    try {
      const r = await api('/api/conferme/' + c.id, { metodo: 'POST', corpo: { approva: ok } });
      if (r.stato !== (ok ? 'approvata' : 'rifiutata')) el.suggerimento.textContent = 'Operazione non autorizzata: la conferma e scaduta o annullata.';
    } catch (e) { el.suggerimento.textContent = 'Risposta alla conferma non inviata: ' + e.message; }
  }
  $('btnInterrompi').addEventListener('click', interrompi);
  function interrompi() {
    if (!S.occupato) return;
    S.confermeCtrl?.abort();
    if (S.conversazioneId) api('/api/chat/abort', { metodo: 'POST', corpo: { conversationId: S.conversazioneId } }).catch(() => {});
    if (S.ctrl) S.ctrl.abort();
  }

  /* ---------- voce ---------- */
  function modalitaMic() { return S.pref.modalita !== 'testo' && riconoscimento.supportato; }
  function vuoleParlare(viaVoce) { return S.pref.voceOn === '1' && sintesi.supportata && sintesi.haVoceItaliana() && (S.pref.modalita === 'voce' || (S.pref.modalita === 'mista' && viaVoce)); }
  function parlaAutomatico(testo, trace) { if (vuoleParlare(S.viaVoce)) parla(testo, trace); }
  function parla(testo, trace = null) {
    if (!sintesi.haVoceItaliana()) { el.suggerimento.textContent = suggerimentoBrowser() || 'Nessuna voce italiana disponibile.'; return; }
    fermaVoce();
    sintesi.parla(MD.perVoce(testo), {
      voce: S.pref.voceNome, velocita: S.pref.voceVelocita,
      richiesta: trace?.richiesta,
      onSintesi: () => trace?.marca('sintesi_inizio'),
      onAudio: () => { trace?.marca('audio_primo'); trace?.invia(); },
      onRiproduzioneFine: () => { trace?.marca('audio_fine'); trace?.invia(); },
      onInizio: () => { evento({ tipo: 'locale:voce_inizio' }, true); el.btnVoceStop.disabled = false; aggiornaAscolto(); },
      onLivello: v => { if (S.core.nome === 'speaking') core.livello(v); },
      onBoundary: () => { if (S.core.nome === 'speaking') core.impulso(); },
      onFine: () => { evento({ tipo: 'locale:voce_fine' }, true); el.btnVoceStop.disabled = true; core.livello(0); aggiornaAscolto(); },
      onErrore: m => { el.suggerimento.textContent = m; }
    });
  }
  function fermaVoce() { sintesi.ferma(); el.btnVoceStop.disabled = true; core.livello(0); evento({ tipo: 'locale:voce_fine' }, true); aggiornaAscolto(); }

  function inviaDettatura(testo, tempi, bozza) {
    if (bozza === bozzaCorrente && !S.occupato && S.core.nome !== 'paused') return invia(testo, true, tempi);
    if (!testo) return;
    bozza.fallite.push({ originale: testo, stato: 'interrotta', messaggio: 'Dettatura conservata senza invio: la conversazione è cambiata o Orbit è occupato.' });
    if (!bozza.testo) { bozza.testo = testo; bozza.revisione++; if (bozza === bozzaCorrente) { el.input.value = testo; adattaAltezza(); } }
    if (bozza === bozzaCorrente) aggiornaRecuperi();
  }
  function microfono() {
    if (S.occupato || S.core.nome === 'paused') return;
    if (riconoscimento.attivo()) { riconoscimento.ferma(); return; }
    if (!riconoscimento.supportato) { el.suggerimento.textContent = suggerimentoBrowser(); return; }
    fermaVoce();
    const bozza = bozzaCorrente, revisione = bozza.revisione;
    riconoscimento.avvia({
      lingua: 'it-IT',
      onInizio: () => { el.btnMic.setAttribute('aria-pressed', 'true'); evento({ tipo: 'locale:mic_avvio' }, true); aggiornaAscolto(); },
      onInterim: t => { if (bozza === bozzaCorrente && bozza.revisione === revisione && !bozza.testo) { el.input.value = t; if (!el.capsula.hidden) adattaAltezza(); } },
      onLivello: v => core.livello(v),
      onErrore: m => { el.suggerimento.textContent = m; },
      onFine: (finale, tempi) => {
        el.btnMic.setAttribute('aria-pressed', 'false'); core.livello(0); evento({ tipo: 'locale:mic_fine' }, true); setTimeout(aggiornaAscolto, 0);
        if (finale) inviaDettatura(finale, tempi, bozza); else if (bozza === bozzaCorrente && bozza.revisione === revisione && !bozza.testo) el.input.value = '';
      }
    });
  }
  el.btnMic.addEventListener('click', microfono);

  /* ---------- parola di attivazione "Orbit" ---------- */
  const ETICHETTE_PAROLA = { attesa: 'In attesa di "Orbit"', attivata: 'Ti ascolto', pausa: 'In pausa mentre lavoro o parlo', errore: 'Non disponibile' };
  let parolaAttivata = false, bozzaParola = null;
  const attivazione = window.OrbitVoice.creaParolaDiAttivazione(window, {
    onStato: (s, d) => {
      const chip = $('statoParola');
      chip.className = 'chip-stato ' + (s === 'spento' ? '' : s);
      chip.textContent = s === 'spento' ? '' : (s === 'errore' ? ETICHETTE_PAROLA.errore + (d ? ' (' + d + ')' : '') : (ETICHETTE_PAROLA[s] || ''));
      if (s !== 'attivata' && parolaAttivata) { parolaAttivata = false; evento({ tipo: 'locale:mic_fine' }, true); }
      if (s === 'errore') { S.pref.parolaAttivazione = '0'; applicaPreferenze(); api('/api/preferences', { metodo: 'PUT', corpo: { parolaAttivazione: '0' } }).catch(() => {}); }
    },
    onAttivata: () => { if (S.occupato || S.core.nome === 'paused') return; fermaVoce(); bozzaParola = bozzaCorrente; parolaAttivata = true; evento({ tipo: 'locale:mic_avvio' }, true); },
    onLivello: v => { if (parolaAttivata || !v) core.livello(v); },
    onTesto: t => { if (!el.capsula.hidden && (!bozzaParola || bozzaParola === bozzaCorrente) && !bozzaCorrente.testo) { el.input.value = t; adattaAltezza(); } },
    onComando: (t, tempi) => { parolaAttivata = false; evento({ tipo: 'locale:mic_fine' }, true); inviaDettatura(t, tempi, bozzaParola || bozzaCorrente); bozzaParola = null; },
    onErrore: m => { el.suggerimento.textContent = m; }
  });
  // L'ascolto della parola si ferma mentre Orbit lavora, parla, e in pausa o durante la dettatura a mano: cosi non sente la propria voce.
  function aggiornaAscolto() {
    if (!attivazione.attiva()) return;
    const libero = !S.occupato && !sintesi.inCorso() && !riconoscimento.attivo() && S.core.nome !== 'paused';
    if (libero) attivazione.riprendi(); else attivazione.pausa();
  }
  async function impostaParola(on) {
    if (on) {
      if (!attivazione.supportata) { el.suggerimento.textContent = 'La parola di attivazione richiede il riconoscimento vocale di Chrome: ' + nomeBrowser() + ' non lo ha.'; return; }
      attivazione.avvia();
    } else { attivazione.ferma(); parolaAttivata = false; }
    await salvaPref('parolaAttivazione', on ? '1' : '0');
  }

  /* ---------- pausa ---------- */
  function impostaPausa(on) {
    if (on) { if (S.occupato) interrompi(); fermaVoce(); riconoscimento.ferma(); chiudiCapsula(); evento({ tipo: 'locale:pausa' }, true); }
    else evento({ tipo: 'locale:riprendi' }, true);
    aggiornaAscolto(); aggiornaMenu();
  }

  /* ---------- barra in alto: azioni sempre visibili, gli interruttori mostrano il loro stato ---------- */
  function aggiornaMenu() {
    const parola = S.pref.parolaAttivazione === '1', mParola = $('mParola'), mPausa = $('mPausa');
    mParola.setAttribute('aria-pressed', String(parola)); mParola.disabled = !riconoscimento.supportato;
    mParola.title = parola ? 'Orbit ascolta la parola «Orbit»: tocca per spegnere' : 'Tocca per far ascoltare a Orbit la parola «Orbit»';
    mPausa.setAttribute('aria-pressed', String(!!S.core.inPausa));
    mPausa.title = S.core.inPausa ? 'Orbit e in pausa: tocca per riprendere' : 'Metti Orbit in pausa';
    const testo = mPausa.querySelector('.voce-testo'); if (testo) testo.textContent = S.core.inPausa ? 'Riprendi' : 'Pausa';
  }
  $('mNuova').addEventListener('click', () => nuovaChat());
  $('mCronologia').addEventListener('click', () => apriCronologia());
  $('mDiagnostica').addEventListener('click', () => apriDiagnostica());
  $('mImpostazioni').addEventListener('click', () => apriImpostazioni());
  $('mParola').addEventListener('click', () => impostaParola(S.pref.parolaAttivazione !== '1'));
  $('mPausa').addEventListener('click', () => impostaPausa(!S.core.inPausa));

  /* ---------- il pallino come punto di accesso ---------- */
  el.nucleo.addEventListener('click', () => {
    if (S.core.nome === 'paused') return impostaPausa(false);
    if (S.aperta) return chiudiRisposta();
    if (S.occupato) { if (el.capsula.hidden) apriCapsula(); else chiudiCapsula(); return; }
    if (S.pref.modalita === 'voce' && modalitaMic()) return microfono();
    if (el.capsula.hidden) apriCapsula(); else chiudiCapsula();
  });
  // Il campo di testo si apre soltanto dal nucleo; la tastiera gestisce la chiusura.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      if (!el.vistaDiag.hidden) return chiudiDiagnostica();
      if (!el.pannello.hidden) return chiudiCronologia();
      if (sintesi.inCorso()) return fermaVoce();
      if (S.aperta) return chiudiRisposta();
      if (!el.capsula.hidden) return chiudiCapsula();
      return;
    }
  });
  $('rChiudi').addEventListener('click', chiudiRisposta);
  $('rPrec').addEventListener('click', () => { riavviaTimerLettura(); mostraRisposta(S.indice - 1); });
  $('rSucc').addEventListener('click', () => { riavviaTimerLettura(); mostraRisposta(S.indice + 1); });

  /* ---------- cronologia ---------- */
  function data(ms) { return new Date(ms).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  async function caricaCronologia() {
    let lista = [];
    try { lista = await api('/api/conversations'); } catch (e) { el.cronologiaVuota.hidden = false; el.cronologiaVuota.textContent = 'Non riesco a caricare la cronologia. Riapri il pannello per riprovare.'; return; }
    el.listaConv.innerHTML = '';
    el.cronologiaVuota.hidden = lista.length > 0;
    for (const c of lista) {
      const li = document.createElement('li');
      const apri = document.createElement('button'); apri.type = 'button'; apri.className = 'btn-neu apri' + (c.id === S.conversazioneId ? ' attivo' : '');
      const b = document.createElement('b'); b.textContent = c.titolo; const sm = document.createElement('small'); sm.textContent = data(c.aggiornata) + ' · ' + c.messaggi + ' messaggi';
      apri.append(b, sm); apri.addEventListener('click', () => apriConversazione(c.id));
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn-neu icona piccolo pericolo'; del.setAttribute('aria-label', 'Elimina la conversazione ' + c.titolo); del.textContent = 'x';
      del.addEventListener('click', async () => {
        if (!await chiediConferma({ titolo: 'Eliminare la conversazione?', testo: '"' + c.titolo + '" e i suoi messaggi salvati verranno eliminati da Orbit. I tuoi appunti nel vault non vengono toccati.', conferma: 'Elimina' })) return;
        try { await api('/api/conversations/' + c.id, { metodo: 'DELETE' }); if (c.id === S.conversazioneId) nuovaChat(); caricaCronologia(); } catch (e) { erroreInterfaccia(e.message); }
      });
      li.append(apri, del); el.listaConv.appendChild(li);
    }
    filtraConversazioni();
  }
  async function apriConversazione(id) {
    if (S.occupato) return;
    if (id === S.conversazioneId && sintesi.inCorso()) { chiudiCronologia(); return; }
    if (id !== S.conversazioneId) fermaVoce();
    const selezione = ++selezioneConversazione;
    try {
      const c = await api('/api/conversations/' + id);
      if (selezione !== selezioneConversazione || S.occupato) return;
      cambiaBozza(id); chiudiCapsula(); S.risposte = []; let domanda = '';
      for (const m of c.messaggi) {
        if (m.ruolo === 'user') domanda = m.contenuto;
        else S.risposte.push({ tipo: m.ruolo === 'sistema' ? 'errore' : 'risposta', testo: m.contenuto, verifica: m.verifica, verifiche: [], daCronologia: true, richiesta: m.richiesta, fonti: m.fonti, domanda });
      }
      chiudiCronologia();
      if (S.risposte.length) { S.daMostrare = true; evento({ tipo: 'finale' }, true); }
      else if (S.aperta) chiudiRisposta();
      caricaCronologia();
    } catch (e) { if (selezione === selezioneConversazione && !S.occupato) erroreInterfaccia(e.message); }
  }
  function nuovaChat() {
    if (S.occupato) return;
    selezioneConversazione++; fermaVoce(); cambiaBozza(null); S.risposte = []; S.indice = -1;
    if (S.aperta) chiudiRisposta();
    chiudiCapsula(); chiudiCronologia(false);
  }
  function apriCronologia() { rivela(el.pannello); rivela(el.velo); aggiornaSfondo(); caricaCronologia(); $('cercaConversazioni').focus(); }
  function chiudiCronologia(ripristina = true) { if (el.pannello.hidden) return; congeda(el.velo); congeda(el.pannello, () => { el.pannello.hidden = true; aggiornaSfondo(); (ripristina === false && !el.capsula.hidden ? el.input : $('mCronologia')).focus(); }); }
  $('btnNuova').addEventListener('click', nuovaChat);
  $('btnChiudiCronologia').addEventListener('click', chiudiCronologia);
  el.velo.addEventListener('click', chiudiCronologia);

  /* ---------- diagnostica ---------- */
  const fmt = n => (n == null ? 'Non disponibile' : Number(n).toLocaleString('it-IT'));
  const usd = n => (n == null ? 'Non disponibile' : n > 0 && n < 0.000001 ? 'Meno di 0,000001 USD' : Number(n).toLocaleString('it-IT', { style: 'currency', currency: 'USD', currencyDisplay: 'code', minimumFractionDigits: 4, maximumFractionDigits: 6 }));
  const ATTIVITA = { chat: 'Conversazione', qa: 'Domanda', memory: 'Memoria', planning: 'Pianificazione', math: 'Calcolo', coding: 'Codice', writing: 'Scrittura', translation: 'Traduzione', summarization: 'Riassunto', analysis: 'Analisi' };
  const risultato = r => BADGE[r.verifica]?.[1] || ({ ok: 'Completata', errore: 'Errore', interrotta: 'Interrotta' }[r.esito] || r.esito || 'Non comunicato');
  function riga(a, b) { const d = document.createElement('div'); d.className = 'riga'; const x = document.createElement('span'); x.textContent = a; const y = document.createElement('span'); y.textContent = b; d.append(x, y); return d; }
  async function apriDiagnostica(richiesta) { rivela(el.vistaDiag); aggiornaSfondo(); $('dChiudi').focus(); await caricaDiagnostica(); if (richiesta && !el.vistaDiag.hidden) dettaglioRichiesta(richiesta); }
  function chiudiDiagnostica() { selezioneDiag++; congeda(el.vistaDiag, () => { el.vistaDiag.hidden = true; aggiornaSfondo(); $('mDiagnostica').focus(); }); }
  $('dChiudi').addEventListener('click', chiudiDiagnostica);
  $('diagAggiorna').addEventListener('click', caricaDiagnostica);
  async function caricaDiagnostica() {
    const aggiornamento = $('diagAggiorna'); if (aggiornamento.disabled) return;
    aggiornamento.disabled = true; $('diagStato').textContent = 'Aggiornamento in corso...';
    try {
      const [d, st] = await Promise.all([api('/api/diagnostics'), api('/api/status')]); S.stato = st;
      const storico = d.storico;
      $('diagCostoStorico').textContent = usd(storico?.costo);
      $('diagCostoOggi').textContent = usd(d.oggi.costo);
      $('diagChiamateStoriche').textContent = fmt(storico?.chiamate);
      $('diagPeriodo').textContent = !storico ? 'Intervallo storico non disponibile.' : storico.dal != null ? 'Dati conservati dal ' + new Date(storico.dal).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }) + '.' : 'Nessuna chiamata registrata nello storico.';
      const coperturaNota = storico && [storico.chiamate, storico.costiNoti, storico.costiMancanti].every(n => Number.isSafeInteger(n) && n >= 0)
        && storico.costiNoti + storico.costiMancanti === storico.chiamate;
      $('diagCopertura').textContent = !storico ? 'Copertura non determinabile: totale storico non disponibile in questa versione del server.' : !coperturaNota
        ? 'Copertura non determinabile: i conteggi dei costi sono mancanti o incoerenti.' : storico.costiMancanti > 0
        ? 'Totale parziale: ' + fmt(storico.costiNoti) + ' chiamate con costo comunicato, ' + fmt(storico.costiMancanti) + ' senza costo disponibile.'
        : 'Copertura completa: costo disponibile per tutte le ' + fmt(storico.chiamate) + ' chiamate registrate.';
      const schede = $('diagSchede'); schede.innerHTML = ''; const r = d.riepilogo.richieste;
      [[fmt(d.oggi.chiamate), 'Chiamate AI oggi'], [fmt((d.oggi.token_in || 0) + (d.oggi.token_out || 0)), 'Token oggi'],
       [fmt(r.richieste), 'Richieste negli ultimi 7 giorni'], [fmt(r.verificate), 'Controlli superati negli ultimi 7 giorni']]
        .forEach(([v, l]) => { const c = document.createElement('div'); c.className = 'scheda'; const b = document.createElement('b'), et = document.createElement('span'); b.textContent = v; et.textContent = l; c.append(b, et); schede.appendChild(c); });
      const mod = $('diagModelli'); mod.innerHTML = '';
      for (const [tier, m] of Object.entries(st.modelli.tiers)) mod.appendChild(riga(tier.toUpperCase(), (m.id || 'Non configurato') + ': ' + m.nota + (m.origine ? ' (' + m.origine + ')' : '')));
      if (st.modelli.errore) mod.appendChild(riga('Elenco modelli', st.modelli.errore));
      for (const p of d.riepilogo.perModello) mod.appendChild(riga('Uso di ' + p.tier + ' · 7 giorni', fmt(p.chiamate) + ' chiamate · ' + fmt(p.token_in + p.token_out) + ' token · tempo medio ' + (p.latenza_media != null ? fmt(p.latenza_media / 1000) + ' s' : 'Non disponibile') + ' · ' + usd(p.costo)));
      mod.appendChild(riga('Passaggi a un modello più capace · 7 giorni', fmt(r.escalation)));
      mod.appendChild(riga('Limiti abbonamento raggiunti oggi', fmt(d.oggi.limitiRilevati?.n || 0)));
      const tb = $('diagTabella').tBodies[0]; tb.innerHTML = '';
      for (const x of d.richieste) {
        const tr = document.createElement('tr'), quando = document.createElement('td'), apri = document.createElement('button');
        apri.type = 'button'; apri.className = 'diag-apri'; apri.textContent = data(x.creata); apri.setAttribute('aria-label', 'Apri richiesta del ' + data(x.creata));
        apri.addEventListener('click', () => dettaglioRichiesta(x.id, apri)); quando.appendChild(apri); tr.appendChild(quando);
        [ATTIVITA[x.categoria] || x.categoria || 'Non comunicata', x.tier_iniziale || 'Non comunicato', risultato(x), x.latenza_ms != null ? (x.latenza_ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' s' : 'Non disponibile', usd(x.costo)]
          .forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }); tb.appendChild(tr);
      }
      if (!d.richieste.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = 'Nessuna richiesta registrata.'; tr.appendChild(td); tb.appendChild(tr); }
      $('diagStato').textContent = 'Dati aggiornati alle ' + new Date().toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' }) + '.';
      const ta = $('auditTabella').tBodies[0]; ta.innerHTML = '';
      try {
        for (const x of await api('/api/audit?limite=50')) { const tr = document.createElement('tr'); [data(x.creato), x.integrazione || '-', x.azione || '-', x.livello || '-', x.esito, x.dettaglio || ''].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }); ta.appendChild(tr); }
        if (!ta.children.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = 'Nessuna operazione registrata.'; tr.appendChild(td); ta.appendChild(tr); }
      } catch (e) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = 'Registro non disponibile: ' + e.message; tr.appendChild(td); ta.appendChild(tr); }
    } catch (e) { $('diagStato').textContent = 'Aggiornamento non riuscito: ' + e.message + '. Gli eventuali dati già mostrati non sono stati aggiornati.'; }
    finally { aggiornamento.disabled = false; }
  }
  let selezioneDiag = 0;
  async function dettaglioRichiesta(id, origine) {
    const box = $('diagDettaglio'), selezione = ++selezioneDiag;
    box.hidden = false; box.textContent = 'Caricamento dei dettagli...';
    try {
      const r = await api('/api/diagnostics/' + id); if (selezione !== selezioneDiag || el.vistaDiag.hidden) return;
      box.innerHTML = ''; const testa = document.createElement('div'); testa.className = 'diag-dettaglio-testa';
      const h = document.createElement('h3'), chiudi = document.createElement('button'); h.textContent = 'Richiesta del ' + data(r.creata);
      chiudi.type = 'button'; chiudi.className = 'btn-neu testo piccolo'; chiudi.textContent = 'Chiudi dettagli'; chiudi.addEventListener('click', () => { selezioneDiag++; box.hidden = true; (origine?.isConnected === false ? $('dChiudi') : origine || $('dChiudi')).focus(); }); testa.append(h, chiudi); box.appendChild(testa);
      [['Esito', risultato(r)], ['Stato della richiesta', r.esito || 'Non comunicato'], ['Equivalente API', usd(r.costo)], ['Tempo totale', r.latenza_ms != null ? (r.latenza_ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' s' : 'Non disponibile'], ['Chiamate AI', fmt(r.chiamate)], ['Token in ingresso / uscita', fmt(r.token_in) + ' / ' + fmt(r.token_out)]]
        .forEach(([a, b]) => box.appendChild(riga(a, b)));
      if (r.errore) box.appendChild(riga('Errore', r.errore));
      const sezione = titolo => { const d = document.createElement('details'), sum = document.createElement('summary'); d.className = 'diag-sezione'; sum.textContent = titolo; d.appendChild(sum); box.appendChild(d); return d; };
      const p = r.piano || {}, scelta = sezione('Scelta del modello e tentativi');
      [['Attività', ATTIVITA[r.categoria] || r.categoria || '-'], ['Modello iniziale', r.modello_iniziale || 'Non comunicato'], ['Motivo della scelta', p.motivo || 'Non comunicato'], ['Verifica prevista', p.verifica?.modo || 'Non comunicata'], ['Motivo della verifica prevista', p.verifica?.motivo || 'Non comunicato'], ['Tentativi di risposta', fmt(r.tentativi)], ['Passaggi a un modello più capace', fmt(r.escalation)], ['Motivo del passaggio', r.motivo_escalation || '-'], ['Complessità / rischio', (p.complessita || '-') + ' / ' + (p.rischio || '-')]]
        .forEach(([a, b]) => scelta.appendChild(riga(a, b)));
      const chiamate = r.chiamateDettaglio || [], elenco = sezione('Chiamate AI · ' + chiamate.length);
      for (const c of chiamate) {
        const articolo = document.createElement('article'); articolo.className = 'diag-chiamata'; const titolo = document.createElement('h4');
        titolo.textContent = ({ produttore: 'Risposta', verificatore: 'Controllo AI' }[c.ruolo] || c.ruolo || 'Chiamata') + ' · ' + (c.modello || c.tier || 'Modello non comunicato'); articolo.appendChild(titolo);
        [['Esito del servizio', c.esito || '-'], ['Equivalente API', usd(c.costo)], ['Token in ingresso / uscita', fmt(c.token_in) + ' / ' + fmt(c.token_out)], ['Tempo', c.latenza_ms != null ? c.latenza_ms + ' ms' : 'Non disponibile'], ['Provider / tentativo', (c.provider || '-') + ' / ' + fmt(c.tentativo)], ['Fonte dei token / codice di uscita', (c.token_fonte || '-') + ' / ' + fmt(c.codice_uscita)]]
          .forEach(([a, b]) => articolo.appendChild(riga(a, b))); elenco.appendChild(articolo);
      }
      const eventi = sezione('Sequenza degli eventi'), ul = document.createElement('ul'); ul.className = 'eventi';
      for (const e of r.eventi || []) { const li = document.createElement('li'); li.textContent = e.tipo + ' · +' + Math.round(e.t || 0) + ' ms · ' + ['tentativo', 'modo', 'status', 'tier', 'modello', 'categoria', 'motivo', 'da', 'a', 'codice'].filter(k => e[k] != null).map(k => k + ': ' + e[k]).join(' ') + (e.semantico === true ? ' · controllo AI' : ''); ul.appendChild(li); } eventi.appendChild(ul);
      box.scrollIntoView({ behavior: document.documentElement.classList.contains('movimento-ridotto') ? 'auto' : 'smooth', block: 'start' }); box.focus({ preventScroll: true });
    } catch (e) { if (selezione === selezioneDiag) box.textContent = 'Dettagli non disponibili: ' + e.message; }
  }

  /* ---------- impostazioni e configurazione ---------- */
  function applicaPreferenze() {
    document.documentElement.dataset.tema = S.pref.tema;
    core.temaCambiato();
    core.movimento(S.pref.movimento || 'auto');
    if ($('selMovimento')) $('selMovimento').value = S.pref.movimento || 'auto';
    document.querySelectorAll('[data-tema]').forEach(b => { if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', String(b.dataset.tema === S.pref.tema)); });
    document.querySelectorAll('[data-modalita]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modalita === S.pref.modalita)));
    el.btnVoceOnOff.setAttribute('aria-pressed', String(S.pref.voceOn === '1')); el.btnVoceOnOff.textContent = 'Risposta vocale: ' + (S.pref.voceOn === '1' ? 'on' : 'off');
    el.btnMic.disabled = S.occupato || !modalitaMic();
    el.btnMic.title = !riconoscimento.supportato ? 'La dettatura funziona in Chrome' : (S.pref.modalita === 'testo' ? 'Passa a Voce o Mista per dettare' : 'Detta a voce');
    aggiornaMenu();
  }
  function nomeBrowser() { const u = navigator.userAgent; return /Firefox\//.test(u) ? 'Firefox' : /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'questo browser'; }
  // Spiega in chiaro perche dettatura o voce potrebbero non funzionare in questo browser.
  function suggerimentoBrowser() {
    const msg = [];
    if (!riconoscimento.supportato) msg.push('La dettatura non funziona in ' + nomeBrowser() + ': apri Orbit in Chrome.');
    if (!sintesi.supportata) msg.push('Sintesi vocale non supportata da questo browser.');
    else if (!sintesi.haVoceItaliana()) msg.push('Nessuna voce italiana: installa la voce locale di Orbit (node orbit/tools/installa-voce.js) oppure aggiungi l\'italiano tra le voci di Windows.');
    return msg.join(' ');
  }
  async function salvaPref(chiave, valore) {
    S.pref[chiave] = valore; applicaPreferenze();
    try { await api('/api/preferences', { metodo: 'PUT', corpo: { [chiave]: valore } }); } catch (e) { el.suggerimento.textContent = 'Preferenza non salvata: ' + e.message; }
  }
  async function riempiVoci() {
    await sintesi.inizializza();
    try {
      const s = await api('/api/voce/stato');
      $('notaRiconoscimento').textContent = s.motore === 'browser'
        ? 'Riconoscimento del browser: il produttore del browser puo ricevere l’audio. Orbit non conserva le registrazioni.'
        : s.motore === 'whisper' ? 'Riconoscimento locale con Whisper e parola Orbit con Vosk: l’audio viene elaborato sul PC, senza servizi cloud. Orbit non conserva le registrazioni.'
        : 'Motore di riconoscimento non identificato: non posso confermare dove viene elaborato l’audio.';
    } catch (e) { $('notaRiconoscimento').textContent = 'Stato del riconoscimento non disponibile: non posso confermare dove viene elaborato l’audio.'; }
    const sel = $('selVoce'); sel.innerHTML = '';
    $('selVelocita').value = S.pref.voceVelocita || '1';
    const voci = sintesi.voci();
    if (!voci.length) { const o = document.createElement('option'); o.textContent = sintesi.supportata ? 'Nessuna voce italiana installata' : 'Sintesi vocale non supportata'; sel.appendChild(o); sel.disabled = true; $('notaVoci').textContent = suggerimentoBrowser(); return; }
    sel.disabled = false;
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Automatica (la migliore disponibile)'; sel.appendChild(auto);
    for (const v of voci) { const o = document.createElement('option'); o.value = v.name; o.textContent = v.etichetta || (v.name + (v.localService === false ? ' (online)' : '')); if (v.name === S.pref.voceNome) o.selected = true; sel.appendChild(o); }
    $('selVelocita').value = S.pref.voceVelocita || '1';
    const motore = sintesi.locale.motore || '';
    const voceBrowser = S.pref.voceNome && S.pref.voceNome !== window.OrbitVoice.VOCE_LOCALE;
    const scelta = voci.find(v => v.name === S.pref.voceNome);
    let nota = 'Voce di Orbit non disponibile.';
    if (voceBrowser) nota = scelta?.localService === true ? 'Voce locale del browser: il testo viene elaborato sul dispositivo.'
      : 'Voce del browser: il produttore del browser puo ricevere il testo letto, anche dalle note personali.';
    else if (sintesi.locale.disponibile) {
      if (/ElevenLabs/.test(motore)) nota = 'Voce di Orbit con ElevenLabs (cloud): il testo letto, anche dalle note personali, viene inviato a ElevenLabs e consuma i crediti del tuo piano.' + (sintesi.locale.ripiego ? ' Se il servizio non e disponibile, Orbit usa Piper sul PC.' : '');
      else if (/Piper/.test(motore)) nota = 'Voce di Orbit con Piper: il testo viene elaborato sul PC, senza servizi cloud e senza crediti a consumo.';
      else nota = 'Motore della voce di Orbit non identificato: non posso confermare dove viene elaborato il testo.';
    }
    if (!voceBrowser && sintesi.locale.elevenlabs?.configurata) nota += ' ElevenLabs resta configurato: quando torna disponibile, Orbit puo inviare il testo al servizio cloud e consumare i crediti del piano.';
    $('notaVoci').textContent = nota + ' Se scegli una voce online del browser, il produttore del browser puo ricevere il testo letto.';
  }
  const ETICHETTA_LIVELLO = { lettura: 'Leggere dati', bozza: 'Preparare bozze', crea: 'Creare', amplia: 'Aggiungere a una esistente (con backup)', modifica: 'Riscrivere', irreversibile: 'Spostare, eliminare, inviare' };
  const ETICHETTA_DECISIONE = { consenti: 'Consenti', conferma: 'Chiedi conferma', nega: 'Nega' };
  // Collegamento a Google: l'accesso avviene nella pagina di Google (nel browser), Orbit non vede mai password o token.
  function riquadroGoogle() {
    const rg = document.createElement('div'); rg.className = 'riga';
    const info = document.createElement('span'); info.className = 'nota'; info.textContent = 'Controllo...';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn-neu testo piccolo'; btn.hidden = true;
    let timer = 0;
    async function aggiorna() {
      try {
        const s = await api('/api/google/stato');
        info.textContent = s.clientPresente ? s.messaggio : 'manca il file del client OAuth: Orbit lo cerca in ' + (s.cartella || '?') + '\\client.json (su questo computer)';
        btn.hidden = false; btn.textContent = s.collegato ? 'Scollega Google' : 'Collega Google'; btn.dataset.collegato = s.collegato ? '1' : '0';
        if (s.collegato) clearInterval(timer);
      } catch (e) { info.textContent = e.message; }
    }
    btn.addEventListener('click', async () => {
      try {
        if (btn.dataset.collegato === '1') { await api('/api/google/scollega', { metodo: 'POST', corpo: {} }); await aggiorna(); return; }
        const st = await api('/api/google/stato');
        if (!st.clientPresente) { info.textContent = 'Non posso collegare: manca ' + st.cartella + '\\client.json'; return; }
        await api('/api/google/collega', { metodo: 'POST', corpo: {} });
        info.textContent = 'Accedi nella scheda di Google che si e aperta...';
        clearInterval(timer); timer = setInterval(() => { if (!el.dlg.open) clearInterval(timer); else aggiorna(); }, 3000);
      } catch (e) { info.textContent = e.message; }
    });
    rg.append(info, btn); aggiorna();
    return rg;
  }
  async function mostraIntegrazioni() {
    const box = $('impIntegrazioni'); box.textContent = 'Controllo in corso...';
    let lista;
    try { lista = await api('/api/integrazioni'); } catch (e) { box.textContent = e.message; return; }
    box.innerHTML = '';
    if (!lista.length) { box.textContent = 'Nessuna integrazione e ancora collegata in questa versione.'; return; }
    for (const i of lista) {
      const blocco = document.createElement('div'); blocco.className = 'integrazione';
      const testa = document.createElement('div'); testa.className = 'riga';
      const nome = document.createElement('span'); nome.textContent = i.nome + (i.abilitata && !i.configurata ? ' (da configurare: ' + i.messaggio + ')' : '');
      const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'btn-neu testo piccolo'; sw.setAttribute('aria-pressed', String(i.abilitata)); sw.textContent = i.abilitata ? 'Attiva' : 'Disattivata';
      sw.addEventListener('click', async () => { try { await api('/api/integrazioni/' + i.id, { metodo: 'PUT', corpo: { abilitata: !i.abilitata } }); } catch (e) { el.suggerimento.textContent = e.message; } mostraIntegrazioni(); });
      testa.append(nome, sw); blocco.appendChild(testa);
      if (i.id === 'google') blocco.appendChild(riquadroGoogle());
      const livelli = [...new Set(i.strumenti.map(s => s.livello))];
      for (const l of livelli) {
        const rg = document.createElement('div'); rg.className = 'riga';
        const et = document.createElement('span'); et.textContent = ETICHETTA_LIVELLO[l] || l;
        const sel = document.createElement('select'); sel.className = 'neu-incavo'; sel.setAttribute('aria-label', ETICHETTA_LIVELLO[l] + ' per ' + i.nome);
        const ammesse = (l === 'modifica' || l === 'irreversibile') ? ['conferma', 'nega'] : ['consenti', 'conferma', 'nega'];
        for (const d of ammesse) { const o = document.createElement('option'); o.value = d; o.textContent = ETICHETTA_DECISIONE[d]; if (i.livelli[l] === d) o.selected = true; sel.appendChild(o); }
        sel.addEventListener('change', async () => { try { await api('/api/integrazioni/' + i.id, { metodo: 'PUT', corpo: { livello: l, decisione: sel.value } }); } catch (e) { el.suggerimento.textContent = e.message; } mostraIntegrazioni(); });
        rg.append(et, sel); blocco.appendChild(rg);
      }
      box.appendChild(blocco);
    }
  }
  function apriImpostazioni() { riempiVoci(); mostraStatoImpostazioni(); mostraIntegrazioni(); el.dlg.showModal(); }
  async function mostraStatoImpostazioni() {
    const box = $('impStato'); box.innerHTML = 'Controllo in corso...';
    try {
      const st = await api('/api/status'); S.stato = st; box.innerHTML = '';
      const r = (a, b, cls) => { const d = riga(a, b); if (cls) d.lastChild.className = cls; box.appendChild(d); };
      r('Accesso a Claude', st.abbonamento.ok ? 'abbonamento claude.ai (piano ' + (st.abbonamento.piano || '?') + '), nessuna chiave API' : (st.abbonamento.errore || 'non collegato'), st.abbonamento.ok ? 'ok' : 'ko');
      r('Consumo (limiti di Orbit)', st.limiti.chiamatePerOra + ' chiamate/ora, ' + st.limiti.chiamatePerGiorno + ' al giorno; oggi ' + (st.oggi.chiamate || 0), 'ok');
      r('File di configurazione', st.fileEnv + (st.fileEnvTrovato ? '' : ' (non trovato)'));
      for (const [t, m] of Object.entries(st.modelli.tiers)) r('Modello ' + t, (m.id || 'non configurato') + ' - ' + m.nota, m.disponibile === true ? 'ok' : m.disponibile === false ? 'ko' : 'att');
      r('Memoria del vault', st.memoria.ok ? st.memoria.note + ' note, sola lettura' : (st.memoria.errore || 'non disponibile'), st.memoria.ok ? 'ok' : 'ko');
      for (const p of st.configurazione) r(p.livello === 'error' ? 'Errore di configurazione' : 'Avviso', p.messaggio, p.livello === 'error' ? 'ko' : 'att');
    } catch (e) { box.textContent = e.message; }
  }
  async function verificaConfigurazione() {
    try {
      const st = await api('/api/status'); S.stato = st; S.tracing = st.performanceTrace === true;
      const errori = st.configurazione.filter(p => p.livello === 'error');
      if (!st.abbonamento.ok) errori.push({ messaggio: st.abbonamento.errore || 'Claude Code non e collegato al tuo abbonamento.' });
      const senzaModelli = st.abbonamento.ok && !Object.values(st.modelli.tiers).some(m => m.id && m.disponibile !== false);
      if (errori.length || senzaModelli) {
        el.avviso.hidden = false; el.avviso.className = 'avviso errore';
        el.avviso.textContent = errori.length ? errori.map(e => e.messaggio).join(' ') : 'Nessun modello utilizzabile: ' + (st.modelli.errore || 'controlla ORBIT_MODEL_HAIKU, ORBIT_MODEL_SONNET e ORBIT_MODEL_OPUS.');
      } else if (!st.memoria.ok) {
        el.avviso.hidden = false; el.avviso.className = 'avviso'; el.avviso.textContent = 'Memoria del vault non disponibile: ' + (st.memoria.errore || '') + ' Orbit funziona lo stesso, ma senza consultare i tuoi appunti.';
      } else el.avviso.hidden = true;
    } catch (e) { el.avviso.hidden = false; el.avviso.className = 'avviso errore'; el.avviso.textContent = 'Non riesco a raggiungere il server di Orbit. La finestra di avvio e ancora aperta?'; }
  }
  document.querySelectorAll('[data-modalita]').forEach(b => b.addEventListener('click', () => salvaPref('modalita', b.dataset.modalita)));
  document.querySelectorAll('button[data-tema]').forEach(b => b.addEventListener('click', () => salvaPref('tema', b.dataset.tema)));
  el.btnVoceStop.addEventListener('click', fermaVoce);
  el.btnVoceOnOff.addEventListener('click', () => { const v = S.pref.voceOn === '1' ? '0' : '1'; if (v === '0') fermaVoce(); salvaPref('voceOn', v); });
  $('selVelocita').addEventListener('change', e => salvaPref('voceVelocita', e.target.value));
  $('selMovimento').addEventListener('change', e => salvaPref('movimento', e.target.value));
  $('btnProvaVoce').addEventListener('click', () => parla('Ciao' + (S.stato && S.stato.utente && S.stato.utente.nome ? ' ' + S.stato.utente.nome : '') + ', sono Orbit. Questa e la voce che sentirai leggendo le mie risposte.'));
  $('selVoce').addEventListener('change', e => { salvaPref('voceNome', e.target.value); riempiVoci(); });
  $('btnAggiornaModelli').addEventListener('click', async () => { try { await api('/api/models/refresh', { metodo: 'POST', corpo: {} }); } catch (e) { /* lo stato mostra l'errore */ } mostraStatoImpostazioni(); verificaConfigurazione(); });
  $('btnProvaModelli').addEventListener('click', async () => {
    if (!await chiediConferma({ titolo: 'Provare i tre modelli?', testo: 'Orbit manda una richiesta minima a Haiku, Sonnet e Opus con il tuo abbonamento Claude. Consuma pochissimo dei limiti, ma non e gratis in termini di limiti.', conferma: 'Provali' })) return;
    const b = $('btnProvaModelli'), nota = $('notaProva');
    b.disabled = true; b.classList.add('caricamento'); nota.textContent = 'Prova in corso, puo richiedere qualche decina di secondi...';
    try {
      const r = await api('/api/models/probe', { metodo: 'POST', corpo: {} });
      nota.textContent = 'Risultato: ' + r.risultati.map(m => m.id + ' ' + (m.verificato ? (m.disponibile ? 'disponibile' : 'non disponibile nel tuo piano') : 'non provato' + (m.errore ? ' (' + m.errore + ')' : ''))).join(', ') + '.';
    } catch (e) { nota.textContent = 'Prova non riuscita: ' + e.message; }
    b.disabled = false; b.classList.remove('caricamento');
    mostraStatoImpostazioni(); verificaConfigurazione();
  });
  function chiudiImpostazioni() { congeda(el.dlg, () => el.dlg.close()); }
  el.dlg.addEventListener('click', e => { if (e.target === el.dlg) { const r = el.dlg.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) chiudiImpostazioni(); } });
  el.dlg.addEventListener('cancel', e => { e.preventDefault(); chiudiImpostazioni(); });
  el.dlg.querySelector('form').addEventListener('submit', e => { e.preventDefault(); chiudiImpostazioni(); });
  if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = riempiVoci;

  /* ---------- avvio ---------- */
  async function avvia() {
    const voceLocalePronta = sintesi.inizializza();     // in parallelo con lo stato: non rallenta l'avvio
    applica(S.core);
    try { const p = await api('/api/status'); S.stato = p; S.tracing = p.performanceTrace === true; Object.assign(S.pref, p.preferenze || {}); } catch (e) { /* verificaConfigurazione mostra l'errore */ }
    await voceLocalePronta;
    applicaPreferenze();
    if (S.pref.parolaAttivazione === '1') { if (attivazione.supportata) attivazione.avvia(); else { S.pref.parolaAttivazione = '0'; applicaPreferenze(); } }
    await verificaConfigurazione();
    caricaCronologia();
    el.nucleo.focus({ preventScroll: true });
  }
  // Diagnostica per i test: stato reale dell'interfaccia, senza effetti.
  window.__orbit = { conferma: chiediConferma, confermaOperazione: chiediConfermaOperazione, aggiornaVoci: riempiVoci, stato: () => ({ core: S.core, mostrato: S.mostrato, aperta: S.aperta, risposte: S.risposte.length, rete: core.diagnostica() }), evento, avanza: (n, dt) => core.avanza(n, dt), forzaMovimento: si => core.forzaMovimento(si) };
  avvia();
})();
