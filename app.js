'use strict';
// ---------- helpers ----------
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('sera.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sera.' + k, JSON.stringify(v)); } catch {} },
};
class Abort extends Error {}

// ---------- settings ----------
const S = {
  get apiKey() { return store.get('apiKey', ''); },
  get model() { return store.get('model', 'gemini-flash-latest'); },
  get rate() { return Number(store.get('rate', 0.85)); },
  get voiceName() { return store.get('voice', ''); },
  get pitch() { return Number(store.get('pitch', 1.2)); },
};

// ---------- media (photo / video clips kept in IndexedDB) ----------
const db = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('seraphina', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('media');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async put(k, v) { const d = await this.open(); return new Promise(r => { const t = d.transaction('media', 'readwrite'); t.objectStore('media').put(v, k); t.oncomplete = r; }); },
  async get(k) { const d = await this.open(); return new Promise(r => { const q = d.transaction('media').objectStore('media').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); },
  async del(k) { const d = await this.open(); return new Promise(r => { const t = d.transaction('media', 'readwrite'); t.objectStore('media').delete(k); t.oncomplete = r; }); },
};
async function loadMedia() {
  try {
    const p = await db.get('photo'); if (p) $('photo').src = URL.createObjectURL(p);
    for (const [k, el] of [['idle', 'vidIdle'], ['talk', 'vidTalk']]) {
      const b = await db.get(k);
      if (b) { $(el).src = URL.createObjectURL(b); $(el).dataset.ready = '1'; }
      else {
        try { const r = await fetch(k + '.mp4', {method: 'HEAD'}); if (r.ok) { $(el).src = k + '.mp4'; $(el).dataset.ready = '1'; } } catch {}
      }
    }
  } catch {}
  setMood('idle');
}

// ---------- avatar mood ----------
function setMood(m) {
  const av = $('avatar'); av.className = m;
  const idle = $('vidIdle'), talk = $('vidTalk');
  const hasIdle = idle.dataset.ready, hasTalk = talk.dataset.ready;
  const useTalk = m === 'talking' && hasTalk;
  const useIdle = !useTalk && hasIdle;
  talk.hidden = !useTalk; idle.hidden = !useIdle;
  $('photo').hidden = useTalk || useIdle;
  if (useTalk) talk.play().catch(() => {}); else talk.pause();
  if (useIdle) idle.play().catch(() => {}); else idle.pause();
}

// ---------- voice out ----------
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const sel = $('voiceSel'); const cur = S.voiceName;
  const es = voices.filter(v => v.lang.toLowerCase().startsWith('es'));
  es.sort((a, b) => (b.lang === 'es-ES') - (a.lang === 'es-ES'));
  sel.replaceChildren();
  for (const v of es) { const o = new Option(v.name, v.name, false, v.name === cur); sel.add(o); }
  if (!es.length) sel.add(new Option('(sem vozes espanholas instaladas)', ''));
  if (!cur && es.length) { const v = pickVoice('es-ES'); if (v) sel.value = v.name; }
}
speechSynthesis.onvoiceschanged = loadVoices;
function pickVoice(lang, male) {
  const pre = lang.slice(0, 2);
  if (lang.startsWith('es') && !male && S.voiceName) {
    const v = voices.find(v => v.name === S.voiceName); if (v) return v;
  }
  const pool = voices.filter(v => v.lang.replace('_', '-').toLowerCase().startsWith(pre));
  const exact = pool.filter(v => v.lang.replace('_', '-') === lang);
  const list = exact.length ? exact : pool;
  const fem = /female|femenin|mujer|helena|elvira|laura|lucia|lucía|monica|mónica|paulina|sabina|marisol|conchita|ines|inês|joana|fernanda|catarina|google español|x-eea|x-eec|-f\b|#female/i;
  const mal = /male|hombre|pablo|alvaro|jorge|diego|duarte|antonio|-m\b|#male/i;
  return (male ? list.find(v => mal.test(v.name) && !/female/i.test(v.name)) : list.find(v => fem.test(v.name))) || list[0] || null;
}

