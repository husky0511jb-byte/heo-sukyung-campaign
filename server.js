const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const SOLAPI_API_KEY = process.env.SOLAPI_API_KEY || 'NCSQXGZ4SHAZ5QJB';
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET || 'LZ6WYOIZE5T6OWWUXDVYWKWXI2NBUFI7';
const SENDER = process.env.SENDER || '01048054360';

// ── DB 설정 (로컬: JSON 파일 폴백) ──
let pool = null;
const DATA_DIR = path.join(__dirname, 'data');

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  pool.connect()
    .then(() => {
      console.log('PostgreSQL 연결 성공');
      return initDB();
    })
    .catch(err => console.error('DB 연결 실패:', err));
} else {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  console.log('로컬 모드: JSON 파일 사용');
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pledges (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone_last4 TEXT,
      message TEXT DEFAULT '',
      location TEXT DEFAULT '',
      newsletter BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS surveys (
      id SERIAL PRIMARY KEY,
      q1 TEXT[],
      q2 TEXT,
      q3 TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS volunteers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      activities TEXT[],
      times TEXT[],
      message TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB 테이블 준비 완료');
}

// ── JSON 파일 유틸 (로컬용) ──
function readJSON(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ── SMS ──
const codeStore = new Map();

function makeAuthHeader() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', SOLAPI_API_SECRET).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

app.post('/api/send-sms', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.replace(/\D/g, '').length < 10)
    return res.status(400).json({ error: '올바른 번호를 입력해주세요.' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const normalizedPhone = phone.replace(/\D/g, '');
  codeStore.set(normalizedPhone, { code, expires: Date.now() + 3 * 60 * 1000 });

  try {
    const response = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': makeAuthHeader() },
      body: JSON.stringify({ message: { to: normalizedPhone, from: SENDER, text: `[허수경 지지선언] 인증번호: ${code} (3분 유효)` } })
    });
    const data = await response.json();
    if (!response.ok) { console.error('Solapi 오류:', data); return res.status(500).json({ error: 'SMS 발송 실패' }); }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.post('/api/verify-code', (req, res) => {
  const { phone, code } = req.body;
  const normalizedPhone = (phone || '').replace(/\D/g, '');
  const entry = codeStore.get(normalizedPhone);
  if (!entry) return res.status(400).json({ error: '인증번호를 먼저 요청해주세요.' });
  if (Date.now() > entry.expires) { codeStore.delete(normalizedPhone); return res.status(400).json({ error: '만료되었습니다.' }); }
  if (entry.code !== code) return res.status(400).json({ error: '인증번호가 올바르지 않습니다.' });
  codeStore.delete(normalizedPhone);
  res.json({ success: true });
});

// ── 지지선언 ──
app.get('/api/pledge-count', async (req, res) => {
  try {
    if (pool) {
      const countRes = await pool.query('SELECT COUNT(*) FROM pledges');
      const msgRes = await pool.query(
        "SELECT name, message, created_at FROM pledges WHERE message != '' ORDER BY created_at DESC LIMIT 20"
      );
      return res.json({
        count: parseInt(countRes.rows[0].count),
        messages: msgRes.rows.map(r => ({ name: r.name, message: r.message, timestamp: r.created_at }))
      });
    }
    // 로컬 폴백
    const pledges = readJSON('pledges.json');
    const messages = pledges.filter(p => p.message).slice(-20).reverse();
    res.json({ count: pledges.length, messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

app.post('/api/pledge', async (req, res) => {
  const { name, phone, message, location, newsletter } = req.body;
  if (!name) return res.status(400).json({ error: '이름을 입력해주세요.' });
  try {
    if (pool) {
      await pool.query(
        'INSERT INTO pledges (name, phone_last4, message, location, newsletter) VALUES ($1, $2, $3, $4, $5)',
        [name, (phone || '').replace(/\D/g, '').slice(-4), (message || '').trim(), (location || '').trim(), !!newsletter]
      );
      const countRes = await pool.query('SELECT COUNT(*) FROM pledges');
      return res.json({ success: true, count: parseInt(countRes.rows[0].count) });
    }
    // 로컬 폴백
    const pledges = readJSON('pledges.json');
    pledges.push({ name, phone_last4: (phone || '').replace(/\D/g, '').slice(-4), message: (message || '').trim(), location: (location || '').trim(), newsletter: !!newsletter, timestamp: new Date().toISOString() });
    writeJSON('pledges.json', pledges);
    res.json({ success: true, count: pledges.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// ── 설문 ──
app.post('/api/survey', async (req, res) => {
  const { q1, q2, q3 } = req.body;
  try {
    if (pool) {
      await pool.query('INSERT INTO surveys (q1, q2, q3) VALUES ($1, $2, $3)', [q1 || [], q2 || '', q3 || '']);
      return res.json({ success: true });
    }
    const surveys = readJSON('surveys.json');
    surveys.push({ ...req.body, timestamp: new Date().toISOString() });
    writeJSON('surveys.json', surveys);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// ── 자원봉사 ──
app.post('/api/volunteer', async (req, res) => {
  const { name, phone, activities, times, message } = req.body;
  if (!name || !phone) return res.status(400).json({ error: '이름과 연락처를 입력해주세요.' });
  try {
    if (pool) {
      await pool.query(
        'INSERT INTO volunteers (name, phone, activities, times, message) VALUES ($1, $2, $3, $4, $5)',
        [name, phone, activities || [], times || [], (message || '').trim()]
      );
      return res.json({ success: true });
    }
    const volunteers = readJSON('volunteers.json');
    volunteers.push({ name, phone, activities, times, message, timestamp: new Date().toISOString() });
    writeJSON('volunteers.json', volunteers);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '서울 여성이 안전해야 서울이 바뀐다 — 허수경.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
