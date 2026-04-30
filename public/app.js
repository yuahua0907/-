// ===== 多人版：裝置 ID + 顯示名稱 =====
function getUid() { return (localStorage.getItem('fitness_uid') || '').trim(); }
function getName() { return (localStorage.getItem('fitness_name') || '').trim(); }
function setUid(v) { localStorage.setItem('fitness_uid', v.trim()); }
function setName(v) { localStorage.setItem('fitness_name', v.trim()); }
function genUid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// v1 → v2 自動遷移：把舊的「名字當 ID」升級成「真 UUID」但保留原資料
(function migrateLegacy() {
  const legacy = (localStorage.getItem('fitness_user') || '').trim();
  if (!getUid() && legacy) {
    setUid(legacy);   // 直接用舊名字當 ID 才能讀到舊資料
    setName(legacy);
    localStorage.removeItem('fitness_user');
  }
})();

// 第一次來：產生 UID + 問顯示名稱
function askName(reason) {
  let n = '';
  while (!n) {
    n = (window.prompt(`${reason}\n\n顯示名稱（小健會這樣叫你，可重複、可改）：`) || '').trim();
    if (n.length > 30) { alert('名字太長（最多 30 字）'); n = ''; }
  }
  setName(n);
  return n;
}
if (!getUid()) {
  setUid(genUid());
  askName('👋 第一次來！');
}

// 所有 /api/* 自動帶兩個 header
const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts = {}) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    const headers = new Headers(opts.headers || {});
    headers.set('X-User', getUid());
    headers.set('X-User-Name', getName() || '匿名');
    opts = { ...opts, headers };
  }
  return _origFetch(url, opts);
};

// 使用者列 UI + 識別碼管理
window.addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.id = 'user-bar';
  bar.innerHTML = `
    <span>👤 <b id="user-name"></b></span>
    <div class="user-bar-actions">
      <button id="rename-user" type="button">改名</button>
      <button id="show-uid" type="button">我的識別碼</button>
      <button id="sync-uid" type="button">換裝置同步</button>
    </div>
  `;
  document.body.insertBefore(bar, document.body.firstChild);

  const refresh = () => { document.getElementById('user-name').textContent = getName() || '匿名'; };
  refresh();

  document.getElementById('rename-user').addEventListener('click', () => {
    const cur = getName();
    const n = (prompt('改顯示名稱（不會影響資料，只是小健叫你用的）：', cur) || '').trim();
    if (n && n !== cur) { setName(n); refresh(); alert('改好了'); }
  });

  document.getElementById('show-uid').addEventListener('click', async () => {
    const uid = getUid();
    try {
      await navigator.clipboard.writeText(uid);
      alert('✅ 你的識別碼已複製到剪貼簿：\n\n' + uid + '\n\n換裝置時在新手機點「換裝置同步」貼上，資料就接得回來。建議存到 LINE 給自己 / 備忘錄。');
    } catch {
      prompt('複製這串識別碼，貼到備忘錄保存：\n（換裝置同步時要用）', uid);
    }
  });

  document.getElementById('sync-uid').addEventListener('click', () => {
    const cur = getUid();
    const v = (prompt(`貼上你之前的識別碼來接回原本資料：\n（目前識別碼：${cur}）\n⚠️ 接回後這台裝置原本的「${getName() || '匿名'}」資料就看不到了，但其實在原本那組 ID 下不會消失。`, '') || '').trim();
    if (!v || v === cur) return;
    setUid(v);
    location.reload();
  });
});

// ===== INBODY：拍照辨識 / 手動 / 儲存 / 趨勢圖 =====
const inbodyForm = document.getElementById('inbody-form');
const saveMsg = document.getElementById('save-msg');
const latestBox = document.getElementById('latest-inbody');
const inbodyFile = document.getElementById('inbody-file');
const recognizeBtn = document.getElementById('recognize-btn');
const recognizeMsg = document.getElementById('recognize-msg');

