
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

const state = {
  settings: {
    apiKey: '',
    outputDir: path.join(os.homedir(), 'Videos', 'Veo3'),
    watchDir: '',
    concurrency: 2,
    personGenerationDefault: 'allow_all', // fallback; UI can change per job
    costCapJobs: 100 // simple cap: max jobs per run
  },
  queue: [], // {id, prompt, negativePrompt, seed, personGeneration, status, progress, eta, attempts}
  running: 0,
  totalRunCount: 0 // to enforce cost cap
};

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const QUEUE_FILE = path.join(app.getPath('userData'), 'queue.json');

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
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

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  Object.assign(state.settings, loadJSON(SETTINGS_FILE, state.settings));
  const restored = loadJSON(QUEUE_FILE, []);
  // Resume: requeue unfinished jobs
  state.queue = restored.map(j => (j.status === 'done' ? j : { ...j, status: 'queued', progress: 0 }));
  ensureDirs();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveJSON(SETTINGS_FILE, state.settings);
  saveJSON(QUEUE_FILE, state.queue);
});

// ---------- Helpers ----------

function notify(title, body) {
  new Notification({ title, body }).show();
}

function send(channel, payload) {
  if (win && win.webContents) {
    win.webContents.send(channel, payload);
  }
}

function slugify(s) {
  const clean = s.replace(/\s+/g, ' ').trim().slice(0, 60);
  return sanitize(clean).replace(/\s/g, '_');
}

// Fake ETA/progress since Veo ops don't expose progress
function tickProgress(job) {
  if (job.status !== 'running') return;
  job.progress = Math.min(95, job.progress + Math.random() * 5);
  job.eta = Math.max(5, (job.eta || 60) - 5);
}

// ---------- Queue processing ----------

async function runJob(job) {
  const apiKey = state.settings.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing Gemini API key. Set it in Settings.');

  const ai = new GoogleGenAI({ apiKey });

  job.status = 'running';
  job.progress = 5;
  job.startedAt = Date.now();
  job.eta = 90;

  send('queue:update', state.queue);

  // Start generation
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
    throw new Error('Start generation failed: ' + (e.message || e.toString()));
  }

  // Poll
  try {
    while (!operation.done) {
      await new Promise(r => setTimeout(r, 10000));
      tickProgress(job);
      send('queue:update', state.queue);
      operation = await ai.operations.getVideosOperation({ operation });
    }
  } catch (e) {
    throw new Error('Polling failed: ' + (e.message || e.toString()));
  }

  // Download
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
    throw new Error('Download failed: ' + (e.message || e.toString()));
  }
}

function intToTimeStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

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

// ---------- IPC ----------

ipcMain.handle('settings:get', () => state.settings);
ipcMain.handle('settings:set', (e, s) => {
  Object.assign(state.settings, s);
  ensureDirs();
  saveJSON(SETTINGS_FILE, state.settings);
  return state.settings;
});

ipcMain.handle('queue:list', () => state.queue);
ipcMain.handle('queue:add', (e, job) => {
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

ipcMain.handle('queue:retry', (e, id) => {
  const j = state.queue.find(x => x.id === id);
  if (j && j.status === 'error') {
    j.status = 'queued';
    j.error = undefined;
    send('queue:update', state.queue);
    pumpQueue();
  }
});

ipcMain.handle('queue:start', () => {
  state.totalRunCount = 0;
  pumpQueue();
});

ipcMain.handle('queue:pause', () => {
  // Let currently running jobs finish. No new jobs will be started.
  state.settings.concurrency = 0;
  send('queue:update', state.queue);
});

ipcMain.handle('queue:setConcurrency', (e, n) => {
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
});

ipcMain.handle('import:txt', async (_e, filePath) => {
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
});

ipcMain.handle('watch:start', (e, dirPath) => {
  if (watcher) watcher.close();
  if (!dirPath) return false;
  watcher = chokidar.watch([path.join(dirPath, '*.txt'), path.join(dirPath, '*.csv')], { ignoreInitial: false });
  watcher.on('add', (p) => {
    if (p.endsWith('.txt')) {
      ipcMain.emit('import:txt', null, p);
    } else if (p.endsWith('.csv')) {
      ipcMain.emit('import:csv', null, p);
    }
  });
  state.settings.watchDir = dirPath;
  saveJSON(SETTINGS_FILE, state.settings);
  return true;
});

ipcMain.handle('output:set', (e, dir) => {
  if (dir) {
    state.settings.outputDir = dir;
    ensureDirs();
    saveJSON(SETTINGS_FILE, state.settings);
    return true;
  }
  return false;
});
