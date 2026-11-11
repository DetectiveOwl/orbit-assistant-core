'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ambienteUI}=require('./performance-ui-fixture');
const scrivi=(u,t)=>{u.elementi.get('input').value=t;u.elementi.get('input').listeners.input({});};
const testo=u=>u.elementi.get('input').value;
const recuperi=u=>u.elementi.get('recuperiTesti').children;
const finale={tipo:'finale',testo:'Risposta completa.',verifica:'PASS',verificaModo:'deterministico'};
const sse=(eventi,errore=null)=>{let letto=false;return{ok:true,body:{getReader:()=>({read:async()=>{if(letto){if(errore)throw errore;return{done:true};}letto=true;return{done:false,value:new TextEncoder().encode(typeof eventi==='string'?eventi:eventi.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''))};}})}};};
function attesa(){let completa,rifiuta;const p=new Promise((r,j)=>{completa=r;rifiuta=j;});return{fetch:init=>{init.signal.addEventListener('abort',()=>rifiuta(init.signal.reason),{once:true});return p;},completa,rifiuta};}
function chat(){return{'/api/conversations':[{id:'conv_a',titolo:'A',aggiornata:1,messaggi:0},{id:'conv_b',titolo:'B',aggiornata:1,messaggi:0}],'/api/conversations/conv_a':{messaggi:[]},'/api/conversations/conv_b':{messaggi:[]}};}
const cambia=async(u,i)=>{u.elementi.get('listaConv').children[i].children[0].listeners.click();await u.scarica();};

test('bozze: chiusura/riapertura e pannelli conservano testo e spazi',async()=>{
 const u=ambienteUI();await u.scarica();u.elementi.get('nucleo').listeners.click();scrivi(u,'  Bozza\ncompleta  ');u.elementi.get('nucleo').listeners.click();assert.equal(u.elementi.get('capsula').hidden,true);u.elementi.get('nucleo').listeners.click();assert.equal(testo(u),'  Bozza\ncompleta  ');
 u.elementi.get('mCronologia').listeners.click();await u.scarica();u.elementi.get('btnChiudiCronologia').listeners.click();assert.equal(testo(u),'  Bozza\ncompleta  ');
});

test('bozze: due conversazioni e la chat nuova mantengono testi separati',async()=>{
 const u=ambienteUI(undefined,chat());await u.scarica();scrivi(u,'Nuova');await cambia(u,0);assert.equal(testo(u),'');scrivi(u,'Bozza A');await cambia(u,1);assert.equal(testo(u),'');scrivi(u,'Bozza B');await cambia(u,0);assert.equal(testo(u),'Bozza A');await cambia(u,1);assert.equal(testo(u),'Bozza B');u.elementi.get('btnNuova').listeners.click();assert.equal(testo(u),'Nuova');
});

test('bozze: errori HTTP, rete, timeout e SSE conservano l’originale senza reinvio',async()=>{
 for(const risposta of [()=>({ok:false,status:429,json:async()=>({errore:'Servizio occupato.'})}),()=>{throw new TypeError('Failed to fetch');},()=>{throw Object.assign(new Error('scaduta'),{name:'TimeoutError'});},()=>sse([{tipo:'errore',messaggio:'Non riesco a completare la richiesta.'}]),()=>sse([])]){
  const u=ambienteUI(undefined,{'/api/chat':risposta});await u.scarica();await u.invia([],false,'  Testo originale  ');assert.equal(testo(u),'  Testo originale  ');assert.equal(recuperi(u).length,1);assert.equal(recuperi(u)[0].children[1].value,'  Testo originale  ');assert.equal(u.richieste.length,1);assert.equal(u.win.__orbit.stato().core.nome,'error');assert.equal(u.win.__orbit.stato().risposte,1);assert.equal(u.elementi.get('btnInvia').disabled,false);recuperi(u)[0].children.at(-1).listeners.click();assert.equal(u.elementi.get('capsula').hidden,false);assert.equal(testo(u),'  Testo originale  ');assert.equal(u.richieste.length,1);
 }
});

test('bozze: successo svuota solo il testo inviato e conserva Quality Gate e Ascolta',async()=>{
 const u=ambienteUI();await u.scarica();u.sintesi.haVoceItaliana=()=>true;await u.invia([finale],false,'Domanda');assert.equal(testo(u),'');assert.equal(recuperi(u).length,0);assert.equal(u.win.__orbit.stato().core.nome,'responding');assert.ok(u.elementi.get('rMeta').children.some(x=>x.className==='verifica-badge'));assert.equal(u.elementi.get('rMeta').children.at(-1).textContent,'Ascolta');assert.equal(u.richieste.filter(x=>x.message).length,1);
});

