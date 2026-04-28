const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || 'file:fitness.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({ url, authToken });

async function run(sql, args = []) {
  const r = await client.execute({ sql, args });
  return { lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null, changes: r.rowsAffected };
}

async function all(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows.map((row) => ({ ...row }));
}

async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0] || null;
}

async function init() {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS inbody (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weight REAL NOT NULL,
      body_fat REAL NOT NULL,
      muscle REAL NOT NULL,
      bmr REAL NOT NULL,
      goal TEXT NOT NULL,
      feedback TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS workout_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duration_sec INTEGER NOT NULL,
      note TEXT,
      started_at DATETIME,
      ended_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS workout_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT NOT NULL,
      note TEXT,
      feedback TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS workout_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      exercise TEXT NOT NULL,
      sets INTEGER NOT NULL,
      reps INTEGER NOT NULL,
      weight REAL NOT NULL,
      FOREIGN KEY (log_id) REFERENCES workout_logs(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_date TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT DEFAULT '訓練計畫',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS meal_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT NOT NULL,
      meal_type TEXT NOT NULL,
      content TEXT NOT NULL,
      note TEXT,
      calories REAL,
      protein REAL,
      carbs REAL,
      fat REAL,
      feedback TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ]);

  // 漸進升級：舊 schema 沒 feedback 欄位的補上
  await ensureColumn('workout_logs', 'feedback', 'TEXT');
  await ensureColumn('inbody', 'feedback', 'TEXT');

  // 多人版：每張資料表加 user 欄位（舊資料預設 'default'）
  for (const t of ['inbody', 'chat_log', 'workout_sessions', 'workout_logs', 'calendar_events', 'meal_logs']) {
    await ensureColumn(t, 'user', "TEXT NOT NULL DEFAULT 'default'");
  }
}

async function ensureColumn(table, column, type) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

module.exports = { client, run, all, get, init };
