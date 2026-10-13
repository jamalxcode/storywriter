<img src="logo.svg" width="72" align="left" alt="">

# Scene to Story

**Live: [story.sala.company](https://story.sala.company)** · part of [Sala Company](https://go.sala.company)

<br clear="left">

Record, upload or pick a YouTube clip up to one minute long. The AI (currently Claude) watches it, reads any text on screen, describes the people, listens to what they say, and writes about the moment as literary prose with dialogue, a poem, a screenplay, a noir story, a haiku sequence or a fairy tale.

It's a static site on GitHub Pages: no server, no database, nothing to pay for hosting. Visitors sign in with their own OpenRouter account, which pays for the AI.

[![Scene to Story: the start of the page](screenshot.jpg)](https://story.sala.company)

## Using it

The page walks you through four numbered steps:

1. **Sign in to OpenRouter**, or create a free account and add a little credit. Once you're signed in, this step shrinks to one faded line.
2. **Choose your video:** record with the camera, upload a file, or paste a YouTube link with a start time. The chosen tab's controls appear right under the tabs, above the video.
3. **Writing Style:** prose with dialogue, poem, screenplay, noir, haiku or fairy tale, plus an optional language and extra direction. The AI models and frame rate are under "More options".
4. **Write the story:** shows the estimated cost first, then progress (frames, audio, watching, writing), a Cancel button and the actual cost.

The story appears on a parchment scroll. Copy or Download keeps it, and "Rewrite in chosen style" writes it again in another style, paying only for the writing. "What the AI (Claude) saw" (collapsed) shows the setting, text on screen, characters, timeline and dialogue it found.

**Languages:** the story is written in the language spoken or shown in the video, or in the language you type. Right-to-left languages such as Arabic are detected automatically. The scroll switches direction, the text is set in Amiri, and the first paragraph opens with a gold ornament instead of a drop cap, so joined letters are never split.

## How it works

```
Video (camera, upload, or a YouTube link + timestamp; up to 60 s)
 ├─ Frames: 1 per second (or 2, or 1 every 2 s), captured in the browser with <canvas>
 ├─ Speech: transcribed in the browser by Whisper (Transformers.js, in a Web Worker)
 └─ AI (Claude) through OpenRouter, signed in with OAuth (PKCE)
      1. Watching (Sonnet 5.5 by default): text on screen, characters, timeline and
         who said what, returned in a strict JSON format
      2. Writing (Opus 5.5 by default): the piece, streamed onto the page
```

- **Sign-in:** "Sign in with OpenRouter" uses OAuth PKCE, so it needs no server or secret. Returning users go through OpenRouter's sign-in page, and new users get a separate "Create account" link. The key is kept in the visitor's browser until they sign out, and never in this repo.
- **Two models:** a cheaper model watches the frames, which is most of the input, and the best model writes. Both can be changed on the page.
- **YouTube:** paste a link (a `?t=1m30s` timestamp fills in the start time) and choose a length, which defaults to 60 seconds. A static page can't download from YouTube, so the clip plays in YouTube's own embedded player while the page records its own tab, cropped to the player. When the browser asks, share **this tab** with **"Also share tab audio"** ticked. It records in real time and needs desktop Chrome or Edge (Firefox records without sound). Videos whose owners block embedding can't be used. Only capture videos you have the right to use. The player is controlled only by messages to YouTube's own frame (no YouTube script runs in the page), so YouTube code can't read the saved sign-in. On phones and tablets, which can't capture a tab, the YouTube tab is hidden.
- **Reliability:** rate limits, server errors and dropped connections are retried automatically (up to 3 attempts, honouring `Retry-After`), but never after part of a story has appeared. The analysis is asked for again once if it still comes back unreadable. A **Cancel** button stops any step.
- **Cost:** an estimate before you start, from OpenRouter's live prices, and the actual cost OpenRouter reports afterwards.
- **Large files:** for uploads over 150 MB, the sound isn't decoded in one go. The first minute is played silently and recorded instead, in real time.
- **Speech model:** Whisper base (8-bit), about 80 MB, downloaded once from Hugging Face and then cached by the browser.

## Look

The page is styled as parchment:

- **Paper:** aged paper drawn with small SVG noise tiles, with no images and nothing recalculated while scrolling.
- **Type:** IM Fell English for headings, Pinyon Script calligraphy for the title, Cinzel gold numerals for the steps, EB Garamond for text, Amiri for Arabic, and Inter for buttons and inputs so they stay clearly clickable.
- **Details:** wax-seal red buttons, a gold ❦ flourish between steps, and a wax-seal tick on finished steps.
- **The story scroll:** rolled ends, a one-second unrolling animation (skipped when the device asks for reduced motion), and a gold drop cap for left-to-right text or a gold quill ornament for right-to-left text.
- **Dark mode** becomes "candlelit": dark aged paper with warm ink.
- **Logo:** a gold quill, inkpot and document on a dark badge (`logo.svg`, also the favicon).

The fonts add about 100 KB to the first visit. Amiri downloads only when Arabic text appears.

The plain design from before the theme is tagged `before-parchment`. To return to it, remove the `parchment.css` `<link>` in `index.html`, or check out that tag.

## Privacy

A **🔒 Privacy** button right after "Your video never leaves your device." opens a pop-up that tells visitors this in plain language (the step 4 "Details" link and the footer link open it too, as does `#privacy` in the address).

| What | Where it goes |
|---|---|
| The video and its sound | Stays on the device. Speech is turned into text on the device, too. |
| Still frames and the speech transcript | Sent to the AI (Claude, made by Anthropic) through OpenRouter, only when "Write the story" is pressed |
| The story and the AI's notes | Shown on the page only, and gone on reload unless the visitor copies or downloads it |
| OpenRouter sign-in and settings | Saved in the visitor's browser. "Sign out" removes them. |

Nothing is sent back to this site. The page also loads fonts from Google Fonts, the speech model from Hugging Face and jsDelivr, and the YouTube player when a YouTube link is used.

## Cost per story (paid by the visitor through OpenRouter)

Rough figures for a one-minute 16:9 video at 1 frame per second. The page shows its own estimate for each video.

| Watching → Writing | Approx. cost |
|---|---|
| Sonnet 5.5 → Opus 5.5 (default) | ~$0.17 |
| Haiku 5.5 → Opus 5.5 | ~$0.08 |
| Opus 5.5 → Opus 5.5 | ~$0.26 |
| Sonnet 5.5 → Fable 5.1 | ~$0.27 |
| Haiku 5.5 → Haiku 5.5 | under $0.01 |

A rewrite in another style costs only the writing step.

## Hosting

GitHub Pages serves the `main` branch at `story.sala.company` (see `CNAME`; DNS is a `CNAME` record for `story` pointing to `jamalxcode.github.io`), with HTTPS enforced. Every push to `main` goes live in about a minute. The old address, `jamalxcode.github.io/storywriter`, redirects here.

OpenRouter's PKCE sign-in accepts any HTTPS callback address, so a move to another domain needs no OpenRouter settings. Visitors just sign in again on the new address.

## Run locally

Camera access and ES modules need `http://localhost` or HTTPS, so opening `index.html` directly won't work. Any static server will do:

```bash
npx serve .
```

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout: the four numbered steps (sign in, choose a video, writing style, write), the results and the privacy pop-up |
| `style.css` | Base layout and styling, with light and dark modes |
| `parchment.css` | The parchment theme, loaded after `style.css` (see Look) |
| `app.js` | Recording, YouTube capture, frame capture, OpenRouter sign-in, AI calls, cost estimate, rendering |
| `whisper-worker.js` | Speech-to-text in a background thread |
| `logo.svg` | The logo (a gold quill, inkpot and document), also used as the favicon |
| `screenshot.jpg` | The screenshot in this README |
| `og-image.jpg` | The 1200×630 link-preview image (Open Graph and X tags in `index.html`) |
| `CNAME` | The custom domain, `story.sala.company` |
| `LICENSE` | MIT licence |

## Status

Tested end to end on 13 October 2026: OpenRouter sign-in, watching and writing with Claude, the cost estimate and actual cost, and an Arabic story. Retries, Cancel, large files, YouTube capture and the unrolling scroll were also tested with simulated AI replies and stand-in streams.

## Limits

- Only the first 60 seconds of a video are used.
- Speakers are matched from the frames, not by voice, so it works best with one or two people on screen.
- Very fast action between frames can be missed. Choose "2 per second" for those clips.
- The browser must be able to play the video format. MP4 and WebM work everywhere; some phone HEVC files play only in Safari.
- Capturing from YouTube doesn't work on phones.

## Licence

MIT, © 2026 SALA CO, [sala.company](https://www.sala.company). See [LICENSE](LICENSE).