// Tab 切換：初始兩個都不亮；選了才顯示對應區塊
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isPhoto = btn.dataset.tab === 'photo';
    document.getElementById('tab-photo').style.display = isPhoto ? 'block' : 'none';
    // 手動 → 直接顯示空白表單讓使用者填
    // 拍照 → 隱藏表單，等辨識完再秀
    if (isPhoto) {
      inbodyForm.style.display = 'none';
      inbodyForm.reset();
      recognizeMsg.textContent = '';
    } else {
      inbodyForm.style.display = 'grid';
      inbodyForm.reset();
    }
  });
});

async function loadLatestInbody() {
  const res = await fetch('/api/inbody/latest');
  const r = await res.json();
  if (!r) {
    latestBox.innerHTML = '<span class="empty">尚未輸入 INBODY 資料，先拍一張或手動填。</span>';
    return;
  }
  latestBox.innerHTML = `
    <strong>最新紀錄</strong>（${r.created_at}）｜
    體重 <b>${r.weight}</b>kg ｜ 體脂 <b>${r.body_fat}</b>% ｜
    骨骼肌 <b>${r.muscle}</b>kg ｜ BMR <b>${r.bmr}</b>kcal ｜ 目標：<b>${r.goal}</b>
  `;
}
loadLatestInbody();

recognizeBtn.addEventListener('click', async () => {
  const file = inbodyFile.files[0];
  if (!file) { recognizeMsg.textContent = '請先選照片'; return; }
  recognizeBtn.disabled = true;
  recognizeMsg.textContent = '📤 上傳中…';
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    let mime = file.type || 'image/jpeg';
    if (/\.hei[cf]$/i.test(file.name) && !mime) mime = 'image/heic';
    recognizeMsg.textContent = '🔍 小健正在讀報告…（約 5–10 秒）';
    try {
      const res = await fetch('/api/inbody/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, mime_type: mime })
      });
      const j = await res.json();
      if (j.error) { recognizeMsg.textContent = '❌ ' + j.error; return; }
      inbodyForm.style.display = 'grid';
      inbodyForm.weight.value = j.weight ?? '';
      inbodyForm.body_fat.value = j.body_fat ?? '';
      inbodyForm.muscle.value = j.muscle ?? '';
      inbodyForm.bmr.value = j.bmr ?? '';
      recognizeMsg.textContent = '✅ 辨識完成！請核對下方數字（可修改）再按儲存';
    } catch (e) {
      recognizeMsg.textContent = '❌ ' + e.message;
    } finally {
      recognizeBtn.disabled = false;
    }
  };
  reader.readAsDataURL(file);
});

// ===== 趨勢圖 =====
let trendChart = null;
let trendData = [];
let currentMetric = 'weight';
let currentRange = 5;
const metricLabels = { weight: '體重 (kg)', body_fat: '體脂率 (%)', muscle: '骨骼肌 (kg)' };
const metricColors = { weight: '#0a84ff', body_fat: '#ff3b30', muscle: '#34c759' };

async function loadTrend() {
  const res = await fetch('/api/inbody/history');
  trendData = await res.json();
  renderTrend();
}

function renderTrend() {
  const canvas = document.getElementById('trend-chart');
  const msg = document.getElementById('trend-msg');
  if (trendData.length < 2) {
    msg.textContent = `目前只有 ${trendData.length} 筆紀錄，累積 2 筆以上才能畫趨勢圖。`;
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';
  const sliced = currentRange === 'all' ? trendData : trendData.slice(-Number(currentRange));
  msg.textContent = `顯示 ${sliced.length} / ${trendData.length} 筆`;
  const labels = sliced.map(r => r.created_at.slice(0, 10));
  const values = sliced.map(r => r[currentMetric]);
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: metricLabels[currentMetric],
        data: values,
        borderColor: metricColors[currentMetric],
        backgroundColor: metricColors[currentMetric] + '33',
        tension: 0.25,
        fill: true,
        pointRadius: 5
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: false } }
    }
  });
}

document.querySelectorAll('.chart-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMetric = btn.dataset.metric;
    renderTrend();
  });
});

