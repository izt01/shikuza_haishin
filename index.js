const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app  = express();
const port = process.env.PORT || 3000;

// ---- DB接続 ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ---- CORS（フロントのドメインを環境変数 ALLOWED_ORIGIN で指定） ----
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// ---- DB初期化（テーブルがなければ作成） ----
async function initDB() {
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
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 行がなければデフォルト行を挿入
  const { rowCount } = await pool.query('SELECT 1 FROM stream_config WHERE id = 1');
  if (rowCount === 0) {
    await pool.query(`INSERT INTO stream_config (id) VALUES (1)`);
  }
  console.log('DB initialized');
}

// ---- ルーティング ----

// 視聴者向け：公開情報取得（パスワード等センシティブな値は除外）
app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT title, yt_url, start_time, end_time, next_start, next_end,
              pass_enabled, name_enabled, notice, updated_at
       FROM stream_config WHERE id = 1`
    );
    res.json(rows[0] || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// 視聴者向け：パスワード認証
app.post('/api/auth', async (req, res) => {
  const { password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT pass_enabled, view_pass FROM stream_config WHERE id = 1'
    );
    const row = rows[0];
    if (!row) return res.json({ ok: true });
    if (row.pass_enabled && row.view_pass) {
      if (password !== row.view_pass) {
        return res.status(401).json({ ok: false, error: 'パスワードが正しくありません' });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// 管理者向け：設定全取得（admin_pass含む）
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

// 管理者向け：設定保存
app.post('/api/admin/save', async (req, res) => {
  const {
    adminPass, title, ytUrl,
    startTime, endTime, nextStart, nextEnd,
    passEnabled, viewPass, nameEnabled, notice,
    newAdminPass,
  } = req.body;

  try {
    const { rows } = await pool.query('SELECT admin_pass FROM stream_config WHERE id = 1');
    const row = rows[0];
    if (!row || adminPass !== row.admin_pass) {
      return res.status(401).json({ error: '管理者パスワードが正しくありません' });
    }

    const finalAdminPass = newAdminPass && newAdminPass.trim() ? newAdminPass.trim() : row.admin_pass;

    await pool.query(
      `UPDATE stream_config SET
        title        = $1,
        yt_url       = $2,
        start_time   = $3,
        end_time     = $4,
        next_start   = $5,
        next_end     = $6,
        pass_enabled = $7,
        view_pass    = $8,
        name_enabled = $9,
        notice       = $10,
        admin_pass   = $11,
        updated_at   = NOW()
       WHERE id = 1`,
      [
        title        || null,
        ytUrl        || null,
        startTime    || null,
        endTime      || null,
        nextStart    || null,
        nextEnd      || null,
        !!passEnabled,
        viewPass     || null,
        !!nameEnabled,
        notice       || null,
        finalAdminPass,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ---- 起動 ----
initDB().then(() => {
  app.listen(port, () => console.log(`API server running on port ${port}`));
}).catch(e => {
  console.error('DB init failed:', e);
  process.exit(1);
});
