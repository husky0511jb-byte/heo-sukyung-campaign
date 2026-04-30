const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const SOLAPI_API_KEY = process.env.SOLAPI_API_KEY || 'NCSQXGZ4SHAZ5QJB';
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET || 'LZ6WYOIZE5T6OWWUXDVYWKWXI2NBUFI7';
const SENDER = process.env.SENDER || '01048054360';
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJSON(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// 인증코드 임시 저장 (phone -> { code, expires })
const codeStore = new Map();

function makeAuthHeader() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto
    .createHmac('sha256', SOLAPI_API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

// ── SMS 발송 ──
app.post('/api/send-sms', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ error: '올바른 번호를 입력해주세요.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const normalizedPhone = phone.replace(/\D/g, '');
  codeStore.set(normalizedPhone, { code, expires: Date.now() + 3 * 60 * 1000 });

  try {
    const response = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': makeAuthHeader()
      },
      body: JSON.stringify({
        message: {
          to: normalizedPhone,
          from: SENDER,
          text: `[허수경 지지선언] 인증번호: ${code} (3분 유효)`
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Solapi 오류:', data);
      return res.status(500).json({ error: 'SMS 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' });
    }

    console.log(`SMS 발송 완료 → ${normalizedPhone}`);
    res.json({ success: true });
  } catch (err) {
    console.error('서버 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── 인증번호 확인 ──
app.post('/api/verify-code', (req, res) => {
  const { phone, code } = req.body;
  const normalizedPhone = (phone || '').replace(/\D/g, '');
  const entry = codeStore.get(normalizedPhone);

  if (!entry) return res.status(400).json({ error: '인증번호를 먼저 요청해주세요.' });
  if (Date.now() > entry.expires) {
    codeStore.delete(normalizedPhone);
    return res.status(400).json({ error: '인증번호가 만료되었습니다. 다시 요청해주세요.' });
  }
  if (entry.code !== code) return res.status(400).json({ error: '인증번호가 올바르지 않습니다.' });

  codeStore.delete(normalizedPhone);
  res.json({ success: true });
});

// ── 지지선언 수 조회 + 최근 메시지 ──
app.get('/api/pledge-count', (req, res) => {
  const pledges = readJSON('pledges.json');
  const messages = pledges
    .filter(p => p.message && p.message.trim())
    .slice(-20)
    .reverse()
    .map(p => ({ name: p.name, message: p.message, timestamp: p.timestamp }));
  res.json({ count: pledges.length, messages });
});

// ── 지지선언 제출 ──
app.post('/api/pledge', (req, res) => {
  const { name, phone, message, newsletter } = req.body;
  if (!name) return res.status(400).json({ error: '이름을 입력해주세요.' });

  const pledges = readJSON('pledges.json');
  pledges.push({
    name,
    phone_last4: (phone || '').replace(/\D/g, '').slice(-4),
    message: (message || '').trim(),
    newsletter: !!newsletter,
    timestamp: new Date().toISOString()
  });
  writeJSON('pledges.json', pledges);
  res.json({ success: true, count: pledges.length });
});

// ── 설문 저장 ──
app.post('/api/survey', (req, res) => {
  const surveys = readJSON('surveys.json');
  surveys.push({ ...req.body, timestamp: new Date().toISOString() });
  writeJSON('surveys.json', surveys);
  res.json({ success: true });
});

// ── 자원봉사 신청 ──
app.post('/api/volunteer', (req, res) => {
  const { name, phone, activities, times, message } = req.body;
  if (!name || !phone) return res.status(400).json({ error: '이름과 연락처를 입력해주세요.' });

  const volunteers = readJSON('volunteers.json');
  volunteers.push({
    name,
    phone,
    activities: activities || [],
    times: times || [],
    message: (message || '').trim(),
    timestamp: new Date().toISOString()
  });
  writeJSON('volunteers.json', volunteers);
  console.log(`자원봉사 신청: ${name}`);
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '서울 여성이 안전해야 서울이 바뀐다 — 허수경.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
