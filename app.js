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
  abort: null,        // AbortController for the run in progress
  cost: 0,            // actual $ spent in the current run, as reported by OpenRouter
  prices: {},         // model id → [$ per input token, $ per output token]
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

async function signIn(newAccount = false) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set('pkce_verifier', verifier, sessionStorage);
  const auth = new URL(`${OPENROUTER}/auth`);
  auth.searchParams.set('callback_url', callbackUrl());
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  // OpenRouter's /auth sends logged-out visitors to its sign-up form, so returning
  // users go through the sign-in page first, which then continues to /auth.
  if (newAccount) {
    location.href = auth.toString();
  } else {
    const signin = new URL(`${OPENROUTER}/sign-in`);
    signin.searchParams.set('redirect_url', auth.toString());
    location.href = signin.toString();
  }
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
  $('#signedout').hidden = !!state.key;
  $('#signedin').hidden = !state.key;
  $('#step-signin').classList.toggle('done', !!state.key);
  $('#step-signin h2').textContent = state.key ? 'Signed in to OpenRouter' : 'Sign in to OpenRouter';
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
    showYouTubeStage(tab.dataset.tab === 'youtube' && !!ytPlayer && !state.video);
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
  $('#rec-total').textContent = clock(MAX_SECONDS);
  recTimer = setInterval(() => {
    const s = (performance.now() - recStart) / 1000;
    $('#rec-time').textContent = clock(Math.min(s, MAX_SECONDS));
    if (s >= MAX_SECONDS) stopRecording();
  }, 250);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function clock(s) {
  const whole = Math.floor(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
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
  updateEstimate();
}

function setVideo(blob, knownDuration) {
  clearVideo();
  const url = URL.createObjectURL(blob);
  state.video = { blob, url, knownDuration };
  showYouTubeStage(false);
  preview.srcObject = null;
  preview.src = url;
  preview.muted = false;
  preview.controls = true;
  $('#placeholder').hidden = true;
  hideError();
  updateGo();
  probeVideo(state.video);
}

// Reads the length and picture size up front so the cost estimate can be shown.
async function probeVideo(video) {
  try {
    const v = await loadVideoElement(video.url);
    video.meta = {
      duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : video.knownDuration,
      w: v.videoWidth,
      h: v.videoHeight,
    };
    v.removeAttribute('src');
    v.load();
  } catch {
    video.meta = null;
  }
  if (state.video === video) updateEstimate();
}

// ---------- cost estimate ----------
// Used until live prices arrive from OpenRouter ($ per token: input, output).
const FALLBACK_PRICES = {
  'anthropic/claude-fable-5.1': [10e-6, 50e-6],
  'anthropic/claude-opus-5.5': [4e-6, 20e-6],
  'anthropic/claude-sonnet-5.5': [2e-6, 10e-6],
  'anthropic/claude-haiku-5.5': [0.1e-6, 0.5e-6],
};
// Rough token budgets per step, including the AI's hidden reasoning.
const WATCH_EXTRA_IN = 1500, WATCH_OUT = 3500, WRITE_IN = 3000, WRITE_OUT = 3000;

async function loadPrices() {
  try {
    const res = await fetch(`${OPENROUTER}/api/v1/models`);
    const { data } = await res.json();
    for (const m of data) {
      if (m.id.startsWith('anthropic/')) state.prices[m.id] = [Number(m.pricing.prompt), Number(m.pricing.completion)];
    }
    updateEstimate();
  } catch { /* keep the fallback prices */ }
}

function price(model) {
  return state.prices[model] || FALLBACK_PRICES[model] || [0, 0];
}

function estimateCost() {
  const meta = state.video?.meta;
  if (!meta?.w || !meta?.h) return null;
  const duration = Math.min(meta.duration || MAX_SECONDS, MAX_SECONDS);
  const frames = frameTimes(duration, Number($('#fps').value)).length;
  const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(meta.w, meta.h));
  const tokensPerFrame = Math.ceil((meta.w * scale) * (meta.h * scale) / 750) + 12; // image + timestamp label
  const [wi, wo] = price($('#watch').value);
  const [ri, ro] = price($('#model').value);
  return {
    frames,
    watch: (frames * tokensPerFrame + WATCH_EXTRA_IN) * wi + WATCH_OUT * wo,
    write: WRITE_IN * ri + WRITE_OUT * ro,
  };
}