document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    renderTrend();
  });
});

loadTrend();

// ===== INBODY 歷史紀錄（含刪除） =====
const inbodyHistoryEl = document.getElementById('inbody-history');
async function loadInbodyHistory() {
  const res = await fetch('/api/inbody/history');
  const rows = await res.json();
  inbodyHistoryEl.innerHTML = rows.slice().reverse().map(r => `
    <div class="log-item" data-id="${r.id}">
      <button class="del-log del-inbody" data-id="${r.id}">刪除</button>
      <strong>${r.created_at.slice(0,10)}</strong>
      體重 ${r.weight}kg｜體脂 ${r.body_fat}%｜骨骼肌 ${r.muscle}kg｜BMR ${r.bmr}｜${r.goal}
    </div>
  `).join('') || '<p>尚無紀錄</p>';
  inbodyHistoryEl.querySelectorAll('.del-inbody').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定刪除這筆 INBODY 紀錄？')) return;
      await fetch(`/api/inbody/${btn.dataset.id}`, { method: 'DELETE' });
      loadInbodyHistory();
      loadLatestInbody();
      loadTrend();
    });
  });
}
loadInbodyHistory();

const chat = document.getElementById('chat');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('msg');

const inbodyFeedback = document.getElementById('inbody-feedback');

inbodyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(inbodyForm));
  const res = await fetch('/api/inbody', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const j = await res.json();
  saveMsg.textContent = `✅ 已儲存（id=${j.id}），小健分析中…`;
  loadLatestInbody();
  loadTrend();

  inbodyFeedback.style.display = 'block';
  inbodyFeedback.textContent = '💬 小健正在對照你的歷史資料…';
  const fb = await fetch('/api/inbody/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: j.id })
  });
  const fbJson = await fb.json();
  inbodyFeedback.textContent = '💬 小健：' + (fbJson.feedback || `錯誤：${fbJson.error}`);
  saveMsg.textContent = `✅ 已儲存（id=${j.id}）`;
  inbodyForm.reset();
  inbodyForm.style.display = 'none';
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-photo').style.display = 'none';
  loadInbodyHistory();
});

function addBubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

// ===== 訓練計時器 =====
const totalTimeEl = document.getElementById('total-time');
const startWorkoutBtn = document.getElementById('start-workout');
const endWorkoutBtn = document.getElementById('end-workout');
const restSecondsInput = document.getElementById('rest-seconds');
const restDisplayEl = document.getElementById('rest-display');
const startRestBtn = document.getElementById('start-rest');
const stopRestBtn = document.getElementById('stop-rest');
const workoutMsg = document.getElementById('workout-msg');

let workoutStartTs = null;
let totalTimer = null;
let restTimer = null;

function fmt(totalSec) {
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function ding() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0.4, t0);
      gain.gain.exponentialRampToValueAtTime(0.01, t0 + 0.5);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    });
  } catch {}
}

startWorkoutBtn.addEventListener('click', () => {
  workoutStartTs = Date.now();
  startWorkoutBtn.disabled = true;
  endWorkoutBtn.disabled = false;
  totalTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - workoutStartTs) / 1000);
    totalTimeEl.textContent = fmt(elapsed);
  }, 1000);
  workoutMsg.textContent = '訓練開始！加油 💪';
});

endWorkoutBtn.addEventListener('click', async () => {
  clearInterval(totalTimer);
  const elapsed = Math.floor((Date.now() - workoutStartTs) / 1000);
  const startedAt = new Date(workoutStartTs).toISOString();
  const note = prompt('這次訓練備註（可留空）：') || '';
  try {
    const res = await fetch('/api/workout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_sec: elapsed, started_at: startedAt, note })
    });
    const j = await res.json();
    workoutMsg.textContent = `✅ 已儲存（id=${j.id}，時長 ${fmt(elapsed)}）`;
    loadSessionHistory();
  } catch (e) {
    workoutMsg.textContent = `❌ 儲存失敗：${e.message}`;
  }
  startWorkoutBtn.disabled = false;
  endWorkoutBtn.disabled = true;
  totalTimeEl.textContent = '00:00:00';
  workoutStartTs = null;
});

