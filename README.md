# Scene to Story

Record or upload a video up to one minute long. The AI (currently Claude) watches it, reads any text on screen, describes the people, listens to what they say, and writes about the moment: literary prose with dialogue, a poem, a screenplay, a noir story, a haiku sequence or a fairy tale.

It is a static site for **GitHub Pages**. There is no server and nothing to pay for hosting.

## How it works

```
Video (camera, upload, or a YouTube link + timestamp; ≤ 60 s)
 ├─ Frames: 1 per second, captured in the browser with <canvas>
 ├─ Audio: transcribed in the browser by Whisper (Transformers.js, Web Worker)
 └─ Claude, through OpenRouter, signed in with OAuth (PKCE)
      1. Analysis: text on screen, characters, timeline, who said what
      2. Writing: the piece, streamed onto the page
```

- **Sign-in:** "Sign in with OpenRouter" uses OAuth PKCE, so it needs no server and no secret. Each visitor's usage is billed to **their own** OpenRouter account. No key is ever stored in this repo.
- **YouTube:** paste a link (a `?t=1m30s` timestamp fills in the start time) and choose a length, which defaults to 60 seconds. A static page can't download YouTube videos, so the clip plays in YouTube's own embedded player while the page records its own tab, cropped to the player. When the browser asks, share **this tab** with **"Also share tab audio"** ticked. Recording happens in real time, and only desktop Chrome and Edge can do it (Firefox records without sound). Videos whose owners block embedding can't be used. Only capture videos you have the right to use.
- **Privacy:** the video and audio never leave the device. Only the still frames and the transcript go to the AI. Stories and analysis exist only on the open page (users keep them with Copy or Download). The page has a "Your privacy" section that explains this to users.
- **Speech model:** Whisper base (8-bit), about 75 MB, downloaded once from Hugging Face and then cached by the browser. It runs on WebAssembly in a background thread, so the page stays responsive.

## Cost per video (paid by the visitor through OpenRouter)

| Model | Approx. cost for a 1-minute video at 1 frame/s |
|---|---|
| Claude Opus 5.5 (default) | ~$0.25 |
| Claude Sonnet 5.5 | ~$0.12 |
| Claude Haiku 5.5 | ~$0.01 |
| Claude Fable 5.1 | ~$0.60 |

## Deploy to GitHub Pages

1. Create a new repository on GitHub and upload these files: `index.html`, `app.js`, `style.css`, `whisper-worker.js`, `README.md`.
2. In the repository, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then pick `main` and `/ (root)`.
3. After a minute your site is live at `https://<your-username>.github.io/<repo-name>/`.

Nothing to configure: OpenRouter's PKCE sign-in accepts any HTTPS callback address, so it works as soon as the site is published.

## Run locally

Camera access and ES modules need `http://localhost` or HTTPS, so opening the file directly won't work. Any static server will do:

```bash
npx serve .
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `style.css` | Styling, with light and dark modes |
| `app.js` | Recording, frame capture, OpenRouter sign-in, Claude calls, rendering |
| `whisper-worker.js` | Speech-to-text in a background thread |

## Limits

- Only the first 60 seconds of an uploaded video are used.
- Speaker attribution is inferred from the frames, so it is best with one or two people on screen.
- Very fast action between frames can be missed. Choose "2 per second" for those clips.
- The browser must be able to play the video format (MP4 and WebM work everywhere; some phone HEVC files only play in Safari).