test('bozze: durante l’attesa si scrive il prossimo testo, senza secondo invio',async()=>{
 const a=attesa(),u=ambienteUI(undefined,{'/api/chat':a.fetch});await u.scarica();await u.invia([],false,'Prima richiesta');assert.equal(u.elementi.get('btnInvia').disabled,true);u.elementi.get('nucleo').listeners.click();assert.equal(u.elementi.get('capsula').hidden,false);scrivi(u,'Nuovo testo');u.elementi.get('capsula').listeners.submit({preventDefault(){}});assert.equal(u.richieste.length,1);a.completa(sse([finale]));await u.scarica();assert.equal(testo(u),'Nuovo testo');assert.equal(u.elementi.get('btnInvia').disabled,false);
});

test('bozze: errore tardivo e recupero manuale non sovrascrivono una nuova bozza',async()=>{
 const a=attesa(),u=ambienteUI(undefined,{'/api/chat':a.fetch});await u.scarica();await u.invia([],false,'Prima richiesta');scrivi(u,'Nuova bozza');a.rifiuta(new TypeError('rete'));await u.scarica();assert.equal(testo(u),'Nuova bozza');assert.equal(recuperi(u)[0].children[1].value,'Prima richiesta');recuperi(u)[0].children.at(-1).listeners.click();assert.equal(testo(u),'Nuova bozza');scrivi(u,'');recuperi(u)[0].children.at(-1).listeners.click();assert.equal(testo(u),'Prima richiesta');assert.equal(u.richieste.length,1);
});

test('bozze: cancellazione intenzionale dopo l’invio impedisce ripristino automatico',async()=>{
 const a=attesa(),u=ambienteUI(undefined,{'/api/chat':a.fetch});await u.scarica();await u.invia([],false,'Prima');scrivi(u,'Nuova');scrivi(u,'');a.rifiuta(new TypeError('rete'));await u.scarica();assert.equal(testo(u),'');assert.equal(recuperi(u)[0].children[1].value,'Prima');
});

test('bozze: assegnazione della nuova conversazione mantiene la bozza successiva nel posto corretto',async()=>{
 const a=attesa(),api=chat(),u=ambienteUI(undefined,{...api,'/api/chat':a.fetch});await u.scarica();await u.invia([],false,'Prima');scrivi(u,'Successiva');a.completa(sse([{tipo:'conversazione',conversazioneId:'conv_a'},finale]));await u.scarica();await cambia(u,1);assert.equal(testo(u),'');await cambia(u,0);assert.equal(testo(u),'Successiva');assert.equal(u.richieste[0].conversationId,null);
});

test('bozze: cambio conversazione durante invio e caricamento tardivo non contaminano la chat',async()=>{
 const a=attesa(),u=ambienteUI(undefined,{...chat(),'/api/chat':a.fetch});await u.scarica();await cambia(u,0);await u.invia([],false,'Richiesta A');await cambia(u,1);scrivi(u,'Bozza A');a.rifiuta(new TypeError('rete'));await u.scarica();assert.equal(testo(u),'Bozza A');assert.equal(u.richieste[0].conversationId,'conv_a');await cambia(u,1);assert.equal(testo(u),'');await cambia(u,0);assert.equal(testo(u),'Bozza A');assert.equal(recuperi(u).length,1);
 const b=attesa(),v=ambienteUI(undefined,{...chat(),'/api/conversations/conv_b':()=>b.fetch({signal:new AbortController().signal}),'/api/chat':()=>sse([finale])});await v.scarica();v.elementi.get('listaConv').children[1].children[0].listeners.click();await v.invia([finale],false,'Chat nuova');b.completa({ok:true,json:async()=>({messaggi:[]})});await v.scarica();assert.equal(v.richieste[0].conversationId,null);assert.equal(v.win.__orbit.stato().risposte,1);
});