const sessionHistoryEl = document.getElementById('session-history');
async function loadSessionHistory() {
  const res = await fetch('/api/workout-sessions');
  const rows = await res.json();
  sessionHistoryEl.innerHTML = rows.slice(0, 20).map(r => `
    <div class="log-item" data-id="${r.id}">
      <button class="del-log del-session" data-id="${r.id}">刪除</button>
      <strong>${(r.started_at || r.ended_at).slice(0,16).replace('T',' ')}</strong>
      時長 ${fmt(r.duration_sec)}
      ${r.note ? `<br><em>${escapeHtml(r.note)}</em>` : ''}
    </div>
  `).join('') || '<p>尚無紀錄</p>';
  sessionHistoryEl.querySelectorAll('.del-session').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定刪除這筆訓練時長紀錄？')) return;
      await fetch(`/api/workout-session/${btn.dataset.id}`, { method: 'DELETE' });
      loadSessionHistory();
    });
  });
}
loadSessionHistory();

document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    restSecondsInput.value = btn.dataset.sec;
  });
});

startRestBtn.addEventListener('click', () => {
  if (restTimer) clearInterval(restTimer);
  let remaining = parseInt(restSecondsInput.value, 10);
  if (!remaining || remaining < 1) return;
  restDisplayEl.classList.remove('rest-warn');
  restDisplayEl.textContent = fmt(remaining);
  startRestBtn.disabled = true;
  stopRestBtn.disabled = false;
  restTimer = setInterval(() => {
    remaining--;
    restDisplayEl.textContent = fmt(remaining);
    if (remaining <= 3 && remaining > 0) restDisplayEl.classList.add('rest-warn');
    if (remaining <= 0) {
      clearInterval(restTimer);
      restTimer = null;
      ding();
      restDisplayEl.textContent = '⏰ 開始下一組！';
      restDisplayEl.classList.remove('rest-warn');
      startRestBtn.disabled = false;
      stopRestBtn.disabled = true;
    }
  }, 1000);
});

stopRestBtn.addEventListener('click', () => {
  if (restTimer) clearInterval(restTimer);
  restTimer = null;
  restDisplayEl.textContent = '—';
  restDisplayEl.classList.remove('rest-warn');
  startRestBtn.disabled = false;
  stopRestBtn.disabled = true;
});

// ===== 訓練回報 =====
const logDateEl = document.getElementById('log-date');
const setsContainer = document.getElementById('sets-container');
const addSetBtn = document.getElementById('add-set');
const logForm = document.getElementById('workout-log-form');
const logNoteEl = document.getElementById('log-note');
const logMsg = document.getElementById('log-msg');
const logFeedback = document.getElementById('log-feedback');
const logHistory = document.getElementById('log-history');

logDateEl.value = new Date().toISOString().slice(0, 10);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function addSetRow(exercise = '', sets = 3, reps = 10, weight = '') {
  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `
    <input placeholder="深蹲、臥推…" class="ex" value="${exercise}" required>
    <input type="number" class="s" value="${sets}" min="1" required>
    <input type="number" class="r" value="${reps}" min="1" required>
    <input type="number" step="0.5" class="w" value="${weight}" placeholder="kg" required>
    <button type="button" class="del-set">×</button>
  `;
  row.querySelector('.del-set').addEventListener('click', () => row.remove());
  setsContainer.appendChild(row);
}
addSetRow();
addSetBtn.addEventListener('click', () => addSetRow());

