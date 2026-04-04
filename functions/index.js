const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const https = require('https');

setGlobalOptions({ region: 'asia-southeast1' });

const LINE_TOKEN = process.env.LINE_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;

function pushLine(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text: message }],
    });
    const req = https.request(
      {
        hostname: 'api.line.me',
        path: '/v2/bot/message/push',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_TOKEN}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.lineNotify = onRequest(
  { cors: true, secrets: ['LINE_TOKEN', 'LINE_USER_ID'] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const { type, name, examTitle, score, total } = req.body || {};
    if (!type || !name || !examTitle) {
      res.status(400).json({ error: 'Missing fields' });
      return;
    }

    let message;
    if (type === 'start') {
      message = `🎯 เริ่มทำข้อสอบ\n👤 ${name}\n📋 ${examTitle}`;
    } else if (type === 'finish') {
      const pct = total ? Math.round((score / total) * 100) : 0;
      const star = pct >= 80 ? '🏆' : pct >= 60 ? '✅' : '⚠️';
      message = `${star} ส่งข้อสอบแล้ว\n👤 ${name}\n📋 ${examTitle}\n📊 ${score}/${total} คะแนน (${pct}%)`;
    } else {
      res.status(400).json({ error: 'Invalid type' });
      return;
    }

    try {
      const result = await pushLine(message);
      res.json({ ok: result.status === 200 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
