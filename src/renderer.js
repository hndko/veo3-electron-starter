
if (!window.api) {
  alert('Preload gagal di-load. Pastikan contextIsolation aktif dan preload.js dieksekusi (lihat console).');
}


const $ = (sel) => document.querySelector(sel);
const tbody = $('#tbl tbody');
let settings = await window.api.getSettings();
let queue = await window.api.queueList();

$('#concurrency').value = settings.concurrency;
$('#outputDir').textContent = settings.outputDir;

function render() {
  tbody.innerHTML = '';
  queue.forEach((j, i) => {
    const tr = document.createElement('tr');

    const tdIdx = document.createElement('td');
    tdIdx.textContent = (i+1);
    tr.appendChild(tdIdx);

    const tdPrompt = document.createElement('td');
    tdPrompt.textContent = j.prompt;
    tr.appendChild(tdPrompt);

    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = `<span class="status">${j.status}</span>${j.error ? `<br><small class="mono" style="color:#b00">${j.error}</small>`:''}`;
    tr.appendChild(tdStatus);

    const tdProg = document.createElement('td');
    tdProg.innerHTML = `<div class="progress"><div class="bar" style="width:${j.progress||0}%"></div></div>`;
    tr.appendChild(tdProg);

    const tdEta = document.createElement('td');
    tdEta.textContent = j.status==='running' ? ((j.eta||0)+'s') : '';
    tr.appendChild(tdEta);

    const tdOut = document.createElement('td');
    if (j.output) {
      const a = document.createElement('a');
      a.href = 'file://' + j.output;
      a.textContent = j.output.split(/[\\/]/).pop();
      a.target = '_blank';
      tdOut.appendChild(a);
    }
    tr.appendChild(tdOut);

    const tdAct = document.createElement('td');
    if (j.status==='error') {
      const b = document.createElement('button');
      b.textContent = 'Retry';
      b.onclick = async () => {
        await window.api.retryJob(j.id);
      };
      tdAct.appendChild(b);
    }
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });

  $('#status').textContent = `Queue: ${queue.filter(j=>j.status==='queued').length} queued, ${queue.filter(j=>j.status==='running').length} running, ${queue.filter(j=>j.status==='done').length} done.`;
}

render();

// Controls
$('#btnAdd').onclick = async () => {
  const job = {
    prompt: $('#prompt').value.trim(),
    negativePrompt: $('#negPrompt').value.trim(),
    seed: $('#seed').value.trim(),
    personGeneration: $('#person').value
  };
  if (!job.prompt) return alert('Prompt required');
  await window.api.addJob(job);
  $('#prompt').value = '';
  render();
};

$('#btnStart').onclick = async () => {
  await window.api.startQueue();
};

$('#btnPause').onclick = async () => {
  await window.api.pauseQueue();
};

$('#btnClearDone').onclick = async () => {
  await window.api.clearDone();
  queue = await window.api.queueList();
  render();
};

$('#btnImportCSV').onclick = async () => {
  const file = await window.api.chooseFile([{ name:'CSV', extensions:['csv'] }]);
  if (!file) return;
  const count = await window.api.importCSV(file);
  alert(`Imported ${count} rows`);
};

$('#btnImportTXT').onclick = async () => {
  const file = await window.api.chooseFile([{ name:'Text', extensions:['txt'] }]);
  if (!file) return;
  const count = await window.api.importTXT(file);
  alert(`Imported ${count} lines`);
};

$('#btnWatchFolder').onclick = async () => {
  const dir = await window.api.chooseDir();
  if (!dir) return;
  await window.api.startWatch(dir);
  alert('Watching: ' + dir);
};

$('#btnOutputFolder').onclick = async () => {
  const dir = await window.api.chooseDir();
  if (!dir) return;
  await window.api.setOutputDir(dir);
  settings = await window.api.getSettings();
  $('#outputDir').textContent = settings.outputDir;
};

$('#concurrency').onchange = async (e) => {
  await window.api.setConcurrency(Number(e.target.value));
};

