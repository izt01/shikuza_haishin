const path = require('path');

// 静的ファイル配信（index.html, admin.html, CSS, JS など）
app.use(express.static(path.join(__dirname)));

// ルートで index.html を返す
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 管理画面用のルート（必要なら）
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app  = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

async function initDB() {
  // メイン設定テーブル
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stream_config (
      id           INTEGER PRIMARY KEY DEFAULT 1,
      title        TEXT,
      yt_url       TEXT,
      start_time   TIMESTAMPTZ,
      end_time     TIMESTAMPTZ,
      next_start   TIMESTAMPTZ,
      next_end     TIMESTAMPTZ,
      pass_enabled BOOLEAN DEFAULT FALSE,
      view_pass    TEXT,
      name_enabled BOOLEAN DEFAULT FALSE,
      notice       TEXT,
      admin_pass   TEXT DEFAULT 'admin1234',
      is_public    BOOLEAN DEFAULT FALSE,
      current_session_id INTEGER,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE stream_config ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE stream_config ADD COLUMN IF NOT EXISTS current_session_id INTEGER`);

  // 公開セッション（期間）テーブル
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stream_sessions (
      id         SERIAL PRIMARY KEY,
      title      TEXT,
      start_time TIMESTAMPTZ,
      end_time   TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ログインログテーブル（セッションIDと紐付け）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_log (
      id           SERIAL PRIMARY KEY,
      session_id   INTEGER REFERENCES stream_sessions(id),
      name         TEXT,
      logged_in_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE login_log ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES stream_sessions(id)`);

  const { rowCount } = await pool.query('SELECT 1 FROM stream_config WHERE id = 1');
  if (rowCount === 0) {
    await pool.query(`INSERT INTO stream_config (id) VALUES (1)`);
  }
  console.log('DB initialized');
}

