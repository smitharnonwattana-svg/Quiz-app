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

    const { type, name, examTitle, score, total, usedSeconds,
            subject, count, correct, answered, remaining, finished } = req.body || {};
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
      const sec = Math.max(0, Math.floor(usedSeconds || 0));
      const timeStr = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
      message = `${star} ส่งข้อสอบแล้ว\n👤 ${name}\n📋 ${examTitle}\n📊 ${score}/${total} คะแนน (${pct}%)\n⏱ เวลาที่ใช้ ${timeStr} นาที`;
    } else if (type === 'practice_start') {
      const subj = subject || 'ไม่ระบุ';
      message = `🎯 เริ่มแก้จุดอ่อน\n👤 ${name}\n📚 วิชา: ${subj}\n📋 ${examTitle}\n⚠️ มีจุดอ่อน ${count || 0} ข้อ`;
    } else if (type === 'practice_end') {
      const subj = subject || 'ไม่ระบุ';
      const icon = finished ? '✅' : '📝';
      const label = finished ? 'แก้จุดอ่อนเสร็จสิ้น' : 'ออกจากการแก้จุดอ่อน';
      message = `${icon} ${label}\n👤 ${name}\n📚 วิชา: ${subj}\n📋 ${examTitle}\n✅ แก้ได้ ${correct || 0}/${answered || 0} ข้อ\n⚠️ เหลือจุดอ่อน ${remaining ?? '?'} ข้อ`;
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