test('bozze: interruzione manuale e SSE interrotta restano recuperabili senza completamento',async()=>{
 const a=attesa(),u=ambienteUI(undefined,{'/api/chat':a.fetch});await u.scarica();await u.invia([],false,'Da interrompere');u.elementi.get('btnInterrompi').listeners.click();await u.scarica();assert.equal(testo(u),'Da interrompere');assert.equal(u.richieste.length,1);assert.match(recuperi(u)[0].children[0].textContent,/interrotta/);scrivi(u,'');recuperi(u)[0].children.at(-1).listeners.click();assert.equal(testo(u),'Da interrompere');assert.equal(u.richieste.length,1);
 const v=ambienteUI();await v.scarica();await v.invia([{tipo:'interrotta'}],false,'Interrotta dal server');assert.equal(testo(v),'Interrotta dal server');assert.equal(v.win.__orbit.stato().core.nome,'error');
});

test('bozze: frame finale non terminato resta parziale, copiable e senza badge o audio',async()=>{
 const parziale='data: '+JSON.stringify(finale),u=ambienteUI(undefined,{'/api/chat':()=>sse(parziale,new TypeError('stream'))});await u.scarica();let audio=0;u.sintesi.haVoceItaliana=()=>true;u.sintesi.parla=()=>audio++;await u.invia([],false,'Originale');assert.equal(testo(u),'Originale');assert.equal(u.elementi.get('rMeta').children.length,0);assert.equal(u.win.__orbit.stato().core.nome,'error');assert.equal(recuperi(u)[0].children[2].value,'Risposta completa.');assert.equal(audio,0);assert.match(u.elementi.get('rTesto').children[0].textContent,/parziale.*non completata/);
});

test('bozze: errore dopo un finale completo non duplica o declassa la risposta',async()=>{
 const u=ambienteUI();await u.scarica();await u.invia([finale,{tipo:'errore',messaggio:'Tardivo'}],true,'Completata');assert.equal(u.win.__orbit.stato().core.nome,'responding');assert.equal(u.win.__orbit.stato().risposte,1);assert.equal(recuperi(u).length,0);assert.equal(testo(u),'');
});

test('bozze: dettatura e wake word non sovrascrivono testo scritto',async()=>{
 const u=ambienteUI();await u.scarica();scrivi(u,'Bozza scritta');u.riconoscimento.supportato=true;let callbacks;u.riconoscimento.avvia=c=>{callbacks=c;};u.elementi.get('btnMic').listeners.click();callbacks.onInterim('Dettatura');assert.equal(testo(u),'Bozza scritta');callbacks.onFine('',null);assert.equal(testo(u),'Bozza scritta');u.attivazione.callbacks.onTesto('Parola Orbit');assert.equal(testo(u),'Bozza scritta');u.attivazione.callbacks.onComando('Domanda vocale',null);await u.scarica();assert.equal(testo(u),'Bozza scritta');assert.equal(u.richieste[0].message,'Domanda vocale');
});


test('bozze: dettatura tardiva resta nella chat di origine senza avviare una richiesta',async()=>{
 const u=ambienteUI(undefined,chat());await u.scarica();await cambia(u,0);u.riconoscimento.supportato=true;let callbacks;u.riconoscimento.avvia=c=>{callbacks=c;};u.elementi.get('btnMic').listeners.click();await cambia(u,1);scrivi(u,'Bozza B');callbacks.onFine('Dettato A',null);await u.scarica();assert.equal(testo(u),'Bozza B');assert.equal(u.richieste.length,0);await cambia(u,0);assert.equal(testo(u),'Dettato A');assert.equal(recuperi(u)[0].children[1].value,'Dettato A');
});

test('bozze: dettatura durante un altro invio viene conservata, senza secondo invio',async()=>{
 const a=attesa(),u=ambienteUI(undefined,{'/api/chat':a.fetch});await u.scarica();u.riconoscimento.supportato=true;let callbacks;u.riconoscimento.avvia=c=>{callbacks=c;};u.elementi.get('btnMic').listeners.click();await u.invia([],false,'Richiesta scritta');callbacks.onFine('Dettatura successiva',null);await u.scarica();assert.equal(u.richieste.length,1);assert.equal(testo(u),'Dettatura successiva');a.completa(sse([finale]));await u.scarica();assert.equal(testo(u),'Dettatura successiva');assert.equal(recuperi(u).length,1);
});

test('bozze: JSON troncato non inventa una risposta parziale né una verifica',async()=>{
 const u=ambienteUI(undefined,{'/api/chat':()=>sse('data: {"tipo":"finale","testo":"troncato')});await u.scarica();await u.invia([],false,'Originale');assert.equal(testo(u),'Originale');assert.equal(u.elementi.get('rMeta').children.length,0);assert.equal(recuperi(u)[0].children.length,3);assert.equal(u.richieste.length,1);
});
