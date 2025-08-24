
import { app, BrowserWindow, ipcMain, dialog, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import chokidar from 'chokidar';
import { parse as csvParse } from 'csv-parse';
import sanitize from 'sanitize-filename';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let win;
let watcher = null;
let processing = false;

let quotaInterval = null;
let quotaTimeout = null;

const state = {
  settings: {
    apiKey: '',
    outputDir: path.join(os.homedir(), 'Videos', 'Veo3'),
    watchDir: '',
    concurrency: 2,
    personGenerationDefault: 'allow_all',
    costCapJobs: 100
  },
  queue: [],
  running: 0,
  totalRunCount: 0,
  quotaCooldown: {
    active: false,
    nextRetryAt: 0,
    prevConcurrency: 2,
    backoffMs: 5 * 60 * 1000,
    maxBackoffMs: 60 * 60 * 1000
  },
  cooldownUntil: 0
};

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const QUEUE_FILE = path.join(app.getPath('userData'), 'queue.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

function saveJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('saveJSON error', e);
  }
}

function ensureDirs() {
  fs.mkdirSync(state.settings.outputDir, { recursive: true });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  Object.assign(state.settings, loadJSON(SETTINGS_FILE, state.settings));
  const restored = loadJSON(QUEUE_FILE, []);
  state.queue = restored.map(j => (j.status === 'done' ? j : { ...j, status: 'queued', progress: 0 }));
  ensureDirs();
  createWindow();
  // Re-arm cooldown timers if needed
  if (state.quotaCooldown.active && state.quotaCooldown.nextRetryAt > Date.now()) {
    startQuotaCooldown('Resuming previous cooldown');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveJSON(SETTINGS_FILE, state.settings);
  saveJSON(QUEUE_FILE, state.queue);
});

function notify(title, body) {
  new Notification({ title, body }).show();
}

function send(channel, payload) {
  if (win && win.webContents) win.webContents.send(channel, payload);
}

function slugify(s) {
  const clean = s.replace(/\s+/g, ' ').trim().slice(0, 60);
  return sanitize(clean).replace(/\s/g, '_');
}

function intToTimeStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// -------- ETA/progress heuristic --------
function tickProgress(job) {
  if (job.status !== 'running') return;
  job.progress = Math.min(95, (job.progress || 5) + Math.random() * 5);
  job.eta = Math.max(5, (job.eta || 60) - 5);
}

// -------- Video job runner --------
async function runJob(job) {
  const apiKey = state.settings.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing Gemini API key. Set it in Settings.');

  const ai = new GoogleGenAI({ apiKey });

  job.status = 'running';
  job.progress = 5;
  job.startedAt = Date.now();
  job.eta = 90;
  send('queue:update', state.queue);

  let operation;
  try {
    const config = {
      aspectRatio: '16:9',
      ...(job.negativePrompt ? { negativePrompt: job.negativePrompt } : {}),
      ...(job.seed ? { seed: Number(job.seed) } : {}),
      ...(job.personGeneration ? { personGeneration: job.personGeneration } : {})
    };
    operation = await ai.models.generateVideos({
      model: 'veo-3.0-generate-preview',
      prompt: job.prompt,
      config
    });
  } catch (e) {
    if (e && e.message && e.message.includes('429')) { pauseOnQuotaExceeded(); throw new Error('Quota exceeded (429).'); } else { throw new Error('Start generation failed: ' + (e.message || String(e))); }
  }

  try {
    while (!operation.done) {
      await new Promise(r => setTimeout(r, 10000));
      tickProgress(job);
      send('queue:update', state.queue);
      operation = await ai.operations.getVideosOperation({ operation });
    }
  } catch (e) {
    if (e && e.message && e.message.includes('429')) { pauseOnQuotaExceeded(); throw new Error('Quota exceeded (429).'); } else { throw new Error('Polling failed: ' + (e.message || String(e))); }
  }

  try {
    const video = operation.response.generatedVideos?.[0];
    if (!video) throw new Error('No video in response');
    fs.mkdirSync(state.settings.outputDir, { recursive: true });
    const fname = `${intToTimeStamp(Date.now())}__${slugify(job.prompt)}.mp4`;
    const outPath = path.join(state.settings.outputDir, fname);
    await ai.files.download({ file: video.video, downloadPath: outPath });
    job.output = outPath;
    job.progress = 100;
    job.status = 'done';
    job.eta = 0;
    notify('Veo 3: Selesai', `Video disimpan: ${fname}`);
  } catch (e) {
    if (e && e.message && e.message.includes('429')) { pauseOnQuotaExceeded(); throw new Error('Quota exceeded (429).'); } else { throw new Error('Download failed: ' + (e.message || String(e))); }
  }
}


