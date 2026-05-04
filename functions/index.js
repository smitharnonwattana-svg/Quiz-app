const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const https = require('https');
const admin = require('firebase-admin');

setGlobalOptions({ region: 'asia-southeast1' });

if (!admin.apps.length) admin.initializeApp();

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
            subject, count, correct, answered, remaining, finished,
            rewardName } = req.body || {};
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
    } else if (type === 'reward_request') {
      message = '📬 ' + (name || '') + ' ขอรับรางวัล!\n'
        + '🏆 ' + (examTitle || '') + '\n'
        + '🎁 ' + (rewardName || '') + '\n'
        + 'กรุณาเตรียมรางวัลให้น้องด้วยครับ 🙏';
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

// Daily Summary LINE notification — 21:00 Bangkok
exports.dailySummaryNotify = onSchedule(
  {
    schedule: '0 21 * * *',
    timeZone: 'Asia/Bangkok',
    region: 'asia-southeast1',
    secrets: ['LINE_TOKEN', 'LINE_USER_ID'],
  },
  async (event) => {
    const db = admin.firestore();

    // Today's date key in Bangkok time (UTC+7)
    const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const todayKey = bangkokNow.toISOString().slice(0, 10);

    // Fetch all app docs and filter by ID pattern
    const snapshot = await db.collection('app').get();
    const todayDocs = snapshot.docs.filter(
      (doc) => doc.id.includes('_dailySummary_') && doc.id.endsWith('_' + todayKey)
    );

    for (const doc of todayDocs) {
      try {
        const raw = doc.data()._d;
        if (!raw) continue;
        const d = JSON.parse(raw);
        if (!d || !d.userId) continue;

        const qDone = Array.isArray(d.questsCompleted) ? d.questsCompleted.length : 0;
        const message =
          '📊 สรุปวันนี้ของ ' + d.userId + '\n' +
          '━━━━━━━━━━━━━━\n' +
          '🔥 Activity: ' + (d.activityPct || 0) + '%  (' + (d.setsToday || 0) + ' ชุด)\n' +
          '🎯 Score: ' + (d.scorePct || 0) + '%\n' +
          '🔧 Fixes: ' + (d.fixesPct || 0) + '%  (' + (d.resolvedToday || 0) + ' ข้อ)\n' +
          '🔥 Streak: ' + (d.streak || 0) + ' วัน\n' +
          '⭐ Points: ' + (d.pointsTotal || 0) + ' pt\n' +
          '🎫 Stamps: ' + (d.stampsTotal || 0) + '\n' +
          '🎯 Quests: ' + qDone + '/' + (d.questsTotal || 4);

        await pushLine(message);
      } catch (e) {
        console.warn('dailySummaryNotify: failed for doc', doc.id, e.message);
      }
    }

    console.log('dailySummaryNotify: sent', todayDocs.length, 'summaries for', todayKey);
  }
);

// TTL Cleanup — delete expired dailySummary docs at 02:00 Bangkok
exports.cleanupExpiredSummaries = onSchedule(
  {
    schedule: '0 2 * * *',
    timeZone: 'Asia/Bangkok',
    region: 'asia-southeast1',
  },
  async (event) => {
    const db = admin.firestore();
    const nowIso = new Date().toISOString();

    const snapshot = await db.collection('app').get();
    const expired = snapshot.docs.filter((doc) => {
      if (!doc.id.includes('_dailySummary_')) return false;
      try {
        const d = JSON.parse(doc.data()._d || 'null');
        return d && d.expiresAt && d.expiresAt < nowIso;
      } catch {
        return false;
      }
    });

    // Delete in batches of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < expired.length; i += BATCH_SIZE) {
      const batch = db.batch();
      expired.slice(i, i + BATCH_SIZE).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    console.log('cleanupExpiredSummaries: deleted', expired.length, 'expired docs');
  }
);