$('#btnSettings').onclick = async () => {
  const cur = await window.api.getSettings();
  const apiKey = prompt('Paste your Gemini API Key (kept locally):', cur.apiKey || '');
  if (apiKey === null) return;
  cur.apiKey = apiKey.trim();
  await window.api.setSettings(cur);
  alert('Saved.');
};

// Live updates from main
window.api.onQueueUpdate(async (q) => {
  queue = q;
  render();
});
window.api.onPausedByCap((p) => {
  alert(`Paused by cost cap: ${p.cap} jobs this session.`);
});


// ------- Settings Modal -------
const modal = document.getElementById('settingsModal');
const inpKey = document.getElementById('sett_apiKey');
const inpConc = document.getElementById('sett_conc');
const outDirLbl = document.getElementById('sett_outDir');
const btnChooseOut = document.getElementById('sett_chooseOut');
const btnSave = document.getElementById('sett_save');
const btnCancel = document.getElementById('sett_cancel');

function openSettingsModal() {
  modal.style.display = 'flex';
}

function closeSettingsModal() {
  modal.style.display = 'none';
}

$('#btnSettings').onclick = async () => {
  const cur = await window.api.getSettings();
  inpKey.value = cur.apiKey || '';
  inpConc.value = String(cur.concurrency ?? 2);
  outDirLbl.textContent = cur.outputDir || '';
  openSettingsModal();
};

btnChooseOut.onclick = async () => {
  const dir = await window.api.chooseDir();
  if (dir) {
    outDirLbl.textContent = dir;
  }
};

btnSave.onclick = async () => {
  const cur = await window.api.getSettings();
  cur.apiKey = inpKey.value.trim();
  cur.concurrency = Math.max(0, Math.min(8, Number(inpConc.value) || 0));
  if (outDirLbl.textContent) {
    await window.api.setOutputDir(outDirLbl.textContent);
    const after = await window.api.getSettings();
    cur.outputDir = after.outputDir;
    document.getElementById('outputDir').textContent = cur.outputDir;
  }
  await window.api.setSettings(cur);
  // Also apply concurrency immediately
  await window.api.setConcurrency(cur.concurrency);
  closeSettingsModal();
  alert('Settings saved.');
};

btnCancel.onclick = () => closeSettingsModal();

// Close modal if clicking backdrop
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeSettingsModal();
});


// Quota pause notification
window.api.onPausedByQuota((p) => {
  alert((p && p.reason) ? p.reason : 'Quota exceeded (429). Check billing/limits.');
});


// Cooldown notifications
let cooldownTimer = null;
window.api.onCooldown((p) => {
  if (!p || !p.until) return;
  const until = p.until;
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    const left = Math.max(0, until - Date.now());
    const sec = Math.floor(left/1000)%60;
    const min = Math.floor(left/60000);
    document.getElementById('status').textContent = `⏳ Quota cooldown: retry in ${min}m ${sec}s`;
    if (left<=0) {
      clearInterval(cooldownTimer);
    }
  }, 1000);
  alert('Quota exceeded. Auto-retry scheduled.');
});

window.api.onCooldownEnd((p) => {
  alert('Cooldown ended. Queue resumed.');
});


const cooldownLabel = document.getElementById('cooldown');
window.api.onPausedByQuota((p) => {
  alert((p && p.reason) ? p.reason : 'Quota exceeded (429). Check billing/limits.');
});
window.api.onQuotaCooldownTick((p) => {
  if (!p) return;
  const s = Number(p.remainingSec || 0);
  const mm = Math.floor(s / 60).toString().padStart(2,'0');
  const ss = (s % 60).toString().padStart(2,'0');
  cooldownLabel.textContent = s > 0 ? `Cooldown: ${mm}:${ss}` : '';
});
window.api.onQuotaCooldownEnd(() => {
  cooldownLabel.textContent = '';
  // Optionally notify user
  alert('Cooldown selesai. Queue akan melanjutkan otomatis.');
});