function isQuotaError(err) {
  const s = String(err || '');
  return s.includes('"code":429') || s.includes('RESOURCE_EXHAUSTED') || s.includes('rate limit') || s.includes('429');
}


function scheduleQuotaRetry() {
  // simple exponential backoff (start 5 min, double up to 60 min)
  const now = Date.now();
  const last = state.cooldownUntil > now ? state.cooldownUntil - now : 0;
  let nextDelay = 5 * 60 * 1000; // 5 min
  if (last > 0) {
    // double previous if still cooling down, capped at 60 min
    nextDelay = Math.min(last * 2, 60 * 60 * 1000);
  }
  state.cooldownUntil = now + nextDelay;
  saveJSON(SETTINGS_FILE, state.settings);
  send('queue:cooldown', { until: state.cooldownUntil });
  // schedule automatic resume attempt
  setTimeout(() => {
    if (Date.now() >= state.cooldownUntil) {
      state.settings.concurrency = Math.max(1, state.settings.concurrency || 1);
      send('queue:cooldownEnd', { resumed: true });
      pumpQueue();
    }
  }, nextDelay + 2000);
}


function startQuotaCooldown(reason = 'Quota exceeded (429)') {
  const now = Date.now();
  if (!state.quotaCooldown.active) {
    state.quotaCooldown.active = true;
    state.quotaCooldown.prevConcurrency = state.settings.concurrency;
  }
  state.settings.concurrency = 0;
  state.quotaCooldown.nextRetryAt = now + state.quotaCooldown.backoffMs;
  saveJSON(SETTINGS_FILE, state.settings);
  send('queue:pausedByQuota', { reason });
  // clear old timers
  if (quotaInterval) clearInterval(quotaInterval);
  if (quotaTimeout) clearTimeout(quotaTimeout);
  // tick every second
  quotaInterval = setInterval(() => {
    const remainingMs = Math.max(0, state.quotaCooldown.nextRetryAt - Date.now());
    send('quota:cooldownTick', { remainingSec: Math.ceil(remainingMs / 1000) });
    if (remainingMs <= 0) clearInterval(quotaInterval);
  }, 1000);
  // schedule resume
  quotaTimeout = setTimeout(endQuotaCooldown, state.quotaCooldown.nextRetryAt - now);
}

function endQuotaCooldown() {
  state.quotaCooldown.active = false;
  state.settings.concurrency = state.quotaCooldown.prevConcurrency || 2;
  // exponential backoff for next time (up to max)
  state.quotaCooldown.backoffMs = Math.min(state.quotaCooldown.backoffMs * 2, state.quotaCooldown.maxBackoffMs);
  saveJSON(SETTINGS_FILE, state.settings);
  send('quota:cooldownEnd', {});
  pumpQueue();
}

// -------- Queue pump --------
async function pumpQueue() {
  if (processing) return;
  processing = true;
  try {
    while (state.running < state.settings.concurrency) {
      const next = state.queue.find(j => j.status === 'queued');
      if (!next) break;
      if (state.totalRunCount >= state.settings.costCapJobs) {
        send('queue:pausedByCap', { cap: state.settings.costCapJobs });
        break;
      }
      next.attempts = (next.attempts || 0) + 1;
      state.running++;
      state.totalRunCount++;
      runJob(next).then(() => {
        state.running--;
        send('queue:update', state.queue);
        pumpQueue();
      }).catch(err => {
        next.status = 'error';
        if (isQuotaError(err)) {
          next.error = 'Quota exceeded (429). Processing paused.';
          state.running--;
          // Pause new jobs
          state.settings.concurrency = 0;
          saveJSON(SETTINGS_FILE, state.settings);
          send('queue:update', state.queue);
          send('queue:pausedByQuota', { reason: 'Quota exceeded (429). Check billing/limits.' });
          try { new Notification({ title: 'Veo 3', body: 'Quota exceeded, cek billing/limit' }).show(); } catch {}
          return;
        }

        next.error = String(err);
        next.progress = 0;
        state.running--;
        send('queue:update', state.queue);
        pumpQueue();
      });
    }
  } finally {
    processing = false;
    saveJSON(QUEUE_FILE, state.queue);
  }
}