async function loadHistory() {
  const res = await fetch('/api/workout-logs');
  const logs = await res.json();
  logHistory.innerHTML = logs.slice(0, 10).map(l => `
    <div class="log-item" data-id="${l.id}">
      <button class="del-log" data-id="${l.id}">刪除</button>
      <strong>${l.log_date}</strong>
      ${l.sets.map(s => `${s.exercise} ${s.sets}組×${s.reps}次 ${s.weight}kg`).join('、')}
      ${l.note ? `<br><em>${escapeHtml(l.note)}</em>` : ''}
      ${l.feedback ? `<details class="fb-toggle"><summary>💬 小健的回饋</summary><div class="fb-body">${escapeHtml(l.feedback)}</div></details>` : ''}
    </div>
  `).join('') || '<p>尚無紀錄</p>';
  logHistory.querySelectorAll('.del-log').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定刪除這筆紀錄？')) return;
      await fetch(`/api/workout-log/${btn.dataset.id}`, { method: 'DELETE' });
      loadHistory();
    });
  });
}
loadHistory();

async function saveLog() {
  const rows = [...setsContainer.querySelectorAll('.set-row')];
  const sets = rows.map(r => ({
    exercise: r.querySelector('.ex').value.trim(),
    sets: +r.querySelector('.s').value,
    reps: +r.querySelector('.r').value,
    weight: +r.querySelector('.w').value
  })).filter(s => s.exercise);
  if (sets.length === 0) { logMsg.textContent = '請至少填一個動作'; return null; }

  logMsg.textContent = '儲存中…';
  const res = await fetch('/api/workout-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log_date: logDateEl.value, note: logNoteEl.value, sets })
  });
  const j = await res.json();
  logMsg.textContent = `✅ 已儲存（id=${j.id}）`;
  logFeedback.style.display = 'none';
  loadHistory();
  return j.id;
}

logForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = logNoteEl.value;
  const id = await saveLog();
  if (!id) return;
  if (!note.includes('小健')) return;

  logFeedback.style.display = 'block';
  logFeedback.textContent = '小健思考中…';
  const fb = await fetch('/api/workout-log/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log_id: id })
  });
  const fbJson = await fb.json();
  logFeedback.textContent = fbJson.feedback || `錯誤：${fbJson.error}`;
});

// ===== 飲食回報 =====
const mealDateEl = document.getElementById('meal-date');
const mealTypeEl = document.getElementById('meal-type');
const mealContentEl = document.getElementById('meal-content');
const mealNoteEl = document.getElementById('meal-note');
const mealForm = document.getElementById('meal-form');
const mealMsg = document.getElementById('meal-msg');
const mealResult = document.getElementById('meal-result');
const mealHistory = document.getElementById('meal-history');
const dailySummary = document.getElementById('daily-summary');

mealDateEl.value = new Date().toISOString().slice(0, 10);

async function loadDailySummary() {
  const date = mealDateEl.value;
  const res = await fetch(`/api/meals/daily-summary?date=${date}`);
  const s = await res.json();
  const k = n => Math.round(n || 0);
  dailySummary.innerHTML = `
    <div class="cell"><span class="num">${k(s.calories)}</span><span class="lbl">熱量 kcal</span></div>
    <div class="cell"><span class="num">${k(s.protein)}</span><span class="lbl">蛋白質 g</span></div>
    <div class="cell"><span class="num">${k(s.carbs)}</span><span class="lbl">碳水 g</span></div>
    <div class="cell"><span class="num">${k(s.fat)}</span><span class="lbl">脂肪 g</span></div>
  `;
}