function money(x) {
  return x < 0.01 ? 'under $0.01' : `$${x.toFixed(2)}`;
}

function updateEstimate() {
  const e = estimateCost();
  const el = $('#estimate');
  el.hidden = !e;
  if (!e) return;
  el.textContent = `Estimated cost: about ${money(e.watch + e.write)} — watching ${e.frames} frames ${money(e.watch)}, writing ${money(e.write)}. A rewrite costs only the writing.`;
}

// ---------- YouTube ----------
// A static page can't download YouTube videos, so we play the clip in the official
// embedded player and record this browser tab (cropped to the player) while it plays.
const ytHolder = $('#yt-holder');
let ytPlayer = null;
let ytApi = null;
let ytLoaded = null; // { id }

function showYouTubeStage(on) {
  ytHolder.hidden = !on;
  preview.hidden = on;
  if (!on && ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
  $('#placeholder').hidden = on || !!state.video || !!stream;
}

function parseTime(s) {
  s = String(s ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((a, p) => a * 60 + Number(p), 0);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  return NaN;
}

function parseYouTube(input) {
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  return { id, start: parseTime(url.searchParams.get('t') || url.searchParams.get('start')) };
}

function loadYouTubeApi() {
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      if (window.YT?.Player) { resolve(); return; }
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApi = null; reject(new Error('Could not load the YouTube player.')); };
      document.head.append(s);
    });
  }
  return ytApi;
}

function ytMessage(text) {
  const m = $('#yt-msg');
  m.textContent = text || '';
  m.hidden = !text;
}

function ytSettings() {
  const start = parseTime($('#yt-start').value) ?? 0;
  const length = Math.round(Number($('#yt-length').value) || MAX_SECONDS);
  return { start, length: Math.min(Math.max(length, 1), MAX_SECONDS) };
}

async function loadYouTube(id, start) {
  await loadYouTubeApi();
  stopCamera();
  clearVideo();
  showYouTubeStage(true);
  if (ytPlayer && ytLoaded?.id === id) {
    ytPlayer.cueVideoById({ videoId: id, startSeconds: start });
    return;
  }
  if (ytPlayer) ytPlayer.destroy();
  ytHolder.innerHTML = '<div id="yt-player"></div>';
  ytLoaded = { id };
  await new Promise((resolve) => {
    ytPlayer = new YT.Player('yt-player', {
      videoId: id,
      playerVars: { start: Math.floor(start), playsinline: 1, rel: 0 },
      events: {
        onReady: resolve,
        onError: (e) => {
          ytMessage([101, 150].includes(e.data)
            ? "This video's owner doesn't allow it to be played on other sites."
            : 'YouTube could not play this video.');
          $('#yt-capture').disabled = true;
        },
      },
    });
  });
}

let ytTimer = null;
async function onYouTubeInput() {
  clearTimeout(ytTimer);
  ytTimer = setTimeout(async () => {
    ytMessage('');
    const parsed = parseYouTube($('#yt-url').value);
    $('#yt-capture').disabled = !parsed;
    if (!parsed) {
      if ($('#yt-url').value.trim()) ytMessage("That doesn't look like a YouTube video link.");
      return;
    }
    if (parsed.start != null && !$('#yt-start').dataset.touched) $('#yt-start').value = clock(parsed.start);
    if (Number.isNaN(parseTime($('#yt-start').value))) { ytMessage('Start time should look like 1:30 or 90.'); return; }
    try {
      await loadYouTube(parsed.id, ytSettings().start);
    } catch (e) {
      ytMessage(e.message);
    }
  }, 400);
}

$('#yt-url').addEventListener('input', onYouTubeInput);
$('#yt-start').addEventListener('input', () => { $('#yt-start').dataset.touched = '1'; onYouTubeInput(); });

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (performance.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('The video did not start playing.')); }
    }, 100);
  });
}