let lastSaid = null;
let session = null; // {aborted, skip}
function utter(text, lang, opts = {}) {
  return new Promise(res => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang; u.voice = pickVoice(lang, opts.male);
    u.rate = opts.slow ? S.rate * 0.8 : S.rate;
    u.pitch = opts.male ? 0.8 : opts.other ? Math.min(2, S.pitch + 0.25) : (lang.startsWith('es') ? S.pitch : 1.1);
    u.onend = u.onerror = () => res();
    speechSynthesis.speak(u);
  });
}
// Speak a list of segments [{es}|{pt}], show captions.
async function say(segs, opts = {}) {
  check();
  lastSaid = [segs, opts];
  const es = segs.filter(s => s.es).map(s => s.es).join(' ');
  const pt = segs.filter(s => s.pt).map(s => s.pt).join(' ');
  $('capEs').textContent = opts.who && opts.who !== 'seraphina' ? `${opts.who}: ${es}` : es;
  $('capPt').textContent = pt;
  if (!opts.other) setMood('talking');
  for (const s of segs) {
    const text = s.es || s.pt; const lang = s.es ? 'es-ES' : 'pt-PT';
    for (const piece of text.match(/[^.!?…]+[.!?…]*/g) || [text]) {
      if (session && session.skip) break;
      await utter(piece.trim(), lang, opts);
      check();
    }
  }
  if (session) session.skip = false;
  setMood('idle');
}
function check() { if (session && session.aborted) throw new Abort(); }

// ---------- voice in ----------
const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
let pendingListen = null;
function waitForSpeech(hint) {
  check();
  $('hint').textContent = hint || 'Toca no microfone e fala';
  $('btnMic').disabled = false;
  return new Promise((res, rej) => { pendingListen = {res, rej}; });
}
function listenOnce() {
  return new Promise(res => {
    if (!Rec) { res({text: '', error: 'no-rec'}); return; }
    const r = new Rec(); r.lang = 'es-ES'; r.interimResults = false; r.maxAlternatives = 3;
    let done = false;
    r.onresult = e => {
      done = true;
      const alts = Array.from(e.results[0]).map(a => a.transcript);
      res({text: alts[0] || '', alts, confidence: e.results[0][0].confidence});
    };
    r.onerror = e => { if (!done) { done = true; res({text: '', error: e.error}); } };
    r.onend = () => { if (!done) res({text: ''}); };
    r.start();
  });
}
$('btnMic').onclick = async () => {
  if (!pendingListen) return;
  speechSynthesis.cancel();
  const mic = $('btnMic'); mic.classList.add('on'); setMood('listening');
  $('hint').textContent = 'A ouvir…';
  const r = await listenOnce();
  mic.classList.remove('on'); setMood('idle');
  if (r.error === 'no-rec') { $('hint').textContent = 'Este navegador não tem reconhecimento de voz. Usa o Chrome.'; return; }
  if (r.error === 'not-allowed') { $('hint').textContent = 'Dá permissão ao microfone nas definições do Chrome.'; return; }
  if (!r.text) { $('hint').textContent = 'Não ouvi nada. Toca outra vez.'; return; }
  const p = pendingListen; pendingListen = null; $('btnMic').disabled = true;
  p.res(r);
};

// ---------- pronunciation score ----------
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zñ0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function score(target, heard, prefix) {
  const a = norm(target).split(' '), b0 = norm(heard).split(' ').filter(Boolean);
  const b = prefix ? b0.slice(0, a.length) : b0;
  const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.max(0, 1 - d[a.length][b.length] / Math.max(a.length, b.length, 1));
}
function bestScore(target, r, prefix) {
  return Math.max(...(r.alts || [r.text]).map(t => score(target, t, prefix)));
}

// ---------- AI conversation (Gemini free tier) ----------
const PERSONA = `És a Seraphina, professora de espanhol, de Madrid, cerca de 30 anos.
Personalidade: calma, calorosa, paciente e charmosa, com um toque leve e elegante de charme (nunca vulgar; és sempre a professora).
O aluno é português (de Portugal), fala contigo só por voz e está a começar do zero.
Regras:
- Responde SEMPRE em JSON: {"es": "...", "pt": "...", "correction": "..."}.
- "es": 1 a 2 frases curtas em espanhol de Espanha, muito simples, ao nível do aluno, terminando com UMA pergunta para continuar a conversa.
- "pt": tradução curta em português de Portugal do que disseste, ou uma dica breve se o aluno estiver perdido.
- "correction": se o aluno errou, a frase correta em espanhol; senão "".
- Sem emojis, sem markdown, sem listas. O texto vai ser lido em voz alta.
- O reconhecimento de voz pode ter errado palavras; se a frase não fizer sentido, adivinha o que o aluno quis dizer.`;

