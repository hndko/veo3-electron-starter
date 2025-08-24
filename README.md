# Veo 3 Electron Starter

A minimal Electron desktop app to auto-generate short videos using **Veo 3** (via the **Gemini API**). Works on Windows/macOS/Linux.

✅ Features
- Add prompts to a **queue** and run with a **concurrency limit** (default: 2).  
- **TXT/CSV import** (CSV columns: `prompt,negativePrompt,seed,personGeneration`).  
- **Watch folder**: drop `.txt` (one prompt per line) or `.csv` files to auto-enqueue.  
- **Parameters** per job: negativePrompt, seed, personGeneration (`allow_all`, `allow_adult`, `dont_allow`*).  
- **Auto-save** `.mp4` files to your output folder.  
- **Resume** unfinished queue on app restart.  
- Basic **ETA** + native **notifications** when a video finishes.

> *Availability of `personGeneration` options depends on region and model variant. See docs linked below.

---

## 1) Requirements
- Node.js 18+ (preferably 20+)
- A **Gemini API key** (Paid preview for Veo 3). Create it in [Google AI Studio](https://aistudio.google.com/).

## 2) Setup
```bash
cd veo3-electron-starter
npm install
npm start
```

On first launch, open **Settings** and paste your **Gemini API Key**.  
No API key is stored remotely; it's written to a local `settings.json` in Electron's userData folder.

## 3) Usage
- **Add Job**: Fill the prompt, optional negativePrompt/seed/personGeneration. Click **Add**.
- **CSV/TXT Import**: Use the buttons in the toolbar.
- **Watch Folder**: Pick a folder; `.txt` or `.csv` files added later will be auto-enqueued.
- **Output Folder**: Choose where to save `.mp4` files.
- **Run**: Start/Pause with the toolbar controls. Change **Concurrency** as needed.

> Veo 3 preview generates **8s** videos (24 fps, 720p). During peak hours, generation can take **11s–6min**.
> Videos are **watermarked** with SynthID. See docs: ai.google.dev/gemini-api/docs/video

## 4) Notes & Limits
- Model used: `veo-3.0-generate-preview` (Gemini API). Audio is generated natively.
- Supported params (subset): `negativePrompt`, `personGeneration`, `seed`, `aspectRatio` (16:9).
- Region + policy restrictions may affect `personGeneration` values.
- Quotas & errors are surfaced inline; failed jobs are **retryable** via **Retry** button.

## 5) Packaging (Windows)
Use something like [`electron-packager`](https://github.com/electron/electron-packager) or `electron-builder` (not included) to produce an `.exe`.
A starter command:
```bash
npm i -D electron-packager
npx electron-packager . Veo3App --platform=win32 --arch=x64 --out=dist --overwrite
```

## References
- Veo 3 with Gemini API (JS code & parameters): https://ai.google.dev/gemini-api/docs/video
- Veo on Vertex AI API (REST): https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation

---

**Security**: Don’t hardcode the API key. This app stores it locally on your machine only.
