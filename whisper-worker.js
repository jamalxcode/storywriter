// Runs Whisper speech-to-text entirely in the browser (no server).
// The model is downloaded from Hugging Face on first use and cached by the browser.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

const MODEL = 'onnx-community/whisper-base';
let transcriberPromise = null;

function progress(p) {
  if (p.status === 'progress' && p.total) {
    self.postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
  }
}

async function load() {
  if (!transcriberPromise) {
    // 8-bit weights on WebAssembly: ~75 MB download and works in every modern browser.
    transcriberPromise = pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      progress_callback: progress,
    });
  }
  return transcriberPromise;
}

self.onmessage = async (e) => {
  const { audio } = e.data;
  try {
    const transcriber = await load();
    self.postMessage({ type: 'status', text: 'Transcribing speech…' });
    const out = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: 'transcribe',
    });
    const chunks = (out.chunks || []).map((c) => ({
      start: c.timestamp?.[0] ?? null,
      end: c.timestamp?.[1] ?? null,
      text: (c.text || '').trim(),
    })).filter((c) => c.text);
    self.postMessage({ type: 'done', text: (out.text || '').trim(), chunks });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