async function askSeraphina(history, context) {
  if (!S.apiKey) throw new Error('nokey');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.model)}:generateContent`;
  const body = {
    systemInstruction: {parts: [{text: PERSONA + (context ? '\n\nContexto da aula: ' + context : '')}]},
    contents: history,
    generationConfig: {responseMimeType: 'application/json', temperature: 0.8, maxOutputTokens: 300},
  };
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': S.apiKey}, body: JSON.stringify(body)});
  if (!r.ok) throw new Error('api ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  try { const o = JSON.parse(txt); return {es: o.es || '', pt: o.pt || '', correction: o.correction || '', raw: txt}; }
  catch { return {es: txt.replace(/[{}"]/g, ''), pt: '', correction: '', raw: txt}; }
}

async function conversation(opener, context, minutes) {
  const history = [];
  if (opener) { await say(opener); history.push({role: 'model', parts: [{text: JSON.stringify({es: opener.filter(s => s.es).map(s => s.es).join(' ')})}]}); }
  const end = Date.now() + minutes * 60000;
  while (Date.now() < end) {
    const r = await waitForSpeech('Responde à Seraphina (ou toca Seguinte para terminar)');
    if (r.skipped) break;
    $('capEs').textContent = '«' + r.text + '»'; $('capPt').textContent = '';
    history.push({role: 'user', parts: [{text: r.text}]});
    let a;
    try { setMood('talking'); $('hint').textContent = 'A Seraphina está a pensar…'; a = await askSeraphina(history, context); }
    catch (e) {
      setMood('idle');
      if (e.message === 'nokey') { await say([{pt: 'Para conversarmos, preciso da chave grátis do Gemini. Abre as definições, na roda dentada, e cola lá a chave.'}]); return; }
      console.error(e); await say([{pt: 'Desculpa, perdi a ligação. Vamos tentar outra vez.'}]); history.pop(); continue;
    }
    history.push({role: 'model', parts: [{text: a.raw}]});
    const segs = [];
    if (a.correction) segs.push({pt: 'Diz-se assim:'}, {es: a.correction});
    segs.push({es: a.es}); if (a.pt) segs.push({pt: a.pt});
    await say(segs);
  }
}

// ---------- lesson runner ----------
async function repeatDrill(item) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await say([{es: item.es}, {pt: item.pt}], {slow: attempt > 0});
    const r = await waitForSpeech('Repete: ' + item.es);
    if (r.skipped) return;
    const sc = bestScore(item.es, r, item.prefix);
    $('capEs').textContent = `«${r.text}» · ${Math.round(sc * 100)}%`;
    if (sc >= 0.75) { await say([{es: ['¡Muy bien!', '¡Perfecto!', '¡Eso es!', '¡Qué bien lo dices!'][Math.floor(Math.random() * 4)]}]); return; }
    await say([{pt: attempt < 2 ? 'Quase. Ouve outra vez, devagar.' : 'Não faz mal, vamos continuar e voltamos a isto.'}]);
  }
}

async function runLesson(L) {
  const phase = t => { $('phase').textContent = t; };
  phase('Aquecimento');
  for (const s of L.warmup) await say(s);
  for (const p of L.warmupPractice || []) await repeatDrill({es: p, pt: ''});

  phase('Cena');
  await say(L.scene.intro);
  for (const ln of L.scene.lines) {
    const me = ln.who === 'seraphina';
    const label = me ? 'seraphina' : ln.who.charAt(0).toUpperCase() + ln.who.slice(1);
    await say([{es: ln.es}, {pt: ln.pt}], {who: label, male: !me && ln.male !== false, other: !me});
    await sleep(300);
  }

  phase('Repetição e pronúncia');
  await say([{pt: 'Agora repete comigo. Eu digo, tu repetes.'}]);
  for (const it of L.repeat) await repeatDrill(it);

  phase('Conversa');
  await conversation(L.conversation.intro, `Objetivo: ${L.conversation.goal} Vocabulário: ${L.conversation.vocab}. Usa só este vocabulário.`, 7);

  phase('Resumo');
  for (const s of L.summary) await say(s);
  markDone(L.id);
}

// ---------- progress ----------
function today() { return new Date().toISOString().slice(0, 10); }
function markDone(id) {
  const done = store.get('done', []); if (!done.includes(id)) done.push(id); store.set('done', done);
  const last = store.get('lastDay', ''); let streak = store.get('streak', 0);
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (last !== today()) streak = last === y ? streak + 1 : 1;
  store.set('lastDay', today()); store.set('streak', streak);
}
function nextLesson() { const done = store.get('done', []); return LESSONS.find(l => !done.includes(l.id)) || LESSONS[LESSONS.length - 1]; }
function renderHome() {
  const L = nextLesson(); const st = store.get('streak', 0);
  $('lessonName').textContent = `Semana ${L.week}, dia ${L.day}: ${L.title}`;
  $('streak').textContent = st ? `${st} dia${st > 1 ? 's' : ''} seguido${st > 1 ? 's' : ''} 🔥` : '';
  $('phase').textContent = 'Professora de espanhol · Madrid';
  $('capEs').textContent = ''; $('capPt').textContent = '';
}

// ---------- sessions ----------
async function start(fn) {
  session = {aborted: false, skip: false};
  $('home').hidden = true; $('controls').hidden = false; $('btnMic').disabled = true;
  try { await fn(); }
  catch (e) { if (!(e instanceof Abort)) { console.error(e); } }
  speechSynthesis.cancel(); pendingListen = null; session = null; setMood('idle');
  $('controls').hidden = true; $('home').hidden = false; renderHome();
}
$('btnLesson').onclick = () => start(() => runLesson(nextLesson()));
$('btnChat').onclick = () => start(() => {
  $('phase').textContent = 'Conversa livre';
  return conversation([{es: '¡Hola! ¿Qué tal?'}, {pt: 'Olá! Como estás?'}], 'Conversa livre. Mantém o espanhol ao nível do aluno.', 30);
});
$('btnStop').onclick = () => {
  if (!session) return; session.aborted = true; speechSynthesis.cancel();
  if (pendingListen) { const p = pendingListen; pendingListen = null; p.rej(new Abort()); }
};
$('btnSkip').onclick = () => {
  if (!session) return;
  if (pendingListen) { const p = pendingListen; pendingListen = null; $('btnMic').disabled = true; p.res({skipped: true, text: ''}); }
  else { session.skip = true; speechSynthesis.cancel(); }
};
$('btnRepeat').onclick = async () => {
  if (!lastSaid || !speechSynthesis) return;
  speechSynthesis.cancel();
  const [segs, opts] = lastSaid;
  for (const s of segs) await utter(s.es || s.pt, s.es ? 'es-ES' : 'pt-PT', {...opts, slow: true});
};

// ---------- settings dialog ----------
$('btnSettings').onclick = () => {
  $('apiKey').value = S.apiKey; $('model').value = S.model; $('rate').value = S.rate; $('pitch').value = S.pitch;
  loadVoices(); $('settings').showModal();
};
$('settings').addEventListener('close', () => {
  store.set('apiKey', $('apiKey').value.trim()); store.set('model', $('model').value.trim() || 'gemini-flash-latest');
  store.set('rate', $('rate').value); store.set('voice', $('voiceSel').value); store.set('pitch', $('pitch').value);
});
$('btnTestVoice').onclick = () => {
  store.set('voice', $('voiceSel').value); store.set('rate', $('rate').value); store.set('pitch', $('pitch').value);
  speechSynthesis.cancel(); utter('¡Hola! Soy Seraphina. Encantada de conocerte.', 'es-ES');
};
for (const [id, key] of [['filePhoto', 'photo'], ['fileIdle', 'idle'], ['fileTalk', 'talk']]) {
  $(id).onchange = async e => { const f = e.target.files[0]; if (f) { await db.put(key, f); await loadMedia(); } };
}
$('btnClearMedia').onclick = async () => {
  for (const k of ['photo', 'idle', 'talk']) await db.del(k);
  $('photo').src = 'seraphina.jpg';
  for (const el of ['vidIdle', 'vidTalk']) { $(el).removeAttribute('src'); delete $(el).dataset.ready; }
  setMood('idle');
};

// ---------- boot ----------
loadVoices(); loadMedia(); renderHome();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