// ---- 視聴者向け：公開情報取得 ----
app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT title, yt_url, start_time, end_time, next_start, next_end,
              pass_enabled, name_enabled, notice, is_public, updated_at
       FROM stream_config WHERE id = 1`
    );
    const row = rows[0];
    if (!row) return res.json({});

    const now   = new Date();
    const start = row.start_time ? new Date(row.start_time) : null;
    const end   = row.end_time   ? new Date(row.end_time)   : null;
    const isLive = row.is_public || (start && end && now >= start && now <= end);

    res.json({ ...row, is_live: isLive });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- 視聴者向け：パスワード認証 + ログイン記録 ----
app.post('/api/auth', async (req, res) => {
  const { password, name } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT pass_enabled, view_pass, name_enabled, start_time, end_time, is_public, current_session_id FROM stream_config WHERE id = 1'
    );
    const row = rows[0];
    if (!row) return res.json({ ok: true });

    if (row.pass_enabled && row.view_pass) {
      if (password !== row.view_pass) {
        return res.status(401).json({ ok: false, error: 'パスワードが正しくありません' });
      }
    }

    const now = new Date();
    const inPeriod = row.is_public ||
      (row.start_time && row.end_time &&
       now >= new Date(row.start_time) && now <= new Date(row.end_time));

    if (inPeriod && row.current_session_id) {
      await pool.query(
        'INSERT INTO login_log (session_id, name) VALUES ($1, $2)',
        [row.current_session_id, name && name.trim() ? name.trim() : null]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- 管理者向け：設定全取得 ----
app.post('/api/admin/get', async (req, res) => {
  const { adminPass } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM stream_config WHERE id = 1');
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'no config' });
    if (adminPass !== row.admin_pass) {
      return res.status(401).json({ error: '管理者パスワードが正しくありません' });
    }
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- 管理者向け：設定保存（保存時に新セッション作成 → ログインリセット）----
app.post('/api/admin/save', async (req, res) => {
  const {
    adminPass, title, ytUrl,
    startTime, endTime, nextStart, nextEnd,
    passEnabled, viewPass, nameEnabled, notice,
    newAdminPass, isPublic,
  } = req.body;

  try {
    const { rows } = await pool.query('SELECT admin_pass, start_time, end_time, current_session_id FROM stream_config WHERE id = 1');
    const row = rows[0];
    if (!row || adminPass !== row.admin_pass) {
      return res.status(401).json({ error: '管理者パスワードが正しくありません' });
    }
    const finalAdminPass = newAdminPass && newAdminPass.trim() ? newAdminPass.trim() : row.admin_pass;

    // 公開期間が変わったら新セッションを作成（ログインカウントをリセット）
    const prevStart = row.start_time ? new Date(row.start_time).toISOString() : null;
    const prevEnd   = row.end_time   ? new Date(row.end_time).toISOString()   : null;
    const newStart  = startTime || null;
    const newEnd    = endTime   || null;
    const periodChanged = prevStart !== newStart || prevEnd !== newEnd;

    let sessionId = row.current_session_id;
    if (periodChanged && (newStart || newEnd)) {
      const { rows: sess } = await pool.query(
        'INSERT INTO stream_sessions (title, start_time, end_time) VALUES ($1, $2, $3) RETURNING id',
        [title || null, newStart, newEnd]
      );
      sessionId = sess[0].id;
    }

    await pool.query(
      `UPDATE stream_config SET
        title=$1, yt_url=$2, start_time=$3, end_time=$4,
        next_start=$5, next_end=$6, pass_enabled=$7, view_pass=$8,
        name_enabled=$9, notice=$10, admin_pass=$11, is_public=$12,
        current_session_id=$13, updated_at=NOW()
       WHERE id=1`,
      [
        title||null, ytUrl||null, newStart, newEnd,
        nextStart||null, nextEnd||null, !!passEnabled, viewPass||null,
        !!nameEnabled, notice||null, finalAdminPass, !!isPublic,
        sessionId || null,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- 管理者向け：即時ON/OFFだけ更新 ----
app.post('/api/admin/toggle-public', async (req, res) => {
  const { adminPass, isPublic } = req.body;
  try {
    const { rows } = await pool.query('SELECT admin_pass FROM stream_config WHERE id = 1');
    const row = rows[0];
    if (!row || adminPass !== row.admin_pass) {
      return res.status(401).json({ error: '認証エラー' });
    }
    await pool.query('UPDATE stream_config SET is_public=$1, updated_at=NOW() WHERE id=1', [!!isPublic]);
    res.json({ ok: true, isPublic: !!isPublic });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- 管理者向け：セッション一覧取得 ----
app.post('/api/admin/sessions', async (req, res) => {
  const { adminPass } = req.body;
  try {
    const { rows: cfg } = await pool.query('SELECT admin_pass FROM stream_config WHERE id=1');
    if (!cfg[0] || adminPass !== cfg[0].admin_pass) {
      return res.status(401).json({ error: '認証エラー' });
    }
    const { rows } = await pool.query(`
      SELECT s.id, s.title, s.start_time, s.end_time,
             COUNT(l.id) AS login_count
      FROM stream_sessions s
      LEFT JOIN login_log l ON l.session_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    res.json({ sessions: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- 管理者向け：特定セッションのログイン詳細 ----
app.post('/api/admin/session-stats', async (req, res) => {
  const { adminPass, sessionId } = req.body;
  try {
    const { rows: cfg } = await pool.query('SELECT admin_pass, current_session_id FROM stream_config WHERE id=1');
    if (!cfg[0] || adminPass !== cfg[0].admin_pass) {
      return res.status(401).json({ error: '認証エラー' });
    }
    const { rows: logs } = await pool.query(
      'SELECT name, logged_in_at FROM login_log WHERE session_id=$1 ORDER BY logged_in_at DESC',
      [sessionId]
    );
    res.json({ total: logs.length, logs, currentSessionId: cfg[0].current_session_id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

initDB().then(() => {
  app.listen(port, () => console.log(`API server running on port ${port}`));
}).catch(e => {
  console.error('DB init failed:', e);
  process.exit(1);
});
