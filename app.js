// Scene to Story: a static, serverless page.
// Video → frames (canvas) + transcript (Whisper in a Web Worker) → Claude via OpenRouter.

const MAX_SECONDS = 60;
const MAX_FRAMES = 90;          // Claude accepts up to 100 images per request
const FRAME_MAX_SIDE = 768;     // px; enough to read on-screen text
const OPENROUTER = 'https://openrouter.ai';
const APP_TITLE = 'Scene to Story';

const $ = (sel) => document.querySelector(sel);
const state = {
  key: null,
  video: null,        // { blob, url, knownDuration }
  frames: [],         // [{ t, dataUrl }]
  transcript: null,   // { text, chunks }
  analysis: null,
  story: '',
  busy: false,
};

// ---------- storage (may be unavailable in private modes) ----------
const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { s.setItem(k, v); } catch {} },
  del(k, s = localStorage) { try { s.removeItem(k); } catch {} },
};

// ---------- OpenRouter sign-in (OAuth PKCE, no server needed) ----------
function b64url(bytes) {
  let s = '';
  new Uint8Array(bytes).forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function callbackUrl() {
  return location.origin + location.pathname;
}

async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set('pkce_verifier', verifier, sessionStorage);
  const url = new URL(`${OPENROUTER}/auth`);
  url.searchParams.set('callback_url', callbackUrl());
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  location.href = url.toString();
}

async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return;
  history.replaceState(null, '', callbackUrl());
  const verifier = store.get('pkce_verifier', sessionStorage);
  store.del('pkce_verifier', sessionStorage);
  try {
    const res = await fetch(`${OPENROUTER}/api/v1/auth/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    if (!res.ok) throw new Error(`OpenRouter sign-in failed (${res.status})`);
    const { key } = await res.json();
    if (!key) throw new Error('OpenRouter did not return a key');
    state.key = key;
    store.set('or_key', key);
  } catch (e) {
    showError(e.message);
  }
}

function signOut() {
  state.key = null;
  store.del('or_key');
  renderAuth();
}

function renderAuth() {
  $('#signin').hidden = !!state.key;
  $('#signedin').hidden = !state.key;
  updateGo();
}

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    });
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  });
});

// ---------- camera recording ----------
const preview = $('#preview');
let stream = null;
let recorder = null;
let facing = 'user';
let recTimer = null;
let recStart = 0;

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
  } catch (e) {
    showError(`Could not open the camera: ${e.message}`);
    return;
  }
  clearVideo();
  preview.srcObject = stream;
  preview.muted = true;
  preview.controls = false;
  await preview.play().catch(() => {});
  $('#placeholder').hidden = true;
  $('#cam-start').hidden = true;
  $('#cam-flip').hidden = false;
  $('#rec-btn').hidden = false;
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function pickMime() {
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  const chunks = [];
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const seconds = (performance.now() - recStart) / 1000;
    clearInterval(recTimer);
    $('#rec-timer').hidden = true;
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
    stopCamera();
    $('#rec-stop').hidden = true;
    $('#cam-flip').hidden = true;
    $('#cam-start').hidden = false;
    $('#cam-start').textContent = 'Record again';
    setVideo(blob, Math.min(seconds, MAX_SECONDS));
  };
  recorder.start(1000);
  recStart = performance.now();
  $('#rec-btn').hidden = true;
  $('#rec-stop').hidden = false;
  $('#rec-timer').hidden = false;
  $('#rec-time').textContent = '0:00';
  recTimer = setInterval(() => {
    const s = (performance.now() - recStart) / 1000;
    $('#rec-time').textContent = `0:${String(Math.floor(Math.min(s, 60))).padStart(2, '0')}`;
    if (s >= MAX_SECONDS) stopRecording();
  }, 250);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

$('#cam-start').addEventListener('click', startCamera);
$('#cam-flip').addEventListener('click', () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); });
$('#rec-btn').addEventListener('click', startRecording);
$('#rec-stop').addEventListener('click', stopRecording);

// ---------- upload ----------
const drop = $('#drop');
$('#file').addEventListener('change', (e) => { if (e.target.files[0]) useFile(e.target.files[0]); });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) useFile(f);
});

function useFile(file) {
  if (!file.type.startsWith('video/')) { showError('That file is not a video.'); return; }
  stopCamera();
  setVideo(file, null);
}

function clearVideo() {
  if (state.video) URL.revokeObjectURL(state.video.url);
  state.video = null;
  preview.removeAttribute('src');
  updateGo();
}

function setVideo(blob, knownDuration) {
  clearVideo();
  const url = URL.createObjectURL(blob);
  state.video = { blob, url, knownDuration };
  preview.srcObject = null;
  preview.src = url;
  preview.muted = false;
  preview.controls = true;
  $('#placeholder').hidden = true;
  hideError();
  updateGo();
}

// ---------- options ----------
const OPTION_IDS = ['style', 'model', 'fps', 'lang'];
OPTION_IDS.forEach((id) => {
  const el = $(`#${id}`);
  const saved = store.get(`opt_${id}`);
  if (saved !== null && (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === saved))) el.value = saved;
  el.addEventListener('change', () => store.set(`opt_${id}`, el.value));
});

