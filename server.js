require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

// 版本號：用 Render 自動注入的 commit hash，每次部署會變，前端偵測到就提示更新
const APP_VERSION = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || ('dev-' + Date.now());
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

// 多人版：X-User 是裝置 ID（隔離資料用），X-User-Name 是顯示名稱（給 AI 叫名字用）
app.use('/api', (req, res, next) => {
  const u = (req.header('X-User') || '').trim();
  if (!u) return res.status(400).json({ error: '缺裝置識別碼（請重新整理）' });
  if (u.length > 100) return res.status(400).json({ error: '識別碼太長' });
  req.user = u;
  req.userName = (req.header('X-User-Name') || '').trim().slice(0, 30) || '朋友';
  next();
});

app.post('/api/inbody', async (req, res) => {
  try {
    const { weight, body_fat, muscle, bmr, goal } = req.body;
    const info = await db.run(
      'INSERT INTO inbody (user, weight, body_fat, muscle, bmr, goal) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user, weight, body_fat, muscle, bmr, goal]
    );
    res.json({ id: info.lastInsertRowid });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/workout-session', async (req, res) => {
  try {
    const { duration_sec, started_at, note } = req.body;
    const info = await db.run(
      'INSERT INTO workout_sessions (user, duration_sec, started_at, note) VALUES (?, ?, ?, ?)',
      [req.user, duration_sec, started_at || null, note || null]
    );
    res.json({ id: info.lastInsertRowid });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/workout-session/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM workout_sessions WHERE id = ? AND user = ?', [req.params.id, req.user]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/workout-sessions', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM workout_sessions WHERE user = ? ORDER BY id DESC LIMIT 50', [req.user]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/workout-log', async (req, res) => {
  try {
    const { log_date, note, sets } = req.body;
    const info = await db.run('INSERT INTO workout_logs (user, log_date, note) VALUES (?, ?, ?)', [req.user, log_date, note || null]);
    const logId = info.lastInsertRowid;
    for (const s of (sets || [])) {
      await db.run(
        'INSERT INTO workout_sets (log_id, exercise, sets, reps, weight) VALUES (?, ?, ?, ?, ?)',
        [logId, s.exercise, s.sets, s.reps, s.weight]
      );
    }
    res.json({ id: logId });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/workout-log/:id', async (req, res) => {
  try {
    // 透過 log 的 user 確認權限
    const log = await db.get('SELECT user FROM workout_logs WHERE id = ?', [req.params.id]);
    if (!log || log.user !== req.user) return res.status(404).json({ error: 'not found' });
    await db.run('DELETE FROM workout_sets WHERE log_id = ?', [req.params.id]);
    await db.run('DELETE FROM workout_logs WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/workout-logs', async (req, res) => {
  try {
    const logs = await db.all('SELECT * FROM workout_logs WHERE user = ? ORDER BY log_date DESC, id DESC LIMIT 30', [req.user]);
    const result = [];
    for (const l of logs) {
      const sets = await db.all('SELECT * FROM workout_sets WHERE log_id = ?', [l.id]);
      result.push({ ...l, sets });
    }
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/workout-log/feedback', async (req, res) => {
  try {
    const { log_id } = req.body;
    const log = await db.get('SELECT * FROM workout_logs WHERE id = ? AND user = ?', [log_id, req.user]);
    if (!log) return res.status(404).json({ error: 'not found' });
    const sets = await db.all('SELECT * FROM workout_sets WHERE log_id = ?', [log_id]);
    const latest = await db.get('SELECT * FROM inbody WHERE user = ? ORDER BY id DESC LIMIT 1', [req.user]);
    const recent = await db.all(`
      SELECT wl.log_date, ws.exercise, ws.sets, ws.reps, ws.weight
      FROM workout_logs wl JOIN workout_sets ws ON ws.log_id = wl.id
      WHERE wl.user = ? AND wl.log_date >= date('now', '-7 day')
      ORDER BY wl.log_date
    `, [req.user]);

    const prompt = `你是「小健」，嘴賤健身損友。對話對象叫「${req.userName}」，可以偶爾叫他名字。

**回答優先順序（超重要）**：
1. **先回應備註裡使用者真正在講的事或問的問題**（他可能在問建議、抱怨身體、炫耀進步、或單純閒聊）
2. 再嘴他、再給實際建議。重點在「有沒有接到他的話」，不是背台詞

**酸的風格池（每次挑 1–2 種就好，不要每次都一樣，避免模板感）**：
- 無奈長輩：「唉你這樣練我替你累」
- 短促打臉：「廢」「笑死」「認真的？」
- 反諷：「你這麼強還問我？」
- 假溫柔：「寶貝沒事，你只是不適合練肌肉而已」
- 專業嗆：「這動作啟動肌群全錯細狗」
- 迷因風：「這重量我阿嬤搬菜都比你多」
- 誇張比喻：「你二頭長得像白煮蛋」
- 裝可憐：「我教你這麼多搞成這樣，我失敗了」
- 機車長輩：「我年輕這重量是熱身」
- 冷淡哦：「哦。」「喔好。」

**硬性禁令**：
- 不要每次都用「細狗」「廢物」當梗，這些詞同一次回饋最多 1 次
- 不要每次開頭「哇」「唉呦」
- 不要條列式 1. 2. 3.
- 不要官腔、不要「您」、不要亂灑 emoji
- 不要憑空編造使用者沒說的狀況（沒提睡眠就別腦補睡眠）

**長度**：隨性，有具體問題講詳細，單純打招呼就一兩句嗆完。嘴歸嘴，**建議一定要具體**（加幾 kg、換哪個動作、組間休多久）。

使用者目標：${latest?.goal || '未設定'}（體脂 ${latest?.body_fat || '?'}%、骨骼肌 ${latest?.muscle || '?'}kg）

今日訓練（${log.log_date}）：
${sets.map(s => `- ${s.exercise}：${s.sets} 組 × ${s.reps} 次 @ ${s.weight}kg`).join('\n')}
備註（使用者主要想聊的內容）：${log.note || '無'}

近 7 天訓練紀錄（供對照）：
${recent.map(r => `- ${r.log_date} ${r.exercise} ${r.sets}×${r.reps}@${r.weight}kg`).join('\n') || '無'}`;

    let result;
    for (let i = 0; i < 3; i++) {
      try {
        result = await model.generateContent(prompt);
        break;
      } catch (e) {
        if (i === 2 || !String(e.message).match(/503|UNAVAILABLE/)) throw e;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const feedback = result.response.text();
    await db.run('UPDATE workout_logs SET feedback = ? WHERE id = ?', [feedback, log_id]);
    res.json({ feedback });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inbody/feedback', async (req, res) => {
  try {
    const { id } = req.body;
    const current = await db.get('SELECT * FROM inbody WHERE id = ? AND user = ?', [id, req.user]);
    if (!current) return res.status(404).json({ error: 'not found' });
    const history = await db.all('SELECT * FROM inbody WHERE user = ? AND id < ? ORDER BY id DESC LIMIT 5', [req.user, id]);

    const histText = history.length === 0
      ? '（這是第一筆，還沒有過去資料可比）'
      : history.reverse().map(h => `- ${h.created_at}：體重${h.weight}kg、體脂${h.body_fat}%、骨骼肌${h.muscle}kg、BMR${h.bmr}、目標${h.goal}`).join('\n');

    const prompt = `你是「小健」，嘴賤內行的健身教練損友。對話對象叫「${req.userName}」，可以偶爾叫他名字。使用者剛上傳新一筆 INBODY，請根據「這次 vs 過去」的變化給回饋。

**風格（每次挑不同的，避免模板）**：無奈長輩 / 短促打臉 / 反諷 / 假溫柔 / 專業嗆 / 迷因比喻 / 冷淡哦 / 裝可憐。同一次最多用一次「細狗」「廢物」，不要每次開頭「哇」「唉呦」，不要條列式。

**回饋內容（必講）**：
1. 這次和上次相比，哪個指標進步、哪個退步(具體數字差)。沒有過去資料就嗆他第一次量，定個基準
2. 有沒有在朝他目標（${current.goal}）的方向走
3. **下一階段該重點加強什麼**（例如：體脂下降太慢→提高有氧 / 肌肉沒增加→加重訓強度 / 體重掉太快→注意是不是掉肌肉）
4. 具體 1–2 件可做的事

歷史（由舊到新）：
${histText}

這次（${current.created_at}）：
體重 ${current.weight}kg、體脂 ${current.body_fat}%、骨骼肌 ${current.muscle}kg、BMR ${current.bmr}kcal、目標 ${current.goal}

一段文字 4–7 句繁體中文，嘴歸嘴，建議要實際。`;

    let result;
    for (let i = 0; i < 3; i++) {
      try { result = await model.generateContent(prompt); break; }
      catch (e) {
        if (i === 2 || !String(e.message).match(/503|UNAVAILABLE/)) throw e;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const feedback = result.response.text();
    await db.run('UPDATE inbody SET feedback = ? WHERE id = ?', [feedback, id]);
    res.json({ feedback });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/meal/recognize', async (req, res) => {
  try {
    const { image_base64, mime_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: '缺圖片' });

    const visionModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const prompt = `這是一張食物照片。請辨識照片裡的所有食物，估計分量，回 JSON：
{"content": "食物 1 估計分量、食物 2 估計分量、..."}

範例輸出："白飯 1 碗、滷雞腿 1 隻、滷蛋 1 顆、青江菜 半碗"

要求：
- 用繁體中文
- 估計分量用常見單位（碗/份/隻/顆/片/g）
- 不確定就講大概，例如「雞胸肉 約 150g」
- 不要有任何 markdown 或 json 以外的字
- 看不清楚或不是食物時 content 填「無法辨識，請手動輸入」`;

    let result;
    for (let i = 0; i < 3; i++) {
      try {
        result = await visionModel.generateContent([
          { inlineData: { mimeType: mime_type || 'image/jpeg', data: image_base64 } },
          { text: prompt }
        ]);
        break;
      } catch (e) {
        if (i === 2 || !String(e.message).match(/503|UNAVAILABLE/)) throw e;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const parsed = JSON.parse(result.response.text());
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/report/:range', async (req, res) => {
  try {
    const range = req.params.range; // 'week' or 'month'
    const days = range === 'month' ? 30 : 7;
    const label = range === 'month' ? '本月' : '本週';

    const inbody = await db.all(
      `SELECT * FROM inbody WHERE user = ? AND created_at >= date('now', ?) ORDER BY created_at`,
      [req.user, `-${days} day`]
    );
    const workouts = await db.all(`
      SELECT wl.log_date, wl.note, ws.exercise, ws.sets, ws.reps, ws.weight
      FROM workout_logs wl JOIN workout_sets ws ON ws.log_id = wl.id
      WHERE wl.user = ? AND wl.log_date >= date('now', ?)
      ORDER BY wl.log_date
    `, [req.user, `-${days} day`]);
    const meals = await db.all(
      `SELECT log_date, meal_type, content, calories, protein, carbs, fat FROM meal_logs
       WHERE user = ? AND log_date >= date('now', ?) ORDER BY log_date`,
      [req.user, `-${days} day`]
    );

    const inbodyText = inbody.length === 0 ? '（無 INBODY 紀錄）' :
      inbody.map(i => `- ${i.created_at?.slice(0, 10)}：${i.weight}kg / 體脂${i.body_fat}% / 肌肉${i.muscle}kg / 目標${i.goal}`).join('\n');

    const workoutText = workouts.length === 0 ? '（無訓練紀錄）' :
      workouts.map(w => `- ${w.log_date} ${w.exercise} ${w.sets}×${w.reps}@${w.weight}kg`).join('\n');

    const trainDays = new Set(workouts.map(w => w.log_date)).size;

    const mealText = meals.length === 0 ? '（無飲食紀錄）' :
      meals.map(m => `- ${m.log_date} ${m.meal_type}：${m.content}（${m.calories}kcal、蛋白${m.protein}g）`).join('\n');

    const totalCal = meals.reduce((s, m) => s + (m.calories || 0), 0);
    const totalProtein = meals.reduce((s, m) => s + (m.protein || 0), 0);
    const avgCal = meals.length > 0 ? Math.round(totalCal / new Set(meals.map(m => m.log_date)).size) : 0;
    const avgProtein = meals.length > 0 ? (totalProtein / new Set(meals.map(m => m.log_date)).size).toFixed(1) : 0;

    const prompt = `你是「小健」，嘴賤健身教練損友。對話對象叫「${req.userName}」。請寫一份「${label}總結」，給他看。

**風格**：和平常一樣嘴賤但實用，每次挑不同酸法（無奈長輩 / 短促打臉 / 反諷 / 假溫柔 / 專業嗆 / 迷因 / 冷淡哦 / 裝可憐）。同一份報告最多用一次「細狗」「廢物」，不要每次開頭「哇」「唉呦」，不要官腔。

**結構（4 個段落，每段一兩句即可）**：
① **狀態總評**：${label}整體在搞什麼，先嘴一句再講重點
② **訓練面**：${days} 天裡訓練了 ${trainDays} 天，動作量、強度有沒有進步、缺什麼、哪天偷懶
③ **飲食面**：${meals.length} 餐紀錄，平均日卡 ${avgCal}kcal、日蛋白 ${avgProtein}g，符不符合目標、哪餐不行
④ **下${range === 'month' ? '個月' : '週'}建議**：具體 2~3 件可做的事（加重幾 kg、補多少蛋白、減哪餐）

可以用 emoji 但不要灑，每段最多 1 個。

---資料如下---

📊 INBODY 變化（${label}）：
${inbodyText}

🏋️ 訓練紀錄（${label}，共 ${trainDays} 天有訓練）：
${workoutText}

🍚 飲食紀錄（${label}，共 ${meals.length} 餐）：
${mealText}

平均每日攝取：${avgCal}kcal / 蛋白質 ${avgProtein}g`;

    let result;
    for (let i = 0; i < 3; i++) {
      try { result = await model.generateContent(prompt); break; }
      catch (e) {
        if (i === 2 || !String(e.message).match(/503|UNAVAILABLE/)) throw e;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const summary = result.response.text();
    res.json({
      range,
      summary,
      stats: { train_days: trainDays, meal_count: meals.length, avg_cal: avgCal, avg_protein: Number(avgProtein), inbody_count: inbody.length }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inbody/recognize', async (req, res) => {
  try {
    const { image_base64, mime_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: '缺圖片' });

    const visionModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const prompt = `這是一張 INBODY 身體組成分析報告。請抓出下列 4 個欄位純數字（不要單位）：
- weight: 體重 kg
- body_fat: 體脂率 %
- muscle: 骨骼肌量 kg
- bmr: 基礎代謝率 kcal

回 JSON：{"weight": number, "body_fat": number, "muscle": number, "bmr": number}
讀不到的欄位填 null。只回 JSON。`;

    let result;
    for (let i = 0; i < 3; i++) {
      try {
        result = await visionModel.generateContent([
          { inlineData: { mimeType: mime_type || 'image/jpeg', data: image_base64 } },
          { text: prompt }
        ]);
        break;
      } catch (e) {
        if (i === 2 || !String(e.message).match(/503|UNAVAILABLE/)) throw e;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const parsed = JSON.parse(result.response.text());
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/inbody/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM inbody WHERE id = ? AND user = ?', [req.params.id, req.user]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/inbody/history', async (req, res) => {
  try {
    const rows = await db.all('SELECT id, weight, body_fat, muscle, bmr, goal, created_at FROM inbody WHERE user = ? ORDER BY created_at ASC', [req.user]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/inbody/latest', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM inbody WHERE user = ? ORDER BY id DESC LIMIT 1', [req.user]);
    res.json(row || null);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const latest = await db.get('SELECT * FROM inbody WHERE user = ? ORDER BY id DESC LIMIT 1', [req.user]);

    const systemPrompt = `你是「小健」，一位嘴賤但內行的健身教練兼營養師兼損友。對話對象叫「${req.userName}」，可以偶爾叫他名字增加親切感。講話繁體中文、口語、欠揍但好笑，像在虧哥們；進步酸中帶捧（「細狗還能加重不錯嘛」），退步直接嘲諷（「練假的？」「廢物」），但**一定要給實際可行的建議**——嘴歸嘴，正事辦到位。不用「您」、不用官腔、不要條列式、不要亂灑 emoji。

${latest ? `使用者資料：體重 ${latest.weight}kg、體脂 ${latest.body_fat}%、骨骼肌 ${latest.muscle}kg、基礎代謝 ${latest.bmr}kcal、目標：${latest.goal}` : '使用者還沒輸入 INBODY 資料，先兇他一下叫他趕快填。'}`;

    await db.run('INSERT INTO chat_log (user, role, content) VALUES (?, ?, ?)', [req.user, 'user', message]);

    const historyDesc = await db.all('SELECT role, content FROM chat_log WHERE user = ? ORDER BY id DESC LIMIT 20', [req.user]);
    const history = historyDesc.reverse();

    const contents = history.slice(0, -1).map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));

    const chat = model.startChat({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      history: contents
    });

    let result;
    for (let i = 0; i < 3; i++) {
      try {
        result = await chat.sendMessage(message);
        break;
      } catch (e) {
        if (i === 2 || !String(e.message).match(/503|UNAVAILABLE/)) throw e;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const reply = result.response.text();

    await db.run('INSERT INTO chat_log (user, role, content) VALUES (?, ?, ?)', [req.user, 'assistant', reply]);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: `錯誤：${err.message}` });
  }
});

app.post('/api/meal', async (req, res) => {
  try {
    const { log_date, meal_type, content, note } = req.body;
    if (!content || !meal_type || !log_date) return res.status(400).json({ error: '缺欄位' });

    const latest = await db.get('SELECT * FROM inbody WHERE user = ? ORDER BY id DESC LIMIT 1', [req.user]);
    const wantFeedback = (note || '').includes('小健');

    const prompt = `你是營養師兼健身教練「小健」。對話對象叫「${req.userName}」。分析使用者這餐吃的營養，並視情況給評論。

使用者資料：${latest ? `體重${latest.weight}kg、體脂${latest.body_fat}%、骨骼肌${latest.muscle}kg、BMR${latest.bmr}kcal、目標：${latest.goal}` : '尚未填 INBODY'}

餐次：${meal_type}
吃了什麼（含分量）：${content}
備註：${note || '無'}

回傳 JSON（不要任何 markdown 或其他文字）：
{
  "calories": 總熱量數字(kcal，整數),
  "protein": 蛋白質(g，數字可帶一位小數),
  "carbs": 碳水(g),
  "fat": 脂肪(g),
  "feedback": "${wantFeedback ? `使用者在備註呼喚你（小健），必須：
① 先回應備註裡真正在問的事或抱怨/炫耀的點（接住他的話）
② 再嘴他（**每次挑不同風格，避免模板感**）。可選：無奈長輩 / 短促打臉（「廢」「笑死」）/ 反諷 / 假溫柔 / 專業嗆 / 迷因比喻（「我阿嬤吃飯都比你有營養」）/ 冷淡哦 / 裝可憐
③ 給具體飲食建議（要補什麼、分量多少、該調整哪餐）
禁令：同一次最多用一次「細狗」「廢物」；不要條列式；不要官腔；不要每次開頭「哇」「唉呦」` : ''}"
}${wantFeedback ? '' : '\n注意：備註沒呼喚小健，feedback 欄位請留空字串。'}`;

    const jsonModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json' }
    });

    let result;
    for (let i = 0; i < 3; i++) {
      try { result = await jsonModel.generateContent(prompt); break; }
      catch (e) {
        if (i === 2 || !String(e.message).match(/503|UNAVAILABLE/)) throw e;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const parsed = JSON.parse(result.response.text());
    const info = await db.run(
      'INSERT INTO meal_logs (user, log_date, meal_type, content, note, calories, protein, carbs, fat, feedback) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user, log_date, meal_type, content, note || null, parsed.calories, parsed.protein, parsed.carbs, parsed.fat, parsed.feedback || null]
    );
    res.json({ id: info.lastInsertRowid, ...parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meals', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM meal_logs WHERE user = ? ORDER BY log_date DESC, id DESC LIMIT 50', [req.user]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/meal/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM meal_logs WHERE id = ? AND user = ?', [req.params.id, req.user]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/meals/daily-summary', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const row = await db.get(`
      SELECT SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat, COUNT(*) AS meals
      FROM meal_logs WHERE user = ? AND log_date = ?
    `, [req.user, date]);
    res.json({ date, ...row });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/calendar-event', async (req, res) => {
  try {
    const { event_date, title, type, note } = req.body;
    if (!event_date || !title) return res.status(400).json({ error: '缺日期或標題' });
    const info = await db.run(
      'INSERT INTO calendar_events (user, event_date, title, type, note) VALUES (?, ?, ?, ?, ?)',
      [req.user, event_date, title, type || '訓練計畫', note || null]
    );
    res.json({ id: info.lastInsertRowid });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/calendar-events', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM calendar_events WHERE user = ? ORDER BY event_date', [req.user]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/calendar-event/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM calendar_events WHERE id = ? AND user = ?', [req.params.id, req.user]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/day/:date', async (req, res) => {
  try {
    const date = req.params.date;
    const events = await db.all('SELECT * FROM calendar_events WHERE user = ? AND event_date = ? ORDER BY id', [req.user, date]);
    const logs = await db.all('SELECT * FROM workout_logs WHERE user = ? AND log_date = ?', [req.user, date]);
    const logsFull = [];
    for (const l of logs) {
      const sets = await db.all('SELECT * FROM workout_sets WHERE log_id = ?', [l.id]);
      logsFull.push({ ...l, sets });
    }
    const meals = await db.all('SELECT * FROM meal_logs WHERE user = ? AND log_date = ? ORDER BY id', [req.user, date]);
    res.json({ date, events, workout_logs: logsFull, meals });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
db.init().then(() => {
  app.listen(PORT, () => console.log(`🏋️  健身助手 http://localhost:${PORT}`));
}).catch((err) => {
  console.error('DB init failed:', err);
  process.exit(1);
});
