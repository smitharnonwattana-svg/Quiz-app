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

// ── lineNotify hardening ──
const ALLOWED_ORIGIN = 'https://smitharnonwattana-svg.github.io';

// Rate limit ต่อ instance: กัน spam ยิงถล่ม quota LINE
let _rlWindowStart = 0;
let _rlCount = 0;
function rateLimited() {
  const now = Date.now();
  if (now - _rlWindowStart > 60000) { _rlWindowStart = now; _rlCount = 0; }
  _rlCount += 1;
  return _rlCount > 30;
}

// แปลงเป็นตัวเลขปลอดภัย — กัน NaN/ค่าประหลาดโผล่ในข้อความ LINE
function num(v, max = 10000) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : 0;
}
function txt(v, max = 100) { return String(v == null ? '' : v).slice(0, max); }

exports.lineNotify = onRequest(
  { cors: [ALLOWED_ORIGIN], secrets: ['LINE_TOKEN', 'LINE_USER_ID'] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    // browser fetch ข้าม origin ส่ง Origin header เสมอ — ต้องตรงกับแอปเท่านั้น
    if (req.get('origin') !== ALLOWED_ORIGIN) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (rateLimited()) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const body = req.body || {};
    const { type, finished } = body;
    const name = txt(body.name);
    const examTitle = txt(body.examTitle);
    const subject = txt(body.subject);
    const rewardName = txt(body.rewardName);
    const score = num(body.score);
    const total = num(body.total);
    const usedSeconds = num(body.usedSeconds, 86400);
    const count = num(body.count);
    const correct = num(body.correct);
    const answered = num(body.answered);
    const remaining = body.remaining == null ? null : num(body.remaining);
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
      if (result.status !== 200) {
        console.warn('lineNotify: LINE API rejected', result.status, result.body);
        res.status(502).json({ ok: false, lineStatus: result.status });
        return;
      }
      res.json({ ok: true });
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

    // อ่านค่า lineNotify ต่อสมาชิกจาก mainStore doc (อยู่ใน snapshot เดียวกัน ไม่เพิ่ม read)
    // กัน daily summary ส่งทับ toggle "ปิด LINE" ที่ตั้งไว้ในแอป
    let disabledNames = new Set();
    try {
      const mainStoreDoc = snapshot.docs.find((doc) => doc.id.endsWith('_mainStore'));
      const raw = mainStoreDoc && mainStoreDoc.data()._d;
      const mainStore = raw ? JSON.parse(raw) : null;
      const members = (mainStore && Array.isArray(mainStore.members)) ? mainStore.members : [];
      disabledNames = new Set(
        members.filter((m) => m && m.lineNotify === false).map((m) => m.name)
      );
    } catch (e) {
      console.warn('dailySummaryNotify: failed to read mainStore for lineNotify prefs', e.message);
    }

    const todayDocs = snapshot.docs.filter(
      (doc) => doc.id.includes('_dailySummary_') && doc.id.endsWith('_' + todayKey)
    );

    for (const doc of todayDocs) {
      try {
        const raw = doc.data()._d;
        if (!raw) continue;
        const d = JSON.parse(raw);
        if (!d || !d.userId) continue;
        if (disabledNames.has(d.userId)) continue; // สมาชิกปิด LINE notify ไว้

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

// Auto Backup — snapshot mainStore doc daily at 01:00 Bangkok
// เก็บไว้ในคอลเลกชัน 'app' เดิม (ตาม pattern ของ dailySummary) doc id: <origin>_backup_auto_<YYYY-MM-DD>
exports.autoBackupMainStore = onSchedule(
  {
    schedule: '0 1 * * *',
    timeZone: 'Asia/Bangkok',
    region: 'asia-southeast1',
  },
  async (event) => {
    const db = admin.firestore();
    const snapshot = await db.collection('app').get();
    const mainStoreDoc = snapshot.docs.find((doc) => doc.id.endsWith('_mainStore'));
    if (!mainStoreDoc) {
      console.warn('autoBackupMainStore: mainStore doc not found');
      return;
    }
    const raw = mainStoreDoc.data()._d;
    if (!raw) {
      console.warn('autoBackupMainStore: mainStore doc has no data');
      return;
    }

    const origin = mainStoreDoc.id.slice(0, -'_mainStore'.length);
    const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const todayKey = bangkokNow.toISOString().slice(0, 10);
    const backupId = `${origin}_backup_auto_${todayKey}`;

    await db.collection('app').doc(backupId).set({
      _d: raw,
      _ts: Date.now(),
      type: 'auto',
      date: todayKey,
      createdAt: new Date().toISOString(),
    });

    console.log('autoBackupMainStore: saved', backupId);
  }
);

// TTL Cleanup — ลบ auto backup ที่เก่ากว่า 14 วัน ที่ 02:30 Bangkok (backup manual ไม่ถูกแตะ)
exports.cleanupOldAutoBackups = onSchedule(
  {
    schedule: '30 2 * * *',
    timeZone: 'Asia/Bangkok',
    region: 'asia-southeast1',
  },
  async (event) => {
    const db = admin.firestore();
    const RETENTION_DAYS = 14;
    const cutoffKey = new Date(Date.now() + 7 * 60 * 60 * 1000 - RETENTION_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);

    const snapshot = await db.collection('app').get();
    const expired = snapshot.docs.filter((doc) => {
      if (!doc.id.includes('_backup_auto_')) return false;
      const d = doc.data();
      return d && d.date && d.date < cutoffKey;
    });

    const BATCH_SIZE = 500;
    for (let i = 0; i < expired.length; i += BATCH_SIZE) {
      const batch = db.batch();
      expired.slice(i, i + BATCH_SIZE).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    console.log('cleanupOldAutoBackups: deleted', expired.length, 'auto backups older than', cutoffKey);
  }
);