function updateGo() {
  const ready = !!state.key && !!state.video && !state.busy;
  $('#go').disabled = !ready;
  $('#rewrite').disabled = !state.key || !state.analysis || state.busy;
  $('#hint').textContent = !state.key
    ? 'Sign in with OpenRouter to begin.'
    : !state.video ? 'Record or upload a video to begin.'
    : state.busy ? 'Working…' : 'Ready.';
}

// ---------- video helpers ----------
function once(target, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, timeoutMs);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('The video could not be read by this browser.')); };
    function cleanup() { clearTimeout(t); target.removeEventListener(event, ok); target.removeEventListener('error', bad); }
    target.addEventListener(event, ok);
    target.addEventListener('error', bad);
  });
}

async function loadVideoElement(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  await once(v, 'loadedmetadata');
  // Recorded WebM files often report an unknown (Infinity) duration until you seek to the end.
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e7;
    await once(v, 'seeked').catch(() => {});
    v.currentTime = 0;
    await once(v, 'seeked').catch(() => {});
  }
  if (v.readyState < 2) await once(v, 'loadeddata').catch(() => {});
  return v;
}

async function extractFrames(url, knownDuration, fps, onProgress) {
  const v = await loadVideoElement(url);
  let duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : knownDuration;
  if (!duration) throw new Error('Could not determine the video length.');
  duration = Math.min(duration, MAX_SECONDS);

  let step = 1 / fps;
  if (duration / step > MAX_FRAMES) step = duration / MAX_FRAMES;
  const times = [];
  for (let t = Math.min(0.1, duration / 2); t < duration; t += step) times.push(t);

  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) throw new Error('This video has no picture track.');
  const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');

  const frames = [];
  for (let i = 0; i < times.length; i++) {
    v.currentTime = times[i];
    await once(v, 'seeked', 5000).catch(() => {});
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    frames.push({ t: times[i], dataUrl: canvas.toDataURL('image/jpeg', 0.72) });
    onProgress(i + 1, times.length);
  }
  v.removeAttribute('src');
  v.load();
  return { frames, duration };
}

async function decodeAudio(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const len = Math.min(buf.length, 16000 * MAX_SECONDS);
    const mono = new Float32Array(len);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / buf.numberOfChannels;
    }
    let sum = 0;
    for (let i = 0; i < len; i++) sum += mono[i] * mono[i];
    const rms = Math.sqrt(sum / Math.max(1, len));
    return rms < 0.003 ? null : mono; // near-silence: skip (Whisper invents words on silence)
  } catch {
    return null; // no audio track, or a format this browser can't decode
  } finally {
    ctx.close();
  }
}

