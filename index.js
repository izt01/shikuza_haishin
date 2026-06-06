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
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // is_public カラムが古いDBにない場合に追加
  await pool.query(`
    ALTER TABLE stream_config ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_log (
      id           SERIAL PRIMARY KEY,
      name         TEXT,
      logged_in_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rowCount } = await pool.query('SELECT 1 FROM stream_config WHERE id = 1');
  if (rowCount === 0) {
    await pool.query(`INSERT INTO stream_config (id) VALUES (1)`);
  }
  console.log('DB initialized');
}

// 視聴者向け：公開情報取得
app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT title, yt_url, start_time, end_time, next_start, next_end,
              pass_enabled, name_enabled, notice, is_public, updated_at
       FROM stream_config WHERE id = 1`
    );
    res.json(rows[0] || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// 視聴者向け：パスワード認証 + ログイン記録
app.post('/api/auth', async (req, res) => {
  const { password, name } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT pass_enabled, view_pass, name_enabled, start_time, end_time, is_public FROM stream_config WHERE id = 1'
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
      ((!row.start_time || now >= new Date(row.start_time)) &&
       (!row.end_time   || now <= new Date(row.end_time)));
    if (inPeriod) {
      await pool.query('INSERT INTO login_log (name) VALUES ($1)', [name && name.trim() ? name.trim() : null]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// 管理者向け：設定全取得
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
    newAdminPass, isPublic,
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
        title=$1, yt_url=$2, start_time=$3, end_time=$4,
        next_start=$5, next_end=$6, pass_enabled=$7, view_pass=$8,
        name_enabled=$9, notice=$10, admin_pass=$11, is_public=$12, updated_at=NOW()
       WHERE id=1`,
      [
        title||null, ytUrl||null, startTime||null, endTime||null,
        nextStart||null, nextEnd||null, !!passEnabled, viewPass||null,
        !!nameEnabled, notice||null, finalAdminPass, !!isPublic,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// 管理者向け：即時ON/OFFだけ更新
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

// 管理者向け：ログイン統計取得
app.post('/api/admin/stats', async (req, res) => {
  const { adminPass, startTime, endTime } = req.body;
  try {
    const { rows } = await pool.query('SELECT admin_pass FROM stream_config WHERE id=1');
    const row = rows[0];
    if (!row || adminPass !== row.admin_pass) {
      return res.status(401).json({ error: '認証エラー' });
    }
    const where = startTime && endTime ? `WHERE logged_in_at >= $1 AND logged_in_at <= $2` : '';
    const params = startTime && endTime ? [startTime, endTime] : [];
    const { rows: logs } = await pool.query(
      `SELECT name, logged_in_at FROM login_log ${where} ORDER BY logged_in_at DESC`, params
    );
    res.json({ total: logs.length, logs });
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