async function captureYouTube() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    ytMessage('Capturing YouTube needs a desktop browser. Chrome or Edge work best.');
    return;
  }
  if (!ytPlayer?.seekTo) return;
  const { start, length } = ytSettings();
  ytMessage('');

  // Must be called straight from the click so the browser allows the share prompt.
  let cap;
  try {
    cap = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 30 },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') ytMessage(`Could not capture the tab: ${e.message}`);
    return;
  }

  clearVideo();
  showYouTubeStage(true);
  ytHolder.scrollIntoView({ block: 'center' });
  const [track] = cap.getVideoTracks();
  if (window.CropTarget && track.cropTo) {
    try { await track.cropTo(await CropTarget.fromElement(ytHolder)); } catch { /* record the whole tab */ }
  }
  const hasAudio = cap.getAudioTracks().length > 0;

  $('#yt-capture').disabled = true;
  try {
    ytPlayer.seekTo(start, true);
    ytPlayer.playVideo();
    await waitFor(() => ytPlayer.getPlayerState() === YT.PlayerState.PLAYING
      && Math.abs(ytPlayer.getCurrentTime() - start) < 3, 30000);

    const chunks = [];
    const mimeType = pickMime();
    const rec = new MediaRecorder(cap, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(1000);
    const t0 = performance.now();
    $('#rec-timer').hidden = false;
    $('#rec-total').textContent = clock(length);

    await new Promise((resolve) => {
      track.addEventListener('ended', resolve); // user pressed "Stop sharing"
      const iv = setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        $('#rec-time').textContent = clock(Math.min(s, length));
        const ended = ytPlayer.getPlayerState() === YT.PlayerState.ENDED;
        if (s >= length || ytPlayer.getCurrentTime() >= start + length || ended) {
          clearInterval(iv);
          resolve();
        }
      }, 100);
    });
    const seconds = Math.min((performance.now() - t0) / 1000, length);
    rec.stop();
    await stopped;
    ytPlayer.pauseVideo();
    const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'video/webm' });
    setVideo(blob, seconds);
    if (!hasAudio) ytMessage('No sound was captured, so the story will be written from the pictures only. To include speech, capture again and tick "Also share tab audio".');
  } catch (e) {
    ytMessage(e.message);
  } finally {
    cap.getTracks().forEach((t) => t.stop());
    $('#rec-timer').hidden = true;
    $('#yt-capture').disabled = false;
  }
}

$('#yt-capture').addEventListener('click', captureYouTube);

// ---------- options ----------
const OPTION_IDS = ['style', 'watch', 'model', 'fps', 'lang'];
OPTION_IDS.forEach((id) => {
  const el = $(`#${id}`);
  const saved = store.get(`opt_${id}`);
  if (saved !== null && (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === saved))) el.value = saved;
  el.addEventListener('change', () => { store.set(`opt_${id}`, el.value); updateEstimate(); });
});