// ---------- Whisper (Web Worker) ----------
let worker = null;
function transcribe(audio, onStatus) {
  if (!worker) worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const files = {};
    worker.onmessage = ({ data }) => {
      if (data.type === 'download') {
        files[data.file] = data;
        const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
        const total = Object.values(files).reduce((a, f) => a + f.total, 0);
        onStatus(`Downloading speech model (first time only): ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
      } else if (data.type === 'status') {
        onStatus(data.text);
      } else if (data.type === 'done') {
        resolve({ text: data.text, chunks: data.chunks });
      } else if (data.type === 'error') {
        reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Speech model failed to load'));
    onStatus('Loading speech model…');
    worker.postMessage({ audio }, [audio.buffer]);
  });
}

// ---------- Claude via OpenRouter ----------
async function callClaude({ messages, maxTokens, onDelta }) {
  const res = await fetch(`${OPENROUTER}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': callbackUrl(),
      'X-Title': APP_TITLE,
    },
    body: JSON.stringify({
      model: $('#model').value,
      messages,
      max_tokens: maxTokens,
      stream: !!onDelta,
    }),
  });

  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    if (res.status === 401) { signOut(); throw new Error('Your OpenRouter session expired. Please sign in again.'); }
    if (res.status === 402) throw new Error('Your OpenRouter account is out of credit. Add credit at openrouter.ai/settings/credits.');
    throw new Error(`Claude request failed: ${msg}`);
  }

  if (!onDelta) {
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'Claude returned an error');
    return j.choices?.[0]?.message?.content || '';
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // skip keep-alive comments
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'Claude returned an error');
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) { full += delta; onDelta(full); }
    }
  }
  return full;
}

const ANALYZE_SYSTEM = `You are a meticulous observer of video. You receive still frames sampled from a short video, each labelled with its timestamp, plus an automatic speech transcript that may contain mistakes or be empty.

Return ONLY a JSON object with this shape:
{
  "title": "a short evocative title for the moment",
  "setting": "where and when this seems to take place; light, weather, atmosphere",
  "mood": "the emotional tone in a few words",
  "on_screen_text": ["every piece of legible text, transcribed exactly: signs, captions, labels, screens"],
  "characters": [
    { "label": "a short visual handle, e.g. 'the man in the grey hoodie'", "description": "appearance, clothing, apparent age range, posture, expressions, what they do" }
  ],
  "timeline": [ { "t": 0, "event": "what happens, in one sentence" } ],
  "dialogue": [ { "t": 0, "speaker": "a character label, 'off-screen voice', or 'unclear'", "line": "the words spoken" } ],
  "notes": "anything else notable: animals, objects, camera movement, sounds implied by the transcript"
}

Rules:
- Describe people only by what is visible. Never identify or guess who a real person is. Use a name only if it is visibly written or clearly spoken in the video.
- Attribute each line of dialogue by matching its timestamp to the frames (who is facing the camera, mouth movement, gestures, context). If you cannot tell, use "unclear".
- Correct obvious speech-recognition errors only when the frames make the intended words clear; never invent dialogue.
- Characters can include animals. Use an empty array when there is nothing for a field.`;

function fmt(t) {
  if (t == null) return '?';
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
}

function transcriptText(tr) {
  if (!tr || !tr.chunks?.length) return '(no speech detected)';
  return tr.chunks.map((c) => `[${fmt(c.start)}–${fmt(c.end)}] ${c.text}`).join('\n');
}