async function loadMealHistory() {
  const res = await fetch('/api/meals');
  const rows = await res.json();
  if (!rows.length) { mealHistory.innerHTML = '<p class="empty-hint">尚無紀錄</p>'; return; }

  // 按日期分組
  const groups = {};
  for (const m of rows) {
    (groups[m.log_date] = groups[m.log_date] || []).push(m);
  }
  const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a)).slice(0, 30);

  mealHistory.innerHTML = dates.map(date => {
    const meals = groups[date];
    const totalKcal = meals.reduce((s, m) => s + (m.calories || 0), 0);
    const totalP = meals.reduce((s, m) => s + (m.protein || 0), 0);
    const totalC = meals.reduce((s, m) => s + (m.carbs || 0), 0);
    const totalF = meals.reduce((s, m) => s + (m.fat || 0), 0);
    return `
      <details class="meal-day">
        <summary>
          <span class="md-date">${date}</span>
          <span class="md-stats">${meals.length} 餐 · ${Math.round(totalKcal)} kcal</span>
        </summary>
        <div class="md-body">
          <div class="md-totals">
            <span>🔥 ${Math.round(totalKcal)}</span>
            <span>💪 ${totalP.toFixed(1)}g</span>
            <span>🍚 ${totalC.toFixed(1)}g</span>
            <span>🥑 ${totalF.toFixed(1)}g</span>
          </div>
          ${meals.map(m => `
            <div class="meal-item" data-id="${m.id}">
              <button class="del-meal" data-id="${m.id}">刪除</button>
              <strong>${m.meal_type}</strong>：${escapeHtml(m.content)}
              ${m.note ? `<br><em>${escapeHtml(m.note)}</em>` : ''}
              <div class="nutrition">
                <span>🔥 ${Math.round(m.calories || 0)} kcal</span>
                <span>💪 ${m.protein || 0}g</span>
                <span>🍚 ${m.carbs || 0}g</span>
                <span>🥑 ${m.fat || 0}g</span>
              </div>
              ${m.feedback ? `<details class="fb-toggle"><summary>💬 小健的回饋</summary><div class="fb-body">${escapeHtml(m.feedback)}</div></details>` : ''}
            </div>
          `).join('')}
        </div>
      </details>
    `;
  }).join('');

  mealHistory.querySelectorAll('.del-meal').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm('確定刪除這筆飲食紀錄？')) return;
      await fetch(`/api/meal/${btn.dataset.id}`, { method: 'DELETE' });
      loadMealHistory();
      loadDailySummary();
    });
  });
}

mealDateEl.addEventListener('change', loadDailySummary);
loadDailySummary();
loadMealHistory();

// 飲食拍照辨識
const mealPhoto = document.getElementById('meal-photo');
const mealPhotoMsg = document.getElementById('meal-photo-msg');
if (mealPhoto) {
  mealPhoto.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    mealPhotoMsg.textContent = '🔍 小健正在認你吃了什麼…';
    mealPhotoMsg.style.color = '';
    try {
      const buf = await f.arrayBuffer();
      let bin = ''; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      const res = await fetch('/api/meal/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: b64, mime_type: f.type || 'image/jpeg' })
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      const contentEl = document.getElementById('meal-content');
      contentEl.value = j.content || '';
      mealPhotoMsg.textContent = '✅ 已填入，可以再修改';
      mealPhotoMsg.style.color = 'green';
    } catch (err) {
      mealPhotoMsg.textContent = '❌ 辨識失敗：' + err.message;
      mealPhotoMsg.style.color = 'red';
    } finally {
      mealPhoto.value = '';
    }
  });
}

// 週報 / 月報
async function loadReport(range) {
  const box = document.getElementById('report-result');
  box.style.display = 'block';
  box.innerHTML = `<p>📊 小健正在整理${range === 'month' ? '本月' : '本週'}資料…(可能要 5~10 秒)</p>`;
  try {
    const res = await fetch('/api/report/' + range);
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    const s = j.stats || {};
    box.innerHTML = `
      <div class="report-stats">
        <span>🏋️ 訓練 <b>${s.train_days}</b> 天</span>
        <span>🍚 ${s.meal_count} 餐</span>
        <span>📊 日均 ${s.avg_cal} kcal / ${s.avg_protein}g 蛋白</span>
      </div>
      <div class="report-summary">${(j.summary || '').replace(/\n/g, '<br>')}</div>
    `;
  } catch (err) {
    box.innerHTML = `<p style="color:red;">❌ ${err.message}</p>`;
  }
}
const reportWeek = document.getElementById('report-week');
const reportMonth = document.getElementById('report-month');
if (reportWeek) reportWeek.addEventListener('click', () => loadReport('week'));
if (reportMonth) reportMonth.addEventListener('click', () => loadReport('month'));

mealForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  mealMsg.textContent = '分析中…（約 3–5 秒）';
  mealResult.style.display = 'none';
  const body = {
    log_date: mealDateEl.value,
    meal_type: mealTypeEl.value,
    content: mealContentEl.value,
    note: mealNoteEl.value
  };
  const res = await fetch('/api/meal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (j.error) { mealMsg.textContent = `❌ ${j.error}`; return; }
  mealMsg.textContent = '';
  mealResult.style.display = 'block';
  mealResult.innerHTML = `
    <div class="bubble assistant">
      ✅ 營養分析完成：
      🔥 ${Math.round(j.calories)} kcal ｜ 💪 蛋白 ${j.protein}g ｜ 🍚 碳水 ${j.carbs}g ｜ 🥑 脂肪 ${j.fat}g
      ${j.feedback ? `\n\n💬 小健：${j.feedback}` : ''}
    </div>
  `;
  mealContentEl.value = '';
  mealNoteEl.value = '';
  loadDailySummary();
  loadMealHistory();
});

// ===== 行事曆 =====
const dayPanel = document.getElementById('day-panel');
const dayPanelTitle = document.getElementById('day-panel-title');
const dayEventsEl = document.getElementById('day-events');
const dayWorkoutsEl = document.getElementById('day-workouts');
const dayMealsEl = document.getElementById('day-meals');
const eventForm = document.getElementById('add-event-form');
const eventTypeEl = document.getElementById('event-type');
const eventTitleEl = document.getElementById('event-title');
const eventNoteEl = document.getElementById('event-note');

let calendar;
let selectedDate = null;

async function loadCalendarEvents() {
  const [evRes, wlRes] = await Promise.all([
    fetch('/api/calendar-events').then(r => r.json()),
    fetch('/api/workout-logs').then(r => r.json())
  ]);
  const evs = evRes.map(e => ({
    id: 'ev-' + e.id,
    title: (e.type === '休息日' ? '🛌 ' : e.type === '其他' ? '📌 ' : '📅 ') + e.title,
    start: e.event_date,
    color: e.type === '休息日' ? '#8e8e93' : e.type === '其他' ? '#ff9500' : '#0a84ff',
    display: 'block'
  }));
  const workoutDates = [...new Set(wlRes.map(l => l.log_date))];
  const done = workoutDates.map(d => ({
    id: 'wl-' + d,
    title: '✅ 完成訓練',
    start: d,
    color: '#34c759',
    display: 'block'
  }));
  return [...evs, ...done];
}

function highlightSelectedDay(dateStr) {
  document.querySelectorAll('.fc-daygrid-day.fc-day-selected').forEach(el => el.classList.remove('fc-day-selected'));
  const cell = document.querySelector(`.fc-daygrid-day[data-date="${dateStr}"]`);
  if (cell) cell.classList.add('fc-day-selected');
}