// -------- Import helpers (used by IPC and watcher) --------
async function importCSVPath(filePath) {
  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csvParse({ columns: true, skip_empty_lines: true, trim: true }))
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });
  rows.forEach(r => {
    const job = {
      prompt: r.prompt || '',
      negativePrompt: r.negativePrompt || '',
      seed: r.seed || '',
      personGeneration: r.personGeneration || state.settings.personGenerationDefault
    };
    if (job.prompt) {
      const id = 'job_' + Math.random().toString(36).slice(2, 9);
      state.queue.push({ id, ...job, status:'queued', progress:0, eta:0, attempts:0 });
    }
  });
  saveJSON(QUEUE_FILE, state.queue);
  send('queue:update', state.queue);
  pumpQueue();
  return rows.length;
}

async function importTXTPath(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const id = 'job_' + Math.random().toString(36).slice(2, 9);
    state.queue.push({
      id, prompt: line, negativePrompt:'', seed:'',
      personGeneration: state.settings.personGenerationDefault,
      status:'queued', progress:0, eta:0, attempts:0
    });
  }
  saveJSON(QUEUE_FILE, state.queue);
  send('queue:update', state.queue);
  pumpQueue();
  return lines.length;
}


function pauseOnQuotaExceeded() {
  state.settings.concurrency = 0;
  send('queue:update', state.queue);
  notify('Veo 3: Quota Exceeded', 'Quota exceeded, cek billing/limit di Google AI Studio.');
}

// -------- IPC --------
ipcMain.handle('settings:get', () => state.settings);
ipcMain.handle('settings:set', (_e, s) => {
  Object.assign(state.settings, s);
  ensureDirs();
  saveJSON(SETTINGS_FILE, state.settings);
  return state.settings;
});

ipcMain.handle('queue:list', () => state.queue);
ipcMain.handle('queue:add', (_e, job) => {
  const id = 'job_' + Math.random().toString(36).slice(2, 9);
  state.queue.push({
    id,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt || '',
    seed: job.seed || '',
    personGeneration: job.personGeneration || state.settings.personGenerationDefault,
    status: 'queued',
    progress: 0,
    eta: 0,
    attempts: 0
  });
  saveJSON(QUEUE_FILE, state.queue);
  send('queue:update', state.queue);
  pumpQueue();
  return id;
});

ipcMain.handle('queue:retry', (_e, id) => {
  const j = state.queue.find(x => x.id === id);
  if (j && j.status === 'error') {
    j.status = 'queued';
    j.error = undefined;
    send('queue:update', state.queue);
    pumpQueue();
  }
});

ipcMain.handle('queue:start', () => {
  if (state.settings.concurrency === 0) state.settings.concurrency = 2;
  state.totalRunCount = 0;
  pumpQueue();
});

ipcMain.handle('queue:pause', () => {
  state.settings.concurrency = 0; // let running jobs finish
  send('queue:update', state.queue);
});

ipcMain.handle('queue:setConcurrency', (_e, n) => {
  state.settings.concurrency = Math.max(0, Math.min(8, Number(n) || 0));
  saveJSON(SETTINGS_FILE, state.settings);
  pumpQueue();
});

ipcMain.handle('queue:clearDone', () => {
  state.queue = state.queue.filter(j => j.status !== 'done');
  saveJSON(QUEUE_FILE, state.queue);
  send('queue:update', state.queue);
});

ipcMain.handle('dialog:chooseDir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? '' : res.filePaths[0];
});

ipcMain.handle('dialog:chooseFile', async (_e, filters) => {
  const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: filters || [] });
  return res.canceled ? '' : res.filePaths[0];
});

ipcMain.handle('import:csv', async (_e, filePath) => {
  return importCSVPath(filePath);
});

ipcMain.handle('import:txt', async (_e, filePath) => {
  return importTXTPath(filePath);
});

ipcMain.handle('watch:start', (_e, dirPath) => {
  if (watcher) watcher.close();
  if (!dirPath) return false;
  watcher = chokidar.watch([path.join(dirPath, '*.txt'), path.join(dirPath, '*.csv')], { ignoreInitial: false });
  watcher.on('add', async (p) => {
    try {
      if (p.endsWith('.txt')) await importTXTPath(p);
      else if (p.endsWith('.csv')) await importCSVPath(p);
    } catch (e) {
      console.error('watch import failed', e);
    }
  });
  state.settings.watchDir = dirPath;
  saveJSON(SETTINGS_FILE, state.settings);
  return true;
});

ipcMain.handle('output:set', (_e, dir) => {
  if (dir) {
    state.settings.outputDir = dir;
    ensureDirs();
    saveJSON(SETTINGS_FILE, state.settings);
    return true;
  }
  return false;
});