function parseJson(text) {
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Claude did not return a readable analysis. Please try again.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function analyze(frames, duration, transcript) {
  const content = [{ type: 'text', text: `Video length: ${duration.toFixed(1)} seconds. ${frames.length} frames follow, in order.` }];
  for (const f of frames) {
    content.push({ type: 'text', text: `[t=${f.t.toFixed(1)}s]` });
    content.push({ type: 'image_url', image_url: { url: f.dataUrl } });
  }
  content.push({ type: 'text', text: `Speech transcript (automatic, may contain errors):\n${transcriptText(transcript)}` });
  const text = await callClaude({
    messages: [{ role: 'system', content: ANALYZE_SYSTEM }, { role: 'user', content }],
    maxTokens: 16000,
  });
  return parseJson(text);
}

const STYLES = {
  prose: 'Literary prose, 350 to 700 words. Weave the real dialogue in as quoted speech, each speaker on a new paragraph. Sensory, precise, unhurried.',
  poem: 'A lyrical free-verse poem of 16 to 40 lines. Rich imagery, rhythm and silence. Spoken words may appear as short italic echoes.',
  screenplay: 'A short screenplay in standard format: a scene heading (INT./EXT.), action lines, CHARACTER NAMES in capitals above their dialogue, and parentheticals where useful. Use the real dialogue.',
  noir: 'A hardboiled noir short story, 300 to 600 words, first person, world-weary and atmospheric, with the real dialogue as clipped quoted speech.',
  haiku: 'A sequence of 5 to 9 haiku (5-7-5 where the language allows) that follow the moment from beginning to end. Put a blank line between haiku.',
  fairytale: 'A fairy tale of 300 to 600 words that begins "Once upon a time", turning the real events and dialogue into something gently enchanted.',
};

function writeMessages(analysis, transcript) {
  const style = $('#style').value;
  const lang = $('#lang').value.trim();
  const direction = $('#direction').value.trim();
  const system = `You are a gifted writer who turns one real minute of life into a beautiful piece of writing.

Form: ${STYLES[style]}

Rules:
- Stay faithful to what actually happened: the setting, the people, their actions and their words. You may imagine inner thoughts, textures and small sensory details, but do not invent major events.
- Use the real dialogue. You may lightly tidy speech-recognition errors.
- Refer to people by evocative descriptions, never by guessed real identities.
- Begin with the title on its own line as a Markdown heading ("# Title"), then the piece. No preface, no commentary afterwards.
- Language: ${lang ? `write in ${lang}.` : 'write in the language spoken or written in the video; if there is none, write in English.'}`;
  const user = `Here is what was observed in the video:\n\n${JSON.stringify(analysis, null, 2)}\n\nRaw transcript:\n${transcriptText(transcript)}${direction ? `\n\nExtra direction from the reader: ${direction}` : ''}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

async function write() {
  const style = $('#style').value;
  const body = $('#story');
  body.className = `story-body ${style === 'poem' || style === 'haiku' ? 'verse' : ''} ${style === 'screenplay' ? 'screenplay' : ''}`;
  body.innerHTML = '<p class="cursor"></p>';
  $('#story-title').textContent = state.analysis?.title || 'The story';
  state.story = await callClaude({
    messages: writeMessages(state.analysis, state.transcript),
    maxTokens: 16000,
    onDelta: (text) => renderStory(text, true),
  });
  renderStory(state.story, false);
}

// ---------- rendering ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1<em>$2</em>');
}

function renderStory(text, streaming) {
  let t = text.replace(/^\s+/, '');
  const m = t.match(/^#\s+(.+)\n?/);
  if (m) {
    $('#story-title').textContent = m[1].trim();
    t = t.slice(m[0].length);
  }
  const body = $('#story');
  if (body.classList.contains('screenplay')) {
    body.innerHTML = esc(t.trim()) + (streaming ? '<span class="cursor"></span>' : '');
    return;
  }
  const blocks = t.trim().split(/\n\s*\n/).filter(Boolean);
  const html = blocks.map((b) => {
    const h = b.match(/^(#{1,3})\s+(.+)$/);
    if (h) return `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
    return `<p>${inline(b)}</p>`;
  });
  if (streaming) {
    if (html.length) html[html.length - 1] = html[html.length - 1].replace(/<p>/, '<p class="cursor">');
    else html.push('<p class="cursor"></p>');
  }
  body.innerHTML = html.join('');
}

function renderAnalysis(a, frames) {
  $('#a-setting').textContent = [a.setting, a.mood].filter(Boolean).join(' · ') || '—';

  const texts = $('#a-text');
  texts.replaceChildren();
  (a.on_screen_text?.length ? a.on_screen_text : [null]).forEach((s) => {
    const li = document.createElement('li');
    if (s == null) { li.className = 'none'; li.textContent = 'None found'; } else li.textContent = s;
    texts.append(li);
  });

  const chars = $('#a-chars');
  chars.replaceChildren();
  (a.characters || []).forEach((c) => {
    const d = document.createElement('div');
    d.className = 'char';
    const s = document.createElement('strong');
    s.textContent = c.label;
    d.append(s, document.createTextNode(c.description || ''));
    chars.append(d);
  });
  if (!a.characters?.length) chars.textContent = 'No one appears.';

  const tl = $('#a-timeline');
  tl.replaceChildren();
  (a.timeline || []).forEach((e) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = fmt(Number(e.t));
    li.append(time, document.createTextNode(e.event || ''));
    tl.append(li);
  });

  const dl = $('#a-dialogue');
  dl.replaceChildren();
  (a.dialogue || []).forEach((l) => {
    const div = document.createElement('div');
    div.className = 'line';
    const s = document.createElement('strong');
    s.textContent = `${l.speaker || 'unclear'}: `;
    div.append(s, document.createTextNode(`"${l.line}"`));
    dl.append(div);
  });
  if (!a.dialogue?.length) {
    const div = document.createElement('div');
    div.className = 'none';
    div.textContent = 'No speech detected.';
    dl.append(div);
  }

  const strip = $('#filmstrip');
  strip.replaceChildren();
  frames.forEach((f) => {
    const img = document.createElement('img');
    img.src = f.dataUrl;
    img.alt = `Frame at ${f.t.toFixed(1)} seconds`;
    img.title = `${f.t.toFixed(1)}s`;
    strip.append(img);
  });
}