function updateGo() {
  const ready = !!state.key && !!state.video && !state.busy;
  $('#go').disabled = !ready;
  $('#rewrite').disabled = !state.key || !state.analysis || state.busy;
  $('#step-video').classList.toggle('done', !!state.video);
  $('#hint').textContent = !state.key && !state.video ? 'First sign in (step 1) and choose a video (step 2).'
    : !state.key ? 'First sign in to OpenRouter (step 1).'
    : !state.video ? 'First choose a video (step 2).'
    : state.busy ? 'Working…' : 'Ready when you are.';
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

function frameTimes(duration, fps) {
  let step = 1 / fps;
  if (duration / step > MAX_FRAMES) step = duration / MAX_FRAMES;
  const times = [];
  for (let t = Math.min(0.1, duration / 2); t < duration; t += step) times.push(t);
  return times;
}

async function extractFrames(url, knownDuration, fps, onProgress, signal) {
  const v = await loadVideoElement(url);
  let duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : knownDuration;
  if (!duration) throw new Error('Could not determine the video length.');
  duration = Math.min(duration, MAX_SECONDS);
  const times = frameTimes(duration, fps);

  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) throw new Error('This video has no picture track.');
  const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');

  const frames = [];
  for (let i = 0; i < times.length; i++) {
    if (signal?.aborted) throw abortError();
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

// Files bigger than this are not decoded in one go (the browser would have to hold the
// whole soundtrack in memory); instead the first minute is played silently and recorded.
const LARGE_FILE_BYTES = 150 * 1024 * 1024;
const SAMPLE_RATE = 16000;

function silentOrNull(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms < 0.003 ? null : samples; // near-silence: skip (Whisper invents words on silence)
}

async function readAudio(video, duration, signal, onProgress) {
  return video.blob.size > LARGE_FILE_BYTES
    ? listenToAudio(video.url, duration, signal, onProgress)
    : decodeAudio(video.blob);
}

async function decodeAudio(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: SAMPLE_RATE });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const len = Math.min(buf.length, SAMPLE_RATE * MAX_SECONDS);
    const mono = new Float32Array(len);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / buf.numberOfChannels;
    }
    return silentOrNull(mono);
  } catch {
    return null; // no audio track, or a format this browser can't decode
  } finally {
    ctx.close();
  }
}

async function listenToAudio(url, duration, signal, onProgress) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: SAMPLE_RATE });
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await once(v, 'loadedmetadata');
    const target = Math.round(Math.min(duration, MAX_SECONDS) * SAMPLE_RATE);
    const out = new Float32Array(target);
    let n = 0;
    const source = ctx.createMediaElementSource(v);
    const tap = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // record it without playing it out loud
    tap.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      const k = Math.min(data.length, target - n);
      if (k > 0) { out.set(data.subarray(0, k), n); n += k; }
    };
    source.connect(tap);
    tap.connect(mute);
    mute.connect(ctx.destination);
    await ctx.resume();
    await v.play();
    await new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        if (signal?.aborted) { clearInterval(iv); reject(abortError()); return; }
        onProgress(`Large file: listening to the soundtrack in real time (${clock(n / SAMPLE_RATE)} of ${clock(target / SAMPLE_RATE)})`);
        if (n >= target || v.ended) { clearInterval(iv); resolve(); }
      }, 250);
    });
    return silentOrNull(out.subarray(0, n));
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    ctx.close();
  }
}