async function renderDayPanel(date) {
  selectedDate = date;
  dayPanel.style.display = 'block';
  dayPanelTitle.textContent = `📍 ${date}`;
  const res = await fetch(`/api/day/${date}`);
  const d = await res.json();

  dayEventsEl.innerHTML = d.events.length === 0
    ? '<div class="empty-hint">這天還沒有排事件</div>'
    : d.events.map(e => `
      <div class="event-item ${e.type === '休息日' ? 'rest' : e.type === '其他' ? 'other' : ''}">
        <span><b>${e.type}</b>｜${escapeHtml(e.title)}${e.note ? `<br><small>${escapeHtml(e.note)}</small>` : ''}</span>
        <button class="del-ev" data-id="${e.id}">×</button>
      </div>
    `).join('');
  dayEventsEl.querySelectorAll('.del-ev').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/calendar-event/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshCalendar();
      renderDayPanel(date);
    });
  });

  dayWorkoutsEl.innerHTML = d.workout_logs.length === 0
    ? '<div class="empty-hint">沒有訓練紀錄</div>'
    : d.workout_logs.map(l => `
      <div class="log-item">
        ${l.sets.map(s => `${s.exercise} ${s.sets}組×${s.reps}次 ${s.weight}kg`).join('、')}
        ${l.note ? `<br><em>${escapeHtml(l.note)}</em>` : ''}
        ${l.feedback ? `<details class="fb-toggle"><summary>💬 小健的回饋</summary><div class="fb-body">${escapeHtml(l.feedback)}</div></details>` : ''}
      </div>
    `).join('');

  dayMealsEl.innerHTML = d.meals.length === 0
    ? '<div class="empty-hint">沒有飲食紀錄</div>'
    : d.meals.map(m => `
      <div class="log-item">
        <strong>${m.meal_type}</strong>：${escapeHtml(m.content)}
        <div class="nutrition" style="display:flex;gap:10px;color:#666;font-size:12px;margin-top:4px;flex-wrap:wrap;">
          <span>🔥${Math.round(m.calories||0)}</span>
          <span>💪${m.protein||0}g</span>
          <span>🍚${m.carbs||0}g</span>
          <span>🥑${m.fat||0}g</span>
        </div>
      </div>
    `).join('');
}

async function refreshCalendar() {
  const events = await loadCalendarEvents();
  calendar.removeAllEvents();
  calendar.addEventSource(events);
}

document.addEventListener('DOMContentLoaded', async () => {
  const el = document.getElementById('calendar');
  calendar = new FullCalendar.Calendar(el, {
    initialView: 'dayGridMonth',
    locale: 'zh-tw',
    height: 450,
    headerToolbar: { left: 'prev,next today', center: 'title', right: '' },
    buttonText: { today: '今天' },
    dayCellContent: (arg) => ({ html: String(arg.date.getDate()) }),
    dateClick: (info) => { highlightSelectedDay(info.dateStr); renderDayPanel(info.dateStr); },
    eventClick: (info) => { const d = info.event.startStr.slice(0, 10); highlightSelectedDay(d); renderDayPanel(d); }
  });
  calendar.render();
  refreshCalendar();
});

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedDate) return;
  await fetch('/api/calendar-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_date: selectedDate,
      title: eventTitleEl.value,
      type: eventTypeEl.value,
      note: eventNoteEl.value
    })
  });
  eventTitleEl.value = '';
  eventNoteEl.value = '';
  await refreshCalendar();
  renderDayPanel(selectedDate);
});

// ===== AI 對話 =====
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = msgInput.value.trim();
  if (!message) return;
  addBubble('user', message);
  msgInput.value = '';
  addBubble('assistant', '思考中…');
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  const j = await res.json();
  chat.lastChild.remove();
  addBubble('assistant', j.reply);
});


// ===== PWA Service Worker =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW 註冊失敗', err));
  });
}

// ===== 自動偵測新版本 =====
async function checkAppVersion() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    const j = await res.json();
    if (!j.version) return;
    const stored = localStorage.getItem('app_version');
    if (!stored) {
      localStorage.setItem('app_version', j.version);
      return;
    }
    if (stored !== j.version && !document.getElementById('update-banner')) {
      showUpdateBanner(j.version);
    }
  } catch {}
}

function showUpdateBanner(newVer) {
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `
    <span>✨ 小健有更新囉！</span>
    <button type="button" id="apply-update">立即套用</button>
    <button type="button" id="dismiss-update" aria-label="關閉">✕</button>
  `;
  document.body.appendChild(banner);
  document.getElementById('apply-update').addEventListener('click', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update()));
      }
    } catch {}
    localStorage.setItem('app_version', newVer);
    location.reload();
  });
  document.getElementById('dismiss-update').addEventListener('click', () => {
    banner.remove();
  });
}

// 進場檢查 + 每 5 分鐘 + 從多工切回來時檢查
window.addEventListener('load', checkAppVersion);
setInterval(checkAppVersion, 5 * 60 * 1000);
window.addEventListener('focus', checkAppVersion);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAppVersion(); });