// ---------- progress & errors ----------
function step(name, status) {
  const li = document.querySelector(`[data-step="${name}"]`);
  li.classList.remove('active', 'done', 'skipped');
  if (status) li.classList.add(status);
}
function detail(text) { $('#progress-detail').textContent = text || ''; }
function showError(msg) {
  $('#progress').hidden = false;
  const e = $('#error');
  e.textContent = msg;
  e.hidden = false;
}
function hideError() { $('#error').hidden = true; }

// ---------- main pipeline ----------
async function run() {
  if (state.busy) return;
  state.busy = true;
  updateGo();
  hideError();
  $('#progress').hidden = false;
  ['frames', 'audio', 'analyze', 'write'].forEach((s) => step(s, null));
  $('#results').hidden = true;

  let current = 'frames';
  try {
    step('frames', 'active');
    const fps = Number($('#fps').value);
    const { frames, duration } = await extractFrames(state.video.url, state.video.knownDuration, fps,
      (i, n) => detail(`Frame ${i} of ${n}`));
    state.frames = frames;
    step('frames', 'done');

    current = 'audio';
    step('audio', 'active');
    detail('Reading the soundtrack…');
    const audio = await decodeAudio(state.video.blob);
    if (audio) {
      state.transcript = await transcribe(audio, detail);
      step('audio', 'done');
    } else {
      state.transcript = { text: '', chunks: [] };
      step('audio', 'skipped');
    }

    current = 'analyze';
    step('analyze', 'active');
    detail(`Claude is studying ${frames.length} frames…`);
    state.analysis = await analyze(frames, duration, state.transcript);
    renderAnalysis(state.analysis, frames);
    step('analyze', 'done');

    current = 'write';
    step('write', 'active');
    detail('Claude is writing…');
    $('#results').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await write();
    step('write', 'done');
    detail('');
  } catch (e) {
    step(current, null);
    showError(e.message || String(e));
    detail('');
  } finally {
    state.busy = false;
    updateGo();
  }
}

async function rewrite() {
  if (state.busy || !state.analysis) return;
  state.busy = true;
  updateGo();
  hideError();
  try {
    step('write', 'active');
    await write();
    step('write', 'done');
  } catch (e) {
    step('write', null);
    showError(e.message || String(e));
  } finally {
    state.busy = false;
    updateGo();
  }
}

function storyMarkdown() {
  return `# ${$('#story-title').textContent}\n\n${state.story.replace(/^\s*#\s+.+\n?/, '').trim()}\n`;
}

$('#go').addEventListener('click', run);
$('#rewrite').addEventListener('click', rewrite);
$('#signin').addEventListener('click', signIn);
$('#signout').addEventListener('click', signOut);
$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(storyMarkdown());
    $('#copy').textContent = 'Copied';
    setTimeout(() => { $('#copy').textContent = 'Copy'; }, 1500);
  } catch { showError('Could not copy to the clipboard.'); }
});
$('#download').addEventListener('click', () => {
  const name = ($('#story-title').textContent || 'story').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'story';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([storyMarkdown()], { type: 'text/markdown' }));
  a.download = `${name}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- start ----------
state.key = store.get('or_key');
await finishSignIn();
renderAuth();