// ---------- Whisper (Web Worker) ----------
let worker = null;
function transcribe(audio, onStatus, signal) {
  if (!worker) worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  return new Promise((_resolve, _reject) => {
    const onAbort = () => {
      worker.terminate(); // the only way to stop Whisper mid-run; a fresh worker is made next time
      worker = null;
      _reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const resolve = (v) => { signal?.removeEventListener('abort', onAbort); _resolve(v); };
    const reject = (e) => { signal?.removeEventListener('abort', onAbort); _reject(e); };
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

// ---------- AI (Claude) via OpenRouter ----------
class RetryableError extends Error {
  constructor(message, retryAfterMs) { super(message); this.retryAfterMs = retryAfterMs; }
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

// Sends one chat request. Retries on rate limits, server errors and dropped connections,
// but never after part of a streamed answer has already been shown.
async function callAI({ model, messages, maxTokens, onDelta, responseFormat, signal }) {
  for (let attempt = 1; ; attempt++) {
    let received = false;
    try {
      return await requestAI({ model, messages, maxTokens, responseFormat, signal,
        onDelta: onDelta && ((text) => { received = true; onDelta(text); }) });
    } catch (e) {
      const retryable = e instanceof RetryableError || (e instanceof TypeError && !signal?.aborted);
      if (!retryable || received || attempt >= MAX_ATTEMPTS) {
        throw e instanceof TypeError ? new Error('Could not reach OpenRouter. Check your connection and try again.') : e;
      }
      const wait = e.retryAfterMs ?? 2000 * 2 ** (attempt - 1);
      detail(`The AI service is busy; trying again in ${Math.ceil(wait / 1000)}s…`);
      await sleep(wait, signal);
    }
  }
}

async function requestAI({ model, messages, maxTokens, onDelta, responseFormat, signal }) {
  const res = await fetch(`${OPENROUTER}/api/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${state.key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': callbackUrl(),
      'X-Title': APP_TITLE,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: !!onDelta,
      usage: { include: true },
      ...(responseFormat && { response_format: responseFormat, provider: { require_parameters: true } }),
    }),
  });

  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    if (res.status === 401) { signOut(); throw new Error('Your OpenRouter session expired. Please sign in again.'); }
    if (res.status === 402) throw new Error('Your OpenRouter account is out of credit. Add credit at openrouter.ai/settings/credits.');
    if (RETRY_STATUS.has(res.status)) {
      const after = Number(res.headers.get('retry-after'));
      throw new RetryableError(`AI request failed: ${msg}`, after > 0 ? Math.min(after, 30) * 1000 : undefined);
    }
    throw new Error(`AI request failed: ${msg}`);
  }

  if (!onDelta) {
    const j = await res.json();
    if (j.error) throw new RetryableError(j.error.message || 'The AI returned an error');
    addCost(j.usage);
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
      if (j.error) throw new RetryableError(j.error.message || 'The AI returned an error');
      if (j.usage) addCost(j.usage);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) { full += delta; onDelta(full); }
    }
  }
  return full;
}

function addCost(usage) {
  if (typeof usage?.cost === 'number') state.cost += usage.cost;
}

const ANALYZE_SYSTEM = `You are a meticulous observer of video. You receive still frames sampled from a short video, each labelled with its timestamp, plus an automatic speech transcript that may contain mistakes or be empty.

Return a JSON object with these fields:
- title: a short evocative title for the moment
- setting: where and when this seems to take place; light, weather, atmosphere
- mood: the emotional tone in a few words
- on_screen_text: every piece of legible text, transcribed exactly (signs, captions, labels, screens)
- characters: for each person or animal, a label (a short visual handle, e.g. "the man in the grey hoodie") and a description (appearance, clothing, apparent age range, posture, expressions, what they do)
- timeline: what happens, as { t: seconds, event: one sentence }
- dialogue: each spoken line as { t: seconds, speaker: a character label, "off-screen voice" or "unclear", line: the words spoken }
- notes: anything else notable (objects, camera movement, sounds implied by the transcript)

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
  if (start < 0 || end < start) throw new Error('The AI did not return a readable analysis. Please try again.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const ANALYSIS_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'video_analysis',
    strict: true,
    schema: obj({
      title: str,
      setting: str,
      mood: str,
      on_screen_text: { type: 'array', items: str },
      characters: { type: 'array', items: obj({ label: str, description: str }) },
      timeline: { type: 'array', items: obj({ t: { type: 'number' }, event: str }) },
      dialogue: { type: 'array', items: obj({ t: { type: 'number' }, speaker: str, line: str }) },
      notes: str,
    }),
  },
};

async function analyze(frames, duration, transcript, signal) {
  const content = [{ type: 'text', text: `Video length: ${duration.toFixed(1)} seconds. ${frames.length} frames follow, in order.` }];
  for (const f of frames) {
    content.push({ type: 'text', text: `[t=${f.t.toFixed(1)}s]` });
    content.push({ type: 'image_url', image_url: { url: f.dataUrl } });
  }
  content.push({ type: 'text', text: `Speech transcript (automatic, may contain errors):\n${transcriptText(transcript)}` });
  const request = {
    model: $('#watch').value,
    messages: [{ role: 'system', content: ANALYZE_SYSTEM }, { role: 'user', content }],
    maxTokens: 16000,
    responseFormat: ANALYSIS_FORMAT,
    signal,
  };
  try {
    return parseJson(await callAI(request));
  } catch (e) {
    if (!(e instanceof SyntaxError) && !/readable analysis/.test(e.message)) throw e;
    detail('The AI\'s notes came back garbled; asking again…');
    return parseJson(await callAI(request));
  }
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

async function write(signal) {
  const style = $('#style').value;
  const body = $('#story');
  body.className = `story-body ${style === 'poem' || style === 'haiku' ? 'verse' : ''} ${style === 'screenplay' ? 'screenplay' : ''}`;
  body.innerHTML = '<p class="cursor"></p>';
  $('#story-title').textContent = state.analysis?.title || 'The story';
  state.story = await callAI({
    model: $('#model').value,
    messages: writeMessages(state.analysis, state.transcript),
    maxTokens: 16000,
    onDelta: (text) => renderStory(text, true),
    signal,
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
// Shows "message… 12s" so long AI calls visibly keep moving.
function ticking(message) {
  const t0 = performance.now();
  detail(message);
  const iv = setInterval(() => {
    const el = $('#progress-detail');
    if (!el.textContent.startsWith(message)) return; // a retry notice is showing
    el.textContent = `${message} ${Math.round((performance.now() - t0) / 1000)}s`;
  }, 1000);
  return () => clearInterval(iv);
}

function begin() {
  state.busy = true;
  state.cost = 0;
  state.abort = new AbortController();
  $('#cost').hidden = true;
  $('#cancel').hidden = false;
  updateGo();
  hideError();
  $('#progress').hidden = false;
  return state.abort.signal;
}

function finish(current, error) {
  if (error) {
    step(current, null);
    if (error.name === 'AbortError') detail('Cancelled.');
    else { showError(error.message || String(error)); detail(''); }
  } else {
    detail('');
  }
  if (state.cost > 0) {
    $('#cost').textContent = `This cost $${state.cost.toFixed(3)}, charged to your OpenRouter account.`;
    $('#cost').hidden = false;
  }
  $('#cancel').hidden = true;
  state.abort = null;
  state.busy = false;
  updateGo();
}

async function run() {
  if (state.busy) return;
  const signal = begin();
  ['frames', 'audio', 'analyze', 'write'].forEach((s) => step(s, null));
  $('#results').hidden = true;
  $('.analysis').open = false;

  let current = 'frames';
  let stopTicking = () => {};
  try {
    step('frames', 'active');
    const fps = Number($('#fps').value);
    const { frames, duration } = await extractFrames(state.video.url, state.video.knownDuration, fps,
      (i, n) => detail(`Frame ${i} of ${n}`), signal);
    state.frames = frames;
    step('frames', 'done');

    current = 'audio';
    step('audio', 'active');
    detail('Reading the soundtrack…');
    const audio = await readAudio(state.video, duration, signal, detail);
    if (audio) {
      state.transcript = await transcribe(audio, detail, signal);
      step('audio', 'done');
    } else {
      state.transcript = { text: '', chunks: [] };
      step('audio', 'skipped');
    }

    current = 'analyze';
    step('analyze', 'active');
    stopTicking = ticking(`The AI is studying ${frames.length} frames…`);
    state.analysis = await analyze(frames, duration, state.transcript, signal);
    stopTicking();
    renderAnalysis(state.analysis, frames);
    step('analyze', 'done');

    current = 'write';
    step('write', 'active');
    detail('The AI is writing…');
    $('#results').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await write(signal);
    step('write', 'done');
    finish(current);
  } catch (e) {
    stopTicking();
    finish(current, e);
  }
}

async function rewrite() {
  if (state.busy || !state.analysis) return;
  const signal = begin();
  try {
    step('write', 'active');
    detail('The AI is writing…');
    await write(signal);
    step('write', 'done');
    finish('write');
  } catch (e) {
    finish('write', e);
  }
}

$('#cancel').addEventListener('click', () => state.abort?.abort());

function storyMarkdown() {
  return `# ${$('#story-title').textContent}\n\n${state.story.replace(/^\s*#\s+.+\n?/, '').trim()}\n`;
}

$('.analysis').addEventListener('toggle', (e) => {
  e.target.querySelector('.toggle').textContent = e.target.open ? 'Hide' : 'Show';
});
$('#go').addEventListener('click', run);
$('#rewrite').addEventListener('click', rewrite);
$('#signin').addEventListener('click', () => signIn(false));
$('#signup').addEventListener('click', () => signIn(true));
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
loadPrices();
