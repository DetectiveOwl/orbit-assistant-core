'use strict';
// Interazione vocale dietro interfacce sostituibili: oggi usa le API del browser (Web Speech), domani un servizio AI.
//  - Riconoscimento: avvia(opzioni) / ferma(). Orbit non registra ne salva audio.
//  - Sintesi: parla(testo, opzioni) / ferma(). Voce italiana scelta tra quelle disponibili.
// Nota privacy: in Chrome ed Edge il riconoscimento del browser puo inviare l'audio al servizio del produttore del browser.
(function (root) {
  const oraVoce = win => (win.performance || performance).now();
  const MESSAGGI_ERRORE = {
    'not-allowed': 'Permesso al microfono negato. Consentilo dall\'icona accanto all\'indirizzo della pagina e riprova.',
    'service-not-allowed': 'Il browser non permette il riconoscimento vocale su questa pagina.',
    'no-speech': 'Non ho sentito niente, riprova.',
    'audio-capture': 'Non trovo nessun microfono collegato.',
    'network': 'Il riconoscimento vocale del browser ha bisogno di una connessione a internet.',
    'language-not-supported': 'Il riconoscimento in italiano non e supportato da questo browser.'
  };

  // Vecchio motore (riconoscimento di Chrome, invia l'audio al servizio del browser): resta solo se ORBIT_STT_MOTORE=browser.
  function creaRiconoscimentoBrowser(win) {
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    let rec = null, attivo = false, livello = null;
    return {
      supportato: !!SR,
      attivo: () => attivo,
      // opzioni: { lingua, onInterim(testo), onFinale(testo), onFine(), onErrore(messaggio), onLivello(0..1) }
      avvia(o) {
        if (!SR) { o.onErrore('Il riconoscimento vocale funziona su Chrome o Edge: questo browser non lo supporta.'); return false; }
        if (attivo) return false;
        rec = new SR();
        rec.lang = o.lingua || 'it-IT'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
        let finale = '';
        rec.onstart = () => { attivo = true; avviaLivello(o.onLivello); if (o.onInizio) o.onInizio(); };
        rec.onresult = e => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) finale += r[0].transcript; else interim += r[0].transcript;
          }
          if (o.onInterim) o.onInterim((finale + interim).trim());
        };
        rec.onerror = e => { if (e.error !== 'aborted') o.onErrore(MESSAGGI_ERRORE[e.error] || ('Errore del microfono: ' + e.error)); };
        rec.onend = () => { attivo = false; fermaLivello(); if (o.onFine) o.onFine(finale.trim()); };
        try { rec.start(); } catch (e) { attivo = false; o.onErrore('Non riesco ad avviare il microfono.'); return false; }
        return true;
      },
      ferma() { if (rec && attivo) { try { rec.stop(); } catch (e) { /* gia fermo */ } } }
    };

    // Misura del livello del microfono solo per animare Orbit Core: l'audio non viene registrato ne inviato.
    function avviaLivello(cb) {
      if (!cb || !win.navigator.mediaDevices || !win.navigator.mediaDevices.getUserMedia || !(win.AudioContext || win.webkitAudioContext)) return;
      win.navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (!attivo) { stream.getTracks().forEach(t => t.stop()); return; }
        const ctx = new (win.AudioContext || win.webkitAudioContext)();
        const an = ctx.createAnalyser(); an.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        let raf = 0;
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let max = 0; for (const v of buf) max = Math.max(max, Math.abs(v - 128));
          cb(Math.min(1, max / 64));
          raf = win.requestAnimationFrame(tick);
        };
        tick();
        livello = { stop() { win.cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); try { ctx.close(); } catch (e) { /* gia chiuso */ } cb(0); } };
      }).catch(() => { /* il livello e solo estetico: il riconoscimento continua */ });
    }
    function fermaLivello() { if (livello) { livello.stop(); livello = null; } }
  }

  function creaSintesi(win) {
    const synth = win.speechSynthesis || null;
    let parlando = false, turno = 0;
    // Punteggio di qualita presunta: le voci neurali o "naturali" e quelle online (Google, Microsoft Online) suonano molto meglio di quelle SAPI locali.
    function punteggio(x) {
      const n = x.name || '';
      let p = 0;
      if (/natural|neural/i.test(n)) p += 100;
      if (/online/i.test(n)) p += 50;
      if (/google/i.test(n)) p += 40;
      if (/premium|enhanced|siri|elsa|isabella|diego|cosimo/i.test(n)) p += 20;
      if (x.localService === false) p += 10;
      if ((x.lang || '').replace('_', '-').toLowerCase() === 'it-it') p += 5;
      return p;
    }
    // Solo voci italiane, dalla migliore alla peggiore. Se non ce ne sono, Orbit NON legge in italiano con una voce straniera.
    function voci() {
      return synth ? synth.getVoices().filter(x => x.lang && x.lang.toLowerCase().replace('_', '-').startsWith('it')).sort((a, b) => punteggio(b) - punteggio(a)) : [];
    }
    function scegli(nome) {
      const v = voci();
      return (nome && v.find(x => x.name === nome)) || v[0] || null;
    }
    return {
      supportata: !!synth,
      voci,
      haVoceItaliana: () => voci().length > 0,
      inCorso: () => parlando,
      // opzioni: { voce, velocita, onInizio, onFine, onBoundary, onErrore }
      parla(testo, o = {}) {
        const mioTurno = ++turno; parlando = false;
        if (synth) synth.cancel();
        if (!synth || !testo) { if (o.onFine) o.onFine(); return; }
        const scelta = scegli(o.voce);
        if (!scelta) { if (o.onErrore) o.onErrore('Questo browser non ha nessuna voce italiana: non leggo la risposta con una voce straniera. Installa una voce italiana in Windows (lingua italiana con la sintesi vocale) oppure prova un altro browser.'); if (o.onFine) o.onFine(); return; }
        const frasi = (testo.match(/[^.!?;:]+[.!?;:]*/g) || [testo]).map(s => s.trim()).filter(Boolean);
        if (!frasi.length) { if (o.onFine) o.onFine(); return; }
        parlando = true;
        const attuale = () => mioTurno === turno && parlando;
        frasi.forEach((f, i) => {
          if (!attuale()) return;
          const u = new win.SpeechSynthesisUtterance(f);
          u.lang = 'it-IT'; u.rate = Number(o.velocita) || 1; u.pitch = 1;
          u.voice = scelta;
          let iniziata = false, finita = false;
          if (i === 0) u.onstart = () => {
            if (!attuale() || iniziata || finita) return;
            iniziata = true; if (o.onInizio) o.onInizio();
            if (attuale() && o.onAudio) o.onAudio();
          };
          u.onboundary = () => { if (attuale() && !finita && o.onBoundary) o.onBoundary(); };
          u.onend = () => {
            if (!attuale() || finita) return;
            finita = true;
            if (i !== frasi.length - 1) return;
            parlando = false; if (o.onRiproduzioneFine) o.onRiproduzioneFine();
            if (mioTurno === turno && o.onFine) o.onFine();
          };
          u.onerror = e => {
            if (!attuale() || finita) return;
            finita = true; parlando = false;
            if (e.error !== 'canceled' && e.error !== 'interrupted' && o.onErrore) o.onErrore('La sintesi vocale non e riuscita (' + e.error + ').');
            if (mioTurno === turno && o.onFine) o.onFine();
          };
          synth.speak(u);
        });
      },
      ferma() { turno++; parlando = false; if (synth) synth.cancel(); }
    };
  }

  // ---------- voce locale Orbit (Piper) con ripiego sulle voci del browser ----------
  const VOCE_LOCALE = '__locale__';

  // Spezza il testo in blocchi da leggere uno alla volta: il primo e corto, cosi la voce parte subito.
  function spezzaPerVoce(testo) {
    const frasi = String(testo).split(/(?<=[.!?;:])\s+/).map(s => s.trim()).filter(Boolean);
    const blocchi = [];
    let corrente = '';
    for (const f of frasi) {
      const minimo = blocchi.length === 0 ? 25 : 80;
      corrente = corrente ? corrente + ' ' + f : f;
      if (corrente.length >= minimo) { blocchi.push(corrente); corrente = ''; }
    }
    if (corrente) blocchi.push(corrente);
    return blocchi.flatMap(b => (b.length <= 450 ? [b] : b.split(/(?<=,)\s+/).reduce((acc, p) => { const u = acc[acc.length - 1]; if (u !== undefined && (u + ' ' + p).length <= 450) acc[acc.length - 1] = u + ' ' + p; else acc.push(p); return acc; }, [])));
  }

  function creaSintesiOrbit(win, { fetchFn } = {}) {
    const browser = creaSintesi(win);
    const chiama = fetchFn || (win.fetch ? win.fetch.bind(win) : null);
    let locale = { disponibile: false, voce: null };
    let turno = 0, parlando = false, elemento = null, urlCorrente = null, ctx = null;

    async function inizializza() {
      try {
        const r = await chiama('/api/tts/stato', { headers: { 'X-Orbit': '1' } });
        locale = r.ok ? await r.json() : { disponibile: false, voce: null };
      } catch (e) { locale = { disponibile: false, voce: null }; }
      return locale;
    }
    async function scaricaAudio(testo, velocita, richiesta) {
      const r = await chiama('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orbit': '1' }, body: JSON.stringify({ testo, velocita: Number(velocita) || 1, richiesta }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.errore || ('Errore ' + r.status)); }
      const blob = await r.blob(); blob.residua = Number(r.headers && r.headers.get ? r.headers.get('X-Orbit-Residua') : 0) || 1;   // parte della velocita che il servizio non copre
      return blob;
    }
    function riproduci(blob, velocita, onLivello, mioTurno, onAudio) {
      return new Promise((resolve, reject) => {
        const url = win.URL.createObjectURL(blob);
        const el = new win.Audio(url);
        elemento = el; urlCorrente = url;
        el.playbackRate = blob.residua || 1;      // Piper applica la velocita nell'audio; ElevenLabs arriva a 1,2x e il resto lo fa il browser (tono invariato)
        let analizzatore = null, buf = null, raf = 0, pulito = false;
        if (onLivello && (win.AudioContext || win.webkitAudioContext)) {
          try {
            ctx = ctx || new (win.AudioContext || win.webkitAudioContext)();
            const src = ctx.createMediaElementSource(el);
            analizzatore = ctx.createAnalyser(); analizzatore.fftSize = 256;
            src.connect(analizzatore); analizzatore.connect(ctx.destination);
            buf = new Uint8Array(analizzatore.frequencyBinCount);
          } catch (e) { analizzatore = null; }
        }
        const tick = () => {
          if (!analizzatore || pulito || mioTurno !== turno) return;
          analizzatore.getByteTimeDomainData(buf);
          let max = 0; for (const v of buf) max = Math.max(max, Math.abs(v - 128));
          onLivello(Math.min(1, max / 70));              // livello reale dell'audio che sta uscendo
          if (!pulito && mioTurno === turno) raf = win.requestAnimationFrame(tick);
        };
        const pulisci = () => {
          if (pulito) return;
          pulito = true; win.cancelAnimationFrame(raf); win.URL.revokeObjectURL(url);
          if (urlCorrente === url) urlCorrente = null;
          if (mioTurno === turno && onLivello) onLivello(0);
        };
        el.onended = () => { pulisci(); resolve(); };
        let iniziato = false;
        el.onplaying = () => { if (!iniziato && !pulito && mioTurno === turno) { iniziato = true; if (onAudio) onAudio(); } };
        el.onerror = () => { pulisci(); reject(new Error('Riproduzione audio non riuscita.')); };
        el.onpause = () => { if (mioTurno !== turno) { pulisci(); resolve(); } };
        if (ctx && ctx.state === 'suspended') ctx.resume();
        el.play().then(tick, e => { pulisci(); reject(e); });
      });
    }

    function usaLocale(voce) { return locale.disponibile && (voce === VOCE_LOCALE || !voce); }
    const elencoVoci = () => {
      const b = browser.voci();
      return locale.disponibile ? [{ name: VOCE_LOCALE, etichetta: locale.voce + ' (consigliata)', locale: true }].concat(b) : b;
    };

    return {
      get supportata() { return browser.supportata || locale.disponibile; },
      get locale() { return locale; },
      inizializza,
      voci: elencoVoci,
      browserVoci: browser.voci,
      haVoceItaliana: () => locale.disponibile || browser.haVoceItaliana(),
      inCorso: () => parlando || browser.inCorso(),
      // opzioni: { voce, velocita, onInizio, onFine, onBoundary, onLivello, onErrore }
      parla(testo, o = {}) {
        if (!usaLocale(o.voce)) return browser.parla(testo, o);
        const blocchi = spezzaPerVoce(testo);
        if (!blocchi.length) { if (o.onFine) o.onFine(); return; }
        browser.ferma();
        const mioTurno = ++turno;
        parlando = true;
        const audio = new Array(blocchi.length);
        if (o.onSintesi) o.onSintesi();
        if (mioTurno !== turno) return;
        const prepara = i => { if (i < blocchi.length && !audio[i]) { audio[i] = scaricaAudio(blocchi[i], o.velocita, o.richiesta); audio[i].catch(() => {}); } };
        prepara(0); prepara(1);
        (async () => {
          for (let i = 0; i < blocchi.length; i++) {
            const blob = await audio[i];
            if (mioTurno !== turno) return;
            prepara(i + 2);
            if (i === 0 && o.onInizio) o.onInizio();
            if (mioTurno !== turno) return;
            await riproduci(blob, o.velocita, o.onLivello, mioTurno, i === 0 ? o.onAudio : null);
            if (mioTurno !== turno) return;
          }
          parlando = false; if (o.onRiproduzioneFine) o.onRiproduzioneFine();
          if (mioTurno === turno && o.onFine) o.onFine();
        })().catch(e => {
          if (mioTurno !== turno) return;
          parlando = false;
          if (o.onErrore) o.onErrore('La voce locale non e riuscita: ' + (e && e.message ? e.message : e));
          if (mioTurno === turno && o.onFine) o.onFine();
        });
      },
      ferma() {
        turno++; parlando = false;
        if (elemento) { try { elemento.pause(); } catch (e) { /* gia fermo */ } }
        browser.ferma();
      }
    };
  }

  // ---------- parola di attivazione "Orbit" ----------
  // Ascolto continuo con il riconoscimento del browser: il testo parlato fuori dalla parola di attivazione viene scartato subito
  // (non si salva, non si invia a Orbit). Attenzione: finche e attivo, il browser (Chrome) trasmette l'audio al suo servizio di riconoscimento.
  const RE_ATTIVAZIONE = /\b(orbit|orbita|orbite|orbid|orbyt|or bit|orbis|orbi)\b[\s,.:;!?-]*/gi;

  // Trova l'ultima occorrenza della parola di attivazione e restituisce quello che segue.
  function estraiComando(trascritto) {
    const t = String(trascritto || '');
    let ultimo = null, m;
    RE_ATTIVAZIONE.lastIndex = 0;
    while ((m = RE_ATTIVAZIONE.exec(t)) !== null) ultimo = m;
    if (!ultimo) return { attivata: false, comando: '' };
    return { attivata: true, comando: t.slice(ultimo.index + ultimo[0].length).trim() };
  }

  // callbacks: { onStato(stato, dettaglio), onAttivata(), onTesto(parziale), onComando(testo), onErrore(msg) }
  // stati: 'spento', 'attesa' (in ascolto della parola), 'attivata' (ha sentito Orbit, aspetta il comando), 'pausa', 'errore'
  function creaParolaBrowser(win, cb, { attesaComandoMs = 8000, riavvioMs = 400 } = {}) {
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    let rec = null, abilitata = false, pausata = false, attivata = false, timer = 0, indice = 0, riavvio = 0;
    const stato = (s, d) => { if (cb.onStato) cb.onStato(s, d); };
    const spegniTimer = () => { clearTimeout(timer); timer = 0; };
    function disattiva() { attivata = false; spegniTimer(); }
    function finisci(testo) { disattiva(); try { rec && rec.stop(); } catch (e) { /* gia fermo */ } pausata = true; stato('pausa'); if (cb.onComando) cb.onComando(testo); }
    function segnalaAttivazione() {
      if (attivata) return;
      attivata = true; stato('attivata');
      if (cb.onAttivata) cb.onAttivata();
      timer = setTimeout(() => { disattiva(); if (cb.onTesto) cb.onTesto(''); stato('attesa'); }, attesaComandoMs);
    }
    function avviaSessione() {
      if (!abilitata || pausata || rec) return;
      rec = new SR();
      rec.lang = 'it-IT'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      indice = 0;
      rec.onresult = e => {
        for (let i = Math.max(e.resultIndex, indice); i < e.results.length; i++) {
          const r = e.results[i];
          const testo = r[0].transcript;
          const est = estraiComando(testo);
          if (!r.isFinal) {
            if (est.attivata) { segnalaAttivazione(); if (cb.onTesto) cb.onTesto(est.comando); }
            else if (attivata && cb.onTesto) cb.onTesto(testo.trim());
            continue;
          }
          indice = i + 1;
          if (est.attivata) {
            segnalaAttivazione();
            if (est.comando) return finisci(est.comando);
          } else if (attivata && testo.trim()) {
            return finisci(testo.trim());
          }                                           // fuori dalla parola di attivazione: scartato
        }
      };
      rec.onerror = e => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
          abilitata = false; disattiva(); stato('errore', e.error);
          if (cb.onErrore) cb.onErrore(MESSAGGI_ERRORE[e.error] || ('Errore del microfono: ' + e.error));
          return;
        }
        if (cb.onErrore && e.error === 'network') cb.onErrore(MESSAGGI_ERRORE.network);
      };
      rec.onend = () => {
        rec = null; disattiva();
        if (abilitata && !pausata) { clearTimeout(riavvio); riavvio = setTimeout(avviaSessione, riavvioMs); stato('attesa'); }
      };
      try { rec.start(); stato('attesa'); } catch (e) { rec = null; }
    }
    return {
      supportata: !!SR,
      attiva: () => abilitata,
      avvia() { if (!SR) { if (cb.onErrore) cb.onErrore('La parola di attivazione richiede Chrome: questo browser non ha il riconoscimento vocale.'); return false; } abilitata = true; pausata = false; avviaSessione(); return true; },
      ferma() { abilitata = false; pausata = false; disattiva(); clearTimeout(riavvio); const r = rec; rec = null; if (r) { try { r.abort(); } catch (e) { /* gia fermo */ } } stato('spento'); },
      pausa() { pausata = true; disattiva(); clearTimeout(riavvio); const r = rec; rec = null; if (r) { r.onend = null; try { r.abort(); } catch (e) { /* gia fermo */ } } if (abilitata) stato('pausa'); },
      riprendi() { if (!abilitata) return; pausata = false; clearTimeout(riavvio); riavvio = setTimeout(avviaSessione, riavvioMs); }
    };
  }

  // =====================================================================================================================
  // Riconoscimento LOCALE (predefinito): microfono e pause nel browser, parola "Orbit" con Vosk e trascrizione con Whisper Small
  // sul PC, tramite il backend di Orbit (/api/voce/*). Nessun audio va in rete ne viene salvato. Vedi docs/WHISPER-STT.md.
  // Stesse interfacce e stessi callback del vecchio motore, cosi l'interfaccia (app.js) non cambia.
  // =====================================================================================================================
  const HZ = 16000, FRAME = 320;                     // 20 ms a 16 kHz
  const MARGINE_FRAME = 15;                          // 300 ms di audio conservati prima e dopo il parlato quando si taglia il silenzio
  const MSG_LOCALE = {
    nonInstallato: 'Il riconoscimento vocale locale non e installato: esegui node orbit/tools/installa-stt.js e riavvia Orbit.',
    backend: 'Il riconoscimento vocale locale non risponde.',
    vuoto: 'Non ho sentito niente, riprova.',
    inaffidabile: 'Non ho capito bene, riprova.'
  };

  // Stato del backend vocale, chiesto una volta (avvia anche il caricamento di Whisper e Vosk sul server).
  function creaStatoVoce(win, chiama) {
    let promessa = null, ultimo = null;
    return {
      get ultimo() { return ultimo; },
      leggi(forza) {
        if (!promessa || forza) {
          promessa = chiama('/api/voce/stato', { headers: { 'X-Orbit': '1' } }).then(r => (r.ok ? r.json() : null)).catch(() => null)
            .then(j => { ultimo = j; return j; });
        }
        return promessa;
      }
    };
  }

  // Rilevamento del parlato per energia. Il rumore di fondo e il minimo recente (scende in fretta, sale piano sui frame senza parlato)
  // e una soglia con isteresi lo separa dal parlato. Se il livello resta alto e quasi costante per piu di bloccoMs non e parlato ma
  // rumore (ventola, ronzio, guadagno automatico del microfono): la stima si ricalibra su quel livello e il silenzio torna rilevabile.
  // Il parlato vero varia di molti dB da una sillaba all'altra e non scatta mai questa ricalibrazione.
  function creaVad({ margineDb = 9, margineFineDb = 6, minimoDb = -52, bloccoMs = 4000, variazioneMaxDb = 2 } = {}) {
    let rumore = -60, inParlato = false, durata = 0, media = 0, scarto = 0;
    return frame => {
      let s = 0; for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
      const db = 10 * Math.log10(s / frame.length / (32768 * 32768) + 1e-12);
      let parlato = db > (inParlato ? Math.max(rumore + margineFineDb, minimoDb - 3) : Math.max(rumore + margineDb, minimoDb));
      if (parlato) {
        durata += 20;
        if (durata === 20) { media = db; scarto = 0; } else { const d = db - media; media += d * 0.02; scarto += (Math.abs(d) - scarto) * 0.02; }
        if (durata >= bloccoMs && scarto < variazioneMaxDb) { rumore = media; parlato = false; durata = 0; }
      } else durata = 0;
      if (db < rumore) rumore = rumore * 0.8 + db * 0.2; else if (!parlato) rumore = rumore * 0.97 + db * 0.03;
      rumore = Math.max(-75, rumore);                // un frame di silenzio digitale non deve azzerare la stima
      inParlato = parlato;
      return { parlato, db, rumore };
    };
  }

  // Microfono -> frame PCM Int16 da 20 ms a 16 kHz. Cancellazione dell'eco e del rumore del browser attive.
  function creaCattura(win, { onFrame, onErrore }) {
    let stream = null, ctx = null, nodo = null, src = null, muto = null, resto = new Float32Array(0), pos = 0, accumulo = [];
    const AC = win.AudioContext || win.webkitAudioContext;
    function chiudi() {
      try { if (nodo) { nodo.onaudioprocess = null; nodo.disconnect(); } if (src) src.disconnect(); if (muto) muto.disconnect(); } catch (e) { /* gia scollegati */ }
      if (stream) stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
      if (ctx) { try { ctx.close(); } catch (e) { /* gia chiuso */ } }
      stream = ctx = nodo = src = muto = null; resto = new Float32Array(0); pos = 0; accumulo = [];
    }
    async function apri() {
      if (!win.navigator.mediaDevices || !win.navigator.mediaDevices.getUserMedia || !AC) throw Object.assign(new Error('audio'), { codice: 'audio-capture' });
      try {
        stream = await win.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      } catch (e) {
        throw Object.assign(new Error(e.name), { codice: e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'not-allowed' : 'audio-capture' });
      }
      stream.getTracks().forEach(t => { t.onended = () => { chiudi(); onErrore('audio-capture'); }; });   // microfono scollegato
      try { ctx = new AC({ sampleRate: HZ }); } catch (e) { ctx = new AC(); }      // 16 kHz diretti: il browser ricampiona con un filtro vero; se non puo, resta la media sui campioni
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* riprova al prossimo gesto */ } }
      src = ctx.createMediaStreamSource(stream);
      nodo = ctx.createScriptProcessor(ctx.sampleRate > 24000 ? 4096 : 1024, 1, 1);       // circa 85 ms (48 kHz) o 64 ms (16 kHz) per blocco: la fine del parlato non deve arrivare in ritardo
      muto = ctx.createGain(); muto.gain.value = 0;
      const passo = ctx.sampleRate / HZ;
      nodo.onaudioprocess = ev => {
        const ingresso = ev.inputBuffer.getChannelData(0);
        const tutto = new Float32Array(resto.length + ingresso.length); tutto.set(resto); tutto.set(ingresso, resto.length);
        // ricampionamento a 16 kHz con media sui campioni di ogni intervallo (filtro passa basso semplice)
        while (pos + passo <= tutto.length) {
          const a = Math.floor(pos), b = Math.floor(pos + passo); let s = 0; for (let i = a; i < b; i++) s += tutto[i];
          accumulo.push(Math.max(-1, Math.min(1, s / Math.max(1, b - a))));
          pos += passo;
        }
        const usati = Math.floor(pos); resto = tutto.slice(usati); pos -= usati;
        while (accumulo.length >= FRAME) {
          const f = new Int16Array(FRAME); for (let i = 0; i < FRAME; i++) f[i] = Math.round(accumulo[i] * 32767);
          accumulo = accumulo.slice(FRAME);
          onFrame(f);
        }
      };
      src.connect(nodo); nodo.connect(muto); muto.connect(ctx.destination);
    }
    return { apri, chiudi, aperta: () => !!stream };
  }

  function unisci(frames) { let n = 0; for (const f of frames) n += f.length; const o = new Int16Array(n); let p = 0; for (const f of frames) { o.set(f, p); p += f.length; } return o; }
  function wav(pcm) {
    const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, HZ, true); v.setUint32(28, HZ * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    new Int16Array(b, 44).set(pcm);
    return b;
  }
  async function trascriviLocale(chiama, pcm) {
    const r = await chiama('/api/voce/trascrivi', { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Orbit': '1' }, body: wav(pcm) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.errore || MSG_LOCALE.backend);
    return j;
  }
  // Toglie la parola di attivazione (e un suo resto, come "bit") dall'inizio del comando trascritto.
  function pulisciComando(testo) {
    const t = String(testo || '').trim();
    const m = t.match(/^\W*(orbit|orbita|orbid|orbyt|or bit|orbis|orbi)\b[\s,.:;!?-]*/i);
    return (m ? t.slice(m[0].length) : t).replace(/^\W*bit\b[\s,.:;!?-]*/i, '').trim();
  }

  // ---------- dettatura (pulsante del microfono) ----------
  // Registra finche si parla, si ferma dopo una pausa (o con ferma()), poi trascrive con Whisper.
  function creaRiconoscimentoLocale(win, { chiama, finePausaMs = 1200, senzaParlatoMs = 8000, massimoMs = 60000 } = {}) {
    let attivo = false, sessione = 0, cattura = null;
    return {
      supportato: !!(win.navigator && win.navigator.mediaDevices && (win.AudioContext || win.webkitAudioContext)),
      attivo: () => attivo,
      avvia(o) {
        if (attivo) return false;
        attivo = true; const mia = ++sessione;
        const frames = [], vad = creaVad(); let parlatoMs = 0, silenzioMs = 0, totaleMs = 0, finito = false, parlatoFine = null, primo = -1, ultimo = -1;
        const termina = async () => {
          if (finito || mia !== sessione) return; finito = true;
          if (cattura) cattura.chiudi(); cattura = null; attivo = false;
          if (o.onLivello) o.onLivello(0);
          if (parlatoMs < 250) { if (o.onErrore) o.onErrore(MSG_LOCALE.vuoto); if (o.onFine) o.onFine(''); return; }
          if (o.onInterim) o.onInterim('…');
          try {
            const r = await trascriviLocale(chiama, unisci(frames.slice(Math.max(0, primo - MARGINE_FRAME), ultimo + 1 + MARGINE_FRAME)));     // senza il silenzio prima e dopo: meno tempo e meno frasi inventate sul vuoto
            if (mia !== sessione) return;
            if (r.vuoto && o.onErrore) o.onErrore(r.motivo === 'trascrizione poco affidabile' ? MSG_LOCALE.inaffidabile : MSG_LOCALE.vuoto);
            if (o.onFine) o.onFine(r.vuoto ? '' : String(r.testo || '').trim(), { parlatoFine, trascrizioneFine: oraVoce(win) });
          } catch (e) { if (o.onErrore) o.onErrore(e.message || MSG_LOCALE.backend); if (o.onFine) o.onFine(''); }
        };
        this._termina = termina;
        cattura = creaCattura(win, {
          onFrame: f => {
            if (finito) return;
            frames.push(f); totaleMs += 20;
            const v = vad(f);
            if (o.onLivello) o.onLivello(Math.min(1, Math.max(0, (v.db + 60) / 45)));
            if (v.parlato) { parlatoMs += 20; silenzioMs = 0; parlatoFine = oraVoce(win); if (primo < 0) primo = frames.length - 1; ultimo = frames.length - 1; } else silenzioMs += 20;
            if ((parlatoMs >= 250 && silenzioMs >= finePausaMs) || totaleMs >= massimoMs || (parlatoMs < 250 && totaleMs >= senzaParlatoMs)) termina();
          },
          onErrore: c => { if (!finito) { finito = true; attivo = false; if (o.onErrore) o.onErrore(MESSAGGI_ERRORE[c]); if (o.onFine) o.onFine(''); } }
        });
        cattura.apri().then(() => { if (mia === sessione && !finito && o.onInizio) o.onInizio(); }, e => {
          finito = true; attivo = false; cattura = null;
          if (o.onErrore) o.onErrore(MESSAGGI_ERRORE[e.codice] || 'Non riesco ad avviare il microfono.'); if (o.onFine) o.onFine('');
        });
        return true;
      },
      ferma() { if (attivo && this._termina) this._termina(); }
    };
  }

  // ---------- parola di attivazione "Orbit" ----------
  // Stati e callback identici al vecchio motore. In attesa si mandano al backend solo i pezzi con un suono (con 300 ms di audio
  // precedente), mai il silenzio; la parola e riconosciuta da Vosk, non da Whisper. Dopo "Orbit" il comando si registra a partire
  // dalla fine della parola (anche se detto senza pausa: l'audio recente resta in un buffer), fino a una pausa, e lo trascrive Whisper.
  function creaParolaLocale(win, cb, { chiama, attesaComandoMs = 8000, riavvioMs = 400, finePausaMs = 1000, massimoMs = 20000, pezzoMs = 250, margineTaglioS = 0.2, guardiaParolaS = 0.25 } = {}) {
    let abilitata = false, pausata = false, sessione = 0, cattura = null, riavvio = 0;
    const stato = (s, d) => { if (cb.onStato) cb.onStato(s, d); };
    const supportata = !!(win.navigator && win.navigator.mediaDevices && (win.AudioContext || win.webkitAudioContext));

    function chiudiSessione() { sessione++; if (cattura) cattura.chiudi(); cattura = null; }
    if (win.addEventListener) win.addEventListener('pagehide', chiudiSessione);      // chiudendo Orbit il microfono si rilascia subito

    function avviaSessione() {
      if (!abilitata || pausata || cattura) return;
      const mia = ++sessione;
      const vad = creaVad();
      // registro dell'audio inviato a Vosk: indice del primo campione, frame, parlato. Serve a ritrovare l'audio dopo la parola.
      // sfasamento: differenza tra il tempo del browser e quello di Vosk. Il server dice quanti campioni ha ricevuto (campioni): se un
      // pacchetto e andato perso o Vosk e ripartito da zero (si spegne dopo 10 minuti senza audio) la differenza si corregge da sola.
      let inviati = 0, sfasamento = 0, inizioPezzo = 0; const registro = []; const prima = [];
      let pezzo = [], inVolo = false, coda = 0, attivata = null;
      const tieni = 6000 / 20;                       // ultimi 6 s
      const accoda = (f, parlato) => {
        if (!pezzo.length) inizioPezzo = inviati;
        registro.push({ indice: inviati, frame: f, parlato }); pezzo.push(f); inviati += FRAME;
      };
      const manda = () => {
        if (inVolo || !pezzo.length || attivata) return;
        const pcm = unisci(pezzo), da = inizioPezzo; pezzo = []; inVolo = true;
        chiama('/api/voce/ascolta', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Orbit': '1' }, body: pcm.buffer })
          .then(r => r.json().then(j => ({ ok: r.ok, j })))
          .then(({ ok, j }) => {
            inVolo = false;
            if (mia !== sessione) return;
            if (!ok) { if (cb.onErrore) cb.onErrore(j.errore || MSG_LOCALE.backend); return; }
            if (typeof j.campioni === 'number') sfasamento = da - (j.campioni - pcm.length);
            if (j.attivata && !attivata) inizioComando(Math.max(0, Math.round((j.fine - margineTaglioS) * HZ)) + sfasamento, Math.round(j.fine * HZ) + sfasamento);
            else if (pezzo.length) manda();                // quello che si e accumulato nel frattempo
          })
          .catch(() => { inVolo = false; });
      };
      function inizioComando(daCampione, fineParola) {
        attivata = { frames: [], parlatoMs: 0, silenzioMs: 0, totaleMs: 0, attesa: 0, parlatoFine: oraVoce(win), primo: -1, ultimo: -1 };
        // audio gia registrato dopo la parola (comando detto senza pausa); si parte 0,2 s prima della fine di "Orbit" per non tagliare
        // l'inizio del comando: l'eventuale resto della parola lo toglie pulisciComando
        for (const r of registro) {
          if (r.indice + FRAME <= daCampione) continue;
          const f = r.indice < daCampione ? r.frame.slice(daCampione - r.indice) : r.frame;
          aggiungiComando(f, r.parlato && r.indice >= fineParola + Math.round(guardiaParolaS * HZ));     // la coda di «Orbit» (la fine esatta e stimata) non conta come inizio del comando
        }
        stato('attivata'); if (cb.onAttivata) cb.onAttivata();
        attivata.attesa = setTimeout(() => {               // solo "Orbit" e poi niente: si torna in attesa
          if (mia !== sessione || !attivata || attivata.parlatoMs >= 250) return;
          attivata = null; if (cb.onLivello) cb.onLivello(0); if (cb.onTesto) cb.onTesto(''); chiama('/api/voce/azzera', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Orbit': '1' } }).catch(() => {});
          inviati = 0; sfasamento = 0; registro.length = 0; pezzo = []; prima.length = 0; stato('attesa');
        }, attesaComandoMs);
      }
      function aggiungiComando(f, parlato) {
        const a = attivata; a.frames.push(f); a.totaleMs += 20;
        if (parlato) { a.parlatoMs += 20; a.silenzioMs = 0; a.parlatoFine = oraVoce(win); if (a.primo < 0) a.primo = a.frames.length - 1; a.ultimo = a.frames.length - 1; } else a.silenzioMs += 20;
        if ((a.parlatoMs >= 250 && a.silenzioMs >= finePausaMs) || a.totaleMs >= massimoMs) fineComando();
      }
      async function fineComando() {
        const a = attivata; if (!a || a.chiuso) return; a.chiuso = true; clearTimeout(a.attesa); if (cb.onLivello) cb.onLivello(0);
        chiudiSessione(); pausata = true; stato('pausa');
        try {
          const utili = a.primo < 0 ? a.frames : a.frames.slice(Math.max(0, a.primo - MARGINE_FRAME), a.ultimo + 1 + MARGINE_FRAME);   // senza la pausa dopo «Orbit» e il silenzio finale
          const r = await trascriviLocale(chiama, unisci(utili));
          const testo = r.vuoto ? '' : pulisciComando(r.testo);
          if (testo) { if (cb.onComando) cb.onComando(testo, { parlatoFine: a.parlatoFine, trascrizioneFine: oraVoce(win) }); return; }     // l'interfaccia riprende l'ascolto quando ha finito
          if (cb.onTesto) cb.onTesto('');
          if (cb.onErrore) cb.onErrore(r.motivo === 'trascrizione poco affidabile' ? MSG_LOCALE.inaffidabile : MSG_LOCALE.vuoto);     // come nella dettatura: chi ha parlato deve sapere che non e arrivato nulla
        } catch (e) { if (cb.onErrore) cb.onErrore(e.message || MSG_LOCALE.backend); }
        pausata = false; if (abilitata) { clearTimeout(riavvio); riavvio = setTimeout(avviaSessione, riavvioMs); }
      }
      cattura = creaCattura(win, {
        onFrame: f => {
          if (mia !== sessione) return;
          const v = vad(f);
          if (attivata) {
            if (!attivata.chiuso) { if (cb.onLivello) cb.onLivello(Math.min(1, Math.max(0, (v.db + 60) / 45))); aggiungiComando(f, v.parlato); }     // stessa scala della dettatura
            return;
          }
          // in attesa: solo i frame con suono (piu 300 ms prima e 600 ms dopo) vanno a Vosk
          if (v.parlato) coda = 30; else if (coda > 0) coda--;
          if (v.parlato || coda > 0) {
            for (const p of prima.splice(0)) accoda(p.f, p.parlato);
            accoda(f, v.parlato);
            if (registro.length > tieni) registro.splice(0, registro.length - tieni);
            if (pezzo.length >= pezzoMs / 20) manda();
          } else {
            prima.push({ f, parlato: v.parlato }); if (prima.length > 15) prima.shift();
            if (pezzo.length) manda();                 // fine del suono: si manda subito il resto
          }
        },
        onErrore: c => { if (mia !== sessione) return; abilitata = false; chiudiSessione(); stato('errore', c); if (cb.onErrore) cb.onErrore(MESSAGGI_ERRORE[c]); }
      });
      chiama('/api/voce/azzera', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Orbit': '1' } }).catch(() => {});
      cattura.apri().then(() => { if (mia === sessione) stato('attesa'); }, e => {
        if (mia !== sessione) return;
        cattura = null;
        if (e.codice === 'not-allowed' || e.codice === 'audio-capture') { abilitata = false; stato('errore', e.codice); if (cb.onErrore) cb.onErrore(MESSAGGI_ERRORE[e.codice]); }
        else if (cb.onErrore) cb.onErrore('Non riesco ad avviare il microfono.');
      });
    }

    return {
      supportata,
      attiva: () => abilitata,
      avvia(statoVoce) {
        if (!supportata) { if (cb.onErrore) cb.onErrore('Questo browser non da accesso al microfono.'); return false; }
        if (statoVoce && !(statoVoce.stt && statoVoce.stt.disponibile && statoVoce.parola && statoVoce.parola.disponibile)) {
          if (cb.onErrore) cb.onErrore(MSG_LOCALE.nonInstallato); stato('spento'); return false;   // non spegne la preferenza: torna attiva dopo l'installazione
        }
        abilitata = true; pausata = false; avviaSessione(); return true;
      },
      ferma() { abilitata = false; pausata = false; clearTimeout(riavvio); chiudiSessione(); stato('spento'); },
      pausa() { pausata = true; clearTimeout(riavvio); chiudiSessione(); if (abilitata) stato('pausa'); },
      riprendi() { if (!abilitata) return; pausata = false; clearTimeout(riavvio); riavvio = setTimeout(avviaSessione, riavvioMs); }
    };
  }

  // ---------- scelta del motore (configurazione centrale: ORBIT_STT_MOTORE, letta dal backend) ----------
  function creaRiconoscimento(win, opzioni = {}) {
    const chiama = opzioni.fetchFn || (win.fetch ? win.fetch.bind(win) : null);
    const statoVoce = opzioni.statoVoce || creaStatoVoce(win, chiama);
    const locale = creaRiconoscimentoLocale(win, { chiama }), browser = creaRiconoscimentoBrowser(win);
    statoVoce.leggi();
    const usaBrowser = () => !!(statoVoce.ultimo && statoVoce.ultimo.motore === 'browser');
    return {
      get supportato() { return usaBrowser() ? browser.supportato : locale.supportato; },
      attivo: () => locale.attivo() || browser.attivo(),
      avvia(o) {
        statoVoce.leggi().then(s => {
          if (s && s.motore === 'browser') return browser.avvia(o);
          if (s && !(s.stt && s.stt.disponibile)) { o.onErrore(MSG_LOCALE.nonInstallato); if (o.onFine) o.onFine(''); return; }
          locale.avvia(o);
        });
        return true;
      },
      ferma() { locale.ferma(); browser.ferma(); }
    };
  }

  function creaParolaDiAttivazione(win, cb, opzioni = {}) {
    const chiama = opzioni.fetchFn || (win.fetch ? win.fetch.bind(win) : null);
    const statoVoce = opzioni.statoVoce || creaStatoVoce(win, chiama);
    const locale = creaParolaLocale(win, cb, Object.assign({ chiama }, opzioni)), browser = creaParolaBrowser(win, cb, opzioni);
    statoVoce.leggi();
    let attuale = null, voluta = false;
    const scegli = s => (s && s.motore === 'browser' ? browser : locale);
    return {
      get supportata() { return statoVoce.ultimo && statoVoce.ultimo.motore === 'browser' ? browser.supportata : locale.supportata; },
      attiva: () => !!attuale && attuale.attiva(),
      avvia() {
        voluta = true;
        statoVoce.leggi(true).then(s => { if (!voluta) return; attuale = scegli(s); if (attuale === browser) browser.avvia(); else locale.avvia(s); });
        return true;
      },
      ferma() { voluta = false; if (attuale) attuale.ferma(); else if (cb.onStato) cb.onStato('spento'); },
      pausa() { if (attuale) attuale.pausa(); },
      riprendi() { if (attuale) attuale.riprendi(); }
    };
  }

  const api = { creaRiconoscimento, creaSintesi, creaSintesiOrbit, creaParolaDiAttivazione, creaRiconoscimentoBrowser, creaParolaBrowser, creaRiconoscimentoLocale, creaParolaLocale, creaVad, pulisciComando, wav, estraiComando, spezzaPerVoce, VOCE_LOCALE, MESSAGGI_ERRORE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OrbitVoice = api;
})(typeof window !== 'undefined' ? window : globalThis);
