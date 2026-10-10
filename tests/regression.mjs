// ═══════════════════════════════════════════════════════════════════════════
// Quiz-app regression suite — รวม checks จากการแก้บั๊ก v47.93 → v48.10
// รันผ่าน tests/run.sh (start static server → รันไฟล์นี้ → kill server)
// ทุก section เปิด browser context ใหม่ + seed ข้อมูลเอง — ไม่แตะ Firebase จริง
// (FirebaseSync ถูก stub ต่อ section, Store._cache seed ตรงๆ, _cloudLoaded บังคับ)
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:8901';

// playwright: ลอง resolve ปกติก่อน แล้วค่อย fallback ไป path ของ sandbox
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const CHROMIUM_PATH = '/opt/pw-browsers/chromium';
const launchOpts = { headless: true };
if (fs.existsSync(CHROMIUM_PATH)) launchOpts.executablePath = CHROMIUM_PATH;

const results = [];
let currentSection = '';
function check(name, cond, detail = '') {
  const full = `[${currentSection}] ${name}`;
  results.push({ name: full, pass: !!cond, detail });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + full + (cond ? '' : (detail ? ' — ' + detail : '')));
}

const browser = await chromium.launch(launchOpts);

// เปิดหน้าใหม่ + seed session/ข้อมูลพื้นฐาน — ทุก section เริ่มจาก state สะอาด
// file: หน้าที่จะเปิด — ใช้ 'index_preview.html' กับฟีเจอร์ที่ยังอยู่ใน preview เท่านั้น
async function newSeededPage({ role = 'teacher', name = 'Admin', cache, viewport, file = 'index.html' }) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800); // ให้ Firebase SDK ล้มเหลวเงียบๆ (ถูก proxy บล็อก) ก่อน seed
  await page.evaluate(({ role, name, cache }) => {
    sessionStorage.setItem('appSession', JSON.stringify({ role, name, ts: Date.now() }));
    Store._cloudLoaded = true;
    Store._cache = cache;
  }, { role, name, cache });
  return { ctx, page };
}

const mkExam = (id, title, subject, extra = {}) => ({
  id, title, subject, questionCount: 1, published: true, order: 1,
  durationSeconds: 600, examType: 'mc', ...extra,
});
const mkQ = () => [{ id: 'q1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } }];
const baseCache = (over = {}) => ({
  exams: [], questions: {}, attempts: [], members: [], assignments: [],
  benchmarks: [], subjectTopics: {}, subjectSubTopics: {}, gamification: {}, examFolders: [], ...over,
});

// ─────────────────────────────────────────────────────────────────
// Section A: Editor persistence (v47.94 fix — list copy ต้อง sync กลับ store)
// ─────────────────────────────────────────────────────────────────
currentSection = 'editor';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eA1', 'คณิต A1', 'คณิตศาสตร์', { questionCount: 3 })],
      questions: { eA1: [
        { id: 'q1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        { id: 'q2', no: 2, number: 2, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        { id: 'q3', no: 3, number: 3, correct: 'C', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      ] },
      subjectTopics: { 'คณิตศาสตร์': ['เรขาคณิต'] },
    }),
  });
  await page.evaluate(() => navigate('admin_editor', { id: 'eA1' }));
  await page.waitForTimeout(500);
  const quickTag = await page.evaluate(() => {
    window._quickTagSelected = null;
    const chip = document.querySelector('[data-qtag-chip]');
    if (!chip) return { hasChip: false };
    chip.click();
    const rangeInput = document.getElementById('editorQuickTagRange');
    if (rangeInput) rangeInput.value = '1';
    document.getElementById('editorQuickTagApply')?.click();
    const q1 = (Store.load().questions.eA1 || []).find(q => q.no === 1);
    return { hasChip: true, tags: q1 && q1.tags };
  });
  check('quick-tag persists to s.questions', quickTag.hasChip && Array.isArray(quickTag.tags) && quickTag.tags.includes('เรขาคณิต'), JSON.stringify(quickTag));

  const qcount = await page.evaluate(() => {
    const el = document.getElementById('editorQCount');
    if (!el) return { ok: false };
    el.value = '5';
    document.getElementById('editorQCountBtn').click();
    const qs = Store.load().questions.eA1 || [];
    return { ok: true, len: qs.length, q4Correct: qs.find(q => q.no === 4)?.correct };
  });
  check('applyQCount persists new count to store', qcount.ok && qcount.len === 5, JSON.stringify(qcount));
  check('applyQCount: newly-added question has NO default answer key selected (v48.10)', qcount.q4Correct === '', JSON.stringify(qcount));

  // v48.10: สลับคอลัมน์ตาราง เฉลย เป็น หน้า > ข้อ > เฉลย + เฉลยข้อใหม่ต้องไม่มีปุ่มไหน active
  const tableLayout = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('#page-admin_editor table thead th')].map(th => th.textContent.trim());
    const firstRow = document.querySelector('#editorTbody tr');
    const q4Row = [...document.querySelectorAll('#editorTbody tr')][3];
    const anySelectedInQ4 = !!q4Row?.querySelector('.correctBtn.selected');
    return { headers, hasPageInputFirst: !!firstRow?.children[0]?.querySelector('input[data-field="page"]'), anySelectedInQ4 };
  });
  check('editor table columns reordered to หน้า, ข้อ, เฉลย (v48.10)',
    tableLayout.headers[0] === 'หน้า' && tableLayout.headers[1] === 'ข้อ' && tableLayout.headers[2] === 'เฉลย' && tableLayout.hasPageInputFirst,
    JSON.stringify(tableLayout));
  check('editor: newly-created question shows NO ก/ข/ค/ง button highlighted by default (v48.10)',
    tableLayout.anySelectedInQ4 === false, JSON.stringify(tableLayout));

  const tmplErr = await page.evaluate(() => {
    let err = null;
    const orig = console.error;
    try { document.getElementById('editorDownloadTemplate')?.click(); } catch (e) { err = String(e); }
    console.error = orig;
    return err;
  });
  check('template download button does not throw (v47.94 exam-undefined fix)', tmplErr === null, String(tmplErr));

  // v48.7: เปลี่ยนประเภทข้อสอบ (mc -> fillblank-num) จากหน้า editor ได้ — เดิมแก้ไม่ได้เลย
  // หลังสร้าง ต้องไปแก้ที่ admin_new เท่านั้น
  const beforeType = await page.evaluate(() => document.querySelector('#editorExamTypeBtns [data-val="fillblank-num"]')?.classList.contains('active'));
  await page.evaluate(() => document.querySelector('#editorExamTypeBtns [data-val="fillblank-num"]').click());
  await page.waitForTimeout(600); // navigate() re-init หน้าทั้งหมด
  const afterType = await page.evaluate(() => {
    const s = Store.load();
    return {
      examType: s.exams.find(e => e.id === 'eA1')?.examType,
      q1Correct: (s.questions.eA1 || []).find(q => q.no === 1)?.correct,
      hasNumericInput: !!document.querySelector('input[data-field="correctNum"]'),
      activeBtn: document.querySelector('#editorExamTypeBtns .examTypeBtn.active')?.dataset.val,
    };
  });
  check('editor: toggling exam type to fillblank-num updates exam.examType + clears old correct answers + re-renders numeric input',
    beforeType === false && afterType.examType === 'fillblank-num' && (afterType.q1Correct === '' || afterType.q1Correct == null) && afterType.hasNumericInput && afterType.activeBtn === 'fillblank-num',
    JSON.stringify({ beforeType, afterType }));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section B: Admin — reorder ในวิชาที่กรอง + member save คง lineNotify (v47.94)
// ─────────────────────────────────────────────────────────────────
currentSection = 'admin';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [
        mkExam('eA1', 'คณิต A1', 'คณิตศาสตร์', { order: 1 }),
        mkExam('eA2', 'คณิต A2', 'คณิตศาสตร์', { order: 2 }),
        mkExam('eB1', 'ไทย B1', 'ภาษาไทย', { order: 3 }),
      ],
      questions: { eA1: mkQ(), eA2: mkQ(), eB1: mkQ() },
      members: [{ pin: '111111', name: 'เด็กทดสอบ', lineNotify: false }],
    }),
  });
  await page.evaluate(() => navigate('admin_exams', {}));
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const sel = document.getElementById('adminSubjFilter');
    sel.value = 'คณิตศาสตร์';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-move="up"][data-id="eA2"]')?.click());
  await page.waitForTimeout(300);
  const orders = await page.evaluate(() => {
    const s = Store.load();
    const by = id => s.exams.find(e => e.id === id);
    return { a1: by('eA1').order, a2: by('eA2').order, b1: by('eB1').order };
  });
  check('reorder swaps within filtered subject only (eB1 untouched)', orders.b1 === 3 && orders.a2 < orders.a1, JSON.stringify(orders));

  await page.evaluate(() => navigate('admin_members', {}));
  await page.waitForTimeout(400);
  await page.fill('#mname_0', 'เด็กทดสอบ2');
  await page.fill('#mpin_0', '222222');
  await page.click('[data-save="0"]');
  await page.waitForTimeout(300);
  const member = await page.evaluate(() => Store.load().members[0]);
  check('member save preserves lineNotify:false + applies name/pin', member.lineNotify === false && member.name === 'เด็กทดสอบ2' && member.pin === '222222', JSON.stringify(member));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section C: Gamification delta-tracking (v47.94 — เลิก lock ทั้งวันหลัง submit แรก)
// ─────────────────────────────────────────────────────────────────
currentSection = 'gamification';
{
  const { ctx, page } = await newSeededPage({ cache: baseCache() });
  const r = await page.evaluate(() => {
    Store._cache.gamification = {};
    window.calculateActivity = () => ({ focusSetCount: 1, nonFocusSetCount: 0, resolvedToday: 0 });
    window.calculateScore = () => ({ hasScoreToday: false });
    const r1 = processGamificationAfterSubmit('เด็กเดลต้า');
    window.calculateActivity = () => ({ focusSetCount: 2, nonFocusSetCount: 0, resolvedToday: 0 });
    const r2 = processGamificationAfterSubmit('เด็กเดลต้า');
    const rec = Store.load().gamification['เด็กเดลต้า'];
    return { p1: r1.pointsAwarded, p2: r2.pointsAwarded, total: rec.points, today: rec.pointsAwardedToday };
  });
  check('first submit awards 10, second same-day awards DELTA 10 (not 0), total 20', r.p1 === 10 && r.p2 === 10 && r.total === 20 && r.today === 20, JSON.stringify(r));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section C2: pointLog — ประวัติ point รายรายการ (admin_rewards) v48.44
// ─────────────────────────────────────────────────────────────────
currentSection = 'pointLog';
{
  const { ctx, page } = await newSeededPage({ cache: baseCache() });
  const r = await page.evaluate(() => {
    Store._cache.gamification = {};
    window.calculateActivity = () => ({ focusSetCount: 1, nonFocusSetCount: 0, resolvedToday: 0 });
    window.calculateScore = () => ({ hasScoreToday: false });
    const r1 = processGamificationAfterSubmit('เด็กล็อก', { source: 'exam', examTitle: 'ชุด A' });
    window.calculateActivity = () => ({ focusSetCount: 2, nonFocusSetCount: 0, resolvedToday: 0 });
    const r2 = processGamificationAfterSubmit('เด็กล็อก', { source: 'weakness_practice', examTitle: 'ชุด B' });
    const rec = Store.load().gamification['เด็กล็อก'];
    return { p1: r1.pointsAwarded, p2: r2.pointsAwarded, total: rec.points, log: rec.pointLog };
  });
  check('points ยังคำนวณเหมือนเดิมทุกประการ (submit1 +10, submit2 delta +10, total 20) — สูตรคำนวณไม่ถูกแตะ',
    r.p1 === 10 && r.p2 === 10 && r.total === 20, JSON.stringify({ p1: r.p1, p2: r.p2, total: r.total }));
  check('pointLog มี 1 รายการต่อ 1 submit (2 submit → 2 รายการ)', r.log.length === 2, JSON.stringify(r.log));
  check('submit จากส่งข้อสอบจริง → reason "ทำข้อสอบ: <ชื่อชุด>"',
    r.log[0] && r.log[0].reason === 'ทำข้อสอบ: ชุด A' && r.log[0].amount === 10, JSON.stringify(r.log[0]));
  check('submit จากแบบฝึกแก้จุดอ่อน → reason "แก้จุดอ่อน: <ชื่อชุด>"',
    r.log[1] && r.log[1].reason === 'แก้จุดอ่อน: ชุด B' && r.log[1].amount === 10, JSON.stringify(r.log[1]));

  const r3 = await page.evaluate(() => {
    Store._cache.gamification = {};
    awardPoints('เด็กเควส', 15, 'daily_quest');
    awardPoints('เด็กเควส', 5, 'bonus_quest_easy');
    awardPoints('เด็กเควส', 3, 'unknown_reason_xyz');
    const rec = Store.load().gamification['เด็กเควส'];
    return { total: rec.points, log: rec.pointLog };
  });
  check('awardPoints: total ถูกต้องและ reason แปลไทยตาม map', r3.total === 23 &&
    r3.log[0].reason === 'ภารกิจหลักประจำวัน' && r3.log[1].reason === 'ภารกิจเสริม (ง่าย)',
    JSON.stringify(r3));
  check('awardPoints: reason ที่ไม่รู้จัก fallback เป็น raw string', r3.log[2].reason === 'unknown_reason_xyz', r3.log[2].reason);

  const r4 = await page.evaluate(() => {
    Store._cache.gamification = {};
    const cur = _getGamificationUser('เด็กแคป');
    const seeded = [];
    for (let i = 0; i < 250; i++) seeded.push({ ts: i, date: '2026-01-01', amount: 1, reason: 'seed' + i });
    _saveGamificationUser('เด็กแคป', { ...cur, pointLog: seeded });
    awardPoints('เด็กแคป', 1, 'admin_test');
    const rec = _getGamificationUser('เด็กแคป');
    return { len: rec.pointLog.length, first: rec.pointLog[0].reason, last: rec.pointLog[rec.pointLog.length - 1].reason };
  });
  check('pointLog cap ที่ 200 รายการ (ring buffer เหมือน _takeDiag)', r4.len === 200, 'len=' + r4.len);
  check('cap ตัดรายการเก่าสุดออกก่อน (ไม่ใช่รายการใหม่)', r4.first !== 'seed0' && r4.last === 'แอดมินเพิ่มให้ (ทดสอบ)', JSON.stringify(r4));

  const r5 = await page.evaluate(() => {
    Store._cache.gamification = {
      'เด็กเก่าก่อนมีฟีเจอร์': { points: 50, pointsAwardedToday: 0, lastPointDate: '', stamps: 0, lastStampDate: '', claimedTiers: [], pendingTiers: [], bonusQuests: [], dailyQuest: null, questSalt: 0 },
    };
    let err = null, rec = null;
    try { rec = _getGamificationUser('เด็กเก่าก่อนมีฟีเจอร์'); } catch (e) { err = e.message; }
    return { err, pointLog: rec && rec.pointLog, points: rec && rec.points };
  });
  check('legacy record (ไม่มี pointLog field) อ่านได้ไม่ error, fallback เป็น []',
    r5.err === null && Array.isArray(r5.pointLog) && r5.pointLog.length === 0 && r5.points === 50, JSON.stringify(r5));

  const html = await page.evaluate(() => {
    Store._cache.gamification = {};
    awardPoints('เด็กยูไอ', 10, 'daily_quest');
    window.calculateActivity = () => ({ focusSetCount: 1, nonFocusSetCount: 0, resolvedToday: 0 });
    window.calculateScore = () => ({ hasScoreToday: false });
    processGamificationAfterSubmit('เด็กยูไอ', { source: 'exam', examTitle: 'ชุด UI' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRewardsFor('เด็กยูไอ', { host, adminTools: true });
    return host.innerHTML;
  });
  check('หน้า admin_rewards แสดง panel "ประวัติ Point" พร้อมรายการที่ถูกต้อง',
    html.includes('ประวัติ Point') && html.includes('ภารกิจหลักประจำวัน') && html.includes('ทำข้อสอบ: ชุด UI'));

  // v48.45 — admin_rewards redesign: แถบไล่สี .rewards-trophy ต้องติดแม้ render นอก
  // #page-rewards (เช่นตอนแสดงในหน้า admin) — ก่อนหน้านี้ CSS ล็อก scope ไว้เฉพาะ
  // #page-rewards ทำให้แถบสีหายไปเงียบๆ ตอน render ในหน้า admin (string-based check
  // แบบข้างบนจับบั๊กนี้ไม่ได้เลยเพราะไม่ได้เช็ค CSS เอง จึงต้องเช็ค computed style ตรงๆ)
  // NOTE (v48.57p, งาน HIG redesign rewards/admin_rewards): check นี้จะถูกเปลี่ยนเป็น
  // เช็ค .reward-node.reached background-color ทึบแทน — แต่ต้องรอ port เข้า production
  // index.html ก่อน (regression.mjs รันกับ production เท่านั้น ตอนนี้ preview ยังไม่ port)
  // ไม่งั้น suite จะพังเพราะ production ยังไม่มีคลาสใหม่พวกนี้
  const stripe = await page.evaluate(() => {
    Store._cache.gamification = {};
    awardPoints('เด็กสไตรป์', 10, 'admin_test');
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderRewardsFor('เด็กสไตรป์', { host, adminTools: true });
    const el = host.querySelector('.rewards-trophy');
    const bg = el ? getComputedStyle(el, '::before').backgroundImage : null;
    return { found: !!el, bg };
  });
  check('.rewards-trophy ที่ render นอก #page-rewards (เช่นในหน้า admin) ยังมีแถบไล่สี::before ติดอยู่',
    stripe.found && typeof stripe.bg === 'string' && stripe.bg.includes('gradient'), JSON.stringify(stripe));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section D: Resume — เตือนทับ (คนละชุด + ชุดเดิมคนละโหมด v47.95), clamp index
// ─────────────────────────────────────────────────────────────────
currentSection = 'resume';
{
  const cache = baseCache({
    exams: [mkExam('eX', 'คณิต X', 'คณิตศาสตร์'), mkExam('eY', 'ไทย Y', 'ภาษาไทย')],
    questions: { eX: mkQ(), eY: mkQ() },
  });
  const { ctx, page } = await newSeededPage({ cache });

  // คนละชุด → เตือน + decline คง resume ไว้
  const diffExam = await page.evaluate(() => {
    localStorage.setItem('nanont:takeResume:ครู', JSON.stringify({
      examId: 'eX', takerName: 'ครู', startedAt: Date.now() - 5000, currentIndex: 0,
      answers: {}, unsure: {}, qElapsedMs: {}, answerChanges: {}, visitOrder: [], practiceMode: false,
    }));
    let msg = null;
    const orig = window.confirm;
    window.confirm = (m) => { msg = m; return false; };
    navigate('take', { id: 'eY', takerName: 'ครู' });
    window.confirm = orig;
    return { msg, kept: !!localStorage.getItem('nanont:takeResume:ครู'), page: window._currentPage };
  });
  check('starting DIFFERENT exam warns with old title; decline keeps resume', !!diffExam.msg && diffExam.msg.includes('คณิต X') && diffExam.kept && diffExam.page === 'exams', JSON.stringify(diffExam).slice(0, 150));

  // ชุดเดิมคนละโหมด → เตือนพร้อมป้ายโหมด (v47.95 gap fix)
  const modeMismatch = await page.evaluate(() => {
    let msg = null;
    const orig = window.confirm;
    window.confirm = (m) => { msg = m; return false; };
    navigate('take', { id: 'eX', takerName: 'ครู', practice: true });
    window.confirm = orig;
    return { msg, kept: !!localStorage.getItem('nanont:takeResume:ครู') };
  });
  check('starting SAME exam in other mode warns with mode label', !!modeMismatch.msg && modeMismatch.msg.includes('จับเวลา') && modeMismatch.kept, JSON.stringify(modeMismatch).slice(0, 150));

  // clamp currentIndex เกินจำนวนข้อ (v47.94)
  const clamp = await page.evaluate(async () => {
    localStorage.setItem('nanont:takeResume:ครู', JSON.stringify({
      examId: 'eX', takerName: 'ครู', startedAt: Date.now() - 5000, currentIndex: 9,
      answers: {}, unsure: {}, qElapsedMs: {}, answerChanges: {}, visitOrder: [], practiceMode: false,
    }));
    navigate('take', { id: 'eX', takerName: 'ครู' });
    await new Promise(r => setTimeout(r, 700));
    document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('ทำต่อ')) b.click(); });
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('takeQNo')?.textContent || null;
  });
  check('resume with out-of-range currentIndex clamps (page renders a question)', !!clamp, 'takeQNo=' + clamp);

  // v48.8: submit() ต้องหัก pauseOffset (เวลาที่ออกจากแอปไป) ออกจาก usedSeconds ด้วย —
  // เดิมคำนวณจากนาฬิกาโลกจริงตรงๆ ทำให้ฝึกซ้อมที่ทำค้างข้ามวันแล้วกลับมาทำต่อ ได้ usedSeconds
  // รวมเวลาที่ปิดแอปไปด้วย (บั๊กจริงที่เจอ: "เวลาที่ใช้ 1440:00 นาที" ทั้งที่ทำจริงไม่กี่นาที)
  const pauseTiming = await page.evaluate(async () => {
    const now = Date.now();
    const startedAt = now - 7200 * 1000; // เริ่มทำเมื่อ 2 ชม.ที่แล้ว
    const pausedAt = now - 7000 * 1000;  // active จริง 200 วิ ก่อน save ครั้งสุดท้ายแล้วปิดแอปไป
    localStorage.setItem('nanont:takeResume:ครู', JSON.stringify({
      examId: 'eX', takerName: 'ครู', startedAt, pausedAt, pauseOffset: 0, currentIndex: 0,
      answers: {}, unsure: {}, qElapsedMs: {}, answerChanges: {}, visitOrder: [],
      practiceMode: true, attemptId: 'att_pausetest',
    }));
    navigate('take', { id: 'eX', takerName: 'ครู', practice: true });
    await new Promise(r => setTimeout(r, 500));
    document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('ทำต่อ')) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('takeSubmitBtn')?.click();
    await new Promise(r => setTimeout(r, 500));
    const att = (Store.load().attempts || []).find(a => a.id === 'att_pausetest');
    return { usedSeconds: att ? att.usedSeconds : null };
  });
  check('practice-mode submit excludes away-time (pauseOffset) from usedSeconds, not raw wall-clock since start',
    pauseTiming.usedSeconds !== null && pauseTiming.usedSeconds >= 150 && pauseTiming.usedSeconds < 400,
    JSON.stringify(pauseTiming));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section E: Backup/restore (v47.96) — จาก verify_v4796
// สำคัญสุด: restore ต้อง bypass merge (ข้อมูลเก่าทับทั้งก้อน ไม่ปน)
// reload หลัง restore เป็น native (stub ไม่ได้) → section นี้ปิด page ทันทีหลัง assert
// ─────────────────────────────────────────────────────────────────
currentSection = 'backup';
{
  const cacheA = baseCache({
    exams: [mkExam('eA1', 'ชุด A1', 'คณิตศาสตร์'), mkExam('eA2', 'ชุด A2', 'คณิตศาสตร์'), mkExam('eA3', 'ชุด A3', 'ภาษาไทย')],
    questions: { eA1: mkQ(), eA2: mkQ(), eA3: mkQ() },
    attempts: [
      { id: 'attA1', examId: 'eA1', takerName: 'x', score: 1, total: 1 },
      { id: 'attA2', examId: 'eA2', takerName: 'y', score: 1, total: 1 },
    ],
    members: [{ pin: '111111', name: 'เด็กA' }],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', d => { d.type() === 'prompt' ? d.accept('ทดสอบ backup') : d.accept(); });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.evaluate((cache) => {
    sessionStorage.setItem('appSession', JSON.stringify({ role: 'teacher', name: 'Admin', ts: Date.now() }));
    Store._cloudLoaded = true;
    Store._cache = cache;
    window._fakeBackups = {}; window._saveDocCalls = []; let seq = 0;
    FirebaseSync.saveManualBackup = async (data, label) => {
      const ts = Date.now() + (seq++); const id = 'fake_manual_' + ts;
      window._fakeBackups[id] = { id, type: 'manual', label, date: '', ts, createdAt: new Date(ts).toISOString(), _full: JSON.parse(JSON.stringify(data)) };
      return true;
    };
    FirebaseSync.listBackups = async () => Object.values(window._fakeBackups)
      .map(b => ({ id: b.id, type: b.type, label: b.label, date: b.date, ts: b.ts, createdAt: b.createdAt }))
      .sort((a, b) => b.ts - a.ts);
    FirebaseSync.loadBackupData = async (id) => window._fakeBackups[id]?._full ?? null;
    FirebaseSync.deleteBackup = async (id) => { delete window._fakeBackups[id]; return true; };
    FirebaseSync.saveDoc = async (id, data) => { window._saveDocCalls.push({ id, data: JSON.parse(JSON.stringify(data)) }); return true; };
    FirebaseSync.loadPrefix = async () => []; // v48.55: restore อ่าน doc แยก (rec_*) ปัจจุบันก่อน — ชุดนี้ไม่มี
    // seed backup เก่า (dataset B — ต่างจาก A ชัดเจน เพื่อพิสูจน์ no-merge)
    window._fakeBackups['fake_auto_2026-01-01'] = {
      id: 'fake_auto_2026-01-01', type: 'auto', label: '', date: '2026-01-01', ts: Date.now() - 86400000,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      _full: {
        exams: [{ id: 'eB1', title: 'ชุด B1', subject: 'คณิตศาสตร์', questionCount: 1, published: true, order: 1, durationSeconds: 600, examType: 'mc' }],
        questions: { eB1: [{ id: 'q1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } }] },
        attempts: [{ id: 'attB1', examId: 'eB1', takerName: 'z', score: 1, total: 1 }],
        members: [{ pin: '999999', name: 'เด็กเก่า' }],
        assignments: [], benchmarks: [], subjectTopics: {}, subjectSubTopics: {}, gamification: {},
      },
    };
  }, cacheA);

  await page.evaluate(() => navigate('admin_backup', {}));
  await page.waitForTimeout(500);
  await page.click('#backupNowBtn');
  await page.waitForTimeout(400);
  const manualState = await page.evaluate(() => {
    document.getElementById('backupTabManual').click();
    return { count: document.getElementById('backupManualCount').textContent, html: document.getElementById('backupList').innerHTML };
  });
  check('manual backup created with label, appears in manual tab', manualState.count === '1' && manualState.html.includes('ทดสอบ backup'), JSON.stringify(manualState).slice(0, 120));

  await page.evaluate(() => { document.getElementById('backupTabAuto').click(); document.querySelector('[data-restore]').click(); });
  await page.waitForTimeout(500);
  const modal = await page.evaluate(() => ({
    okDisabled: document.getElementById('backupRestoreOk').disabled,
    compare: document.getElementById('backupRestoreCompare').textContent,
  }));
  check('restore modal shows comparison; Ok starts disabled', modal.okDisabled && modal.compare.includes('3 ชุดข้อสอบ') && modal.compare.includes('1 ชุดข้อสอบ'), JSON.stringify(modal).slice(0, 150));

  await page.fill('#backupRestoreConfirmInput', 'กู้คืน');
  await page.dispatchEvent('#backupRestoreConfirmInput', 'input');
  await page.waitForTimeout(150);
  const enabled = await page.evaluate(() => !document.getElementById('backupRestoreOk').disabled);
  check('typing exact phrase enables Ok', enabled === true);

  await page.click('#backupRestoreOk');
  await page.waitForTimeout(400); // อ่าน state ก่อน real reload (800ms) ยิง
  const restored = await page.evaluate(() => ({
    exams: Store._cache.exams.map(e => e.id),
    attempts: Store._cache.attempts.map(a => a.id),
    members: Store._cache.members.map(m => m.name),
    calls: window._saveDocCalls.length,
    lastAttempts: window._saveDocCalls.at(-1)?.data.attempts.map(a => a.id),
  }));
  check('restore = clean overwrite, NO merge (only backup ids remain)',
    JSON.stringify(restored.exams) === '["eB1"]' && JSON.stringify(restored.attempts) === '["attB1"]' && JSON.stringify(restored.members) === '["เด็กเก่า"]',
    JSON.stringify(restored).slice(0, 200));
  check('restore made exactly one awaited saveDoc with clean data', restored.calls === 1 && JSON.stringify(restored.lastAttempts) === '["attB1"]', JSON.stringify(restored).slice(0, 150));
  await ctx.close(); // ปิดก่อน real reload สร้างความปั่นป่วน
}

// ─────────────────────────────────────────────────────────────────
// Section F: Purge checkbox (v47.98) + PDF ไม่ถูกลบโดย default (v47.97)
// ─────────────────────────────────────────────────────────────────
currentSection = 'purge';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [
        mkExam('eA', 'ชุด A', 'ทั่วไป', { pdfUrl: 'https://firebasestorage.googleapis.com/x/a_q.pdf', answerPdfUrl: 'https://firebasestorage.googleapis.com/x/a_a.pdf' }),
        mkExam('eB', 'ชุด B', 'ทั่วไป', { pdfUrl: 'https://firebasestorage.googleapis.com/x/b_q.pdf', answerPdfUrl: 'https://firebasestorage.googleapis.com/x/b_a.pdf' }),
      ],
      questions: { eA: mkQ(), eB: mkQ() },
    }),
  });
  await page.evaluate(() => {
    window._delCalls = [];
    FirebaseSync.deleteStoragePdf = async (url) => { window._delCalls.push(url); };
  });
  await page.evaluate(() => navigate('admin_exams', {}));
  await page.waitForTimeout(500);

  await page.evaluate(() => document.querySelector('[data-del="eA"]').click());
  await page.waitForTimeout(200);
  const defaultUnchecked = await page.evaluate(() => document.getElementById('adminDeleteModalPurge').checked);
  await page.click('#adminDeleteModalOk');
  await page.waitForTimeout(300);
  const afterA = await page.evaluate(() => ({ gone: !Store.load().exams.some(e => e.id === 'eA'), calls: window._delCalls.length }));
  check('delete WITHOUT purge: checkbox defaults off, exam removed, PDFs preserved', defaultUnchecked === false && afterA.gone && afterA.calls === 0, JSON.stringify(afterA));

  await page.evaluate(() => document.querySelector('[data-del="eB"]').click());
  await page.waitForTimeout(200);
  await page.check('#adminDeleteModalPurge');
  await page.click('#adminDeleteModalOk');
  await page.waitForTimeout(300);
  const afterB = await page.evaluate(() => ({ gone: !Store.load().exams.some(e => e.id === 'eB'), calls: window._delCalls.slice() }));
  check('delete WITH purge: both PDFs deleted', afterB.gone && afterB.calls.length === 2 && afterB.calls.some(u => u.includes('b_q')) && afterB.calls.some(u => u.includes('b_a')), JSON.stringify(afterB));

  // editor PDF replace ต้องไม่ลบไฟล์เก่า (v47.97)
  await page.evaluate(() => { Store._cache.exams.push({ id: 'eC', title: 'ชุด C', subject: 'ทั่วไป', questionCount: 1, published: true, order: 9, durationSeconds: 600, examType: 'mc', pdfUrl: 'https://firebasestorage.googleapis.com/x/c_q.pdf' }); Store._cache.questions.eC = [{ id: 'q1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } }]; });
  await page.evaluate(() => navigate('admin_editor', { id: 'eC' }));
  await page.waitForTimeout(500);
  await page.fill('#editorPdfUrl', 'https://firebasestorage.googleapis.com/x/c_new.pdf');
  await page.click('#editorPdfUrlBtn');
  await page.waitForTimeout(300);
  const replaceState = await page.evaluate(() => ({
    url: Store.load().exams.find(e => e.id === 'eC')?.pdfUrl,
    calls: window._delCalls.length,
  }));
  check('editor PDF replace updates url WITHOUT deleting old file', replaceState.url.includes('c_new') && replaceState.calls === 2 /* ยังเท่าเดิมจาก purge B */, JSON.stringify(replaceState));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section G: Loading state (v47.99) — home/exams ต้องแยก "กำลังโหลด" จาก "ข้อมูลหาย"
// หมายเหตุ: มี wait 10.6s หนึ่งครั้งสำหรับ timeout path
// ─────────────────────────────────────────────────────────────────
currentSection = 'loading';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({ exams: [mkExam('eL', 'ชุด L', 'คณิตศาสตร์')], questions: { eL: mkQ() }, members: [{ pin: '111111', name: 'เด็กL' }] }),
  });
  await page.evaluate(() => { Store._cloudLoaded = false; navigate('home', {}); });
  await page.waitForTimeout(300);
  const homeLoading = await page.evaluate(() => document.getElementById('page-home').textContent.includes('กำลังโหลดข้อมูล'));
  await page.evaluate(() => navigate('exams', {}));
  await page.waitForTimeout(300);
  const examsLoading = await page.evaluate(() => document.getElementById('examsList').textContent.includes('กำลังโหลดข้อมูล'));
  check('home+exams show loading placeholder when cloud not loaded', homeLoading && examsLoading);

  await page.evaluate(() => { Store._cloudLoaded = true; navigate('exams', {}); });
  await page.waitForTimeout(400);
  const recovered = await page.evaluate(() => document.getElementById('examsSubjGrid').textContent.includes('คณิตศาสตร์'));
  check('exams renders normally once cloud loads', recovered === true);

  await page.evaluate(() => { Store._cloudLoaded = false; navigate('home', {}); });
  await page.waitForTimeout(10600);
  const timeoutState = await page.evaluate(() => ({
    failText: document.getElementById('page-home').textContent.includes('โหลดข้อมูลไม่สำเร็จ'),
    retryBtn: !!document.querySelector('#page-home button[onclick="retryCloudLoad()"]'),
  }));
  check('after 10s shows fail message + retry button', timeoutState.failText && timeoutState.retryBtn, JSON.stringify(timeoutState));

  await page.evaluate(() => {
    Store.syncFromCloud = async () => { Store._cloudLoaded = true; };
    document.querySelector('#page-home button[onclick="retryCloudLoad()"]').click();
  });
  await page.waitForTimeout(600);
  const afterRetry = await page.evaluate(() => !document.getElementById('page-home').textContent.includes('โหลดข้อมูล'));
  check('retry button recovers to normal render', afterRetry === true);
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section H: Subject filter รอด soft-refresh (v48.0) — จาก verify_v480
// ─────────────────────────────────────────────────────────────────
currentSection = 'subjectFilter';
{
  const { ctx, page } = await newSeededPage({
    role: 'student', name: 'เด็กทดสอบ',
    cache: baseCache({
      exams: [
        mkExam('m1', 'เลข ชุด 1', 'คณิตศาสตร์', { displayOrder: 1 }),
        mkExam('t1', 'ไทย ชุด 1', 'ภาษาไทย', { displayOrder: 2, order: 2 }),
      ],
      questions: { m1: mkQ(), t1: mkQ() },
      members: [{ pin: '111111', name: 'เด็กทดสอบ' }],
    }),
  });
  await page.evaluate(() => { window._softRefreshing = false; window._examsSubjectFilter = undefined; navigate('exams', {}); });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#examsSubjGrid [data-subj="คณิตศาสตร์"]').click());
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    window._softRefreshing = true;
    try { navigate('exams', window._currentParams || {}); } finally { window._softRefreshing = false; }
  });
  await page.waitForTimeout(400);
  const afterSoft = await page.evaluate(() => ({
    inList: document.getElementById('examsList').textContent.includes('เลข ชุด 1'),
    gridEmpty: document.getElementById('examsSubjGrid').textContent.trim() === '',
    backRow: document.getElementById('examsBackToSubj').style.display === 'flex',
  }));
  check('soft-refresh keeps exam-list view (no bounce to grid)', afterSoft.inList && afterSoft.gridEmpty && afterSoft.backRow, JSON.stringify(afterSoft));

  await page.evaluate(() => { navigate('home', {}); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { navigate('exams', {}); });
  await page.waitForTimeout(400);
  const genuine = await page.evaluate(() => ({
    grid: document.getElementById('examsSubjGrid').textContent.includes('คณิตศาสตร์'),
    backRowHidden: document.getElementById('examsBackToSubj').style.display !== 'flex',
    stored: window._examsSubjectFilter,
  }));
  check('genuine re-entry resets to subject grid + clears stored filter', genuine.grid && genuine.backRowHidden && genuine.stored === '', JSON.stringify(genuine));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section I: Scratch pad (v48.3) — desktop mouse drawing + split-view ไม่บังโจทย์
// ─────────────────────────────────────────────────────────────────
currentSection = 'scratchpad';
{
  // Desktop (มีเมาส์ ไม่มี touch) — ปุ่มต้องโผล่ + วาดด้วยเมาส์ค้างลากได้จริง
  const { ctx, page } = await newSeededPage({ cache: baseCache() });
  await page.evaluate(() => window.scratchShow());
  await page.waitForTimeout(100);
  const btnVisible = await page.evaluate(() => document.getElementById('scratchToggleBtn')?.classList.contains('visible'));
  check('desktop (mouse, no touch): scratch toggle button appears', btnVisible === true);

  await page.evaluate(() => document.getElementById('scratchToggleBtn').click());
  await page.waitForTimeout(200);
  const box = await page.locator('#scratchCanvas').boundingBox();
  const blankBefore = await page.locator('#scratchCanvas').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return d.every(v => v === 0);
  });
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 100, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const hasInk = await page.locator('#scratchCanvas').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    return false;
  });
  check('desktop: mouse drag draws ink on scratch canvas', blankBefore && hasInk, JSON.stringify({ blankBefore, hasInk }));
  await ctx.close();
}
{
  // iPad (touch + Apple Pencil) — เปิดปกติ (ไม่เต็มจอ) ต้อง split ไม่บังโจทย์,
  // เต็มจอ (.full) ต้องพฤติกรรมเดิม (ไม่ split)
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.scratchShow());
  await page.waitForTimeout(100);
  const gridBefore = await page.locator('.takeGrid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns);

  await page.evaluate(() => document.getElementById('scratchToggleBtn').click());
  await page.waitForTimeout(200);
  const splitOn = await page.locator('.takeGrid').first().evaluate(el => el.classList.contains('scratchSplit'));
  const gridOpen = await page.locator('.takeGrid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns);
  check('iPad: opening scratch pad ปกติ (ไม่เต็มจอ) หด .takeGrid (PDF ไม่ถูกบัง)', splitOn && gridOpen !== gridBefore, JSON.stringify({ gridBefore, gridOpen }));

  await page.evaluate(() => document.getElementById('scratchExpandBtn').click());
  await page.waitForTimeout(200);
  const splitOffFull = await page.locator('.takeGrid').first().evaluate(el => el.classList.contains('scratchSplit'));
  const gridFull = await page.locator('.takeGrid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns);
  check('iPad: โหมดเต็มจอปิด split (พฤติกรรมเดิม, .takeGrid กลับความกว้างเดิม)', splitOffFull === false && gridFull === gridBefore, JSON.stringify({ gridFull, gridBefore }));
  await ctx.close();
}
{
  // v48.10: ปุ่มดินสอ (PDF-annotate) + ปุ่มกระดาษทด ย้ายมากึ่งกลางฝั่ง PDF (.takeLeft
  // 80vw, จุดกึ่งกลาง 40vw) แทนตำแหน่งเดิมใกล้ขอบขวาที่เคยโดน #scratchPad บังตอนเปิด
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('m1', 'เลข ชุด 1', 'คณิตศาสตร์', { questionCount: 2, pdfUrl: 'https://x/m1.pdf' })],
      questions: { m1: mkQ() },
    }),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => navigate('take', { id: 'm1' }));
  await page.waitForTimeout(500);
  // fabricate the PDF-page/canvas DOM pdfAnnotate's buildOverlaysFor() expects —
  // real PDF.js rendering needs network access this sandbox doesn't have
  await page.evaluate(() => {
    const container = document.getElementById('takePdfViewer');
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.id = 'takePdfViewer-page-1';
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 800;
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    window.pdfAnnotateInit('takePdfViewer');
  });
  await page.waitForTimeout(300);
  const box = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, right: r.right, left: r.left };
  }, sel);
  const pen = await box('#pdfAnnotateToggleBtn');
  const scratch = await box('#scratchToggleBtn');
  check('v48.10: pen + scratch buttons centered over PDF pane (40vw), not overlapping',
    Math.abs(pen.cx - (1280 * 0.4 - 26)) < 5 && Math.abs(scratch.cx - (1280 * 0.4 + 26)) < 5 && pen.right < scratch.left,
    JSON.stringify({ pen, scratch }));

  await page.evaluate(() => document.getElementById('scratchToggleBtn').click());
  await page.waitForTimeout(400);
  const padOpen = await box('#scratchPad');
  const penAfterSplit = await box('#pdfAnnotateToggleBtn');
  check('v48.10: pen button NOT covered by #scratchPad when opened (split mode)',
    penAfterSplit.right < padOpen.left, JSON.stringify({ penAfterSplit, padOpen }));

  // v48.10: :active{transform:scale(0.95)} เดิมทับ translateX(-50%) ที่ใช้จัดกึ่งกลาง
  // ทำให้ปุ่มหลุดตำแหน่งชั่วขณะตอนกดค้าง — ต้องรวม translateX ไว้ใน :active ด้วย
  await page.evaluate(() => document.getElementById('offlineBanner')?.remove());
  const idleCx = (await box('#scratchToggleBtn')).cx;
  const handle = await page.$('#scratchToggleBtn');
  const bb = await handle.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const pressedState = await page.evaluate(() => {
    const el = document.getElementById('scratchToggleBtn');
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, isActive: el.matches(':active') };
  });
  await page.mouse.up();
  check('v48.10: scratch button does not shift while pressed (:active + translateX combined)',
    pressedState.isActive && Math.abs(pressedState.cx - idleCx) < 2, JSON.stringify({ idleCx, pressedState }));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section J: Admin exam list — ดาวน์โหลด Template เฉลยทุกวิชา (v48.4)
// 1 sheet ต่อวิชา, แถวหัวเรื่อง (ชื่อชุด+สถานะอัพโหลด) + grid ข้อ/เฉลย 5 คอลัมน์คู่
// ─────────────────────────────────────────────────────────────────
currentSection = 'answerKeyExport';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [
        mkExam('m1', 'เลข ชุด 1', 'คณิตศาสตร์', { questionCount: 7, pdfUrl: 'https://x/m1.pdf' }),
        mkExam('m2', 'เลข ชุด 2', 'คณิตศาสตร์', { questionCount: 3 }),
        mkExam('t1', 'ไทย ชุด 1', 'ภาษาไทย', { questionCount: 12, pdfUrl: 'https://x/t1.pdf' }),
      ],
      questions: {
        // เฉลยจริงในระบบ — m2 ข้อ 3 ยังไม่มีเฉลย (correct undefined) ทดสอบ fallback ช่องว่าง
        m1: [1, 2, 3, 4, 5, 6, 7].map(no => ({ id: 'm1q' + no, no, correct: ['A', 'B', 'C', 'D'][(no - 1) % 4] })),
        m2: [{ id: 'm2q1', no: 1, correct: 'B' }, { id: 'm2q2', no: 2, correct: 'D' }, { id: 'm2q3', no: 3 }],
      },
    }),
  });
  await page.evaluate(() => navigate('admin_exams', {}));
  await page.waitForTimeout(400);
  // SheetJS โหลดจาก CDN ไม่ได้ในแซนด์บ็อกซ์ (proxy บล็อก, เหมือน Firebase) — stub
  // เฉพาะ API 4 ตัวที่ downloadAllAnswerKeyTemplates() เรียกจริง เพื่อจับ raw AOA rows
  const result = await page.evaluate(() => {
    let captured = null;
    window.XLSX = {
      utils: {
        book_new: () => ({ SheetNames: [], Sheets: {} }),
        aoa_to_sheet: (rows) => ({ __aoa: rows }),
        book_append_sheet: (wb, ws, name) => { wb.SheetNames.push(name); wb.Sheets[name] = ws; },
      },
      writeFile: (wb) => { captured = wb; },
    };
    document.getElementById('adminDownloadAllAnswerKeys').click();
    if (!captured) return null;
    const aoa = captured.Sheets['คณิตศาสตร์'].__aoa;
    return {
      sheetNames: captured.SheetNames.slice().sort(),
      m1: aoa[0], m1Row1: aoa[2], // m1: n=7,R=2 → title row, header row, grid row1
      m2: aoa[5], m2Row1: aoa[7], // m2: n=3,R=1 → title row, header row, grid row1
    };
  });
  check('exports one sheet per subject', result && JSON.stringify(result.sheetNames) === JSON.stringify(['คณิตศาสตร์', 'ภาษาไทย'].sort()), JSON.stringify(result));
  check('exam with pdfUrl shows "อยู่ในระบบแล้ว", title correct', result && result.m1[0] === 'เลข ชุด 1' && result.m1[8] === '✓ อยู่ในระบบแล้ว', JSON.stringify(result));
  check('exam WITHOUT pdfUrl shows "ยังไม่อัพโหลด"', result && result.m2[0] === 'เลข ชุด 2' && result.m2[8] === 'ยังไม่อัพโหลด', JSON.stringify(result));
  check('grid numbering is column-major, truncated at questionCount, ข้อ+เฉลยจริงจากระบบ',
    result && JSON.stringify(result.m1Row1) === JSON.stringify([1, 'A', 3, 'C', 5, 'A', 7, 'C', '', '']) && JSON.stringify(result.m2Row1) === JSON.stringify([1, 'B', 2, 'D', 3, '', '', '', '', '']),
    JSON.stringify(result));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section K: หน้าเลือกข้อสอบ — โฟลเดอร์จัดกลุ่มการ์ดต่อวิชา (v48.6, ported จาก preview)
// ─────────────────────────────────────────────────────────────────
currentSection = 'examFolders';
{
  // วิชาไม่มีโฟลเดอร์เลย -> flat list เหมือนเดิม 100%
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('m1', 'เลข ชุด 1', 'คณิตศาสตร์'), mkExam('m2', 'เลข ชุด 2', 'คณิตศาสตร์')],
      questions: { m1: mkQ(), m2: mkQ() },
    }),
  });
  await page.evaluate(() => navigate('exams', {}));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#examsSubjGrid [data-subj="คณิตศาสตร์"]').click());
  await page.waitForTimeout(400);
  const flatState = await page.evaluate(() => ({
    hasFolderTiles: !!document.querySelector('#examsList [data-folder]'),
    examCards: document.querySelectorAll('#examsList .examCard').length,
  }));
  check('subject with NO folders shows flat exam list (no folder grid)', !flatState.hasFolderTiles && flatState.examCards === 2, JSON.stringify(flatState));
  await ctx.close();
}
{
  // วิชามีโฟลเดอร์ -> folder grid, drill-down, ปุ่มย้อนกลับ 2 ชั้น
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [
        mkExam('s1', 'วิทย์ ชุด 1', 'วิทยาศาสตร์', { folderId: 'fA' }),
        mkExam('s2', 'วิทย์ ชุด 2', 'วิทยาศาสตร์', { folderId: 'fA' }),
        mkExam('s3', 'วิทย์ ชุด 3', 'วิทยาศาสตร์'), // ไม่มี folderId -> ทั่วไป
      ],
      questions: { s1: mkQ(), s2: mkQ(), s3: mkQ() },
      examFolders: [{ id: 'fA', subject: 'วิทยาศาสตร์', name: 'บทที่ 1', order: 1 }],
    }),
  });
  await page.evaluate(() => navigate('exams', {}));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#examsSubjGrid [data-subj="วิทยาศาสตร์"]').click());
  await page.waitForTimeout(400);
  const gridTiles = await page.evaluate(() => document.querySelectorAll('#examsList [data-folder]').length);
  check('subject WITH folders shows folder grid (fA + ทั่วไป = 2 tiles)', gridTiles === 2, 'tiles=' + gridTiles);

  await page.evaluate(() => document.querySelector('#examsList [data-folder="fA"]').click());
  await page.waitForTimeout(300);
  const insideFolder = await page.evaluate(() => [...document.querySelectorAll('#examsList .examCard .title')].map(t => t.textContent));
  check('inside folder fA shows only its 2 exams', insideFolder.length === 2 && insideFolder.includes('วิทย์ ชุด 1') && insideFolder.includes('วิทย์ ชุด 2'), JSON.stringify(insideFolder));

  await page.evaluate(() => document.getElementById('examsBackToSubjBtn').click());
  await page.waitForTimeout(300);
  const backOnce = await page.evaluate(() => document.querySelectorAll('#examsList [data-folder]').length);
  check('back button from inside folder returns to folder grid (not all the way out)', backOnce === 2, 'tiles=' + backOnce);

  await page.evaluate(() => document.getElementById('examsBackToSubjBtn').click());
  await page.waitForTimeout(300);
  const backTwice = await page.evaluate(() => document.querySelectorAll('#examsSubjGrid [data-subj]').length);
  check('back button again from folder grid returns to subject grid', backTwice > 0, 'subjTiles=' + backTwice);
  await ctx.close();
}
{
  // Admin edit mode: สร้างโฟลเดอร์แรกจากปุ่มใน edit bar (bug ที่เจอจริง — ไม่ใช่แค่ tile ใน grid),
  // ย้ายการ์ดผ่าน select, ลบโฟลเดอร์ -> การ์ด fallback กลับ "ทั่วไป"
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('t1', 'ไทย ชุด 1', 'ภาษาไทย')],
      questions: { t1: mkQ() },
    }),
  });
  await page.evaluate(() => navigate('exams', {}));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#examsSubjGrid [data-subj="ภาษาไทย"]').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('examsEditBtn').click());
  await page.waitForTimeout(300);
  const createBtnVisible = await page.evaluate(() => {
    const btn = document.getElementById('examCreateFolderBtn');
    return !!btn && btn.style.display !== 'none';
  });
  check('create-folder button in edit bar visible even when subject has ZERO folders', createBtnVisible === true);

  await page.evaluate(() => { window.prompt = () => 'หน่วยที่ 1'; });
  await page.evaluate(() => document.getElementById('examCreateFolderBtn').click());
  await page.waitForTimeout(300);
  const afterCreate = await page.evaluate(() => ({
    folderCount: (Store._cache.examFolders || []).filter(f => f.subject === 'ภาษาไทย').length,
    nowShowsGrid: !!document.querySelector('#examsList [data-folder]'),
  }));
  check('clicking create-folder button creates the FIRST folder + shows folder grid immediately', afterCreate.folderCount === 1 && afterCreate.nowShowsGrid, JSON.stringify(afterCreate));

  const folderId = await page.evaluate(() => Store._cache.examFolders.find(f => f.subject === 'ภาษาไทย').id);
  await page.evaluate(() => document.querySelector('#examsList [data-folder="none"]').click());
  await page.waitForTimeout(300);
  const moveOk = await page.evaluate((fid) => {
    const sel = document.querySelector('.examFolderMoveSel');
    if (!sel) return false;
    sel.value = fid; sel.dispatchEvent(new Event('change'));
    return true;
  }, folderId);
  await page.waitForTimeout(300);
  const afterMove = await page.evaluate(() => ({
    folderId: (Store._cache.exams || []).find(e => e.id === 't1')?.folderId,
    cardsLeftInUngrouped: document.querySelectorAll('#examsList .examCard').length,
  }));
  check('moving exam via select updates folderId + disappears from current view', moveOk && afterMove.folderId === folderId && afterMove.cardsLeftInUngrouped === 0, JSON.stringify(afterMove));

  await page.evaluate(() => document.getElementById('examsBackToSubjBtn').click());
  await page.waitForTimeout(300);
  await page.evaluate((fid) => {
    window.confirm = () => true;
    document.querySelector(`#examsList [data-delfolder="${fid}"]`).click();
  }, folderId);
  await page.waitForTimeout(300);
  const afterDelete = await page.evaluate((fid) => ({
    folderExists: (Store._cache.examFolders || []).some(f => f.id === fid),
    examFolderId: (Store._cache.exams || []).find(e => e.id === 't1')?.folderId,
  }), folderId);
  check('deleting a folder removes it AND exam falls back to ungrouped (not deleted)', !afterDelete.folderExists && (afterDelete.examFolderId === null || afterDelete.examFolderId === undefined), JSON.stringify(afterDelete));
  await ctx.close();
}
{
  // admin_exams table: คอลัมน์โฟลเดอร์ต่อแถว + filter cascading ตามวิชา
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('m1', 'เลข ชุด 1', 'คณิตศาสตร์', { folderId: 'fM' }), mkExam('m2', 'เลข ชุด 2', 'คณิตศาสตร์')],
      questions: { m1: mkQ(), m2: mkQ() },
      examFolders: [{ id: 'fM', subject: 'คณิตศาสตร์', name: 'บทที่ A', order: 1 }],
    }),
  });
  await page.evaluate(() => navigate('admin_exams', {}));
  await page.waitForTimeout(500);
  const rowSel = await page.evaluate(() => {
    const sel = document.querySelector('[data-folder="m1"]');
    return { exists: !!sel, value: sel?.value };
  });
  check('admin_exams table shows folder select per row, pre-selected correctly', rowSel.exists && rowSel.value === 'fM', JSON.stringify(rowSel));

  await page.evaluate(() => {
    const sel = document.getElementById('adminSubjFilter');
    sel.value = 'คณิตศาสตร์'; sel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  const folderFilterOpts = await page.evaluate(() => [...document.getElementById('adminFolderFilter').options].map(o => o.textContent));
  check('folder filter cascades to show folders of selected subject', folderFilterOpts.includes('บทที่ A'), JSON.stringify(folderFilterOpts));

  await page.evaluate(() => {
    const sel = document.querySelector('[data-folder="m2"]');
    sel.value = 'fM'; sel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  const afterAdminMove = await page.evaluate(() => (Store._cache.exams || []).find(e => e.id === 'm2')?.folderId);
  check('admin_exams: changing folder select updates exam.folderId', afterAdminMove === 'fM', 'folderId=' + afterAdminMove);
  await ctx.close();
}
{
  // admin_new: folder select cascading ตามวิชา + folderId ติดไปกับข้อสอบที่สร้างใหม่
  const { ctx, page } = await newSeededPage({
    cache: baseCache({ examFolders: [{ id: 'fSci', subject: 'วิทยาศาสตร์', name: 'บทที่ 1', order: 1 }] }),
  });
  await page.evaluate(() => navigate('admin_new', {}));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById('newSubjectSelect').value = 'วิทยาศาสตร์';
    window._onNewSubjectChange('วิทยาศาสตร์');
  });
  await page.waitForTimeout(200);
  const folderOpts = await page.evaluate(() => [...document.getElementById('newFolderSelect').options].map(o => o.textContent));
  check('admin_new: folder select populates with folders for chosen subject', folderOpts.includes('บทที่ 1'), JSON.stringify(folderOpts));

  await page.evaluate(() => {
    document.getElementById('newTitle').value = 'วิทย์ ชุดใหม่';
    document.getElementById('newFolderSelect').value = 'fSci';
  });
  await page.evaluate(() => document.getElementById('newCreateBtn').click());
  await page.waitForTimeout(300);
  const created = await page.evaluate(() => (Store._cache.exams || []).find(e => e.title === 'วิทย์ ชุดใหม่'));
  check('creating an exam with a folder selected sets exam.folderId', created && created.folderId === 'fSci', JSON.stringify(created));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section L: หน้ารีวิว — ปุ่ม "คำนวณคะแนนใหม่" (v48.9) กรณีแก้เฉลยผิดหลังทำข้อสอบไปแล้ว
// ─────────────────────────────────────────────────────────────────
currentSection = 'recalcScore';
{
  const cache = baseCache({
    exams: [mkExam('eR1', 'เลข ทดสอบ Recalc', 'คณิตศาสตร์')],
    questions: {
      eR1: [
        { id: 'q1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } }, // เฉลยเดิม (ผิด) — จะแก้เป็น C
        { id: 'q2', no: 2, number: 2, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      ],
    },
    attempts: [{
      id: 'attR1', examId: 'eR1', examTitle: 'เลข ทดสอบ Recalc', examSubject: 'คณิตศาสตร์',
      examType: 'mc', weighted: false, takerName: 'เด็กทดสอบ',
      startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date().toISOString(),
      usedSeconds: 60, score: 2, total: 2,
      answers: { q1: 'A', q2: 'B' },
      perQuestion: [
        { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
        { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
      ],
      practiceMode: false, visitOrder: ['q1', 'q2'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
    }],
  });
  const { ctx, page } = await newSeededPage({ cache });

  // ก่อนแก้เฉลย: ปุ่มคำนวณใหม่ต้องโผล่ (admin/teacher เท่านั้น)
  await page.evaluate(() => navigate('review', { attemptId: 'attR1' }));
  await page.waitForTimeout(400);
  const btnVisibleBefore = await page.evaluate(() => {
    const btn = document.getElementById('reviewRecalcBtn');
    return btn && btn.style.display !== 'none';
  });
  check('recalc button visible for teacher on review page', btnVisibleBefore === true);

  // แก้เฉลย q1 จาก A -> C (จำลองว่า admin ไปแก้ในหน้า editor)
  await page.evaluate(() => {
    const s = Store.load();
    const q1 = s.questions.eR1.find(q => q.id === 'q1');
    q1.correct = 'C';
    Store.save(s);
  });

  // กดคำนวณคะแนนใหม่ (confirm ถูก auto-accept โดย newSeededPage)
  await page.evaluate(() => document.getElementById('reviewRecalcBtn').click());
  await page.waitForTimeout(400);

  const afterRecalc = await page.evaluate(() => {
    const s = Store.load();
    const att = s.attempts.find(a => a.id === 'attR1');
    return {
      score: att.score, total: att.total,
      q1Correct: att.perQuestion.find(p => p.qid === 'q1')?.isCorrect,
      q2Correct: att.perQuestion.find(p => p.qid === 'q2')?.isCorrect,
      q1CorrectAnswer: att.perQuestion.find(p => p.qid === 'q1')?.correct,
    };
  });
  check('recalc updates score (2/2 -> 1/2) after fixing wrong answer key',
    afterRecalc.score === 1 && afterRecalc.total === 2 && afterRecalc.q1Correct === false && afterRecalc.q2Correct === true && afterRecalc.q1CorrectAnswer === 'C',
    JSON.stringify(afterRecalc));

  const weaknessAfter = await page.evaluate(() => WeaknessTracker.countWeaknessesByExam('เด็กทดสอบ', 'eR1'));
  check('recalc rebuilds weakness data — q1 now shows as active weakness', weaknessAfter === 1, 'weaknessCount=' + weaknessAfter);

  await ctx.close();
}
{
  // นักเรียน (ไม่ใช่ครู) ต้องไม่เห็นปุ่มคำนวณคะแนนใหม่ — ดูของตัวเองได้ปกติ แต่แก้คะแนนไม่ได้
  const cache = baseCache({
    exams: [mkExam('eR2', 'เลข ทดสอบ Recalc 2', 'คณิตศาสตร์')],
    questions: { eR2: mkQ() },
    attempts: [{
      id: 'attR2', examId: 'eR2', examTitle: 'เลข ทดสอบ Recalc 2', examSubject: 'คณิตศาสตร์',
      examType: 'mc', weighted: false, takerName: 'เด็กทดสอบ',
      startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date().toISOString(),
      usedSeconds: 60, score: 1, total: 1, answers: { q1: 'A' },
      perQuestion: [{ qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 500, changes: 0 }],
      practiceMode: false, visitOrder: ['q1'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
    }],
  });
  const { ctx, page } = await newSeededPage({ cache, role: 'student', name: 'เด็กทดสอบ' });
  await page.evaluate(() => navigate('review', { attemptId: 'attR2' }));
  await page.waitForTimeout(400);
  const btnHiddenForStudent = await page.evaluate(() => {
    const btn = document.getElementById('reviewRecalcBtn');
    return btn && btn.style.display === 'none';
  });
  check('recalc button hidden for student (own attempt, not a teacher)', btnHiddenForStudent === true);
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section K: โหมด "คนละครึ่ง" (v48.12/48.13) — ครึ่งข้อ/ครึ่งเวลา, ยกเลิกคำตอบได้,
// บล็อกเกินโควตา, จุดอ่อนนับเฉพาะข้อที่ตอบจริง
// ─────────────────────────────────────────────────────────────────
currentSection = 'halfMode';
const mkQN = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'q' + (i + 1), no: i + 1, number: i + 1, correct: ['A', 'B', 'C', 'D'][i % 4], choices: { A: 'a', B: 'b', C: 'c', D: 'd' },
}));
const clickChoiceHalf = (page, lab) => page.evaluate((l) => {
  const btn = [...document.querySelectorAll('#takeChoices .choice')].find(el => el.textContent.trim() === ({ A: 'ก', B: 'ข', C: 'ค', D: 'ง' })[l]);
  if (btn) btn.click();
}, lab);
const gotoQHalf = (page, idx) => page.evaluate((i) => document.querySelectorAll('#takeNums .numBtn')[i].click(), idx);
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eH1', 'ชุด Half', 'คณิตศาสตร์', { questionCount: 40, durationSeconds: 2160 })], // 36 min
      questions: { eH1: mkQN(40) },
    }),
  });
  await page.evaluate(() => navigate('exam', { id: 'eH1' }));
  await page.waitForTimeout(400);
  const btnText = await page.evaluate(() => document.getElementById('examStartHalfBtn')?.textContent);
  check('half button shows correct quota+time (40->20, 36->18)', btnText && btnText.includes('20 ข้อ') && btnText.includes('18 นาที'), btnText);
  await ctx.close();
}
{
  // quota=2 exam: mkQN uses 0-indexed i%4 -> q1 correct=A, q2 correct=B, q3 correct=C, q4 correct=D
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eH2', 'ชุด Half เล็ก', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eH2: mkQN(4) },
    }),
  });
  await page.evaluate(() => navigate('take', { id: 'eH2', takerName: 'เด็กครึ่ง', half: true }));
  await page.waitForTimeout(400);
  const title = await page.evaluate(() => document.getElementById('takeExamTitle').textContent);
  check('half-mode title prefixed with [คนละครึ่ง]', title.startsWith('[คนละครึ่ง]'), title);

  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'A'); // correct
  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'A'); // wrong (correct=B)
  const progText = await page.evaluate(() => document.getElementById('takeQNoWrap').textContent);
  // v48.13: ย่อจาก "ตอบแล้ว N / โควตา ข้อ" เป็น "ตอบ N/โควตา" กันปุ่มส่งเลยขอบจอ iPad
  check('half-mode header shows shortened "ตอบ 2/2" (no แล้ว/ข้อ) after quota met', progText === 'ตอบ 2/2', progText);

  await gotoQHalf(page, 2);
  await clickChoiceHalf(page, 'C'); // correct answer but quota full -> should be blocked
  await page.waitForTimeout(100);
  const q3Blocked = await page.evaluate(() => !document.querySelector('#takeChoices .choice.active'));
  check('quota block: cannot answer 3rd question once quota met', q3Blocked === true, String(q3Blocked));

  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'A'); // deselect by clicking same choice again
  const q2Cleared = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#takeChoices .choice')].find(el => el.textContent.trim() === 'ก');
    return !btn.classList.contains('active');
  });
  check('deselect: clicking same choice again removes the answer', q2Cleared === true, String(q2Cleared));

  await gotoQHalf(page, 2); await clickChoiceHalf(page, 'C'); // now answerable after freeing quota, correct
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForTimeout(400);
  const att = await page.evaluate(() => Store.load().attempts[0]);
  check('half-mode submit: score=2, total=2 (quota, not full 4)', att.score === 2 && att.total === 2, JSON.stringify({ score: att.score, total: att.total }));
  check('half-mode attempt tagged halfMode:true, halfQuota:2', att.halfMode === true && att.halfQuota === 2, JSON.stringify({ halfMode: att.halfMode, halfQuota: att.halfQuota }));
  const pq2 = att.perQuestion.find(p => p.no === 2);
  const pq4 = att.perQuestion.find(p => p.no === 4);
  check('perQuestion: deselected/never-touched questions marked counted:false', pq2.counted === false && pq4.counted === false, JSON.stringify({ pq2, pq4 }));
  check('half-mode forces weighted:false (no points gaming)', att.weighted === false, String(att.weighted));

  const weakCount = await page.evaluate(() => WeaknessTracker.countWeaknessesByExam('เด็กครึ่ง', 'eH2'));
  check('weakness: half-mode skipped questions (counted:false) create NO weakness — both counted answers (q1,q3) were correct', weakCount === 0, String(weakCount));
  await ctx.close();
}
{
  // regression: NORMAL mode unanswered question must STILL count as a weakness (guard is half-mode-only)
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eH3', 'ชุด ปกติ', 'คณิตศาสตร์', { questionCount: 2 })],
      questions: { eH3: mkQN(2) },
    }),
  });
  await page.evaluate(() => navigate('take', { id: 'eH3', takerName: 'เด็กปกติ' }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'A'); // answer q1 correctly, leave q2 unanswered
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForTimeout(400);
  const weakCountNormal = await page.evaluate(() => WeaknessTracker.countWeaknessesByExam('เด็กปกติ', 'eH3'));
  check('regression: NORMAL mode unanswered question STILL counts as weakness', weakCountNormal === 1, String(weakCountNormal));
  await ctx.close();
}
{
  // resume: entering a DIFFERENT mode than the in-progress one must NOT silently resume
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eH4', 'ชุด Resume', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eH4: mkQN(4) },
    }),
  });
  await page.evaluate(() => navigate('take', { id: 'eH4', takerName: 'เด็กresume', half: true }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'B');
  await page.waitForTimeout(1200); // let saveTakeResume's 1s throttle flush
  await page.evaluate(() => navigate('exams', {}));
  await page.waitForTimeout(200);
  await page.evaluate(() => navigate('take', { id: 'eH4', takerName: 'เด็กresume' })); // timed mode this time
  await page.waitForTimeout(300);
  const mismatchShown = await page.evaluate(() => !!document.querySelector('.modal, [style*="position:fixed"]') || true); // confirm() intercepted by page.on('dialog')
  const resumedAnswers = await page.evaluate(() => window._takeState ? Object.keys(window._takeState.answers || {}).length : -1);
  check('resume: entering DIFFERENT mode does not silently carry over half-mode answers', resumedAnswers !== 1, String(resumedAnswers));
  await ctx.close();
}
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eH5', 'ชุด Stats', 'คณิตศาสตร์', { questionCount: 2 })],
      questions: { eH5: mkQN(2) },
      attempts: [{
        id: 'attH5', examId: 'eH5', examTitle: 'ชุด Stats', examSubject: 'คณิตศาสตร์', examType: 'mc', weighted: false,
        takerName: 'Admin', startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(),
        usedSeconds: 60, score: 1, total: 1, answers: { q1: 'B' }, halfMode: true, halfQuota: 1,
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 100, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: null, correct: 'C', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
        ],
        practiceMode: false, visitOrder: ['q1'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await page.evaluate(() => navigate('stats', {}));
  await page.waitForTimeout(400);
  const tabExists = await page.evaluate(() => !!document.querySelector('[data-tab="half"]'));
  check('stats: "คนละครึ่ง" tab exists', tabExists === true, String(tabExists));
  const realTabCount = await page.evaluate(() => {
    const btn = document.querySelector('[data-tab="real"]');
    return btn ? btn.textContent : '';
  });
  check('stats: half-mode attempt NOT counted in "จริง" tab', !/[1-9]/.test(realTabCount.replace(/[^\d]/g, '')) || realTabCount === '⏱ จริง', realTabCount);

  await page.evaluate(() => navigate('review', { attemptId: 'attH5' }));
  await page.waitForTimeout(400);
  const reviewInfo = await page.evaluate(() => {
    const title = document.getElementById('reviewTitle').textContent;
    const wrongList = document.getElementById('reviewWrongListText')?.textContent || '';
    return { title, wrongList };
  });
  check('review: title shows คนละครึ่ง mode badge', reviewInfo.title.includes('คนละครึ่ง'), reviewInfo.title);
  check('review: skipped question (counted:false) does NOT appear in "ผิดข้อ:" list', !reviewInfo.wrongList.includes('2'), reviewInfo.wrongList);
  await ctx.close();
}
{
  // v48.13: ปุ่ม "ส่ง" เลยขอบจอ iPad เฉพาะโหมดคนละครึ่ง — ข้อความ "ตอบแล้ว N/โควตา ข้อ"
  // ยาวกว่า "ข้อ X/Y" เดิม จนดันคอลัมน์ฝั่งขวากว้างเกิน 20vw (grid item min-width:auto)
  const IPAD = { width: 1024, height: 768 };
  const submitBtnBox = (page) => page.evaluate(() => {
    const el = document.getElementById('takeSubmitBtn');
    const r = el.getBoundingClientRect();
    return { right: r.right, viewportW: window.innerWidth, visible: r.width > 0 && r.right <= window.innerWidth };
  });
  const qNoWrapInfo = (page) => page.evaluate(() => {
    const el = document.getElementById('takeQNoWrap');
    return { text: el.textContent, parentStyle: el.parentElement.getAttribute('style') || '' };
  });

  const ctxIpad = await browser.newContext({ viewport: IPAD });
  const pageH = await ctxIpad.newPage();
  pageH.on('dialog', d => d.accept());
  await pageH.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await pageH.waitForTimeout(800);
  await pageH.evaluate((cache) => {
    sessionStorage.setItem('appSession', JSON.stringify({ role: 'teacher', name: 'Admin', ts: Date.now() }));
    Store._cloudLoaded = true;
    Store._cache = cache;
    document.getElementById('offlineBanner')?.remove();
  }, baseCache({
    exams: [mkExam('eIpad', 'ชุด iPad', 'คณิตศาสตร์', { questionCount: 25, durationSeconds: 1200 })],
    questions: { eIpad: mkQN(25) },
  }));
  await pageH.evaluate(() => navigate('take', { id: 'eIpad', takerName: 'เด็กipad', half: true }));
  await pageH.waitForTimeout(500);
  let boxH = await submitBtnBox(pageH);
  check('iPad overflow fix: half-mode submit button fully visible on-screen', boxH.visible, JSON.stringify(boxH));
  let infoH = await qNoWrapInfo(pageH);
  check('iPad overflow fix: half-mode div gets min-width:0/flex:1/overflow:hidden safety style', infoH.parentStyle.includes('min-width') && infoH.parentStyle.includes('flex'), infoH.parentStyle);
  await ctxIpad.close();

  // regression: timed mode at the SAME iPad width must be completely untouched
  const ctxIpadNormal = await browser.newContext({ viewport: IPAD });
  const pageN = await ctxIpadNormal.newPage();
  pageN.on('dialog', d => d.accept());
  await pageN.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await pageN.waitForTimeout(800);
  await pageN.evaluate((cache) => {
    sessionStorage.setItem('appSession', JSON.stringify({ role: 'teacher', name: 'Admin', ts: Date.now() }));
    Store._cloudLoaded = true;
    Store._cache = cache;
    document.getElementById('offlineBanner')?.remove();
  }, baseCache({
    exams: [mkExam('eIpadN', 'ชุด iPad ปกติ', 'คณิตศาสตร์', { questionCount: 40 })],
    questions: { eIpadN: mkQN(40) },
  }));
  await pageN.evaluate(() => navigate('take', { id: 'eIpadN', takerName: 'เด็กปกติ' }));
  await pageN.waitForTimeout(500);
  const boxN = await submitBtnBox(pageN);
  check('iPad overflow fix regression: timed mode submit button visible (baseline unaffected)', boxN.visible, JSON.stringify(boxN));
  const infoN = await qNoWrapInfo(pageN);
  check('iPad overflow fix regression: timed mode shows "ข้อ X / Y" unchanged, no inline style', infoN.text.trim() === 'ข้อ 1 / 40' && infoN.parentStyle === '', JSON.stringify(infoN));
  await ctxIpadNormal.close();
}

// ─────────────────────────────────────────────────────────────────
// Section L: โหมด "คนละครึ่ง" เฟส 2 (v48.15-v48.22, port จาก index_preview.html) —
// ทำครึ่งหลังต่อ, รวมเป็น attempt เดียวจริงตอนส่ง (ไม่สร้าง record คู่กันแบบเดิมอีกต่อไป),
// จุดอ่อนไม่นับซ้ำ, findPendingHalf2 ไม่เสนอทำต่อซ้ำถ้าส่งไปแล้ว, fallback ถ้าหาครึ่งแรกไม่เจอ,
// คำนวณคะแนนใหม่รองรับ half-mode
// ─────────────────────────────────────────────────────────────────
currentSection = 'halfMode2Merge';
async function stubMemeScore(page) {
  // MemeScore.show() เล่นแอนิเมชันที่รอโหลด CDN asset ซึ่งถูก sandbox บล็อกเสมอ — ถ้าไม่ stub
  // callback onClose (ที่ทำ navigate ไปหน้ารีวิว) จะไม่ถูกเรียกเลย ทดสอบต่อไม่ได้
  await page.evaluate(() => { MemeScore.show = (score, total, onClose) => { if (onClose) onClose(); }; });
}
{
  // ทำครึ่งแรกจริงผ่าน UI (q1 ผิด, q2 ถูก) แล้วกด "ทำครึ่งหลังต่อ" จริงจากหน้ารีวิว
  // ทำครึ่งหลัง (q3 ผิด, q4 ถูก) แล้วส่ง — ต้องรวมเป็น attempt เดียวจริง
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHM1', 'ชุด Merge', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHM1: mkQN(4) }, // correct: q1=A,q2=B,q3=C,q4=D
    }),
  });
  await stubMemeScore(page);
  await page.evaluate(() => navigate('take', { id: 'eHM1', takerName: 'เด็กmerge', half: true }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'B'); // q1 wrong (correct A)
  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'B'); // q2 right (correct B)
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForFunction(() => window._currentPage === 'review', {}, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  const weakAfterHalf1 = await page.evaluate(() => WeaknessTracker.countWeaknessesByExam('เด็กmerge', 'eHM1'));
  check('จุดอ่อนหลังครึ่งแรก: นับ 1 ข้อ (q1 ผิด)', weakAfterHalf1 === 1, String(weakAfterHalf1));

  const att1Id = await page.evaluate(() => Store.load().attempts[0].id);
  await stubMemeScore(page); // initReview เพิ่ง re-render — override ใหม่กันโดนโหลดทับ
  await page.evaluate(() => document.getElementById('reviewHalf2Btn').click());
  await page.waitForFunction(() => window._currentPage === 'take', {}, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const half2Nums = await page.evaluate(() => [...document.querySelectorAll('#takeNums .numBtn')].map(b => b.textContent.trim()));
  check('ครึ่งหลังมีแค่ 2 ข้อที่เหลือ (3,4)', half2Nums.length === 2 && half2Nums.includes('3') && half2Nums.includes('4'), JSON.stringify(half2Nums));

  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'D'); // q3 wrong (correct C)
  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'D'); // q4 right (correct D)
  await page.waitForTimeout(200);
  await stubMemeScore(page);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForTimeout(500);

  const cacheAfter = await page.evaluate(() => Store._cache);
  check('รวมเป็น attempt เดียวจริงหลังส่งครึ่งหลัง (ไม่ใช่ 2 record)', cacheAfter.attempts.length === 1, JSON.stringify(cacheAfter.attempts.map(a => a.id)));
  const merged = cacheAfter.attempts[0];
  check('merge: id เดิมของครึ่งแรก, score=2/total=4 (halfQuota รวม), ไม่มี halfPart/parentAttemptId', merged.id === att1Id && merged.score === 2 && merged.total === 4 && merged.halfQuota === 4 && !merged.halfPart && !merged.parentAttemptId, JSON.stringify(merged));
  check('merge: มี half2SubmittedAt marker', !!merged.half2SubmittedAt, String(merged.half2SubmittedAt));
  check('merge: ทุกข้อ counted:true (ตอบครบแล้ว)', merged.perQuestion.every(p => p.counted === true), JSON.stringify(merged.perQuestion.map(p => p.counted)));

  const weakAfterHalf2 = await page.evaluate(() => WeaknessTracker.countWeaknessesByExam('เด็กmerge', 'eHM1'));
  check('จุดอ่อนหลังครึ่งหลัง: รวม 2 ข้อพอดี (q1,q3 ผิด) ไม่ใช่ 3 (ไม่นับ q1 ซ้ำ)', weakAfterHalf2 === 2, String(weakAfterHalf2));

  const pending = await page.evaluate(() => findPendingHalf2(Store.load(), 'eHM1', 'เด็กmerge'));
  check('findPendingHalf2 คืน null หลังทำครบแล้ว (ไม่เสนอทำต่อซ้ำ)', pending === null, JSON.stringify(pending));
  await ctx.close();
}
{
  // ตอบครึ่งหลังไม่ครบทุกข้อแล้วส่ง — findPendingHalf2 ต้องคืน null (marker เช็คตรงๆ ไม่ใช่
  // นับจำนวนข้อเหลือ ซึ่งจะยังไม่ใช่ 0 ในเคสนี้)
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHM2', 'ชุด Merge Incomplete', 'คณิตศาสตร์', { questionCount: 6 })],
      questions: { eHM2: mkQN(6) },
      attempts: [{
        id: 'attHM2', examId: 'eHM2', examTitle: 'ชุด Merge Incomplete', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'เด็กincomplete', halfMode: true, halfQuota: 3,
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date(Date.now() - 30000).toISOString(),
        usedSeconds: 30, score: 3, total: 3, answers: { q1: 'A', q2: 'B', q3: 'C' },
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q3', no: 3, chosen: 'C', correct: 'C', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q4', no: 4, chosen: null, correct: 'D', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
          { qid: 'q5', no: 5, chosen: null, correct: 'A', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
          { qid: 'q6', no: 6, chosen: null, correct: 'B', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
        ],
        practiceMode: false, visitOrder: ['q1', 'q2', 'q3'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await stubMemeScore(page);
  await page.evaluate(() => navigate('take', { id: 'eHM2', takerName: 'เด็กincomplete', half2: true, qids: ['q4', 'q5', 'q6'], parentAttemptId: 'attHM2' }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'D'); // ตอบแค่ q4 ข้อเดียว ทิ้ง q5,q6 ไว้
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForTimeout(500);
  const mergedIncomplete = await page.evaluate(() => Store.load().attempts.find(a => a.id === 'attHM2'));
  check('merge สำเร็จแม้ตอบครึ่งหลังไม่ครบ (มี half2SubmittedAt)', !!mergedIncomplete.half2SubmittedAt, String(mergedIncomplete.half2SubmittedAt));
  const pendingIncomplete = await page.evaluate(() => findPendingHalf2(Store.load(), 'eHM2', 'เด็กincomplete'));
  check('findPendingHalf2 คืน null แม้ยังมีข้อเหลือ (ส่งไปแล้วจริง ไม่ควรเสนอทำต่อซ้ำ)', pendingIncomplete === null, JSON.stringify(pendingIncomplete));
  await ctx.close();
}
{
  // Fallback: parentAttemptId ชี้ไปหา attempt ที่ไม่มีจริง (โดนลบไปก่อนหน้า) — ต้องบันทึกเป็น
  // record แยกเหมือนพฤติกรรมเดิม ไม่ error ไม่ทำคำตอบหาย
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHM3', 'ชุด Merge Fallback', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHM3: mkQN(4) },
    }),
  });
  await stubMemeScore(page);
  await page.evaluate(() => navigate('take', { id: 'eHM3', takerName: 'เด็กfallback', half2: true, qids: ['q3', 'q4'], parentAttemptId: 'DELETED_NOT_REAL' }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'C');
  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'D');
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForTimeout(500);
  const cacheFallback = await page.evaluate(() => Store._cache);
  check('fallback: parent ไม่เจอ -> บันทึกเป็น record แยก ไม่ทำคำตอบหาย', cacheFallback.attempts.length === 1 && cacheFallback.attempts[0].halfPart === 2 && cacheFallback.attempts[0].parentAttemptId === 'DELETED_NOT_REAL', JSON.stringify(cacheFallback.attempts[0]));
  await ctx.close();
}
{
  // ปุ่ม "คำนวณคะแนนใหม่" ต้องรองรับ attempt โหมดคนละครึ่งที่ merge แล้ว (total=halfQuota,
  // ไม่ใช่จำนวนข้อเต็มชุด) — ก่อนพอร์ตรอบนี้ production คำนวณผิดเพราะไม่รู้จัก halfMode เลย
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHM4', 'ชุด Recalc Half', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHM4: mkQN(4) }, // correct: q1=A,q2=B,q3=C,q4=D
      attempts: [{
        id: 'attHM4', examId: 'eHM4', examTitle: 'ชุด Recalc Half', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'เด็กrecalc', halfMode: true, halfQuota: 4,
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date().toISOString(),
        usedSeconds: 60, score: 4, total: 4, answers: { q1: 'A', q2: 'B', q3: 'C', q4: 'D' },
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q3', no: 3, chosen: 'C', correct: 'C', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q4', no: 4, chosen: 'D', correct: 'D', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
        ],
        practiceMode: false, visitOrder: ['q1', 'q2', 'q3', 'q4'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await page.evaluate(() => navigate('review', { attemptId: 'attHM4' }));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const s = Store.load();
    s.questions.eHM4.find(q => q.id === 'q1').correct = 'B'; // แก้เฉลย q1 จาก A เป็น B (ตอนนี้ตอบผิด)
    Store.save(s);
  });
  await page.evaluate(() => document.getElementById('reviewRecalcBtn').click());
  await page.waitForTimeout(400);
  const afterRecalc = await page.evaluate(() => Store.load().attempts.find(a => a.id === 'attHM4'));
  check('recalc รองรับ half-mode: total ยังเท่ากับ halfQuota เดิม (4) ไม่ใช่คำนวณผิด', afterRecalc.total === 4, String(afterRecalc.total));
  check('recalc รองรับ half-mode: score ลดเป็น 3/4 ถูกต้อง (q1 กลายเป็นผิดหลังแก้เฉลย)', afterRecalc.score === 3, String(afterRecalc.score));
  await ctx.close();
}
{
  // v48.15 port: cap halfQuota รวมที่จำนวนข้อจริงของชุด — ถ้าครึ่งแรกถูกส่งทั้งที่ตอบไม่ครบ
  // โควตาตัวเอง (เช่น timeout auto-submit) ข้อที่เหลือทั้งหมดจะกลายเป็นโควตาของครึ่งหลัง
  // รวมกันเกินจำนวนข้อทั้งชุดได้ถ้าไม่ cap
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHMQ', 'ชุด Quota Cap', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHMQ: mkQN(4) }, // correct: q1=A,q2=B,q3=C,q4=D
      attempts: [{
        id: 'attHMQ', examId: 'eHMQ', examTitle: 'ชุด Quota Cap', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'เด็กquota', halfMode: true, halfQuota: 2,
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date(Date.now() - 30000).toISOString(),
        usedSeconds: 20, score: 1, total: 1, answers: { q1: 'A' },
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: null, correct: 'B', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
          { qid: 'q3', no: 3, chosen: null, correct: 'C', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
          { qid: 'q4', no: 4, chosen: null, correct: 'D', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
        ],
        practiceMode: false, visitOrder: ['q1'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await stubMemeScore(page);
  await page.evaluate(() => navigate('take', { id: 'eHMQ', takerName: 'เด็กquota', half2: true, qids: ['q2', 'q3', 'q4'], parentAttemptId: 'attHMQ' }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'B'); // q2 correct
  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'C'); // q3 correct
  await gotoQHalf(page, 2); await clickChoiceHalf(page, 'D'); // q4 correct
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForFunction(() => window._currentPage === 'review', {}, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const mergedQuota = await page.evaluate(() => Store.load().attempts.find(a => a.id === 'attHMQ'));
  check('quota cap: halfQuota รวม (2+3=5) ถูก cap ที่จำนวนข้อจริง (4) ไม่ใช่ 5', mergedQuota.halfQuota === 4, String(mergedQuota.halfQuota));
  check('quota cap: total สอดคล้องกับ halfQuota ที่ cap แล้ว', mergedQuota.total === 4, String(mergedQuota.total));
  check('quota cap: score ถูกต้อง 4/4 (ทุกข้อตอบถูก)', mergedQuota.score === 4, String(mergedQuota.score));
  await ctx.close();
}
{
  // v48.15 port: unsure/elapsedMs ของครึ่งหลังต้องไม่หายหลัง merge — เดิมส่ง _parent.perQuestion
  // เก่าเป็น oldPerQuestion เพียงอย่างเดียว ทำให้ค่าจากครึ่งหลังที่เพิ่งตอบถูกทับด้วยค่าเก่า
  // (unsure:false) ของครึ่งแรกที่ยังไม่เคยแตะข้อพวกนี้เลย
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHMU', 'ชุด Metadata', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHMU: mkQN(4) },
      attempts: [{
        id: 'attHMU', examId: 'eHMU', examTitle: 'ชุด Metadata', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'เด็กmeta', halfMode: true, halfQuota: 2,
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date(Date.now() - 30000).toISOString(),
        usedSeconds: 20, score: 2, total: 2, answers: { q1: 'A', q2: 'B' },
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q3', no: 3, chosen: null, correct: 'C', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
          { qid: 'q4', no: 4, chosen: null, correct: 'D', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
        ],
        practiceMode: false, visitOrder: ['q1', 'q2'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await stubMemeScore(page);
  await page.evaluate(() => navigate('take', { id: 'eHMU', takerName: 'เด็กmeta', half2: true, qids: ['q3', 'q4'], parentAttemptId: 'attHMU' }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0);
  await page.evaluate(() => document.getElementById('takeUnsureBtn').click()); // มาร์ค "ไม่แน่ใจ" ที่ q3
  await clickChoiceHalf(page, 'C'); // q3 correct
  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'D'); // q4 correct
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForFunction(() => window._currentPage === 'review', {}, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const mergedMeta = await page.evaluate(() => Store.load().attempts.find(a => a.id === 'attHMU'));
  const q3pq = mergedMeta.perQuestion.find(p => p.qid === 'q3');
  check('metadata preservation: unsure ของ q3 (มาร์คไว้ตอนครึ่งหลัง) ไม่หายหลัง merge', q3pq && q3pq.unsure === true, JSON.stringify(q3pq));
  await ctx.close();
}
{
  // v48.15 port: ส่งครึ่งหลังไม่ครบทุกข้อ (ไม่ตอบข้อสุดท้าย) — เฉลยของข้อที่เหลือต้องไม่ถูกล็อก
  // ค้างถาวร (เดิมเช็ค !att.revealedAt ตรงๆ ซึ่งไม่มีทางเป็น true ได้อีกเลยหลัง half2SubmittedAt
  // ถูกตั้ง เพราะปุ่ม "ขอดูเฉลยเลย" หายไปแล้ว) — submit ด้วย role teacher ก่อน (ข้าม popup
  // ความรู้สึก/ทายคะแนนของ student ตอน submit) แล้วเปิด context ใหม่ role student เพื่อเช็ค UI จริง
  const examId = 'eHML';
  const cache = baseCache({
    exams: [mkExam(examId, 'ชุด Lockout', 'คณิตศาสตร์', { questionCount: 4 })],
    questions: { [examId]: mkQN(4) },
    attempts: [{
      id: 'attHML', examId, examTitle: 'ชุด Lockout', examSubject: 'คณิตศาสตร์',
      examType: 'mc', weighted: false, takerName: 'เด็กlock', halfMode: true, halfQuota: 2,
      startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date(Date.now() - 30000).toISOString(),
      usedSeconds: 20, score: 2, total: 2, answers: { q1: 'A', q2: 'B' },
      perQuestion: [
        { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
        { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
        { qid: 'q3', no: 3, chosen: null, correct: 'C', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
        { qid: 'q4', no: 4, chosen: null, correct: 'D', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
      ],
      practiceMode: false, visitOrder: ['q1', 'q2'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
    }],
  });
  const { ctx, page } = await newSeededPage({ cache }); // role teacher (default) — ข้าม postCheckIn popup
  await stubMemeScore(page);
  await page.evaluate((id) => navigate('take', { id, takerName: 'เด็กlock', half2: true, qids: ['q3', 'q4'], parentAttemptId: 'attHML' }), examId);
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'C'); // ตอบแค่ q3 ทิ้ง q4 ไว้ไม่ตอบ
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForTimeout(500);
  const finalCacheHML = await page.evaluate(() => Store._cache);
  await ctx.close();

  const { ctx: ctx2, page: page2 } = await newSeededPage({ role: 'student', name: 'เด็กlock', cache: finalCacheHML });
  await page2.evaluate(() => navigate('review', { attemptId: 'attHML' }));
  await page2.waitForTimeout(400);
  const q4Locked = await page2.evaluate(() => (document.getElementById('rq-4')?.textContent || '').includes('🔒'));
  check('lockout fix: ข้อที่ยังไม่ได้ตอบ (q4) ไม่ถูกล็อกเฉลยค้างหลังส่งครึ่งหลังไม่ครบ', !q4Locked, String(q4Locked));
  await ctx2.close();
}
{
  // v48.15 port: idempotent retry — Store.save ล้มเหลวรอบแรก (เช่น เน็ตหลุด) แล้วผู้ใช้กดส่งซ้ำ
  // ต้องไม่บวกทบ halfQuota/usedSeconds ซ้ำสอง (Store.load() คืน _cache ตัวจริง ทำให้ merge
  // mutate ไปแล้วก่อน save จะสำเร็จด้วยซ้ำ)
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHMR', 'ชุด Merge Retry', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHMR: mkQN(4) },
      attempts: [{
        id: 'attHMR', examId: 'eHMR', examTitle: 'ชุด Merge Retry', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'เด็กretry', halfMode: true, halfQuota: 2,
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date(Date.now() - 30000).toISOString(),
        usedSeconds: 30, score: 2, total: 2, answers: { q1: 'A', q2: 'B' },
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q3', no: 3, chosen: null, correct: 'C', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
          { qid: 'q4', no: 4, chosen: null, correct: 'D', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
        ],
        practiceMode: false, visitOrder: ['q1', 'q2'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await stubMemeScore(page);
  await page.evaluate(() => {
    window.__saveFailOnce = true;
    const _orig = Store.save.bind(Store);
    Store.save = (s) => {
      if (window.__saveFailOnce) { window.__saveFailOnce = false; return false; }
      return _orig(s);
    };
  });
  await page.evaluate(() => navigate('take', { id: 'eHMR', takerName: 'เด็กretry', half2: true, qids: ['q3', 'q4'], parentAttemptId: 'attHMR' }));
  await page.waitForTimeout(400);
  await gotoQHalf(page, 0); await clickChoiceHalf(page, 'C');
  await gotoQHalf(page, 1); await clickChoiceHalf(page, 'D');
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForTimeout(400);
  const stillOnTake = await page.evaluate(() => window._currentPage === 'take');
  check('save ล้มเหลวรอบแรก: ยังอยู่หน้า take ไม่ navigate ไปรีวิว', stillOnTake, String(stillOnTake));
  const usedSecondsAfterFail = await page.evaluate(() => Store._cache.attempts.find(a => a.id === 'attHMR').usedSeconds);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click()); // retry
  await page.waitForFunction(() => window._currentPage === 'review', {}, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const mergedRetry = await page.evaluate(() => Store.load().attempts.find(a => a.id === 'attHMR'));
  check('retry หลัง save ล้มเหลว: halfQuota ไม่บวกทบซ้ำ (cap ที่ 4 ไม่ใช่ 6)', mergedRetry.halfQuota === 4, String(mergedRetry.halfQuota));
  check('retry หลัง save ล้มเหลว: usedSeconds ไม่บวกทบซ้ำ (เท่าค่าหลัง fail รอบแรก)', mergedRetry.usedSeconds === usedSecondsAfterFail, `${usedSecondsAfterFail} -> ${mergedRetry.usedSeconds}`);
  await ctx.close();
}
{
  // v48.15 port: ครูเปิดรีวิวของนักเรียนที่ยังมี "ครึ่งหลัง" ค้างอยู่ แล้วกดปุ่ม "ทำครึ่งหลังต่อ"
  // ต้องเจอ confirm เตือนก่อนเสมอ (ปุ่มยังคลิกได้ตามที่ผู้ใช้เลือก ไม่ซ่อนปุ่ม) — กด cancel
  // ต้องไม่ navigate ไปหน้า take, กด confirm ต้อง navigate ไปได้ตามปกติ
  const { ctx, page } = await newSeededPage({
    role: 'teacher', name: 'ครู',
    cache: baseCache({
      exams: [mkExam('eHMT', 'ชุด Guard', 'คณิตศาสตร์', { questionCount: 2 })],
      questions: { eHMT: mkQN(2) }, // correct: q1=A,q2=B
      attempts: [{
        id: 'attHMT', examId: 'eHMT', examTitle: 'ชุด Guard', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'นักเรียนคนนี้', halfMode: true, halfQuota: 1,
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date(Date.now() - 30000).toISOString(),
        usedSeconds: 10, score: 1, total: 1, answers: { q1: 'A' },
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: null, correct: 'B', isCorrect: false, isFree: false, unsure: false, visited: false, elapsedMs: 0, changes: 0, counted: false },
        ],
        practiceMode: false, visitOrder: ['q1'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await page.evaluate(() => navigate('review', { attemptId: 'attHMT' }));
  await page.waitForTimeout(300);
  let dialogMsg = null;
  page.removeAllListeners('dialog');
  page.on('dialog', d => { dialogMsg = d.message(); d.dismiss(); });
  await page.evaluate(() => document.getElementById('reviewHalf2Btn').click());
  await page.waitForTimeout(300);
  check('teacher guard: กดปุ่ม "ทำครึ่งหลังต่อ" เจอ confirm เตือนก่อนเสมอ', !!dialogMsg && dialogMsg.includes('ครึ่งหลัง'), String(dialogMsg));
  const stillReview = await page.evaluate(() => window._currentPage === 'review');
  check('teacher guard: กด cancel dialog ไม่ navigate ไปหน้า take', stillReview, String(stillReview));

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());
  await page.evaluate(() => document.getElementById('reviewHalf2Btn').click());
  await page.waitForFunction(() => window._currentPage === 'take', {}, { timeout: 5000 }).catch(() => {});
  const nowTake = await page.evaluate(() => window._currentPage);
  check('teacher guard: กด confirm แล้ว navigate ไปหน้า take ได้ตามปกติ', nowTake === 'take', String(nowTake));
  await ctx.close();
}
{
  // v48.15 port: recalc guard — ครูลบชุดคำถามเดิมแล้วสร้าง/import ใหม่ทั้งชุด (q.id เปลี่ยนหมด
  // ไม่ตรงกับ perQuestion เดิมของ attempt เลย) กด "คำนวณคะแนนใหม่" ต้องไม่ลบ perQuestion/score
  // เดิมทิ้งทั้งหมดเงียบๆ (เดิมจะได้ score 0 ทับของเก่าเพราะ qs2 กรองเหลือ [])
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('eHMG', 'ชุด Recalc Guard', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHMG: mkQN(4) },
      attempts: [{
        id: 'attHMG', examId: 'eHMG', examTitle: 'ชุด Recalc Guard', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'เด็กguard', halfMode: true, halfQuota: 4,
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date().toISOString(),
        usedSeconds: 60, score: 4, total: 4, answers: { q1: 'A', q2: 'B', q3: 'C', q4: 'D' },
        perQuestion: [
          { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q3', no: 3, chosen: 'C', correct: 'C', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          { qid: 'q4', no: 4, chosen: 'D', correct: 'D', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
        ],
        practiceMode: false, visitOrder: ['q1', 'q2', 'q3', 'q4'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await page.evaluate(() => navigate('review', { attemptId: 'attHMG' }));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const s = Store.load();
    // จำลองครูลบชุดคำถามเดิมแล้วสร้างใหม่ทั้งหมด — q.id เปลี่ยนไปหมด ไม่ตรงกับ perQuestion เดิมเลย
    s.questions.eHMG = [
      { id: 'newq1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'newq2', no: 2, number: 2, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'newq3', no: 3, number: 3, correct: 'C', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'newq4', no: 4, number: 4, correct: 'D', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
    ];
    Store.save(s);
  });
  await page.evaluate(() => document.getElementById('reviewRecalcBtn').click());
  await page.waitForTimeout(400);
  const afterGuard = await page.evaluate(() => Store.load().attempts.find(a => a.id === 'attHMG'));
  const toastTextGuard = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
  check('recalc guard: toast เตือนว่าคำนวณใหม่ไม่ได้ (qid ไม่ตรงกับชุดคำถามปัจจุบันทั้งหมด)', toastTextGuard.includes('คำนวณคะแนนใหม่ไม่ได้'), toastTextGuard);
  check('recalc guard: perQuestion เดิมไม่ถูกลบทิ้ง (ยังมีครบ 4 ข้อ)', Array.isArray(afterGuard.perQuestion) && afterGuard.perQuestion.length === 4, String(afterGuard.perQuestion?.length));
  check('recalc guard: score เดิมไม่ถูกรีเซ็ตเป็น 0', afterGuard.score === 4, String(afterGuard.score));
  await ctx.close();
}
{
  // v48.15 port (fix 8 regression): legacy paired record (2 attempt แยกกัน ผูกด้วย
  // parentAttemptId แบบเก่า) ต้องยังรวมเป็นการ์ดเดียวในแท็บ "คนละครึ่ง" ของหน้าสถิติ แม้เอา
  // mergeHalfModePairs ที่เรียกซ้ำ (ตอนสร้าง halfList) ออกไปแล้ว — เพราะ attempts ต้นทางถูก
  // merge ไปแล้วผ่าน timeFiltered ตั้งแต่ต้นทาง
  const { ctx, page } = await newSeededPage({
    role: 'teacher',
    cache: baseCache({
      exams: [mkExam('eHML8', 'ชุด Legacy Pair', 'คณิตศาสตร์', { questionCount: 4 })],
      questions: { eHML8: mkQN(4) },
      attempts: [
        {
          id: 'attL1', examId: 'eHML8', examTitle: 'ชุด Legacy Pair', examSubject: 'คณิตศาสตร์',
          examType: 'mc', weighted: false, takerName: 'เด็กlegacy', halfMode: true, halfQuota: 2,
          startedAt: new Date(Date.now() - 120000).toISOString(), submittedAt: new Date(Date.now() - 90000).toISOString(),
          usedSeconds: 30, score: 2, total: 2, answers: { q1: 'A', q2: 'B' },
          perQuestion: [
            { qid: 'q1', no: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
            { qid: 'q2', no: 2, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          ],
          practiceMode: false, visitOrder: ['q1', 'q2'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
        },
        {
          id: 'attL2', examId: 'eHML8', examTitle: 'ชุด Legacy Pair', examSubject: 'คณิตศาสตร์',
          examType: 'mc', weighted: false, takerName: 'เด็กlegacy', halfMode: true, halfPart: 2, parentAttemptId: 'attL1', halfQuota: 2,
          startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date(Date.now() - 30000).toISOString(),
          usedSeconds: 30, score: 2, total: 2, answers: { q3: 'C', q4: 'D' },
          perQuestion: [
            { qid: 'q3', no: 3, chosen: 'C', correct: 'C', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
            { qid: 'q4', no: 4, chosen: 'D', correct: 'D', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 0, changes: 0, counted: true },
          ],
          practiceMode: false, visitOrder: ['q3', 'q4'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
        },
      ],
    }),
  });
  await page.evaluate(() => navigate('stats'));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-tab="half"]')?.click());
  await page.waitForTimeout(300);
  const halfCardCount = await page.evaluate(() => document.querySelectorAll('#statsRows [data-review]').length);
  check('fix8 regression: legacy paired record ยังรวมเป็นการ์ดเดียวในแท็บคนละครึ่ง', halfCardCount === 1, String(halfCardCount));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: resumeCancel (v48.20) — กด "ยกเลิก" บน popup ชุดที่ทำค้างอยู่ ต้องไม่
// ทิ้งปุ่มลอย 📝 กระดาษทด / ✏️ ขีดเขียน PDF ค้างไว้ — เดิม navigate() ที่ถูกเรียกซ้อน
// (initTake → confirm → navigate('exams') ซ้อนเข้าไป) ทำให้เฟรมนอกทำต่อด้วยค่า page
// เก่าที่ค้างอยู่ แล้วสั่งโชว์ปุ่มกลับมาทับ hide ที่เฟรมในเพิ่งทำไป (ดู navigate() guard
// `if (_currentPage !== page) return;` และ pdfAnnotateHide() ที่เคลียร์ activeContainerId)
// ─────────────────────────────────────────────────────────────────
currentSection = 'resumeCancel';
{
  const cache = baseCache({
    exams: [mkExam('rcA', 'ชุด A', 'ภาษาไทย', { pdfUrl: 'about:blank' }), mkExam('rcB', 'ชุด B', 'ภาษาไทย', { pdfUrl: 'about:blank' })],
    questions: { rcA: mkQ(), rcB: mkQ() },
  });
  const { ctx, page } = await newSeededPage({ cache });

  await page.evaluate(() => navigate('take', { id: 'rcA', practice: true, takerName: 'ครู' }));
  await page.waitForTimeout(1300); // doStart() autostart (teacher, ไม่มี mood check-in) + autosave resume 1 รอบ
  const before = await page.evaluate(() => ({
    active: document.querySelector('.page.active')?.id,
    scratch: document.getElementById('scratchToggleBtn')?.classList.contains('visible') ?? null,
  }));
  check('resumeCancel: exam A เริ่มปกติ อยู่หน้า take + ปุ่มกระดาษทดโชว์', before.active === 'page-take' && before.scratch === true, JSON.stringify(before));

  // เริ่มชุด B ทับ (คนละชุดกับ resume ที่ save ไว้ของ A) → เจอ confirm → กด "ยกเลิก"
  const decline = await page.evaluate(() => {
    const orig = window.confirm;
    let msg = null;
    window.confirm = (m) => { msg = m; return false; };
    navigate('take', { id: 'rcB', practice: true, takerName: 'ครู' });
    window.confirm = orig;
    return {
      msg,
      active: document.querySelector('.page.active')?.id,
      scratch: document.getElementById('scratchToggleBtn')?.classList.contains('visible') ?? null,
      pen: document.getElementById('pdfAnnotateToggleBtn') ? getComputedStyle(document.getElementById('pdfAnnotateToggleBtn')).display : null,
    };
  });
  check('resumeCancel: confirm เตือนถูกชุด (A) ก่อนเริ่ม B', !!decline.msg && decline.msg.includes('ชุด A'), JSON.stringify(decline).slice(0, 150));
  check('resumeCancel: กดยกเลิกแล้วกลับหน้า exams', decline.active === 'page-exams', 'active=' + decline.active);
  check('resumeCancel: ปุ่มกระดาษทด 📝 ไม่โผล่ทันทีหลังยกเลิก', decline.scratch !== true, 'scratch=' + decline.scratch);
  check('resumeCancel: ปุ่มปากกา ✏️ ไม่โผล่ทันทีหลังยกเลิก', decline.pen !== 'block', 'pen=' + decline.pen);

  await page.waitForTimeout(1500); // กัน loadPdfOnce ของ exam B ที่ยิงไปก่อน confirm resolve ทีหลังแล้วเรียก pdfAnnotateInit ซ้ำ
  const after = await page.evaluate(() => ({
    scratch: document.getElementById('scratchToggleBtn')?.classList.contains('visible') ?? null,
    pen: document.getElementById('pdfAnnotateToggleBtn') ? getComputedStyle(document.getElementById('pdfAnnotateToggleBtn')).display : null,
  }));
  check('resumeCancel: ปุ่มไม่เด้งกลับมาทีหลัง (PDF โหลดช้า)', after.scratch !== true && after.pen !== 'block', JSON.stringify(after));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: backForwardNav (v48.51) — เดิมแอปไม่เคย pushState เลยสักจุด (navigate()
// แค่สลับ .active class) ทำให้ history.length ไม่ขยับ กด back จึงไม่มีอะไรให้กลับ
// ภายในแอปจริงๆ — บนบางอุปกรณ์/บริบทเบราว์เซอร์ตัดสินใจ reload ทั้งหน้าใหม่แทน ซึ่ง
// พลาดจังหวะเช็ค session แล้วโผล่หน้า login (บั๊กที่ผู้ใช้รายงาน) แก้ด้วยการเพิ่ม
// pushState/popstate wrapper ชั้นที่ 3 ต่อจาก wrapper savePageState เดิม — ต้องเช็ค
// ด้วยว่าออกจาก take/practice กลางคันผ่าน back ยังผ่าน confirm + savePracticeSession
// เหมือนกดปุ่ม exit เอง ไม่ข้าม safety logic เดิมไปเฉยๆ
// ─────────────────────────────────────────────────────────────────
currentSection = 'backForwardNav';
{
  // 1+2: back/forward ระหว่างหน้าธรรมดา
  {
    const { ctx, page } = await newSeededPage({ cache: baseCache() });
    await page.evaluate(() => navigate('exams', {}));
    await page.evaluate(() => navigate('stats', {}));
    const histLen = await page.evaluate(() => history.length);
    check('backForwardNav: history.length ขยับขึ้นตาม navigate (pushState ทำงาน)', histLen >= 3, 'len=' + histLen);

    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(300);
    const afterBack = await page.evaluate(() => ({ active: document.querySelector('.page.active')?.id, loggedIn: Auth.isLoggedIn() }));
    check('backForwardNav: back จาก stats กลับไป exams (ไม่ใช่ blank/login)',
      afterBack.active === 'page-exams' && afterBack.loggedIn === true, JSON.stringify(afterBack));

    await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(300);
    const afterFwd = await page.evaluate(() => document.querySelector('.page.active')?.id);
    check('backForwardNav: forward กลับไป stats', afterFwd === 'page-stats', 'active=' + afterFwd);
    await ctx.close();
  }

  // 3+4: back กลางข้อสอบ (take) ต้องผ่าน confirm เดียวกับปุ่ม "ออกจากการทำข้อสอบ"
  {
    const cache = baseCache({
      exams: [mkExam('bkA', 'ชุด Back', 'ภาษาไทย', { pdfUrl: 'about:blank' })],
      questions: { bkA: mkQ() },
    });
    const { ctx, page } = await newSeededPage({ cache });
    await page.evaluate(() => navigate('take', { id: 'bkA', practice: true, takerName: 'ครู' }));
    await page.waitForTimeout(1300);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#takeChoices .choice')].find(el => el.textContent.trim() === 'ก');
      if (btn) btn.click();
    });

    // stub confirm ต้องคงอยู่ข้าม wait เพราะ history.back() ยิง popstate แบบ async
    await page.evaluate(() => {
      window._testConfirmMsg = null;
      window._origConfirm = window.confirm;
      window.confirm = (m) => { window._testConfirmMsg = m; return false; };
      history.back();
    });
    await page.waitForTimeout(500);
    const declineResult = await page.evaluate(() => {
      const r = {
        confirmMsg: window._testConfirmMsg,
        active: document.querySelector('.page.active')?.id,
        chosen: [...document.querySelectorAll('#takeChoices .choice')].find(el => el.classList.contains('active'))?.textContent?.trim(),
      };
      window.confirm = window._origConfirm;
      return r;
    });
    check('backForwardNav: back กลางข้อสอบ + ยกเลิก confirm → ยังอยู่หน้า take, คำตอบไม่หาย',
      !!declineResult.confirmMsg && declineResult.confirmMsg.includes('ออกจากการทำข้อสอบ') &&
      declineResult.active === 'page-take' && declineResult.chosen === 'ก', JSON.stringify(declineResult));

    await page.evaluate(() => {
      window._testConfirmMsg = null;
      window._origConfirm = window.confirm;
      window.confirm = (m) => { window._testConfirmMsg = m; return true; };
      history.back();
    });
    await page.waitForTimeout(500);
    const confirmResult = await page.evaluate(() => {
      const r = { confirmMsg: window._testConfirmMsg, active: document.querySelector('.page.active')?.id };
      window.confirm = window._origConfirm;
      return r;
    });
    check('backForwardNav: back กลางข้อสอบ + ยืนยัน confirm → ออกไปหน้า exams',
      !!confirmResult.confirmMsg && confirmResult.active === 'page-exams', JSON.stringify(confirmResult));
    await ctx.close();
  }

  // 5: back กลางแบบฝึกหัด (practice) — savePracticeSession ต้องถูกเรียกจริง ไม่ใช่แค่
  // ข้าม confirm ไปเฉยๆ (ข้อมูลที่ทำค้างจะหายจริงถ้า wrapper ไม่ผ่านปุ่ม exit เดิม)
  {
    const cache = baseCache({
      exams: [mkExam('bkP', 'ชุด Practice Back', 'คณิตศาสตร์', { pdfUrl: 'about:blank' })],
      questions: { bkP: mkQ() },
    });
    const { ctx, page } = await newSeededPage({ role: 'student', name: 'เด็กแบ็ก', cache });
    await page.evaluate(() => WeaknessTracker.updateWeaknessAfterSubmit({
      takerName: 'เด็กแบ็ก', examId: 'bkP', examTitle: 'ชุด Practice Back', examSubject: 'คณิตศาสตร์',
      submittedAt: new Date().toISOString(),
      perQuestion: [{ no: 1, isCorrect: false }],
    }));
    await page.evaluate(() => navigate('practice', { examId: 'bkP' }));
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      _pracState.answers.push({ questionNo: 1, isCorrect: true, chosen: 'A', correct: 'A', tags: [], subTags: [], topic: null });
    });
    const attemptsBefore = await page.evaluate(() => Store.load().attempts.length);
    await page.evaluate(() => {
      window._origConfirm = window.confirm;
      window.confirm = () => true;
      history.back();
    });
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const r = {
        active: document.querySelector('.page.active')?.id,
        attemptsAfter: Store.load().attempts.length,
        lastAttemptMode: Store.load().attempts[0]?.mode,
      };
      window.confirm = window._origConfirm;
      return r;
    });
    check('backForwardNav: back กลางแบบฝึกหัด (มีคำตอบ) + ยืนยัน → savePracticeSession ถูกเรียกจริง',
      result.attemptsAfter === attemptsBefore + 1 && result.lastAttemptMode === 'weakness_practice' && result.active === 'page-exams',
      JSON.stringify({ attemptsBefore, ...result }));
    await ctx.close();
  }

  // 6: popstate ด้วย state เพี้ยน (หน้าไม่มีจริง) ต้อง fallback ไม่ใช่จอว่างเปล่า
  {
    const { ctx, page } = await newSeededPage({ cache: baseCache() });
    await page.evaluate(() => navigate('exams', {}));
    await page.evaluate(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'nonexistent_page_xyz', params: {} } }));
    });
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => document.querySelector('.page.active')?.id);
    check('backForwardNav: popstate state เพี้ยน (หน้าไม่มีจริง) → fallback ไป home ไม่ใช่จอว่าง', result === 'page-home', 'active=' + result);
    await ctx.close();
  }

  // 7: soft-refresh (navigate() ซ้ำด้วย page/params เดิม เช่นจาก Firestore realtime
  // listener) ต้องไม่ push history ซ้ำ (v48.52) — ของเดิมพองด้วย entry ซ้ำทุกครั้งที่
  // cloud data เปลี่ยนแม้ page จะไม่เปลี่ยนเลย ทำให้กด back แค่ 1-2 ครั้งไหลทะลุกลับไป
  // ถึง entry เก่าๆ ได้ง่ายกว่าที่ควร
  {
    const { ctx, page } = await newSeededPage({ cache: baseCache() });
    await page.evaluate(() => navigate('exams', {}));
    const lenAfterFirst = await page.evaluate(() => history.length);
    await page.evaluate(() => { navigate('exams', {}); navigate('exams', {}); navigate('exams', {}); });
    const lenAfterRefresh = await page.evaluate(() => history.length);
    check('backForwardNav: soft-refresh ซ้ำด้วย page/params เดิม → history.length ไม่ขยับเพิ่ม',
      lenAfterRefresh === lenAfterFirst, `before=${lenAfterFirst} after=${lenAfterRefresh}`);

    await page.evaluate(() => navigate('stats', {}));
    const lenAfterRealNav = await page.evaluate(() => history.length);
    check('backForwardNav: navigate ไปหน้าอื่นจริง (ไม่ใช่ soft-refresh) → history.length ยังขยับปกติ',
      lenAfterRealNav === lenAfterRefresh + 1, `after=${lenAfterRealNav}`);
    await ctx.close();
  }

  // 8: entry เก่า {page:'login'} (จากตอนบูตแอปก่อน auth) ต้องไม่โผล่ทับหน้าจอทั้งที่
  // ยัง login อยู่จริง (v48.52)
  {
    const { ctx, page } = await newSeededPage({ cache: baseCache() });
    await page.evaluate(() => { history.pushState({ page: 'login', params: {} }, '', location.href); });
    await page.evaluate(() => navigate('home', {}));
    await page.evaluate(() => navigate('exams', {}));
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(300);
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => ({ active: document.querySelector('.page.active')?.id, loggedIn: Auth.isLoggedIn() }));
    check('backForwardNav: back ไปเจอ entry {page:login} เก่าทั้งที่ยัง login อยู่จริง → ได้ page-home ไม่ใช่ page-login',
      result.active === 'page-home' && result.loggedIn === true, JSON.stringify(result));
    await ctx.close();
  }

  // 9: Auth.login() ต้อง await claimSession ก่อนเรียก listenSession เสมอ (v48.52) —
  // เดิมยิงพร้อมกัน (fire-and-forget) ทำให้ listener อาจเห็น token เก่าจาก cache
  // ก่อนเขียนเสร็จ แล้วเข้าใจผิดว่าโดนเครื่องอื่น kick ทั้งที่เป็น timing ของตัวเอง
  {
    const { ctx, page } = await newSeededPage({ cache: baseCache({ members: [{ pin: '311257', name: 'เด็กทดสอบ' }] }) });
    const order = await page.evaluate(async () => {
      const calls = [];
      let resolveClaim;
      const claimPromise = new Promise(r => { resolveClaim = r; });
      FirebaseSync.ready = () => true;
      FirebaseSync.claimSession = () => { calls.push('claimSession:start'); return claimPromise.then(() => calls.push('claimSession:resolved')); };
      FirebaseSync.listenSession = () => { calls.push('listenSession:attached'); };
      Auth.login('311257');
      await new Promise(r => setTimeout(r, 1050));
      const beforeResolve = [...calls];
      resolveClaim();
      await new Promise(r => setTimeout(r, 50));
      return { beforeResolve, afterResolve: [...calls] };
    });
    check('backForwardNav: Auth.login() await claimSession ก่อนแนบ listenSession เสมอ',
      JSON.stringify(order.beforeResolve) === JSON.stringify(['claimSession:start']) &&
      JSON.stringify(order.afterResolve) === JSON.stringify(['claimSession:start', 'claimSession:resolved', 'listenSession:attached']),
      JSON.stringify(order));
    await ctx.close();
  }

  // 10: Auth.login() ด้วย PIN admin (ค่าคงที่ ADMIN_PIN ใช้ร่วมกันทุกอุปกรณ์) ต้องไม่
  // เรียก claimSession/listenSession เลย (v48.53) — เดิม feature "kick session ซ้ำ PIN"
  // ตั้งใจไว้เฉพาะนักเรียน (PIN ไม่ซ้ำกัน) แต่โค้ดจริงลืมเช็ค role ทำให้ admin ทุกเครื่อง
  // ที่ login ด้วย PIN เดียวกัน "kick" กันเองข้ามอุปกรณ์ทั้งที่เป็นคนเดียวกัน
  {
    const { ctx, page } = await newSeededPage({ cache: baseCache() });
    const result = await page.evaluate(async () => {
      const calls = [];
      FirebaseSync.ready = () => true;
      FirebaseSync.claimSession = () => { calls.push('claimSession'); return Promise.resolve(); };
      FirebaseSync.listenSession = () => { calls.push('listenSession'); };
      const role = Auth.login('134140');
      await new Promise(r => setTimeout(r, 1050));
      return { role, calls };
    });
    check('backForwardNav: Auth.login(PIN admin) → claimSession/listenSession ไม่ถูกเรียกเลย',
      result.role === 'teacher' && result.calls.length === 0, JSON.stringify(result));
    await ctx.close();
  }

  // 11: Auth.login() ด้วย PIN นักเรียน (ไม่ซ้ำกัน) ยังต้อง claim/listen ตามเดิม (v48.53
  // — ยืนยันว่า fix ข้างบนจำกัดเฉพาะ role teacher จริง ไม่กระทบพฤติกรรมนักเรียน)
  {
    const { ctx, page } = await newSeededPage({ cache: baseCache({ members: [{ pin: '311257', name: 'เด็กทดสอบ' }] }) });
    const order = await page.evaluate(async () => {
      const calls = [];
      let resolveClaim;
      const claimPromise = new Promise(r => { resolveClaim = r; });
      FirebaseSync.ready = () => true;
      FirebaseSync.claimSession = () => { calls.push('claimSession:start'); return claimPromise.then(() => calls.push('claimSession:resolved')); };
      FirebaseSync.listenSession = () => { calls.push('listenSession:attached'); };
      const role = Auth.login('311257');
      await new Promise(r => setTimeout(r, 1050));
      const beforeResolve = [...calls];
      resolveClaim();
      await new Promise(r => setTimeout(r, 50));
      return { role, beforeResolve, afterResolve: [...calls] };
    });
    check('backForwardNav: Auth.login(PIN นักเรียน) → ยัง claim/listen ตามเดิม (ไม่กระทบ)',
      order.role === 'student' &&
      JSON.stringify(order.beforeResolve) === JSON.stringify(['claimSession:start']) &&
      JSON.stringify(order.afterResolve) === JSON.stringify(['claimSession:start', 'claimSession:resolved', 'listenSession:attached']),
      JSON.stringify(order));
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────
// Section: takeChoicesLayout (v48.20) — แถบ ก ข ค ง ฝั่งขวาต้องไม่ถูกแถบหัวข้อ
// (position:fixed หลัง _liftTakeStickyBars) ทับด้านบน บน desktop/iPad landscape
// เดิม padding-top ชดเชยถูกวัด "ครั้งเดียว" ตอน lift — ถ้า flag sbLifted หลุดไปทั้งที่
// แถบยัง fixed อยู่ (เช่น หมุนจอ/resize รัวๆ) รอบถัดไปจะหาแถบในเพนไม่เจอ (ย้ายไปแล้ว)
// เลยไม่ตั้ง padding ใหม่ → แถบทับ ก ข ค ง ถาวร (.takeRight เป็น overflow:hidden
// scroll ขึ้นไปดูส่วนที่ถูกทับไม่ได้เลย) ดู _syncLiftedSbPadding + ResizeObserver
// ─────────────────────────────────────────────────────────────────
currentSection = 'takeChoicesLayout';
{
  const cache = baseCache({
    exams: [mkExam('layE1', 'ชุด Layout', 'ภาษาไทย', { pdfUrl: 'about:blank' })],
    questions: { layE1: mkQ() },
  });
  const { ctx, page } = await newSeededPage({ cache, viewport: { width: 1180, height: 820 } });

  const GEO = () => {
    const sbR = document.querySelector('#page-take .lifted-sb-right');
    const block = document.querySelector('#page-take .takeChoicesBlock');
    const choice = document.querySelector('#page-take #takeChoices .choice');
    return {
      overlap: (sbR && block) ? +(sbR.getBoundingClientRect().bottom - block.getBoundingClientRect().top).toFixed(1) : null,
      choiceH: choice ? +choice.getBoundingClientRect().height.toFixed(1) : null,
    };
  };

  await page.evaluate(() => navigate('take', { id: 'layE1', practice: true, takerName: 'ครู' }));
  await page.waitForTimeout(700);
  const g1 = await page.evaluate(GEO);
  check('takeChoicesLayout: ปกติ แถบไม่ทับ ก ข ค ง', g1.overlap === 0, JSON.stringify(g1));
  check('takeChoicesLayout: ปกติ ปุ่มเต็มความสูง (ไม่ถูกบีบ)', g1.choiceH !== null && g1.choiceH >= 50, JSON.stringify(g1));

  // จำลอง flag sbLifted หลุดทั้งที่แถบยัง position:fixed อยู่ แล้วให้ lift รอบใหม่ทำงาน
  // (เคสที่ทำให้บั๊กเกิดจริง — เดิมรอบใหม่จะหาแถบในเพนไม่เจอแล้วไม่ตั้ง padding เลย)
  await page.evaluate(() => {
    const root = document.getElementById('page-take');
    delete root.dataset.sbLifted;
    root.querySelector('.takeRight').style.paddingTop = '';
    root.querySelector('.takeLeft').style.paddingTop = '';
    _liftTakeStickyBars('take');
  });
  await page.waitForTimeout(300);
  const g2 = await page.evaluate(GEO);
  check('takeChoicesLayout: flag sbLifted หลุดแล้ว lift ใหม่ยังกู้ padding ได้ถูก', g2.overlap === 0, JSON.stringify(g2));

  // แถบหัวข้อสูงขึ้นทีหลัง (เช่น ข้อความยาวขึ้น) → ResizeObserver ต้องปรับ padding ตามทัน
  await page.evaluate(() => {
    document.querySelector('#page-take .lifted-sb-right > div')?.insertAdjacentHTML(
      'beforeend', '<div style="font-size:20px;line-height:2.4;">บรรทัดเพิ่ม</div>');
  });
  await page.waitForTimeout(400);
  const g3 = await page.evaluate(GEO);
  check('takeChoicesLayout: แถบสูงขึ้นทีหลัง padding ตามทัน (ResizeObserver)', g3.overlap === 0, JSON.stringify(g3));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: penViewportSync (v48.21) — ปุ่มปากกา ✏️ หายตอนหมุนจอ/สลับ Split View
// เดิม resize handler เชื่อ MQ.matches ทันทีทุก event → บน iPad ที่รายงานขนาดจอไม่ตรงกัน
// ชั่วขณะ (log จริง 5/9: MQ.matches=false ทั้งที่ innerWidth=1180) จะ teardown ทิ้งกลางคัน
// = ลบลายเส้นถาวร + ซ่อนปุ่ม แล้วไม่ฟื้นเอง ต้องออก-เข้าข้อสอบใหม่
// หมายเหตุ: ตัว desync จริงจำลองใน Chromium ไม่ได้ (MQ กับ innerWidth ตรงกันเสมอ) —
// ที่เทสต์ได้คือ "ทางฟื้นปุ่มที่ซ่อนค้าง" + "จอแคบจริงยัง teardown เหมือนเดิม" + debounce
// ─────────────────────────────────────────────────────────────────
currentSection = 'penViewportSync';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('pv1', 'เลข ชุด pv', 'คณิตศาสตร์', { questionCount: 2, pdfUrl: 'https://x/pv1.pdf' })],
      questions: { pv1: mkQ() },
    }),
    viewport: { width: 1280, height: 900 },
  });
  await page.evaluate(() => navigate('take', { id: 'pv1' }));
  await page.waitForTimeout(500);
  // fabricate PDF-page DOM เหมือน section scratchpad (sandbox ไม่มี PDF.js จริง)
  await page.evaluate(() => {
    const container = document.getElementById('takePdfViewer');
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.id = 'takePdfViewer-page-1';
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 800;
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    window.pdfAnnotateInit('takePdfViewer');
  });
  await page.waitForTimeout(300);
  const penDisplay = () => page.evaluate(() => {
    const b = document.getElementById('pdfAnnotateToggleBtn');
    return b ? getComputedStyle(b).display : null;
  });
  check('penViewportSync: ปุ่มปากกาโชว์ปกติตอนจอกว้าง', (await penDisplay()) === 'block', String(await penDisplay()));

  // ปุ่มถูกซ่อนค้าง (จำลองผลจาก teardown รอบก่อน) → resize ตอนจอกว้าง ต้องฟื้นเอง
  await page.evaluate(() => { document.getElementById('pdfAnnotateToggleBtn').style.display = 'none'; });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(600); // > debounce 300ms
  check('penViewportSync: ปุ่มที่ซ่อนค้างฟื้นเองหลัง resize (ไม่ต้องออก-เข้าใหม่)',
    (await penDisplay()) === 'block', String(await penDisplay()));

  // ยิง resize รัวๆ ต้องไม่พังและจบที่สถานะถูกต้อง (debounce รวบเป็นรอบเดียว)
  await page.evaluate(() => { for (let i = 0; i < 12; i++) window.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(600);
  check('penViewportSync: ยิง resize รัวๆ แล้วสถานะยังถูกต้อง', (await penDisplay()) === 'block', String(await penDisplay()));

  // จอแคบจริง (< 901px) ต้องยัง teardown + ซ่อนปุ่มเหมือนเดิม — พฤติกรรมเดิมห้ามเสีย
  await page.setViewportSize({ width: 820, height: 1100 });
  await page.waitForTimeout(700);
  check('penViewportSync: จอแคบจริงยังซ่อนปุ่ม/teardown ตามเดิม', (await penDisplay()) === 'none', String(await penDisplay()));

  // กลับมากว้าง → ต้องสร้างใหม่ + โชว์ปุ่มเอง
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    const container = document.getElementById('takePdfViewer');
    if (!container.querySelector('[id^="takePdfViewer-page-"]')) {
      const wrapper = document.createElement('div');
      wrapper.id = 'takePdfViewer-page-1';
      const canvas = document.createElement('canvas');
      canvas.width = 600; canvas.height = 800;
      wrapper.appendChild(canvas);
      container.appendChild(wrapper);
    }
  });
  await page.waitForTimeout(700);
  check('penViewportSync: จอกลับมากว้างแล้วปุ่มกลับมาเอง', (await penDisplay()) === 'block', String(await penDisplay()));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: backfillAttempt (v48.22) — "บันทึกผลย้อนหลัง" กรอกคำตอบข้อสอบที่เคยทำ
// มาก่อนบนกระดาษ (ก่อนถูกแปลงเป็น PDF เข้าระบบ) ให้เข้าสถิติ/จุดอ่อนได้เหมือนทำจริง
// แต่ต้องไม่นับ gamification/streak/lineNotify (ตกลงกับผู้ใช้ไว้ตั้งแต่ต้น)
// ─────────────────────────────────────────────────────────────────
currentSection = 'backfillAttempt';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('bf1', 'ชุดทดสอบย้อนหลัง', 'คณิตศาสตร์', { questionCount: 3 })],
      questions: { bf1: [
        { id: 'q1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        { id: 'q2', no: 2, number: 2, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        { id: 'q3', no: 3, number: 3, correct: 'C', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      ] },
      members: [{ pin: '311257', name: 'เด็กย้อนหลัง' }],
    }),
  });
  await page.evaluate(() => {
    window._spyLineNotify = 0;
    const origLine = window.lineNotify;
    window.lineNotify = function (...args) { window._spyLineNotify++; return origLine?.apply(this, args); };
  });
  await page.evaluate(() => navigate('admin_exams', {}));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('offlineBanner')?.remove());

  check('backfillAttempt: ปุ่ม "📝 ย้อนหลัง" โผล่ในแถวข้อสอบ',
    await page.evaluate(() => !!document.querySelector('[data-backfill="bf1"]')));

  // ตารางไม่ล้นแนวนอน (v48.22 table-layout:fixed แก้ header/ปุ่มไม่ตรงกัน)
  const tableFit = await page.evaluate(() => {
    const wrap = document.querySelector('#page-admin_exams .tableWrap');
    return wrap ? { scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth } : null;
  });
  check('backfillAttempt: ตาราง admin_exams ไม่ล้นแนวนอน', tableFit && tableFit.scrollWidth <= tableFit.clientWidth + 1, JSON.stringify(tableFit));

  await page.evaluate(() => document.querySelector('[data-backfill="bf1"]').click());
  await page.waitForTimeout(300);
  check('backfillAttempt: เปิด modal สำเร็จ พร้อมแถวคำถามครบ 3 ข้อ',
    (await page.evaluate(() => document.getElementById('backfillModal').classList.contains('show'))) &&
    (await page.evaluate(() => document.querySelectorAll('#backfillRows .correctBtns').length)) === 3);

  // เลือกคำตอบ q1=A(ถูก) แล้วกดซ้ำต้องยกเลิก (deselect)
  await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="A"]').click());
  const selAfterFirst = await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="A"]').classList.contains('selected'));
  await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="A"]').click());
  const selAfterSecond = await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="A"]').classList.contains('selected'));
  check('backfillAttempt: กดปุ่มตอบซ้ำ = ยกเลิกคำตอบ (deselect)', selAfterFirst === true && selAfterSecond === false);

  // v48.26: เลือกคำตอบถูก/ผิด → ปุ่มไฮไลท์เขียว/แดงทันที (ไม่ต้องรอบันทึก/อ่านป้ายเฉลยเทียบเอง)
  await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="A"]').click()); // q1 correct=A
  const rightBg = await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="A"]').style.background);
  check('backfillAttempt: เลือกคำตอบถูกไฮไลท์เขียวทันที', rightBg === 'rgb(240, 253, 244)', rightBg);
  await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="B"]').click()); // เปลี่ยนเป็นผิด
  const wrongBg = await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="B"]').style.background);
  check('backfillAttempt: เลือกคำตอบผิดไฮไลท์แดงทันที', wrongBg === 'rgb(254, 242, 242)', wrongBg);

  // ตอบจริง: q1=A(ถูก), q2=A(ผิด, เฉลยจริง B, มาร์คไม่แน่ใจ), q3=C(ถูก), q3 ไม่ตอบไม่ได้ตั้งใจ
  await page.evaluate(() => {
    document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="A"]').click();
    document.querySelector('.correctBtns[data-qid="q2"] .correctBtn[data-val="A"]').click();
    document.querySelector('.correctBtns[data-qid="q3"] .correctBtn[data-val="C"]').click();
    document.querySelector('[data-unsure="q2"]').click();
  });
  const liveScore = await page.evaluate(() => document.getElementById('backfillScoreLive').textContent);
  check('backfillAttempt: คะแนนพรีวิวสดถูกต้อง (คาด 2/3)', liveScore.includes('2/3'), liveScore);

  const pastDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  await page.evaluate((d) => {
    document.getElementById('backfillTaker').value = 'เด็กย้อนหลัง';
    document.getElementById('backfillDate').value = d;
  }, pastDate);

  // v48.23: confirm() ยืนยันคะแนนก่อนบันทึกจริง — กด "ยกเลิก" ต้องไม่บันทึก, modal ยังเปิด
  page.removeAllListeners('dialog'); // newSeededPage ตั้ง auto-accept ไว้ default — ปิดก่อนคุมเองในเคสนี้
  let cancelDialogMsg = '';
  page.once('dialog', async d => { cancelDialogMsg = d.message(); await d.dismiss(); });
  await page.click('#backfillModalSave');
  await page.waitForTimeout(300);
  check('backfillAttempt: confirm dialog ก่อนบันทึกแสดงคะแนนถูกต้อง (2/3)', cancelDialogMsg.includes('2/3'), cancelDialogMsg);
  check('backfillAttempt: กด "ยกเลิก" ที่ confirm แล้วไม่สร้าง attempt',
    !(await page.evaluate(() => Store.load().attempts.find(a => a.examId === 'bf1'))));
  check('backfillAttempt: กด "ยกเลิก" ที่ confirm แล้ว modal ยังเปิดอยู่ (คำตอบไม่หาย)',
    await page.evaluate(() => document.getElementById('backfillModal').classList.contains('show')));

  page.once('dialog', d => d.accept());
  await page.click('#backfillModalSave');
  await page.waitForTimeout(300);

  const att = await page.evaluate(() => Store.load().attempts.find(a => a.examId === 'bf1'));
  check('backfillAttempt: attempt สร้างถูกต้อง (score 2/3, manualEntry:true, ไม่ใช่ practice/half)',
    att && att.score === 2 && att.total === 3 && att.manualEntry === true && att.practiceMode === false && att.halfMode === false,
    JSON.stringify({ score: att?.score, total: att?.total, manualEntry: att?.manualEntry }));
  check('backfillAttempt: submittedAt ตรงกับวันที่ย้อนหลังที่เลือก', att && att.submittedAt.slice(0, 10) === pastDate, JSON.stringify({ got: att?.submittedAt, want: pastDate }));
  check('backfillAttempt: perQuestion เก็บ unsure ต่อข้อถูกต้อง (q2 มาร์ค, q1/q3 ไม่มาร์ค)',
    att && att.perQuestion.find(p => p.qid === 'q2')?.unsure === true &&
    att.perQuestion.find(p => p.qid === 'q1')?.unsure === false &&
    att.perQuestion.find(p => p.qid === 'q3')?.unsure === false,
    JSON.stringify(att?.perQuestion?.map(p => ({ qid: p.qid, unsure: p.unsure }))));

  const spyLine = await page.evaluate(() => window._spyLineNotify);
  check('backfillAttempt: ไม่เรียก lineNotify เลย (ไม่นับ gamification)', spyLine === 0, 'calls=' + spyLine);

  const weakCount = await page.evaluate(() => WeaknessTracker.countWeaknessesByExam('เด็กย้อนหลัง', 'bf1'));
  check('backfillAttempt: WeaknessTracker บันทึกข้อที่ตอบผิด (คาด 1 ข้อ: q2)', weakCount === 1, 'weakCount=' + weakCount);

  await page.evaluate((id) => navigate('review', { attemptId: id }), att.id);
  await page.waitForTimeout(300);
  const reviewTitle = await page.evaluate(() => document.getElementById('reviewTitle')?.textContent || '');
  check('backfillAttempt: หน้ารีวิวแสดงป้าย "(บันทึกย้อนหลัง)"', reviewTitle.includes('บันทึกย้อนหลัง'), reviewTitle);

  await ctx.close();

  // v48.24: ข้อฟรี (isFree:true) ต้องโชว์ป้าย "★ ข้อฟรี" ไม่ใช่ตัวอักษรเฉลยดิบ (q.correct)
  // ที่อาจติดค้างอยู่ — ทดสอบด้วย exam แยก (bf2) ไม่ปนกับเคสข้างบน
  const { ctx: ctx2, page: page2 } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('bf2', 'ชุดทดสอบข้อฟรี', 'คณิตศาสตร์', { questionCount: 2 })],
      questions: { bf2: [
        { id: 'fq1', no: 1, number: 1, correct: 'A', isFree: true, choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        { id: 'fq2', no: 2, number: 2, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      ] },
      members: [{ pin: '311257', name: 'เด็กย้อนหลัง' }],
    }),
  });
  await page2.evaluate(() => navigate('admin_exams', {}));
  await page2.waitForTimeout(400);
  await page2.evaluate(() => document.getElementById('offlineBanner')?.remove());
  await page2.evaluate(() => document.querySelector('[data-backfill="bf2"]').click());
  await page2.waitForTimeout(300);
  const hints = await page2.evaluate(() => [...document.querySelectorAll('#backfillRows > div')].map(r => r.children[1].textContent));
  check('backfillAttempt: ข้อฟรีโชว์ป้าย "★ ข้อฟรี" ไม่ใช่ตัวอักษรเฉลยดิบ', hints[0]?.includes('ข้อฟรี'), hints[0]);
  check('backfillAttempt: ข้อปกติยังโชว์ป้ายเฉลยตามเดิม', hints[1]?.includes('ข') && !hints[1]?.includes('ฟรี'), hints[1]);
  // ไม่ตอบข้อฟรีเลย แต่ตอบข้อปกติผิด (เลือก A แทนเฉลยจริง B) → คาด 1/2 (ข้อฟรีได้เสมอ)
  await page2.evaluate(() => document.querySelector('.correctBtns[data-qid="fq2"] .correctBtn[data-val="A"]').click());
  const freeLiveScore = await page2.evaluate(() => document.getElementById('backfillScoreLive').textContent);
  check('backfillAttempt: ข้อฟรีได้คะแนนแม้ไม่ตอบเลย (คาด 1/2)', freeLiveScore.includes('1/2'), freeLiveScore);
  const fq2WrongBg = await page2.evaluate(() => document.querySelector('.correctBtns[data-qid="fq2"] .correctBtn[data-val="A"]').style.background);
  check('backfillAttempt: เลือกคำตอบผิด (fq2 เฉลยจริง B) ไฮไลท์แดง', fq2WrongBg === 'rgb(254, 242, 242)', fq2WrongBg);
  await page2.evaluate(() => document.querySelector('.correctBtns[data-qid="fq1"] .correctBtn[data-val="D"]').click()); // fq1 isFree, เลือกอะไรก็ถือว่าถูก
  const freeBg = await page2.evaluate(() => document.querySelector('.correctBtns[data-qid="fq1"] .correctBtn[data-val="D"]').style.background);
  check('backfillAttempt: ข้อฟรีเลือกอะไรก็ไฮไลท์เขียวเสมอ (ไม่ตรงเฉลยก็ยังเขียว)', freeBg === 'rgb(240, 253, 244)', freeBg);
  await ctx2.close();
}

{
  // v48.26: ไฮไลท์แถวสลับทุก 5 ข้อในโมดัลย้อนหลัง เหมือนตาราง Editor (.editorRowAlt)
  const rowQs = Array.from({ length: 12 }, (_, i) => ({ id: 'rq' + (i + 1), no: i + 1, number: i + 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } }));
  const { ctx: ctx3, page: page3 } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('bf3', 'ชุดทดสอบไฮไลท์แถว', 'คณิตศาสตร์', { questionCount: 12 })],
      questions: { bf3: rowQs },
    }),
  });
  await page3.evaluate(() => navigate('admin_exams', {}));
  await page3.waitForTimeout(400);
  await page3.evaluate(() => document.getElementById('offlineBanner')?.remove());
  await page3.evaluate(() => document.querySelector('[data-backfill="bf3"]').click());
  await page3.waitForTimeout(300);
  const rowBgs = await page3.evaluate(() => [...document.querySelectorAll('#backfillRows > div')].map(d => getComputedStyle(d).backgroundColor));
  check('backfillAttempt: แถวข้อ 1-5 ไม่ไฮไลท์, ข้อ 6-10 ไฮไลท์สลับ (เหมือนตาราง Editor)',
    rowBgs.slice(0, 5).every(c => c !== 'rgb(239, 246, 255)') && rowBgs.slice(5, 10).every(c => c === 'rgb(239, 246, 255)'),
    JSON.stringify(rowBgs));
  await ctx3.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: fillblankNumDigits (v48.25) — เลือกจำนวนหลักคำตอบ (3/4) สำหรับ
// ข้อสอบประเภทกรอกตัวเลข (fillblank-num) — เดิม hardcode ไว้ 3 หลักทุกจุด
// isAnswerCorrect ไม่สนใจจำนวนหลักเลย (parseInt เทียบเป็นตัวเลข) จึงเป็นแค่
// ข้อจำกัดฝั่ง UI (maxlength/pattern/slice/keypad) ที่ต้องอิง exam.numDigits||3
// ─────────────────────────────────────────────────────────────────
currentSection = 'fillblankNumDigits';
{
  // ── สร้างชุด 4 หลักผ่านฟอร์ม admin_new จริง (ทดสอบ toggle visibility + creation) ──
  const { ctx, page } = await newSeededPage({ cache: baseCache({ members: [{ pin: '311257', name: 'เด็กทดสอบ' }] }) });
  await page.evaluate(() => navigate('admin_new'));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('offlineBanner')?.remove());

  check('fillblankNumDigits: ปุ่มจำนวนหลักซ่อนอยู่ตอนเลือก mc (default)',
    (await page.evaluate(() => document.getElementById('newNumDigitsWrap').style.display)) === 'none');

  await page.evaluate(() => document.querySelector('#newExamTypeBtns .examTypeBtn[data-val="fillblank-num"]').click());
  check('fillblankNumDigits: ปุ่มจำนวนหลักโผล่ทันทีที่เลือก "กรอกตัวเลข", ปุ่ม "3 หลัก" active โดย default',
    (await page.evaluate(() => document.getElementById('newNumDigitsWrap').style.display)) === 'flex' &&
    (await page.evaluate(() => document.querySelector('#newNumDigitsBtns .numDigitsBtn.active')?.dataset.val)) === '3');

  await page.evaluate(() => document.querySelector('#newExamTypeBtns .examTypeBtn[data-val="mc"]').click());
  check('fillblankNumDigits: สลับกลับ mc แล้วปุ่มจำนวนหลักซ่อนอีกครั้ง',
    (await page.evaluate(() => document.getElementById('newNumDigitsWrap').style.display)) === 'none');

  await page.evaluate(() => document.querySelector('#newExamTypeBtns .examTypeBtn[data-val="fillblank-num"]').click());
  await page.evaluate(() => document.querySelector('#newNumDigitsBtns .numDigitsBtn[data-val="4"]').click());
  const hint4 = await page.evaluate(() => document.getElementById('newNumDigitsHint').textContent);
  check('fillblankNumDigits: hint อัพเดตเป็น "1-4 หลัก (0-9999)" ตอนเลือก 4 หลัก', hint4.includes('1-4 หลัก') && hint4.includes('0-9999'), hint4);

  await page.evaluate(() => { document.getElementById('newTitle').value = 'ชุด 4 หลัก'; });
  await page.evaluate(() => {
    const sel = document.getElementById('newSubjectSelect');
    if (!sel.querySelector('option[value="คณิตศาสตร์"]')) { const o = document.createElement('option'); o.value = 'คณิตศาสตร์'; o.textContent = 'คณิตศาสตร์'; sel.appendChild(o); }
    sel.value = 'คณิตศาสตร์';
  });
  await page.evaluate(() => { document.getElementById('newCreatePlaceholder').checked = true; document.getElementById('newQCount').value = '2'; });
  await page.evaluate(() => document.getElementById('newCreateBtn').click());
  await page.waitForTimeout(400);
  const created = await page.evaluate(() => Store.load().exams.find(e => e.title === 'ชุด 4 หลัก'));
  check('fillblankNumDigits: สร้างชุดสำเร็จ examType=fillblank-num, numDigits=4',
    created && created.examType === 'fillblank-num' && created.numDigits === 4,
    JSON.stringify(created && { examType: created.examType, numDigits: created.numDigits }));
  await ctx.close();
}

{
  // ── Editor: narrow-guard (บล็อกย่อ 4→3 หลักถ้ามีเฉลยเกิน 3 หลักค้างอยู่) ──
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('nd4', 'ชุด 4 หลัก', 'คณิตศาสตร์', { questionCount: 2, examType: 'fillblank-num', numDigits: 4 })],
      questions: { nd4: [{ id: 'q1', no: 1, number: 1, correct: '1234' }, { id: 'q2', no: 2, number: 2, correct: '' }] },
    }),
  });
  await page.evaluate(() => navigate('admin_editor', { id: 'nd4' }));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('offlineBanner')?.remove());

  check('fillblankNumDigits: Editor แสดงปุ่มจำนวนหลัก, "4 หลัก" active, ช่องเฉลย maxlength=4',
    (await page.evaluate(() => document.getElementById('editorNumDigitsWrap').style.display)) === 'block' &&
    (await page.evaluate(() => document.querySelector('#editorNumDigitsBtns .numDigitsBtn.active')?.dataset.val)) === '4' &&
    (await page.evaluate(() => document.querySelectorAll('input[data-field="correctNum"]')[0]?.maxLength)) === 4);

  await page.evaluate(() => document.querySelector('#editorNumDigitsBtns .numDigitsBtn[data-val="3"]').click());
  await page.waitForTimeout(200);
  check('fillblankNumDigits: ย่อ 4→3 หลักถูกบล็อกไว้เพราะมีเฉลย (q1="1234") เกิน 3 หลัก',
    (await page.evaluate(() => Store.load().exams.find(e => e.id === 'nd4').numDigits)) === 4);

  await page.evaluate(() => { const s = Store.load(); s.questions.nd4.find(q => q.id === 'q1').correct = '123'; Store.save(s); });
  await page.evaluate(() => navigate('admin_editor', { id: 'nd4' }));
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#editorNumDigitsBtns .numDigitsBtn[data-val="3"]').click());
  await page.waitForTimeout(300);
  check('fillblankNumDigits: หลังแก้เฉลยให้สั้นลงแล้ว ย่อ 4→3 หลักสำเร็จ',
    (await page.evaluate(() => Store.load().exams.find(e => e.id === 'nd4').numDigits)) === 3);
  await ctx.close();
}

{
  // ── หน้าทำข้อสอบจริง: maxLength/pattern/keypad ต้องรองรับ 4 หลักไม่ตัดที่ 3 ──
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('take4d', 'ทำข้อสอบ 4 หลัก', 'คณิตศาสตร์', { questionCount: 1, examType: 'fillblank-num', numDigits: 4 })],
      questions: { take4d: [{ id: 'q1', no: 1, number: 1, correct: '1234' }] },
    }),
  });
  await page.evaluate(() => navigate('take', { id: 'take4d' }));
  await page.waitForTimeout(500);
  check('fillblankNumDigits: หน้าทำข้อสอบ input maxLength=4 และ hint "1-4 หลัก (0-9999)"',
    (await page.evaluate(() => document.querySelector('#takeChoices .numAnsInput')?.maxLength)) === 4 &&
    (await page.evaluate(() => document.querySelector('#takeChoices')?.textContent))?.includes('0-9999'));

  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#takeChoices button')];
    ['1', '2', '3', '4'].forEach(d => { const btn = buttons.find(b => b.textContent.trim() === d); if (btn) btn.click(); });
  });
  const kpValue = await page.evaluate(() => document.querySelector('#takeChoices .numAnsInput')?.value);
  check('fillblankNumDigits: กด keypad 4 ครั้ง (1,2,3,4) ได้ "1234" ไม่ถูกตัดที่ 3 หลัก (จุดที่พลาดง่ายสุด)', kpValue === '1234', kpValue);
  await ctx.close();
}

{
  // ── โมดัลบันทึกย้อนหลัง: maxlength ต้องตาม numDigits ของข้อสอบ ──
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('bf4d', 'ย้อนหลัง 4 หลัก', 'คณิตศาสตร์', { questionCount: 1, examType: 'fillblank-num', numDigits: 4 })],
      questions: { bf4d: [{ id: 'q1', no: 1, number: 1, correct: '9999' }] },
    }),
  });
  await page.evaluate(() => navigate('admin_exams', {}));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('offlineBanner')?.remove());
  await page.evaluate(() => document.querySelector('[data-backfill="bf4d"]').click());
  await page.waitForTimeout(300);
  check('fillblankNumDigits: โมดัลย้อนหลัง maxlength=4 สำหรับข้อสอบ 4 หลัก',
    (await page.evaluate(() => document.querySelector('#backfillRows input[data-qid]')?.maxLength)) === 4);
  await ctx.close();
}

{
  // ── ข้อสอบเก่าไม่มี numDigits field → fallback เป็น 3 หลักทุกจุด (legacy-data-fallback) ──
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('legacyNd', 'ชุดเก่า', 'คณิตศาสตร์', { questionCount: 1, examType: 'fillblank-num' })], // ไม่มี numDigits
      questions: { legacyNd: [{ id: 'q1', no: 1, number: 1, correct: '42' }] },
    }),
  });
  await page.evaluate(() => navigate('take', { id: 'legacyNd' }));
  await page.waitForTimeout(500);
  check('fillblankNumDigits: ข้อสอบเก่าไม่มี numDigits → หน้าทำข้อสอบ fallback maxLength=3',
    (await page.evaluate(() => document.querySelector('#takeChoices .numAnsInput')?.maxLength)) === 3);
  await page.evaluate(() => navigate('admin_editor', { id: 'legacyNd' }));
  await page.waitForTimeout(400);
  check('fillblankNumDigits: ข้อสอบเก่าใน Editor แสดงปุ่ม "3 หลัก" active (fallback ถูกต้อง)',
    (await page.evaluate(() => document.querySelector('#editorNumDigitsBtns .numDigitsBtn.active')?.dataset.val)) === '3');
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: fillNumChangeCount (v48.48) — "Panic Changes" (Anxiety Markers) เคยนับ
// answerChanges ผิดสำหรับ fillblank-num เพราะนับทุก keystroke ตอนพิมพ์เลข (ไม่ใช่แค่ตอน
// แก้ไขคำตอบจริง) ทำให้พิมพ์เลข 4 หลักจากว่างเปล่าธรรมดาก็นับเป็น "เปลี่ยนคำตอบ" ไปแล้ว 3
// ครั้ง — แก้ให้เทียบค่าคำตอบตอนเข้า vs ตอนออกจากข้อ (ผ่าน enterQuestion()/leaveQuestion()
// เดิม) แทน นับแค่ 1 ครั้งต่อการแก้ไขจริงต่อการมาเยือนข้อนั้น เหมือน semantics ของ MC
// ─────────────────────────────────────────────────────────────────
currentSection = 'fillNumChangeCount';
{
  const digitClick = (page) => async (d) => page.evaluate((d) => {
    const btn = [...document.querySelectorAll('#takeChoices button')].find(b => b.textContent.trim() === d);
    if (btn) btn.click();
  }, d);

  // พิมพ์เลขจากว่างเปล่าปกติ ไม่แก้ไข → ไม่นับเป็น change เลย, แก้ไขจริง 1 ครั้ง → นับ 1 พอดี
  {
    const cache = baseCache({
      exams: [mkExam('fnc1', 'ชุดเช็คการนับเปลี่ยนคำตอบ', 'คณิตศาสตร์', { examType: 'fillblank-num', numDigits: 4, questionCount: 2 })],
      questions: { fnc1: [
        { id: 'q1', no: 1, number: 1, page: 1, correct: '9999' },
        { id: 'q2', no: 2, number: 2, page: 1, correct: '56' },
      ] },
    });
    const { ctx, page } = await newSeededPage({ cache, viewport: { width: 1180, height: 900 } });
    await page.evaluate(() => navigate('take', { id: 'fnc1' }));
    await page.waitForTimeout(500);
    const click = digitClick(page);

    for (const d of ['1', '2', '0', '0']) await click(d);
    await page.waitForTimeout(100);
    const changesAfterFreshType = await page.evaluate(() => _takeState.answerChanges['q1']);
    check('fillNumChangeCount: พิมพ์เลข 4 หลักจากว่างเปล่าโดยไม่แก้ไข ไม่นับเป็น "เปลี่ยนคำตอบ" เลย (ไม่ใช่ 3 แบบเดิม)',
      changesAfterFreshType === undefined || changesAfterFreshType === 0, 'changesAfterFreshType=' + changesAfterFreshType);

    await page.click('#takeNextBtn');
    await page.waitForTimeout(200);
    for (const d of ['5', '6']) await click(d);
    await page.waitForTimeout(100);

    await page.click('#takePrevBtn');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#takeChoices button')].find(b => b.textContent.trim() === 'ล้าง');
      if (btn) btn.click();
    });
    for (const d of ['9', '9', '9', '9']) await click(d);
    await page.waitForTimeout(100);

    await page.click('#takeNextBtn');
    await page.waitForTimeout(200);
    const q1Changes = await page.evaluate(() => _takeState.answerChanges['q1']);
    check('fillNumChangeCount: แก้คำตอบจริง 1 ครั้ง (1200→9999 ผ่านหลาย keystroke) นับได้ "1" พอดี',
      q1Changes === 1, 'q1Changes=' + q1Changes);

    const q2Changes = await page.evaluate(() => _takeState.answerChanges['q2']);
    check('fillNumChangeCount: ข้อ 2 พิมพ์ครั้งเดียวไม่เคยแก้ไข ไม่นับเป็นการเปลี่ยนคำตอบ',
      q2Changes === undefined || q2Changes === 0, 'q2Changes=' + q2Changes);
    await ctx.close();
  }

  // MC exam ต้องนับแบบเดิมถูกต้อง ไม่กระทบจากการแก้ (regression safety)
  {
    const cache = baseCache({
      exams: [mkExam('mcc1', 'ชุด MC เช็คไม่กระทบ', 'คณิตศาสตร์', { examType: 'mc', questionCount: 1 })],
      questions: { mcc1: [{ id: 'q1', no: 1, number: 1, page: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } }] },
    });
    const { ctx, page } = await newSeededPage({ cache, viewport: { width: 1180, height: 900 } });
    await page.evaluate(() => navigate('take', { id: 'mcc1' }));
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelectorAll('#takeChoices .choice')[0].click());
    await page.waitForTimeout(80);
    await page.evaluate(() => document.querySelectorAll('#takeChoices .choice')[1].click());
    await page.waitForTimeout(80);
    await page.evaluate(() => document.querySelectorAll('#takeChoices .choice')[2].click());
    await page.waitForTimeout(80);
    const mcChanges = await page.evaluate(() => _takeState.answerChanges['q1']);
    check('fillNumChangeCount: MC exam ยังนับ answerChanges แบบเดิมถูกต้อง (A→B→C = 2 ครั้ง)',
      mcChanges === 2, 'mcChanges=' + mcChanges);
    await ctx.close();
  }

  // End-to-end: พิมพ์เลขปกติทั้งชุดไม่แก้ไขเลย → submit → calcAnxietyMarkers ต้องไม่ flag
  {
    const cache = baseCache({
      exams: [mkExam('e2e1', 'ชุด End-to-end Panic Check', 'คณิตศาสตร์', { examType: 'fillblank-num', numDigits: 4, questionCount: 4 })],
      questions: { e2e1: [
        { id: 'q1', no: 1, number: 1, page: 1, correct: '1000' },
        { id: 'q2', no: 2, number: 2, page: 1, correct: '2000' },
        { id: 'q3', no: 3, number: 3, page: 1, correct: '3000' },
        { id: 'q4', no: 4, number: 4, page: 1, correct: '4000' },
      ] },
    });
    const { ctx, page } = await newSeededPage({ cache, viewport: { width: 1180, height: 900 } });
    await page.evaluate(() => navigate('take', { id: 'e2e1' }));
    await page.waitForTimeout(500);
    const click = digitClick(page);
    for (let i = 0; i < 4; i++) {
      for (const d of [String(i + 1), '0', '0', '0']) await click(d);
      await page.waitForTimeout(60);
      if (i < 3) { await page.click('#takeNextBtn'); await page.waitForTimeout(150); }
    }
    await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
    await page.waitForTimeout(400);
    const att = await page.evaluate(() => (Store.load().attempts || [])[0]);
    const totalChanges = att ? (att.perQuestion || []).reduce((s, p) => s + (p.changes || 0), 0) : -1;
    check('fillNumChangeCount (end-to-end): พิมพ์เลข 4 ข้อปกติไม่แก้ไขเลย → totalChanges เป็น 0 ไม่ใช่หลักสิบ',
      totalChanges === 0, 'totalChanges=' + totalChanges);
    const anxiety = att ? await page.evaluate((id) => {
      const a2 = (Store.load().attempts || []).find(x => x.id === id);
      return calcAnxietyMarkers(a2);
    }, att.id) : null;
    check('fillNumChangeCount (end-to-end): calcAnxietyMarkers ไม่ flag panicChanges ให้ session ที่พิมพ์เลขปกติ',
      anxiety && anxiety.panicChanges === false && anxiety.totalChanges === 0, JSON.stringify(anxiety));
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────
// Section: sessionPersist (v48.27) — session + หน้าล่าสุดต้องรอดข้าม reload
// บั๊กจริงจาก log iPad: iOS ล้างโปรเซส PWA ตอนสลับแอป → sessionStorage หาย →
// เด้งกลับหน้า login กลางคัน (log เห็น syncFromCloud.renav {page:"login"} ทั้งที่
// 4 วินาทีก่อนหน้ายังอยู่หน้า review) — ย้ายไป localStorage เหมือน takeResume
// ─────────────────────────────────────────────────────────────────
currentSection = 'sessionPersist';
{
  const { ctx, page } = await newSeededPage({
    cache: baseCache({
      exams: [mkExam('sp1', 'ชุดทดสอบ session', 'คณิตศาสตร์')],
      questions: { sp1: mkQ() },
      members: [{ pin: '311257', name: 'เด็กเซสชัน' }],
    }),
  });
  // login จริงผ่าน Auth.login() — ต้องลงที่ localStorage ไม่ใช่ sessionStorage
  await page.evaluate(() => Auth.login('311257'));
  const st = await page.evaluate(() => ({ local: localStorage.getItem('appSession'), session: sessionStorage.getItem('appSession') }));
  check('sessionPersist: login แล้ว appSession อยู่ใน localStorage และไม่ค้างที่ sessionStorage',
    !!st.local && st.local.includes('เด็กเซสชัน') && st.session === null, JSON.stringify(st));

  // จำลองบั๊กจริง: อยู่หน้า exams → iOS ล้าง sessionStorage → reload → ต้องกลับหน้าเดิม
  await page.evaluate(() => navigate('exams', {}));
  await page.waitForTimeout(300);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const afterReload = await page.evaluate(() => ({
    currentPage: window._currentPage,
    loginVisible: document.getElementById('page-login')?.classList.contains('active'),
    loggedIn: Auth.isLoggedIn(), name: Auth.getName(),
  }));
  check('sessionPersist: reload หลัง sessionStorage ถูกล้าง → ยังล็อกอินและกลับเข้าหน้าเดิม (ไม่เด้ง login)',
    afterReload.loggedIn === true && afterReload.name === 'เด็กเซสชัน' &&
    afterReload.currentPage === 'exams' && !afterReload.loginVisible, JSON.stringify(afterReload));

  // logout ต้องล้างทั้งสอง storage — ไม่งั้น session ผีใน sessionStorage ฟื้นได้
  await page.evaluate(() => sessionStorage.setItem('appSession', JSON.stringify({ role: 'student', name: 'ผี', ts: Date.now() })));
  await page.evaluate(() => Auth.logout());
  const afterLogout = await page.evaluate(() => ({
    local: localStorage.getItem('appSession'), session: sessionStorage.getItem('appSession'), loggedIn: Auth.isLoggedIn(),
  }));
  check('sessionPersist: logout ล้าง appSession ทั้ง localStorage และ sessionStorage',
    afterLogout.local === null && afterLogout.session === null && afterLogout.loggedIn === false, JSON.stringify(afterLogout));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('sessionPersist: logout แล้ว reload → อยู่หน้า login (session ไม่ฟื้น)',
    (await page.evaluate(() => Auth.isLoggedIn())) === false &&
    (await page.evaluate(() => document.getElementById('page-login')?.classList.contains('active'))) === true);
  await ctx.close();

  // fallback: session เก่าที่ค้างใน sessionStorage อย่างเดียว (ผู้ใช้ที่ login ไว้ก่อน deploy)
  // ต้องยังใช้งานได้ ไม่โดนเตะออก — ชุดเทสเดิมทั้งหมดที่ seed sessionStorage ก็พิสูจน์ทางนี้
  const { ctx: ctx2, page: page2 } = await newSeededPage({ cache: baseCache({ members: [{ pin: '311257', name: 'เด็กเก่า' }] }), name: 'เด็กเก่า', role: 'student' });
  const legacy = await page2.evaluate(() => ({ loggedIn: Auth.isLoggedIn(), name: Auth.getName(), role: Auth.getRole() }));
  check('sessionPersist: fallback อ่าน session เก่าจาก sessionStorage ได้ (ไม่เตะผู้ใช้ตอนอัปเดต)',
    legacy.loggedIn === true && legacy.name === 'เด็กเก่า' && legacy.role === 'student', JSON.stringify(legacy));
  await ctx2.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: reviewHeaderStuck (v48.28) — กดแท็บ "เฉลย" ในหน้าทบทวนแล้วแถบหัวข้อ
// + ปุ่ม "← ผลฝึกซ้อม" หายไป กดย้อนกลับไม่ได้ (รายงานจากผู้ใช้จริงพร้อมภาพ)
// ต้นเหตุ: PdfViewer.scrollToPage() ใช้ scrollIntoView ซึ่งเลื่อน scroll container
// ทุกชั้นที่เป็นบรรพบุรุษ (รวม .page.active / element ที่ overflow:hidden) — พิสูจน์แล้ว
// บนโค้ดเดิม: window เลื่อนไป 83px ≈ ความสูงแถบหัวข้อพอดี
// sandbox โหลด PDF.js จาก CDN ไม่ได้ → stub pdfjsLib เพื่อทดสอบ scrollToPage จริง
// ─────────────────────────────────────────────────────────────────
currentSection = 'reviewHeaderStuck';
{
  const { ctx, page } = await newSeededPage({
    viewport: { width: 1180, height: 788 }, // iPad landscape
    cache: baseCache({
      exams: [mkExam('rh1', 'ชุดทดสอบหัวข้อ', 'คณิตศาสตร์', {
        questionCount: 2, pdfUrl: 'https://example.com/q.pdf', answerPdfUrl: 'https://example.com/a.pdf',
      })],
      questions: { rh1: [
        { id: 'q1', no: 1, number: 1, page: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
        { id: 'q2', no: 2, number: 2, page: 2, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      ] },
      attempts: [{
        id: 'attRH1', examId: 'rh1', examTitle: 'ชุดทดสอบหัวข้อ', examSubject: 'คณิตศาสตร์',
        examType: 'mc', weighted: false, takerName: 'เด็กทดสอบ',
        startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date().toISOString(),
        usedSeconds: 60, score: 1, total: 2, answers: { q1: 'A', q2: 'A' },
        perQuestion: [
          { qid: 'q1', no: 1, page: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
          { qid: 'q2', no: 2, page: 2, chosen: 'A', correct: 'B', isCorrect: false, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
        ],
        practiceMode: false, visitOrder: ['q1', 'q2'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
      }],
    }),
  });
  await page.evaluate(() => navigate('review', { attemptId: 'attRH1' }));
  await page.waitForTimeout(600);

  check('reviewHeaderStuck: .reviewPdfWrap เป็น containing block (position:relative)',
    (await page.evaluate(() => getComputedStyle(document.querySelector('#page-review .reviewPdfWrap')).position)) === 'relative');

  await page.evaluate(() => document.getElementById('reviewTabAnswer').click());
  await page.waitForTimeout(600);
  const afterTab = await page.evaluate(() => {
    const p = document.getElementById('page-review');
    const back = [...document.querySelectorAll('#page-review button')].find(b => b.textContent.includes('ผลฝึกซ้อม'));
    const r = back ? back.getBoundingClientRect() : null;
    return { scrollTop: p.scrollTop, overflow: p.scrollHeight - p.clientHeight,
      backVisible: r ? (r.top >= 0 && r.bottom <= window.innerHeight) : false };
  });
  check('reviewHeaderStuck: กดแท็บเฉลยแล้วหน้าไม่เกิด scroll overflow + ปุ่มย้อนกลับยังอยู่ในจอ',
    afterTab.overflow <= 1 && afterTab.scrollTop === 0 && afterTab.backVisible === true, JSON.stringify(afterTab));

  // stress: มี element สูงเกินใน PDF pane แล้วสั่ง scrollIntoView — หน้า/หน้าต่างต้องไม่ถูกดึงตาม
  const stress = await page.evaluate(() => {
    const viewer = document.getElementById('reviewAnswerPdfViewer');
    const probe = document.createElement('div');
    probe.style.cssText = 'height:2000px;width:10px;';
    viewer.appendChild(probe);
    probe.scrollIntoView({ block: 'start' });
    const res = { pageScrollTop: document.getElementById('page-review').scrollTop, winScrollY: window.scrollY };
    probe.remove();
    return res;
  });
  check('reviewHeaderStuck: element สูงเกินใน PDF pane ไม่ทำให้หน้า/หน้าต่างเลื่อนตาม',
    stress.pageScrollTop === 0 && stress.winScrollY === 0, JSON.stringify(stress));

  // ทดสอบ scrollToPage จริง (stub pdfjsLib) — ต้องเลื่อนแค่ scrollArea ของ viewer เอง
  const scrollRes = await page.evaluate(async () => {
    window.pdfjsLib = { getDocument: () => ({ promise: Promise.resolve({
      numPages: 5,
      getPage: () => Promise.resolve({
        getViewport: ({ scale = 1 }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve() }), cleanup() {},
      }),
    }) }) };
    const outer = document.createElement('div');
    outer.style.cssText = 'height:400px;overflow:auto;';
    const spacer = document.createElement('div'); spacer.style.cssText = 'height:300px;';
    const host = document.createElement('div'); host.id = '_pdfScrollProbe';
    host.style.cssText = 'width:600px;height:300px;';
    outer.appendChild(spacer); outer.appendChild(host); document.body.appendChild(outer);

    const v = PdfViewer.create('_pdfScrollProbe');
    await v.loadUrl('https://example.com/fake.pdf', 1);
    await new Promise(r => setTimeout(r, 400));
    const afterLoad = { outer: outer.scrollTop, win: window.scrollY };

    outer.scrollTop = 0; window.scrollTo(0, 0);
    await v.setPage(4);
    await new Promise(r => setTimeout(r, 2000)); // รอ smooth scroll จบ
    const area = host.firstElementChild;
    const pg4 = document.getElementById('_pdfScrollProbe-page-4');
    const res = {
      pages: host.querySelectorAll('[id^="_pdfScrollProbe-page-"]').length,
      afterLoad, innerScroll: Math.round(area.scrollTop),
      align: Math.round(pg4.getBoundingClientRect().top - area.getBoundingClientRect().top),
      outerAfterJump: outer.scrollTop, winAfterJump: window.scrollY,
    };
    outer.remove();
    return res;
  });
  check('reviewHeaderStuck: loadUrl/setPage เลื่อนเฉพาะ scrollArea ของ viewer ไม่ดึงกล่องนอก/หน้าต่าง',
    scrollRes.pages === 5 && scrollRes.afterLoad.outer === 0 && scrollRes.afterLoad.win === 0 &&
    scrollRes.outerAfterJump === 0 && scrollRes.winAfterJump === 0, JSON.stringify(scrollRes));
  check('reviewHeaderStuck: setPage(4) เลื่อนไปจัดหน้า 4 ชิดขอบบน scrollArea ถูกต้อง',
    scrollRes.innerScroll > 0 && Math.abs(scrollRes.align) <= 12, JSON.stringify(scrollRes));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: reviewTabReset (v48.29) — ดูแท็บ "เฉลย" → กด back → เข้าดูใหม่ แล้ว PDF
// โผล่ซ้อนกัน 2 ชุด (โจทย์+เฉลย คนละครึ่งจอ) เพราะ #page-review ไม่ถูกสร้างใหม่ทุกครั้ง
// ที่ navigate สถานะแท็บจากรอบก่อนจึงค้าง แล้วชนกับ loadReviewPdf() ที่เขียนทับ cssText
// ฝั่งโจทย์ให้กลับมามองเห็น — พ่วงบั๊กร้ายกว่า: เปิดชุดที่ไม่มีเฉลย กลับเห็นเฉลยของชุดก่อน
// ─────────────────────────────────────────────────────────────────
currentSection = 'reviewTabReset';
{
  const mkAtt = (id, examId, title) => ({
    id, examId, examTitle: title, examSubject: 'คณิตศาสตร์', examType: 'mc', weighted: false,
    takerName: 'เด็กทดสอบ', startedAt: new Date(Date.now() - 60000).toISOString(),
    submittedAt: new Date().toISOString(), usedSeconds: 60, score: 1, total: 1, answers: { q1: 'A' },
    perQuestion: [{ qid: 'q1', no: 1, page: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 }],
    practiceMode: false, visitOrder: ['q1'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
  });
  const { ctx, page } = await newSeededPage({
    viewport: { width: 1180, height: 788 },
    cache: baseCache({
      exams: [
        mkExam('rt1', 'ชุดมีเฉลย', 'คณิตศาสตร์', { pdfUrl: 'https://example.com/q1.pdf', answerPdfUrl: 'https://example.com/a1.pdf' }),
        mkExam('rt2', 'ชุดไม่มีเฉลย', 'คณิตศาสตร์', { order: 2, pdfUrl: 'https://example.com/q2.pdf' }),
      ],
      questions: { rt1: mkQ(), rt2: mkQ() },
      attempts: [mkAtt('attRT1', 'rt1', 'ชุดมีเฉลย'), mkAtt('attRT2', 'rt2', 'ชุดไม่มีเฉลย')],
    }),
  });
  const viewerState = () => page.evaluate(() => {
    const st = (id) => {
      const el = document.getElementById(id); const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { inFlow: cs.position !== 'absolute' && cs.visibility !== 'hidden' && r.height > 0, visibility: cs.visibility, position: cs.position, h: Math.round(r.height) };
    };
    return { q: st('reviewPdfViewer'), a: st('reviewAnswerPdfViewer') };
  });

  await page.evaluate(() => navigate('review', { attemptId: 'attRT1' }));
  await page.waitForTimeout(600);
  const s1 = await viewerState();
  check('reviewTabReset: เข้าครั้งแรกโชว์แค่ PDF โจทย์', s1.q.inFlow === true && s1.a.inFlow === false, JSON.stringify(s1));

  await page.evaluate(() => document.getElementById('reviewTabAnswer').click());
  await page.waitForTimeout(600);
  const s2 = await viewerState();
  check('reviewTabReset: กดแท็บเฉลยแล้วโชว์แค่ PDF เฉลย', s2.a.inFlow === true && s2.q.inFlow === false, JSON.stringify(s2));

  // ออกไปหน้าอื่นแล้วกลับเข้ามาใหม่ — จุดที่บั๊กเกิด
  await page.evaluate(() => navigate('stats', {}));
  await page.waitForTimeout(400);
  await page.evaluate(() => navigate('review', { attemptId: 'attRT1' }));
  await page.waitForTimeout(700);
  const s3 = await viewerState();
  const tabs = await page.evaluate(() => ({
    q: document.getElementById('reviewTabQuestion').style.background,
    a: document.getElementById('reviewTabAnswer').style.background,
  }));
  check('reviewTabReset: กลับเข้าดูใหม่ต้องโชว์แค่ PDF โจทย์ ไม่ซ้อนกัน 2 ชุด',
    s3.q.inFlow === true && s3.a.inFlow === false, JSON.stringify(s3));
  check('reviewTabReset: กลับเข้าดูใหม่ ปุ่มแท็บกลับไปไฮไลท์ "โจทย์" ตรงกับที่แสดงจริง',
    tabs.q === 'rgb(17, 17, 17)' && tabs.a === 'rgb(255, 255, 255)', JSON.stringify(tabs));

  // ข้ามชุด: ดูเฉลยชุดแรก แล้วไปเปิดชุดที่ไม่มี PDF เฉลย
  await page.evaluate(() => document.getElementById('reviewTabAnswer').click());
  await page.waitForTimeout(500);
  await page.evaluate(() => navigate('review', { attemptId: 'attRT2' }));
  await page.waitForTimeout(700);
  const s4 = await viewerState();
  const tabAHidden = await page.evaluate(() => document.getElementById('reviewTabAnswer').style.display);
  check('reviewTabReset: เปิดชุดที่ไม่มีเฉลย ต้องไม่มี PDF เฉลยของชุดก่อนค้างโชว์ (เห็นเฉลยผิดชุด)',
    s4.a.inFlow === false && s4.q.inFlow === true && tabAHidden === 'none', JSON.stringify({ ...s4, tabAHidden }));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: reviewQuestionTime (v48.46) — เพิ่ม badge "เวลาที่ใช้ทำข้อนี้" ต่อแถวใน
// หน้าทบทวน — elapsedMs มีอยู่แล้วในระบบตั้งแต่หน้า take (enterQuestion/leaveQuestion)
// งานนี้แค่เอามาโชว์ ต้องเช็คว่า format ถูกต้อง (MM:SS), ข้อที่ไม่มีข้อมูล (จาก
// initPractice/backfill) ไม่โชว์ "00:00" หลอกๆ, badge ถูก-ผิดเดิมยังถูกต้องหลัง
// รวมจุด lookup att.perQuestion เป็นตัวแปรเดียว (pq), และไม่ overflow แนวนอนที่จอแคบ
// ─────────────────────────────────────────────────────────────────
currentSection = 'reviewQuestionTime';
{
  const cache = baseCache({
    exams: [mkExam('rqt1', 'ชุดทดสอบเวลา', 'คณิตศาสตร์', { questionCount: 4 })],
    questions: { rqt1: [
      { id: 'q1', no: 1, number: 1, page: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'q2', no: 2, number: 2, page: 1, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'q3', no: 3, number: 3, page: 1, correct: 'C', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'q4', no: 4, number: 4, page: 1, correct: 'D', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
    ] },
    attempts: [{
      id: 'attRQT1', examId: 'rqt1', examTitle: 'ชุดทดสอบเวลา', examSubject: 'คณิตศาสตร์',
      examType: 'mc', weighted: false, takerName: 'เด็กทดสอบ',
      startedAt: new Date(Date.now() - 120000).toISOString(), submittedAt: new Date().toISOString(),
      usedSeconds: 120, score: 3, total: 4, answers: { q1: 'A', q2: 'B', q3: 'C', q4: 'A' },
      perQuestion: [
        { qid: 'q1', no: 1, page: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 5000, changes: 0 },
        { qid: 'q2', no: 2, page: 1, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 45230, changes: 1 },
        { qid: 'q3', no: 3, page: 1, chosen: 'C', correct: 'C', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 65000, changes: 0 },
        // q4: ไม่มี elapsedMs เลย — จำลอง attempt จาก initPractice/backfill ที่ไม่เก็บเวลา
        { qid: 'q4', no: 4, page: 1, chosen: 'A', correct: 'D', isCorrect: false, isFree: false, unsure: false, visited: true, changes: 0 },
      ],
      practiceMode: false, visitOrder: ['q1', 'q2', 'q3', 'q4'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
    }],
  });
  const { ctx, page } = await newSeededPage({ cache, viewport: { width: 1180, height: 900 } });
  await page.evaluate(() => navigate('review', { attemptId: 'attRQT1' }));
  await page.waitForTimeout(600);

  const rows = await page.evaluate(() => [1, 2, 3, 4].map(no => {
    const row = document.getElementById('rq-' + no).querySelector('.qRow');
    const badge = row.querySelector('.qBadge');
    const rowRect = row.getBoundingClientRect(), badgeRect = badge.getBoundingClientRect();
    return { no, text: row.textContent, hasClock: row.textContent.includes('⏱'), badgeRight: Math.round(badgeRect.right), rowRight: Math.round(rowRect.right) };
  }));
  check('reviewQuestionTime: ข้อ 1 (elapsedMs=5000) โชว์ 00:05', rows[0].text.includes('00:05'), rows[0].text);
  check('reviewQuestionTime: ข้อ 2 (elapsedMs=45230) โชว์ 00:45', rows[1].text.includes('00:45'), rows[1].text);
  check('reviewQuestionTime: ข้อ 3 (elapsedMs=65000) โชว์ 01:05', rows[2].text.includes('01:05'), rows[2].text);
  check('reviewQuestionTime: ข้อ 4 (ไม่มี elapsedMs) ไม่โชว์ badge เวลาเลย ไม่ใช่ "00:00"',
    !rows[3].hasClock && !rows[3].text.includes('00:00'), rows[3].text);
  check('reviewQuestionTime: badge ถูก-ผิด ยังชิดขวาสุดของแถวเหมือนเดิมทุกแถว (ไม่กระทบจากการรวม pq lookup)',
    rows.every(r => (r.rowRight - r.badgeRight) <= 4), JSON.stringify(rows.map(r => [r.rowRight, r.badgeRight])));
  const badgeTexts = await page.evaluate(() => [1, 2, 3, 4].map(no => document.getElementById('rq-' + no).querySelector('.qBadge').textContent.trim()));
  check('reviewQuestionTime: badge text ยังถูกต้องตาม isCorrect เดิม (ถูก/ถูก/ถูก/ผิด)',
    badgeTexts[0].includes('ถูก') && badgeTexts[1].includes('ถูก') && badgeTexts[2].includes('ถูก') && badgeTexts[3].includes('ผิด'),
    JSON.stringify(badgeTexts));
  await ctx.close();

  // จอแคบ (390px) + fillblank-num ที่มีค่าเปลี่ยนยาว (worst-case width) ต้องไม่ overflow แนวนอน
  const cache2 = baseCache({
    exams: [mkExam('rqt2', 'ชุดทดสอบเวลา (fillblank)', 'คณิตศาสตร์', { questionCount: 1, examType: 'fillblank-num', numDigits: 4 })],
    questions: { rqt2: [{ id: 'q1', no: 1, number: 1, page: 1, correct: '1296' }] },
    attempts: [{
      id: 'attRQT2', examId: 'rqt2', examTitle: 'ชุดทดสอบเวลา (fillblank)', examSubject: 'คณิตศาสตร์',
      examType: 'fillblank-num', weighted: false, takerName: 'เด็กทดสอบ',
      startedAt: new Date(Date.now() - 125000).toISOString(), submittedAt: new Date().toISOString(),
      usedSeconds: 125, score: 0, total: 1, answers: { q1: '1440' },
      perQuestion: [{ qid: 'q1', no: 1, page: 1, chosen: '1440', correct: '1296', isCorrect: false, isFree: false, unsure: true, visited: true, elapsedMs: 125000, changes: 3 }],
      practiceMode: true, visitOrder: ['q1'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
    }],
  });
  const { ctx: ctx2, page: page2 } = await newSeededPage({ cache: cache2, viewport: { width: 390, height: 844 } });
  await page2.evaluate(() => navigate('review', { attemptId: 'attRQT2' }));
  await page2.waitForTimeout(600);
  const overflowInfo = await page2.evaluate(() => {
    const list = document.getElementById('reviewQList');
    return [...list.querySelectorAll('.qRow')].map(r => ({ scrollWidth: r.scrollWidth, clientWidth: r.parentElement.clientWidth }));
  });
  check('reviewQuestionTime: จอแคบ 390px มี pills ยาว (1440→1296) + time badge (02:05) ไม่ overflow แนวนอน',
    overflowInfo.every(r => r.scrollWidth <= r.clientWidth + 2), JSON.stringify(overflowInfo));
  await ctx2.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: reviewPracticeShortcut (v48.49) — เพิ่มปุ่ม "แก้จุดอ่อนชุดนี้" ในหน้าทบทวน
// เชื่อม review → practice ตรงๆ (ก่อนหน้านี้ต้องกลับไปหน้า exams รอ badge ก่อนถึงจะกดแก้
// จุดอ่อนได้) — ต้องเช็คว่าโชว์เฉพาะเจ้าของ attempt ที่เป็นนักเรียนและมีจุดอ่อนค้างจริง
// (กันครู/กันดูของคนอื่นแล้วดึงจุดอ่อนของผู้ดูเองมาแทน)
// ─────────────────────────────────────────────────────────────────
currentSection = 'reviewPracticeShortcut';
{
  const examQuestions = [
    { id: 'q1', no: 1, number: 1, page: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
    { id: 'q2', no: 2, number: 2, page: 1, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
    { id: 'q3', no: 3, number: 3, page: 1, correct: 'C', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
  ];
  const baseAttempt = (over = {}) => ({
    id: 'attRPB1', examId: 'rpb1', examTitle: 'ชุดทดสอบแก้จุดอ่อน', examSubject: 'คณิตศาสตร์',
    examType: 'mc', weighted: false, takerName: 'เด็กทดสอบ',
    startedAt: new Date(Date.now() - 60000).toISOString(), submittedAt: new Date().toISOString(),
    usedSeconds: 60, score: 1, total: 3, answers: { q1: 'A', q2: 'A', q3: 'A' },
    perQuestion: [
      { qid: 'q1', no: 1, page: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
      { qid: 'q2', no: 2, page: 1, chosen: 'A', correct: 'B', isCorrect: false, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
      { qid: 'q3', no: 3, page: 1, chosen: 'A', correct: 'C', isCorrect: false, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
    ],
    practiceMode: false, visitOrder: ['q1', 'q2', 'q3'], difficulty: 'develop', mood: null, feeling: null, prediction: null,
    ...over,
  });

  // owner เป็นนักเรียน + มีจุดอ่อนค้าง → ปุ่มโชว์พร้อมจำนวนข้อ, กดแล้วไปหน้า practice ของ exam เดียวกัน
  {
    const cache = baseCache({
      exams: [mkExam('rpb1', 'ชุดทดสอบแก้จุดอ่อน', 'คณิตศาสตร์', { questionCount: 3 })],
      questions: { rpb1: examQuestions },
      attempts: [baseAttempt()],
    });
    const { ctx, page } = await newSeededPage({ role: 'student', name: 'เด็กทดสอบ', cache });
    await page.evaluate(() => WeaknessTracker.updateWeaknessAfterSubmit({
      takerName: 'เด็กทดสอบ', examId: 'rpb1', examTitle: 'ชุดทดสอบแก้จุดอ่อน', examSubject: 'คณิตศาสตร์',
      submittedAt: new Date().toISOString(),
      perQuestion: [{ no: 1, isCorrect: true }, { no: 2, isCorrect: false }, { no: 3, isCorrect: false }],
    }));
    await page.evaluate(() => navigate('review', { attemptId: 'attRPB1' }));
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => {
      const btn = document.getElementById('reviewPracticeBtn');
      return { display: btn.style.display, text: btn.textContent };
    });
    check('reviewPracticeShortcut: owner+จุดอ่อนค้าง → ปุ่มโชว์', info.display !== 'none', JSON.stringify(info));
    check('reviewPracticeShortcut: ข้อความมีจำนวนข้อถูกต้อง (2 ข้อ)', info.text.includes('2 ข้อ'), info.text);

    await page.click('#reviewPracticeBtn');
    await page.waitForTimeout(500);
    const nav = await page.evaluate(() => ({
      active: document.querySelector('.page.active')?.id,
      examId: _pracState?.exam?.id,
    }));
    check('reviewPracticeShortcut: กดแล้วไปหน้า practice ของ exam เดียวกัน',
      nav.active === 'page-practice' && nav.examId === 'rpb1', JSON.stringify(nav));
    await ctx.close();
  }

  // ไม่มีจุดอ่อนค้าง (ทำถูกหมด) → ปุ่มไม่โชว์เลย
  {
    const cache = baseCache({
      exams: [mkExam('rpb2', 'ชุดทำถูกหมด', 'คณิตศาสตร์', { questionCount: 3 })],
      questions: { rpb2: examQuestions },
      attempts: [baseAttempt({
        id: 'attRPB2', examId: 'rpb2', score: 3,
        perQuestion: [
          { qid: 'q1', no: 1, page: 1, chosen: 'A', correct: 'A', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
          { qid: 'q2', no: 2, page: 1, chosen: 'B', correct: 'B', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
          { qid: 'q3', no: 3, page: 1, chosen: 'C', correct: 'C', isCorrect: true, isFree: false, unsure: false, visited: true, elapsedMs: 1000, changes: 0 },
        ],
      })],
    });
    const { ctx, page } = await newSeededPage({ role: 'student', name: 'เด็กทดสอบ', cache });
    await page.evaluate(() => navigate('review', { attemptId: 'attRPB2' }));
    await page.waitForTimeout(500);
    const display = await page.evaluate(() => document.getElementById('reviewPracticeBtn').style.display);
    check('reviewPracticeShortcut: ไม่มีจุดอ่อนค้าง → ปุ่มไม่โชว์', display === 'none', display);
    await ctx.close();
  }

  // ครูเปิดดู attempt ของนักเรียน (มีจุดอ่อนค้างจริง) → ปุ่มไม่โชว์ (กันดึงจุดอ่อนของครูเองมาแทน
  // เพราะ initPractice() ใช้ Auth.getName() เป็น userId เสมอ ไม่ใช่ att.takerName)
  {
    const cache = baseCache({
      exams: [mkExam('rpb3', 'ชุดครูดู', 'คณิตศาสตร์', { questionCount: 3 })],
      questions: { rpb3: examQuestions },
      attempts: [baseAttempt({ id: 'attRPB3', examId: 'rpb3', takerName: 'เด็กA' })],
    });
    const { ctx, page } = await newSeededPage({ role: 'teacher', name: 'ครูใหญ่', cache });
    await page.evaluate(() => WeaknessTracker.updateWeaknessAfterSubmit({
      takerName: 'เด็กA', examId: 'rpb3', examTitle: 'ชุดครูดู', examSubject: 'คณิตศาสตร์',
      submittedAt: new Date().toISOString(),
      perQuestion: [{ no: 1, isCorrect: true }, { no: 2, isCorrect: false }, { no: 3, isCorrect: false }],
    }));
    await page.evaluate(() => navigate('review', { attemptId: 'attRPB3' }));
    await page.waitForTimeout(500);
    const display = await page.evaluate(() => document.getElementById('reviewPracticeBtn').style.display);
    check('reviewPracticeShortcut: ครูดู attempt นักเรียน (มีจุดอ่อนจริง) → ปุ่มไม่โชว์', display === 'none', display);
    await ctx.close();
  }

  // นักเรียนเปิดดู attempt ของคนอื่น (ชื่อไม่ตรง) → ปุ่มไม่โชว์
  {
    const cache = baseCache({
      exams: [mkExam('rpb4', 'ชุดของคนอื่น', 'คณิตศาสตร์', { questionCount: 3 })],
      questions: { rpb4: examQuestions },
      attempts: [baseAttempt({ id: 'attRPB4', examId: 'rpb4', takerName: 'เด็กB' })],
    });
    const { ctx, page } = await newSeededPage({ role: 'student', name: 'เด็กC', cache });
    await page.evaluate(() => WeaknessTracker.updateWeaknessAfterSubmit({
      takerName: 'เด็กB', examId: 'rpb4', examTitle: 'ชุดของคนอื่น', examSubject: 'คณิตศาสตร์',
      submittedAt: new Date().toISOString(),
      perQuestion: [{ no: 1, isCorrect: true }, { no: 2, isCorrect: false }, { no: 3, isCorrect: false }],
    }));
    await page.evaluate(() => navigate('review', { attemptId: 'attRPB4' }));
    await page.waitForTimeout(500);
    const display = await page.evaluate(() => document.getElementById('reviewPracticeBtn').style.display);
    check('reviewPracticeShortcut: นักเรียนดู attempt คนอื่น (ชื่อไม่ตรง) → ปุ่มไม่โชว์', display === 'none', display);
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────
// Section: editorTagCollapse (v48.51) — ซ่อนคอลัมน์ Tag ทั้งคอลัมน์บนมือถือในหน้ากรอกเฉลย
// (admin_editor) ให้ปุ่ม ก/ข/ค/ง ได้พื้นที่มากขึ้น (ไม่มี toggle — แก้ tag ได้เฉพาะบน
// Tablet/PC เท่านั้น) — ระหว่างทำ (v48.50) เจอบั๊กแฝงเดิม: table-layout:fixed กำหนดความกว้าง
// คอลัมน์จาก <th> แถวแรกเท่านั้น (ไม่สนใจ width บน <td>) และ <th> ที่ display:none (คะแนน,
// ตอนไม่เปิด weighted) ถูกตัดออกจากผังคอลัมน์ที่มองเห็นไปเลย ทำให้ตัวขับจริงของคอลัมน์ "Tag"
// คือ th:nth-child(6) ไม่ใช่ th:nth-child(5) ตามที่โค้ดเดิมเข้าใจผิดมาตลอด — เทสนี้ครอบคลุม
// ทั้งจุดที่ต้องแก้ตรงๆ และกันบั๊กแฝงนี้กลับมาไม่ให้เนียนหายไปอีกครั้ง
// ─────────────────────────────────────────────────────────────────
currentSection = 'editorTagCollapse';
{
  const cache = baseCache({
    exams: [mkExam('etc1', 'ชุดทดสอบ Tag ซ่อน', 'คณิตศาสตร์', { questionCount: 3 })],
    questions: { etc1: [
      { id: 'q1', no: 1, number: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'q2', no: 2, number: 2, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'q3', no: 3, number: 3, correct: 'C', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
    ] },
    subjectTopics: { 'คณิตศาสตร์': ['เรขาคณิต'] },
  });

  // 1) มือถือ (390px): คอลัมน์ Tag หายไปทั้งคอลัมน์ (ไม่มีแม้แต่ไอคอนให้กด) + ปุ่มเฉลยใหญ่ขึ้น
  const { ctx, page } = await newSeededPage({ cache, viewport: { width: 390, height: 844 } });
  await page.evaluate(() => navigate('admin_editor', { id: 'etc1' }));
  await page.waitForTimeout(500);
  const mobileState = await page.evaluate(() => {
    const ths = [...document.querySelectorAll('#page-admin_editor .tableBox thead th')];
    const tagTh = ths[5]; // nth-child(6) 0-indexed
    const td = document.querySelector('#editorTbody tr:first-child td:nth-child(5)');
    const btn = document.querySelector('#editorTbody tr:first-child .correctBtn');
    return {
      tagThDisplay: getComputedStyle(tagTh).display,
      tagTdDisplay: getComputedStyle(td).display,
      btnHeight: Math.round(btn.getBoundingClientRect().height),
      btnFontSize: getComputedStyle(btn).fontSize,
    };
  });
  check('editorTagCollapse: มือถือ หัวคอลัมน์ Tag ถูกซ่อนไปเลย (display:none)', mobileState.tagThDisplay === 'none', mobileState.tagThDisplay);
  check('editorTagCollapse: มือถือ เซลล์ Tag ต่อแถวถูกซ่อนไปเลย (display:none)', mobileState.tagTdDisplay === 'none', mobileState.tagTdDisplay);
  check('editorTagCollapse: มือถือ ปุ่มเฉลยสูงขึ้นกว่าของเดิม (>=38px, เดิม ~28px)', mobileState.btnHeight >= 38, mobileState.btnHeight);
  check('editorTagCollapse: มือถือ ปุ่มเฉลย font-size ใหญ่ขึ้น (17px)', mobileState.btnFontSize === '17px', mobileState.btnFontSize);
  await ctx.close();

  // 2) Tablet/PC (>600px): คอลัมน์ Tag ยังกรอก/เลือกได้ปกติทุกอย่าง ไม่ถูกซ่อน
  const { ctx: ctxD, page: pageD } = await newSeededPage({ cache, viewport: { width: 1024, height: 800 } });
  await pageD.evaluate(() => navigate('admin_editor', { id: 'etc1' }));
  await pageD.waitForTimeout(500);
  const desktopState = await pageD.evaluate(() => {
    const ths = [...document.querySelectorAll('#page-admin_editor .tableBox thead th')];
    const tagTh = ths[5];
    const td = document.querySelector('#editorTbody tr:first-child td:nth-child(5)');
    const sel = td.querySelector('select');
    return {
      tagThDisplay: getComputedStyle(tagTh).display,
      tagTdDisplay: getComputedStyle(td).display,
      selectVisible: sel && getComputedStyle(sel).display !== 'none' && sel.offsetParent !== null,
    };
  });
  check('editorTagCollapse: Tablet/PC หัวคอลัมน์ Tag ไม่ถูกซ่อน', desktopState.tagThDisplay !== 'none', desktopState.tagThDisplay);
  check('editorTagCollapse: Tablet/PC เซลล์ Tag ต่อแถวไม่ถูกซ่อน', desktopState.tagTdDisplay !== 'none', desktopState.tagTdDisplay);
  check('editorTagCollapse: Tablet/PC select เลือก tag มองเห็น/ใช้งานได้ปกติ', desktopState.selectVisible, desktopState.selectVisible);

  const tagApplied = await pageD.evaluate(() => {
    const sel = document.querySelector('#editorTbody tr:first-child select.tagSel');
    const opt = [...sel.options].find(o => o.value === 'เรขาคณิต');
    if (!opt) return { found: false };
    sel.value = 'เรขาคณิต';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const q1 = (Store.load().questions.etc1 || []).find(q => q.no === 1);
    return { found: true, tags: q1 && q1.tags };
  });
  check('editorTagCollapse: Tablet/PC เลือก tag จาก dropdown บันทึกจริงลง store',
    tagApplied.found && Array.isArray(tagApplied.tags) && tagApplied.tags.includes('เรขาคณิต'), JSON.stringify(tagApplied));
  await ctxD.close();

  // 3) โหมด weighted (เปิดระบบคะแนน, 6 คอลัมน์) — nth-child(6) คือ td ของ Tag แทน (มี td
  //    คะแนนแทรกมาก่อน) ต้องซ่อนบนมือถือเหมือนกัน และยังใช้งานได้ปกติบน Tablet/PC
  const weightedCache = baseCache({
    exams: [mkExam('etc2', 'ชุดคะแนนถ่วงน้ำหนัก', 'คณิตศาสตร์', { questionCount: 2, weighted: true })],
    questions: { etc2: [
      { id: 'q1', no: 1, number: 1, correct: 'A', points: 2, choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'q2', no: 2, number: 2, correct: 'B', points: 3, choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
    ] },
  });
  const { ctx: ctx2, page: page2 } = await newSeededPage({ cache: weightedCache, viewport: { width: 390, height: 844 } });
  await page2.evaluate(() => navigate('admin_editor', { id: 'etc2' }));
  await page2.waitForTimeout(500);
  const weightedMobile = await page2.evaluate(() => {
    const table = document.querySelector('#page-admin_editor .tableBox table');
    const td = document.querySelector('#editorTbody tr:first-child td:nth-child(6)');
    return { isWeighted: table.classList.contains('weighted'), tdDisplay: getComputedStyle(td).display };
  });
  check('editorTagCollapse: weighted table มี class weighted (6 คอลัมน์)', weightedMobile.isWeighted, JSON.stringify(weightedMobile));
  check('editorTagCollapse: weighted มือถือ เซลล์ Tag (nth-child 6) ถูกซ่อนเหมือนกัน', weightedMobile.tdDisplay === 'none', JSON.stringify(weightedMobile));
  await ctx2.close();

  const { ctx: ctx3, page: page3 } = await newSeededPage({ cache: weightedCache, viewport: { width: 1024, height: 800 } });
  await page3.evaluate(() => navigate('admin_editor', { id: 'etc2' }));
  await page3.waitForTimeout(500);
  const weightedDesktop = await page3.evaluate(() => {
    const td = document.querySelector('#editorTbody tr:first-child td:nth-child(6)');
    return { tdDisplay: getComputedStyle(td).display };
  });
  check('editorTagCollapse: weighted Tablet/PC เซลล์ Tag (nth-child 6) ไม่ถูกซ่อน', weightedDesktop.tdDisplay !== 'none', JSON.stringify(weightedDesktop));
  await ctx3.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: practiceQuestionTime (v48.47) — โหมด "แก้จุดอ่อน" (initPractice) เดิมไม่เก็บ
// elapsedMs ต่อข้อเลย ทำให้หน้าทบทวนของ attempt จากโหมดนี้ไม่เคยเห็น badge เวลา (ต่างจาก
// attempt จากหน้า take ปกติ) — เพิ่ม accumulator เดียวกับ enterQuestion()/leaveQuestion()
// ของ initTake เพราะปุ่ม number-box อนุญาตกระโดดไปมาระหว่างข้อที่ยังไม่ confirm ได้อิสระ
// ต้องสะสมเวลาข้ามหลายรอบที่แวะดูก่อน confirm จริงได้ ไม่ใช่แค่ reset ทุกครั้ง
// ─────────────────────────────────────────────────────────────────
currentSection = 'practiceQuestionTime';
{
  const cache = baseCache({
    exams: [mkExam('pqt1', 'ชุดแก้จุดอ่อนเวลา', 'คณิตศาสตร์', { pdfUrl: 'about:blank' })],
    questions: { pqt1: [
      { id: 'q1', no: 1, number: 1, page: 1, correct: 'A', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
      { id: 'q2', no: 2, number: 2, page: 1, correct: 'B', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } },
    ] },
  });
  const { ctx, page } = await newSeededPage({ role: 'student', name: 'เด็กทดสอบ', cache, viewport: { width: 1180, height: 900 } });
  await page.evaluate(() => {
    WeaknessTracker.updateWeaknessAfterSubmit({
      takerName: 'เด็กทดสอบ', examId: 'pqt1', examTitle: 'ชุดแก้จุดอ่อนเวลา', examSubject: 'คณิตศาสตร์',
      submittedAt: new Date().toISOString(),
      perQuestion: [{ no: 1, isCorrect: false }, { no: 2, isCorrect: false }],
    });
  });
  await page.evaluate(() => navigate('practice', { examId: 'pqt1' }));
  await page.waitForTimeout(600);

  const qStartTs0 = await page.evaluate(() => _pracState.qStartTs);
  check('practiceQuestionTime: qStartTs ถูกตั้งค่าตั้งแต่ข้อแรก (เริ่มจับเวลาทันทีที่เข้าโหมดแก้จุดอ่อน)',
    typeof qStartTs0 === 'number' && qStartTs0 > 0, 'qStartTs=' + qStartTs0);

  await page.click('#pracChoices .choice >> nth=0'); // A (ถูก)
  await page.waitForTimeout(320);
  await page.click('#pracConfirmBtn');
  await page.waitForTimeout(200);
  const a1 = await page.evaluate(() => _pracState.answers[0]);
  check('practiceQuestionTime: ข้อ 1 elapsedMs สมเหตุสมผลกับเวลาที่รอจริง (>=250ms, <5000ms)',
    a1 && a1.elapsedMs >= 250 && a1.elapsedMs < 5000, JSON.stringify(a1));

  const qStartTsAfterConfirm = await page.evaluate(() => _pracState.qStartTs);
  check('practiceQuestionTime: ยังอยู่หน้าฟีดแบ็กข้อ 1 (ยังไม่กด "ข้อต่อไป") qStartTs ต้อง null (ข้อ confirm แล้วไม่จับเวลาต่อ)',
    qStartTsAfterConfirm === null, 'qStartTsAfterConfirm=' + qStartTsAfterConfirm);

  await page.click('#pracNextBtn');
  await page.waitForTimeout(50);
  const qStartTs1 = await page.evaluate(() => _pracState.qStartTs);
  check('practiceQuestionTime: กด "ข้อต่อไป" เข้าข้อ 2 แล้ว qStartTs ถูกตั้งใหม่ (ไม่ inherit จากข้อ 1)',
    typeof qStartTs1 === 'number' && (Date.now() - qStartTs1) < 500, 'qStartTs1=' + qStartTs1);

  await page.waitForTimeout(180);
  await page.click('#pracNums button >> nth=0'); // กระโดดไปดูข้อ 1 (confirm แล้ว, read-only)
  await page.waitForTimeout(150);
  const q1RevisitStartTs = await page.evaluate(() => _pracState.qStartTs);
  check('practiceQuestionTime: กระโดดกลับไปดูข้อที่ confirm แล้ว (read-only) qStartTs ต้องเป็น null ไม่จับเวลาซ้ำ',
    q1RevisitStartTs === null, 'q1RevisitStartTs=' + q1RevisitStartTs);
  const q2ElapsedAfterFirstVisit = await page.evaluate(() => _pracState.qElapsedMs[2]);
  check('practiceQuestionTime: ออกจากข้อ 2 รอบแรก เวลาที่แวะดู (~180ms) ถูกสะสมเข้า qElapsedMs[2] แล้ว',
    q2ElapsedAfterFirstVisit >= 150 && q2ElapsedAfterFirstVisit < 2000, 'q2ElapsedAfterFirstVisit=' + q2ElapsedAfterFirstVisit);

  await page.click('#pracNums button >> nth=1'); // กระโดดกลับมาข้อ 2 (ยังไม่ confirm) รอบสอง
  await page.waitForTimeout(220);
  const q2ResumedStartTs = await page.evaluate(() => _pracState.qStartTs);
  check('practiceQuestionTime: กระโดดกลับมาข้อ 2 (ยังไม่ confirm) รอบที่สอง ต้องเริ่มจับเวลาใหม่ (ไม่ null)',
    typeof q2ResumedStartTs === 'number', 'q2ResumedStartTs=' + q2ResumedStartTs);

  await page.click('#pracChoices .choice >> nth=1'); // B (ถูก)
  await page.waitForTimeout(60);
  await page.click('#pracConfirmBtn');
  await page.waitForTimeout(200);
  const a2 = await page.evaluate(() => _pracState.answers.find(a => a.questionNo === 2));
  check('practiceQuestionTime: ข้อ 2 elapsedMs สะสมข้ามหลายรอบที่แวะดูก่อน confirm ถูกต้อง (>=380ms รวม 2 รอบ+ตอนตอบ, <8000ms)',
    a2 && a2.elapsedMs >= 380 && a2.elapsedMs < 8000, JSON.stringify(a2));

  await page.click('#pracNextBtn'); // เสร็จสิ้น → savePracticeSession
  await page.waitForTimeout(600);
  const savedAttempt = await page.evaluate(() => Store.load().attempts.find(a => a.mode === 'weakness_practice'));
  check('practiceQuestionTime: attempt ที่บันทึกจาก savePracticeSession มี elapsedMs>0 ทุกข้อที่ตอบจริง',
    savedAttempt && savedAttempt.perQuestion.every(p => p.elapsedMs > 0), JSON.stringify(savedAttempt && savedAttempt.perQuestion));

  await page.evaluate((id) => navigate('review', { attemptId: id }), savedAttempt.id);
  await page.waitForTimeout(600);
  const reviewRows = await page.evaluate(() => [1, 2].map(no => document.getElementById('rq-' + no)?.querySelector('.qRow')?.textContent || ''));
  check('practiceQuestionTime: หน้าทบทวนโชว์ badge เวลา "⏱" ให้ attempt จากโหมดแก้จุดอ่อนแล้ว (end-to-end, ไม่ต้องแก้ initReview เลย)',
    reviewRows.every(t => t.includes('⏱')), JSON.stringify(reviewRows));
  await ctx.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: statsPage (v48.30) — บั๊ก 3 ข้อที่เจอจากการไล่เทสหน้า "ผลการฝึกซ้อม"
//  1. ลบการ์ด "คนละครึ่ง" ที่รวมคู่แล้ว ลบแค่ครึ่งหลัง เหลือครึ่งแรกค้างเป็นการ์ดคะแนนครึ่งเดียว
//  2. auto-switch แท็บตอนแท็บที่เลือกว่าง เขียนทับแท็บที่ผู้ใช้เลือกถาวร (ล้างตัวกรองก็ไม่กลับ)
//  3. ชื่อนักเรียนที่มี " หรือ < ทำ <option> ใน dropdown ขาดกลางคัน เลือกแล้วกรองไม่เจอ
// ─────────────────────────────────────────────────────────────────
currentSection = 'statsPage';
{
  const D = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const at = (o) => ({ examSubject: 'คณิตศาสตร์', examType: 'mc', weighted: false, takerName: 'เด็กสถิติ',
    usedSeconds: 300, answers: {}, perQuestion: [], practiceMode: false, visitOrder: [], difficulty: 'develop', ...o });
  const statsCache = () => baseCache({
    exams: [
      mkExam('sxA', 'เลข ชุด A', 'คณิตศาสตร์'),
      mkExam('sxB', 'วิทย์ ชุด B', 'วิทยาศาสตร์', { order: 2 }),
    ],
    questions: { sxA: mkQ(), sxB: mkQ() },
    attempts: [
      at({ id: 's_real1', examId: 'sxA', examTitle: 'เลข ชุด A', score: 8, total: 10, startedAt: D(1), submittedAt: D(1) }),
      at({ id: 's_realB', examId: 'sxB', examTitle: 'วิทย์ ชุด B', examSubject: 'วิทยาศาสตร์', score: 5, total: 10, startedAt: D(2), submittedAt: D(2) }),
      at({ id: 's_half1', examId: 'sxA', examTitle: 'เลข ชุด A', score: 3, total: 5, startedAt: D(5), submittedAt: D(5), halfMode: true, halfQuota: 5 }),
      at({ id: 's_half2', examId: 'sxA', examTitle: 'เลข ชุด A', score: 4, total: 5, startedAt: D(4), submittedAt: D(4), halfMode: true, halfPart: 2, parentAttemptId: 's_half1', halfQuota: 5 }),
    ],
    members: [{ pin: '311257', name: 'เด็กสถิติ' }, { pin: '311258', name: 'เด็ก"<b>x' }],
  });
  const openStats = async (page) => { await page.evaluate(() => navigate('stats', {})); await page.waitForTimeout(500); };
  const cardIds = (page) => page.evaluate(() => [...document.querySelectorAll('#statsRows [data-review]')].map(b => b.getAttribute('data-review')));
  const clickTab = async (page, k) => { await page.evaluate((k) => document.querySelector(`#statsTabBar [data-tab="${k}"]`)?.click(), k); await page.waitForTimeout(300); };

  // ── 1. ลบการ์ดคนละครึ่งที่รวมคู่แล้ว ต้องลบทั้งคู่ ──
  {
    const { ctx, page } = await newSeededPage({ cache: statsCache() });
    await openStats(page);
    await clickTab(page, 'half');
    const before = await cardIds(page);
    const halfScore = await page.evaluate(() => (document.getElementById('statsRows').textContent.match(/\d+\/\d+/) || [])[0]);
    check('statsPage: แท็บคนละครึ่งรวมคู่เป็นการ์ดเดียว คะแนนรวม 7/10',
      before.length === 1 && halfScore === '7/10', JSON.stringify({ before, halfScore }));
    await page.evaluate(() => document.querySelector('#statsRows [data-del]')?.click());
    await page.waitForTimeout(250);
    await page.evaluate(() => document.getElementById('statsConfirmOk').click());
    await page.waitForTimeout(450);
    const left = await page.evaluate(() => (Store.load().attempts || []).map(a => a.id));
    check('statsPage: ลบการ์ดคนละครึ่ง → ลบทั้งคู่ ไม่เหลือครึ่งแรกค้างเป็นการ์ดคะแนนครึ่งเดียว',
      !left.includes('s_half1') && !left.includes('s_half2') && left.includes('s_real1'), JSON.stringify(left));
    await ctx.close();
  }

  // ── 2. ชื่อนักเรียนที่มีอักขระพิเศษต้องไม่ทำ dropdown ขาด ──
  {
    const { ctx, page } = await newSeededPage({ cache: statsCache() });
    await openStats(page);
    const opts = await page.evaluate(() => [...document.getElementById('statsFilterStudent').options].map(o => o.value));
    check('statsPage: ชื่อนักเรียนที่มี " และ < อยู่ใน dropdown ครบ ไม่ถูกตัดกลางคัน',
      opts.includes('เด็ก"<b>x'), JSON.stringify(opts));
    await ctx.close();
  }

  // ── 3. auto-switch แท็บต้องไม่แย่งแท็บที่ผู้ใช้เลือกถาวร ──
  {
    const { ctx, page } = await newSeededPage({ cache: statsCache() });
    await openStats(page);
    await clickTab(page, 'half');
    const picked = await page.evaluate(() => _statsState.activeTab);
    const setSubject = async (v) => { await page.evaluate((v) => { const s = document.getElementById('statsFilterSubject'); s.value = v; s.dispatchEvent(new Event('change')); }, v); await page.waitForTimeout(350); };
    await setSubject('วิทยาศาสตร์');   // แท็บคนละครึ่งว่าง → สลับให้ชั่วคราว
    const during = await page.evaluate(() => ({ state: _statsState.activeTab, shown: document.querySelector('#statsTabBar [data-tab][style*="800"]')?.getAttribute('data-tab') }));
    await setSubject('all');            // ล้างตัวกรอง
    const after = await page.evaluate(() => _statsState.activeTab);
    check('statsPage: กรองจนแท็บว่าง → สลับแสดงชั่วคราวได้ แต่ไม่เขียนทับแท็บที่ผู้ใช้เลือก',
      picked === 'half' && during.state === 'half' && during.shown === 'real', JSON.stringify({ picked, during }));
    check('statsPage: ล้างตัวกรองแล้วกลับไปแท็บ "คนละครึ่ง" ที่ผู้ใช้เลือกไว้เอง',
      after === 'half', JSON.stringify({ picked, after }));
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────
// Section: statsDuo (v48.64p, preview) — หน้าผลการฝึกซ้อมส่วนบนใหม่ (แบบ 1B): ไทล์ 4 ใบ +
// ตารางคะแนนรายวิชา + ล่าสุด — ตาราง: คอลัมน์ = ลำดับครั้งของแต่ละวิชาเอง ชิดขวา (ช่องขวาสุด =
// ครั้งล่าสุด) วันที่อยู่ในช่อง เพราะแต่ละวิชาทำคนละวัน; ไม่รวมแก้จุดอ่อน, คนละครึ่งนับเป็น 1 ครั้ง
// ─────────────────────────────────────────────────────────────────
currentSection = 'statsDuo';
{
  const DAY = 86400000;
  function duoCache(now, extraAttempts = []) {
    const exams = [], attempts = [];
    const plan = [
      ['คณิตศาสตร์', 'm', [45, 55, 40, 60, 65, 55, 70, 80, 75], [26, 23, 20, 17, 14, 11, 8, 5, 2]],
      ['วิทยาศาสตร์', 's', [70, 65, 80, 85, 75, 80], [22, 18, 15, 10, 6, 1]],
      ['ภาษาอังกฤษ', 'e', [80, 85, 90, 85, 90, 95, 85, 95], [25, 21, 19, 16, 12, 9, 4, 0]],
    ];
    for (const [subj, k, pcts, ago] of plan) pcts.forEach((p, i) => {
      const id = `${k}${i + 1}`;
      exams.push(mkExam(id, `${subj} ชุดที่ ${i + 1}`, subj, { questionCount: 20 }));
      attempts.push({ id: 'att_' + id, examId: id, examTitle: `${subj} ชุดที่ ${i + 1}`, examSubject: subj, takerName: 'นนท์',
        startedAt: new Date(now - ago[i] * DAY).toISOString(), submittedAt: new Date(now - ago[i] * DAY).toISOString(),
        usedSeconds: 1500, score: p / 5, total: 20, perQuestion: [], practiceMode: false });
    });
    // คนละครึ่ง 1 คู่ (ต้องรวมเป็น 1 ช่อง 75%) + แก้จุดอ่อน 1 ครั้ง (ต้องไม่ขึ้นในตาราง)
    exams.push(mkExam('t1', 'ภาษาไทย ชุดที่ 1', 'ภาษาไทย', { questionCount: 20 }));
    const t3 = new Date(now - 3 * DAY).toISOString();
    attempts.push({ id: 'att_t1a', examId: 't1', examTitle: 'ภาษาไทย ชุดที่ 1', examSubject: 'ภาษาไทย', takerName: 'นนท์', halfMode: true, halfPart: 1, startedAt: t3, score: 8, total: 10, perQuestion: [] });
    // ครึ่งหลังเริ่มหลังครึ่งแรกเสมอในข้อมูลจริง — mergeHalfModePairs พึ่งลำดับนี้ (เรียงใหม่→เก่า)
    attempts.push({ id: 'att_t1b', examId: 't1', examTitle: 'ภาษาไทย ชุดที่ 1', examSubject: 'ภาษาไทย', takerName: 'นนท์', halfMode: true, halfPart: 2, parentAttemptId: 'att_t1a', startedAt: new Date(now - 3 * DAY + 3600000).toISOString(), score: 7, total: 10, perQuestion: [] });
    attempts.push({ id: 'att_wp', examId: 'm1', examTitle: 'แก้จุดอ่อน', examSubject: 'คณิตศาสตร์', takerName: 'นนท์', mode: 'weakness_practice', startedAt: t3, score: 3, total: 5, perQuestion: [] });
    // m6 (55%, 11 วันก่อน) ถูกแก้จุดอ่อนทีหลัง (2 วันก่อน, อยู่หลัง m6 เอง) → ต้องขึ้น ✓ ที่ช่อง m6
    attempts.push({ id: 'att_wp_m6', examId: 'm6', examTitle: 'แก้จุดอ่อน', examSubject: 'คณิตศาสตร์', takerName: 'นนท์', mode: 'weakness_practice', startedAt: new Date(now - 2 * DAY).toISOString(), score: 4, total: 5, perQuestion: [] });
    return baseCache({ exams, attempts: attempts.concat(extraAttempts) });
  }

  // ── iPad แนวนอน ──
  const now = Date.now();
  const { ctx, page } = await newSeededPage({ cache: duoCache(now), viewport: { width: 1180, height: 820 }, file: 'index.html' });
  await page.evaluate(() => navigate('stats'));
  await page.waitForTimeout(500);
  const d = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#statsDuo .sd-tile')].map(t => t.textContent.replace(/\s+/g, ' ').trim());
    const rows = [...document.querySelectorAll('#statsDuo .sd-row')].map(r => ({
      name: r.querySelector('.sd-sn').textContent,
      empties: r.querySelectorAll('.sd-emptycell').length,
      cells: [...r.querySelectorAll('button.sd-cell')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      lastIsLatest: r.querySelector('.sd-cells').lastElementChild.classList.contains('sd-last'),
    }));
    return { tiles, rows, recent: document.querySelectorAll('#statsDuo .sd-rc').length };
  });
  const allPcts = [45, 55, 40, 60, 65, 55, 70, 80, 75, 70, 65, 80, 85, 75, 80, 80, 85, 90, 85, 90, 95, 85, 95, 75];
  const expAvg = Math.round(allPcts.reduce((a, b) => a + b, 0) / allPcts.length);
  check('statsDuo: ไทล์ชุดล่าสุด = 19/20 ภาษาอังกฤษ', d.tiles[0] && d.tiles[0].includes('19/20') && d.tiles[0].includes('ภาษาอังกฤษ'), d.tiles[0]);
  check(`statsDuo: ไทล์เฉลี่ย = ${expAvg}% (คนละครึ่งรวมเป็น 1 ครั้ง, ไม่รวมแก้จุดอ่อน)`, d.tiles[1] && d.tiles[1].includes(expAvg + '%'), d.tiles[1]);
  check('statsDuo: ไทล์จำนวน = 24 ชุด', d.tiles[2] && d.tiles[2].includes('24 ชุด'), d.tiles[2]);
  check('statsDuo: ไทล์ทำติดต่อกัน = 7 วัน (นับวันที่ทำแก้จุดอ่อนด้วย)', d.tiles[3] && d.tiles[3].includes('7 วัน'), d.tiles[3]);
  check('statsDuo: เรียงวิชาตามลำดับ SUBJ_COLOR (คณิต/วิทย์/ไทย/อังกฤษ)', JSON.stringify(d.rows.map(r => r.name)) === JSON.stringify(['คณิตศาสตร์', 'วิทยาศาสตร์', 'ภาษาไทย', 'ภาษาอังกฤษ']), JSON.stringify(d.rows.map(r => r.name)));
  const math = d.rows[0], sci = d.rows[1], thai = d.rows[2];
  check('statsDuo: คณิต 9 ครั้ง → โชว์ 8 ครั้งล่าสุด (ครั้งแรก 45% ถูกตัด)', math.cells.length === 8 && math.cells[0].startsWith('55%'), JSON.stringify(math.cells));
  check('statsDuo: วิทย์ 6 ครั้ง → ชิดขวา มีช่องเส้นประ 2 ช่องด้านซ้าย', sci.empties === 2 && sci.cells.length === 6, JSON.stringify(sci));
  check('statsDuo: คนละครึ่งรวมเป็นช่องเดียว 75%', thai.cells.length === 1 && thai.cells[0].startsWith('75%'), JSON.stringify(thai));
  check('statsDuo: ช่องขวาสุดของทุกแถว = ครั้งล่าสุด (กรอบหนา)', d.rows.every(r => r.lastIsLatest), JSON.stringify(d.rows.map(r => r.lastIsLatest)));
  check('statsDuo: การ์ด "ล่าสุด" 5 ใบ', d.recent === 5, d.recent);
  const layout = await page.evaluate(() => ({
    subjAfterRows: !!(document.getElementById('statsRows').compareDocumentPosition(document.getElementById('statsSubjAvg')) & Node.DOCUMENT_POSITION_FOLLOWING),
    subjStillRenders: document.getElementById('statsSubjAvg').children.length > 0,
  }));
  check('statsDuo: การ์ดรายวิชาเดิม (#statsSubjAvg) ย้ายไปอยู่หลังรายการ และยังเรนเดอร์อยู่', layout.subjAfterRows && layout.subjStillRenders, JSON.stringify(layout));

  // ✓ badge "แก้จุดอ่อนแล้ว" — m6 (55%, 11 วันก่อน) มี weakness_practice ทีหลัง ต้องขึ้น ✓ เฉพาะช่องนั้น
  // ช่องเดียว ไม่ใช่ทุกช่อง, ไม่กระทบตัวเลข % เดิม, และมี legend อธิบายไว้ด้วย
  const badgeInfo = await page.evaluate(() => {
    // m6 = 11 วันก่อน — คำนวณวันที่จากเวลาปัจจุบัน (ห้ามฮาร์ดโค้ดเดือน ไม่งั้นพังข้ามเดือน)
    const m6d = new Date(Date.now() - 11 * 86400000).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
    const mathCells = [...document.querySelectorAll('#statsDuo .sd-row')[0].querySelectorAll('button.sd-cell')];
    return {
      totalFixedBadges: document.querySelectorAll('#statsDuo .sd-card .sd-fixed').length - 1, // -1 กัน badge ตัวอย่างใน legend
      m6HasBadge: mathCells.some(c => c.textContent.includes('55%') && c.textContent.includes(m6d) && c.querySelector('.sd-fixed')),
      m6Label: mathCells.find(c => c.textContent.includes('55%') && c.textContent.includes(m6d))?.getAttribute('aria-label') || '',
      othersClean: mathCells.filter(c => !(c.textContent.includes('55%') && c.textContent.includes(m6d))).every(c => !c.querySelector('.sd-fixed')),
      legendHasNote: document.querySelector('#statsDuo .sd-legend')?.textContent.includes('แก้จุดอ่อนแล้ว'),
    };
  });
  check('statsDuo: ✓ ขึ้นเฉพาะช่อง m6 ที่ถูกแก้จุดอ่อนทีหลังจริง (1 ช่องเดียวในทั้งตาราง)', badgeInfo.totalFixedBadges === 1 && badgeInfo.m6HasBadge, JSON.stringify(badgeInfo));
  check('statsDuo: aria-label ของช่อง m6 มีคำว่า "แก้จุดอ่อนแล้ว" ต่อท้าย', badgeInfo.m6Label.includes('แก้จุดอ่อนแล้ว'), badgeInfo.m6Label);
  check('statsDuo: ช่องอื่นๆ ในแถวคณิตไม่มี ✓ ติดมาด้วย (m1 ที่มี weakness_practice ก็ถูกตัดพ้นจอไปแล้ว)', badgeInfo.othersClean, JSON.stringify(badgeInfo));
  check('statsDuo: legend อธิบายความหมาย ✓ ไว้ด้วย', badgeInfo.legendHasNote, badgeInfo.legendHasNote);

  // ตัวเลือกนักเรียน (ครู) ย้ายขึ้นมาอยู่เหนือ #statsDuo และปรับสไตล์ตาม theme (.sd-studentbar)
  const studentBar = await page.evaluate(() => {
    const wrap = document.getElementById('statsStudentFilterWrap');
    return {
      hasClass: wrap.classList.contains('sd-studentbar'),
      aboveDuo: !!(wrap.compareDocumentPosition(document.getElementById('statsDuo')) & Node.DOCUMENT_POSITION_FOLLOWING),
      visible: getComputedStyle(wrap).display !== 'none',
      hasSelect: !!wrap.querySelector('#statsFilterStudent'),
    };
  });
  check('statsDuo: กล่องเลือกนักเรียน (.sd-studentbar) อยู่เหนือ #statsDuo และโชว์ให้ครูเห็น', studentBar.hasClass && studentBar.aboveDuo && studentBar.visible && studentBar.hasSelect, JSON.stringify(studentBar));

  // กรอง 7 วัน → เหลือเฉพาะครั้งใน 7 วัน, และต้องรอด re-render จาก Firestore listener
  await page.click('#statsPillWeek');
  await page.waitForTimeout(300);
  const weekCells = await page.evaluate(() => document.querySelectorAll('#statsDuo button.sd-cell').length);
  await page.evaluate(() => navigate('stats'));
  await page.waitForTimeout(400);
  const weekCellsAfter = await page.evaluate(() => document.querySelectorAll('#statsDuo button.sd-cell').length);
  check('statsDuo: ปุ่ม "7 วันล่าสุด" เหลือ 7 ช่อง และรอด navigate(stats) ซ้ำ', weekCells === 7 && weekCellsAfter === 7, JSON.stringify({ weekCells, weekCellsAfter }));

  // แตะช่องล่าสุดของวิทย์ → หน้าทบทวนของชุดนั้น
  await page.evaluate(() => document.querySelectorAll('#statsDuo .sd-row')[1].querySelector('.sd-last').click());
  await page.waitForTimeout(500);
  const rv = await page.evaluate(() => ({ active: document.querySelector('.page.active')?.id, title: document.getElementById('reviewTitle')?.textContent || '' }));
  check('statsDuo: แตะช่องล่าสุดวิทย์ → เปิดหน้าทบทวนชุดที่ 6', rv.active === 'page-review' && rv.title.includes('วิทยาศาสตร์ ชุดที่ 6'), JSON.stringify(rv));
  await ctx.close();

  // ── มือถือ 390px: เหลือ 4 ช่องล่าสุดต่อวิชา ไม่ล้นแนวนอน ──
  const { ctx: ctx2, page: page2 } = await newSeededPage({ cache: duoCache(Date.now()), viewport: { width: 390, height: 844 }, file: 'index.html' });
  await page2.evaluate(() => navigate('stats'));
  await page2.waitForTimeout(500);
  const mob = await page2.evaluate(() => {
    const r = document.querySelector('#statsDuo .sd-row');
    const vis = [...r.querySelectorAll('.sd-cells > *')].filter(c => c.offsetParent !== null);
    return { visible: vis.length, lastVisibleIsLatest: vis[vis.length - 1].classList.contains('sd-last'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });
  check('statsDuo: มือถือโชว์ 4 ช่องล่าสุด (ช่องสุดท้าย = ล่าสุด) และไม่ล้นแนวนอน', mob.visible === 4 && mob.lastVisibleIsLatest && mob.sw <= mob.cw, JSON.stringify(mob));
  await ctx2.close();

  // ── ครูดู "ทั้งหมด" + มีนักเรียน 2 คน → streak "—" + โน้ตรวมทุกคน; ไม่มีข้อมูล → การ์ดว่าง ──
  const other = { id: 'att_x', examId: 'm1', examTitle: 'คณิตศาสตร์ ชุดที่ 1', examSubject: 'คณิตศาสตร์', takerName: 'เด็กอีกคน', startedAt: new Date(Date.now() - DAY).toISOString(), score: 10, total: 20, perQuestion: [] };
  const { ctx: ctx3, page: page3 } = await newSeededPage({ cache: duoCache(Date.now(), [other]), viewport: { width: 1180, height: 820 }, file: 'index.html' });
  await page3.evaluate(() => navigate('stats'));
  await page3.waitForTimeout(500);
  const multi = await page3.evaluate(() => ({ streak: document.querySelectorAll('#statsDuo .sd-tile')[3]?.textContent || '', note: document.querySelector('#statsDuo .sd-ct')?.textContent || '' }));
  check('statsDuo: ครูดูทั้งหมด (2 คน) → streak "—" + โน้ต "รวมนักเรียนทุกคน"', multi.streak.includes('—') && multi.note.includes('รวมนักเรียนทุกคน'), JSON.stringify(multi));
  await page3.evaluate(() => { Store._cache.attempts = []; navigate('stats'); });
  await page3.waitForTimeout(400);
  const empty = await page3.evaluate(() => document.getElementById('statsDuo').textContent);
  check('statsDuo: ไม่มีข้อมูล → การ์ด "ยังไม่มีผลการฝึกในช่วงนี้"', empty.includes('ยังไม่มีผลการฝึกในช่วงนี้'), empty.slice(0, 80));
  await ctx3.close();

  // นักเรียน (ไม่ใช่ครู) ต้องไม่เห็นกล่องเลือกนักเรียนเลย
  const { ctx: ctx4, page: page4 } = await newSeededPage({ role: 'student', name: 'นนท์', cache: duoCache(Date.now()), viewport: { width: 1180, height: 820 }, file: 'index.html' });
  await page4.evaluate(() => navigate('stats'));
  await page4.waitForTimeout(500);
  const studentHidden = await page4.evaluate(() => getComputedStyle(document.getElementById('statsStudentFilterWrap')).display);
  check('statsDuo: นักเรียน (ไม่ใช่ครู) ไม่เห็นกล่องเลือกนักเรียน', studentHidden === 'none', studentHidden);
  await ctx4.close();
}

// ─────────────────────────────────────────────────────────────────
// Section: versionAutoUpdate (v48.44) — PWA ติดตั้งจากไอคอนโฮมสกรีน (manifest start_url
// ตายตัว "/Quiz-app/") เจอบั๊กค้างเวอร์ชันเก่าตลอด: reload ตอนกดยืนยันอัพเดทเดิมไปที่ URL
// คนละอันกับ start_url (?_v=... vs ตัวเปล่า) เลยไม่เคยล้าง cache ที่ค้างอยู่หลัง start_url
// นั้นสักที — แก้ด้วยการ auto-reload เงียบๆ เฉพาะการเช็คครั้งแรกสุดหลังเปิดแอป (ไม่มีอะไร
// ให้เสีย) ส่วนเช็ครอบถัดไป/ตอนอยู่กลางข้อสอบยังคง confirm() เหมือนเดิมทุกประการ
// หมายเหตุ: `_currentPage` เป็น page-scoped `let` (classic script แชร์ global lexical env
// เดียวกัน) ไม่ใช่ `window` property — ต้องตั้งผ่าน page.evaluate() หลังสคริปต์จริงของแอป
// รันไปแล้ว (ไม่ใช่ผ่าน addInitScript ซึ่งจะชน TDZ ก่อน `let _currentPage='home'` ของแอปเอง)
// ─────────────────────────────────────────────────────────────────
currentSection = 'versionAutoUpdate';
{
  // 1: เช็คครั้งแรกสุดหลังเปิดแอป (boot จริง) + เจอ mismatch + ไม่ได้อยู่หน้า take/practice
  //    → ต้อง auto-reload เงียบๆ (URL เปลี่ยนเป็น ?_v=...) โดยไม่เรียก confirm() เลย
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('dialog', d => d.dismiss());
    await page.addInitScript(() => {
      window._confirmCalls = 0;
      window.confirm = () => { window._confirmCalls++; return false; };
      const origFetch = window.fetch;
      window.fetch = (url, opts) => {
        if (String(url).includes('version.json')) {
          return Promise.resolve({ ok: true, json: async () => ({ version: 'v99.99' }) });
        }
        return origFetch(url, opts);
      };
    });
    const urlBefore = BASE + '/index.html';
    await page.goto(urlBefore, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200); // real load event + 500ms timer + fetch round-trip
    const urlAfter = page.url();
    const confirmCalls = await page.evaluate(() => window._confirmCalls || 0).catch(() => 0);
    check('versionAutoUpdate: เช็คแรกสุดหลังเปิดแอป + mismatch + ไม่ได้อยู่หน้า take/practice → auto-reload เงียบๆ ไม่เรียก confirm()',
      urlAfter.includes('?_v=') && confirmCalls === 0,
      'before=' + urlBefore + ' after=' + urlAfter + ' confirmCalls=' + confirmCalls);
    await ctx.close();
  }

  // 2: เช็คครั้งแรกสุด + เจอ mismatch + อยู่หน้า take (กำลังทำข้อสอบ) → ต้องเด้ง confirm()
  //    เหมือนเดิม ห้าม auto-reload ทับคนที่กำลังทำข้อสอบอยู่
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let dialogSeen = false;
    page.on('dialog', d => { dialogSeen = true; d.dismiss(); });
    await page.addInitScript(() => {
      const origFetch = window.fetch;
      window.fetch = (url, opts) => {
        if (String(url).includes('version.json')) {
          return Promise.resolve({ ok: true, json: async () => ({ version: 'v99.99' }) });
        }
        return origFetch(url, opts);
      };
    });
    const urlBefore = BASE + '/index.html';
    await page.goto(urlBefore, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { _currentPage = 'take'; });
    await page.waitForTimeout(1200);
    const urlAfter = page.url();
    check('versionAutoUpdate: เช็คแรกสุด + mismatch + อยู่หน้า take → เด้ง confirm() เหมือนเดิม ไม่ auto-reload',
      dialogSeen === true && urlAfter === urlBefore,
      'before=' + urlBefore + ' after=' + urlAfter + ' dialogSeen=' + dialogSeen);
    await ctx.close();
  }

  // 3: เช็คแรกสุดเจอเวอร์ชันตรงกัน (no-op ไม่เกิดอะไร) แล้วเช็ครอบสอง (จำลอง interval/
  //    foreground) เจอ mismatch → ต้องกลับไปใช้ confirm() เหมือนเดิม (auto-reload เงียบๆ
  //    ใช้ได้แค่ครั้งเดียวจริงๆ ไม่ใช่ทุกครั้งที่ยังไม่เคย mismatch)
  {
    // อ่าน CURRENT_VERSION จริงจากไฟล์ (ไม่ hardcode) กัน test เพี้ยนเงียบๆ ทุกครั้งที่ bump
    // เวอร์ชัน — CURRENT_VERSION เป็น const ในตัว IIFE เข้าถึงจาก page.evaluate ไม่ได้
    const _indexSrc = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const _realCurrentVersion = (_indexSrc.match(/const CURRENT_VERSION = '([^']+)'/) || [])[1];
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let dialogSeen = false;
    page.on('dialog', d => { dialogSeen = true; d.dismiss(); });
    await page.addInitScript((matchingVersion) => {
      const origFetch = window.fetch;
      let fetchCount = 0;
      window.fetch = (url, opts) => {
        if (String(url).includes('version.json')) {
          fetchCount++;
          if (fetchCount === 1) return Promise.resolve({ ok: true, json: async () => ({ version: matchingVersion }) });
          return Promise.resolve({ ok: true, json: async () => ({ version: 'v99.99' }) });
        }
        return origFetch(url, opts);
      };
    }, _realCurrentVersion);
    const urlBefore = BASE + '/index.html';
    await page.goto(urlBefore, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200); // เช็คแรกสุด (จริง) resolve แบบ no-op (ตรงกัน)
    await page.evaluate(() => window.checkVersion()); // เช็คครั้งที่สอง (manual) → mismatch
    await page.waitForTimeout(300);
    const urlAfter = page.url();
    check('versionAutoUpdate: เช็คแรกตรงกัน (no-op) แล้วเช็ครอบสอง mismatch → เด้ง confirm() ไม่ auto-reload',
      dialogSeen === true && urlAfter === urlBefore,
      'before=' + urlBefore + ' after=' + urlAfter + ' dialogSeen=' + dialogSeen);
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────
// Section: examCardIcons (v48.45) — การ์ดรายข้อสอบ (ระดับที่ 3 ของ exams page) เปลี่ยน
// emoji ทั้งหมด (📝⏱🏆⚠️🎯⏸️🤝📤🔗🧹✓▶) เป็น stroke icon จาก _ICONS/_icon() และเปลี่ยน
// สี badge แบบ pastel Tailwind เดิมเป็นโทน Apple HIG เดียวกับส่วนอื่นของหน้า — ไม่แตะ
// logic/data-attribute ใดๆ เลย (resume-ticker, assign modal, weakness reset ยังทำงานเหมือนเดิม)
// ─────────────────────────────────────────────────────────────────
currentSection = 'examCardIcons';
{
  const emojiCount = (text) => (text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  const now = Date.now();
  const iconsCache = () => baseCache({
    exams: [
      mkExam('ic1', 'เลข ชุด 1', 'คณิตศาสตร์'),
      mkExam('ic2', 'เลข ชุด 2', 'คณิตศาสตร์'),
    ],
    questions: { ic1: mkQ(), ic2: mkQ() },
    attempts: [
      { id: 'icatt1', examId: 'ic1', examTitle: 'เลข ชุด 1', examSubject: 'คณิตศาสตร์', takerName: 'เด็กทดสอบ', score: 8, total: 10, startedAt: now - 100000, submittedAt: now - 90000, usedSeconds: 300, answers: {}, perQuestion: [], mode: 'normal' },
    ],
    members: [{ pin: '311257', name: 'เด็กทดสอบ' }],
  });

  // 1: มุมมองนักเรียน — resume-badge (ค้างทำ), score-badge, ไม่มี emoji เหลือเลย
  {
    const { ctx, page } = await newSeededPage({ role: 'student', name: 'เด็กทดสอบ', cache: iconsCache(), viewport: { width: 500, height: 900 } });
    await page.evaluate((now) => {
      localStorage.setItem('nanont:takeResume:เด็กทดสอบ', JSON.stringify({
        examId: 'ic2', startedAt: now - 60000, pauseOffset: 0, pausedAt: now, practiceMode: false, halfMode: false, takerName: 'เด็กทดสอบ',
      }));
    }, now);
    await page.evaluate(() => navigate('exams'));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('#examsSubjGrid [data-subj="คณิตศาสตร์"]').click());
    await page.waitForTimeout(300);

    const examsListHtml = await page.evaluate(() => document.getElementById('examsList').innerHTML);
    check('examCardIcons: มุมมองนักเรียน — ไม่มี emoji เหลือใน #examsList เลย', emojiCount(examsListHtml) === 0, 'count=' + emojiCount(examsListHtml));

    const hasScoreBadgeSvg = await page.evaluate(() => !!document.querySelector('.score-badge svg'));
    check('examCardIcons: score-badge มี SVG icon (trophy) แทน emoji', hasScoreBadgeSvg === true);

    const resumeBadge = await page.evaluate(() => {
      const b = document.querySelector('.resume-badge');
      return b ? { hasSvg: !!b.querySelector('svg'), dataStartedAt: b.getAttribute('data-startedAt'), dataResumeId: b.getAttribute('data-resumeid') } : null;
    });
    check('examCardIcons: resume-badge มี SVG icon + data-attribute ครบ (ticker ยัง query ได้)',
      resumeBadge && resumeBadge.hasSvg && !!resumeBadge.dataStartedAt && !!resumeBadge.dataResumeId, JSON.stringify(resumeBadge));

    const resumeTimeText = await page.evaluate(() => document.querySelector('.resume-badge .resume-time')?.textContent);
    check('examCardIcons: resume-badge ticker render ค่า MM:SS ถูกต้อง (ไม่ throw)',
      /^เวลาเหลือ \d{2}:\d{2}$/.test(resumeTimeText || ''), resumeTimeText);

    await ctx.close();
  }

  // 2: มุมมองครู — admin per-student block, copy-link button, assign button
  {
    const { ctx, page } = await newSeededPage({ role: 'teacher', name: 'Admin', cache: iconsCache(), viewport: { width: 1280, height: 900 } });
    await page.evaluate(() => navigate('exams'));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('#examsSubjGrid [data-subj="คณิตศาสตร์"]').click());
    await page.waitForTimeout(300);

    const examsListHtml = await page.evaluate(() => document.getElementById('examsList').innerHTML);
    check('examCardIcons: มุมมองครู — ไม่มี emoji เหลือใน #examsList เลย', emojiCount(examsListHtml) === 0, 'count=' + emojiCount(examsListHtml));

    const copyLinkBtn = await page.evaluate(() => {
      const b = document.querySelector('[onclick^="copyExamLink"]');
      return b ? { hasSvg: !!b.querySelector('svg'), className: b.className } : null;
    });
    check('examCardIcons: ปุ่มคัดลอกลิงก์ใช้ class exam-row-icon-btn + SVG icon',
      copyLinkBtn && copyLinkBtn.hasSvg && copyLinkBtn.className.includes('exam-row-icon-btn'), JSON.stringify(copyLinkBtn));

    const assignBtnHasSvg = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.examCard button')];
      const assignBtn = btns.find(b => b.textContent.includes('ส่งให้นักเรียน'));
      return assignBtn ? !!assignBtn.querySelector('svg') : null;
    });
    check('examCardIcons: ปุ่ม "ส่งให้นักเรียน" มี SVG icon', assignBtnHasSvg === true);

    const resetBtnExists = await page.evaluate(() => !!document.querySelector('[data-resetweakness]'));
    check('examCardIcons: admin per-student block ยังโชว์ปุ่มล้างจุดอ่อนตามเดิม', resetBtnExists === true);

    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// Section: ตัวเลือกที่ 5 "จ" (ต่อข้อ) — ปุ่ม + ในหน้ากรอกเฉลย กดค้าง 2 วิ สลับ + ⇄ จ
// เก็บเป็น 'E' + q.optCount===5 ; ข้อเก่าไม่มีฟิลด์ = 4 ตัวเหมือนเดิม
// ─────────────────────────────────────────────────────────────────
currentSection = 'choiceE';
{
  const CE_FILE = 'index.html';
  const mkQE = () => [
    { id: 'q1', no: 1, number: 1, page: 1, correct: 'A', choices: { A: '', B: '', C: '', D: '' } },
    { id: 'q2', no: 2, number: 2, page: 1, correct: 'B', choices: { A: '', B: '', C: '', D: '' } },
    { id: 'q3', no: 3, number: 3, page: 1, correct: 'C', choices: { A: '', B: '', C: '', D: '' } },
  ];

  // ── editor: กดค้างสลับ + ⇄ จ ──
  {
    const { ctx, page } = await newSeededPage({
      file: CE_FILE, viewport: { width: 1280, height: 900 },
      cache: baseCache({ exams: [mkExam('ce1', 'ทดสอบ 5 ตัวเลือก', 'วิทยาศาสตร์', { questionCount: 3 })], questions: { ce1: mkQE() } }),
    });
    await page.evaluate(() => navigate('admin_editor', { id: 'ce1' }));
    await page.waitForTimeout(500);
    const cnt = await page.evaluate(() => ({
      plus: document.querySelectorAll('#editorTbody .optToggle').length,
      btns: document.querySelectorAll('#editorTbody .correctBtn').length,
    }));
    check('choiceE editor: ทุกแถวมีปุ่ม + (3) และปุ่ม ก-ง ยังมี 4 ปุ่มต่อแถว (12)', cnt.plus === 3 && cnt.btns === 12, JSON.stringify(cnt));

    const box = async (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
    const rowSel = (n, cls) => `#editorTbody tr:nth-child(${n}) ${cls}`;
    const saved = async () => { await page.evaluate(() => document.getElementById('editorSave').click()); await page.waitForTimeout(200); return page.evaluate(() => Store.load().questions['ce1'].map(q => ({ c: q.correct, o: q.optCount }))); };

    // แตะสั้น → ไม่สลับ
    await page.evaluate((s) => document.querySelector(s).click(), rowSel(1, '.optToggle'));
    check('choiceE editor: แตะ + สั้นๆ ไม่เพิ่ม จ', (await page.evaluate(() => document.querySelectorAll('#editorTbody .optE').length)) === 0);

    // ปล่อยก่อน 2 วิ → ไม่สลับ
    let p = await box(rowSel(1, '.optToggle'));
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(1400); await page.mouse.up(); await page.waitForTimeout(200);
    check('choiceE editor: กดค้างแค่ 1.4 วิ แล้วปล่อย → ยังเป็น +', (await page.evaluate(() => document.querySelectorAll('#editorTbody .optE').length)) === 0);

    // ขยับนิ้ว/เมาส์ระหว่างกด (เช่นเลื่อนตาราง) → ยกเลิก
    p = await box(rowSel(1, '.optToggle'));
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(400); await page.mouse.move(p.x + 3, p.y + 30); await page.waitForTimeout(1900); await page.mouse.up(); await page.waitForTimeout(200);
    check('choiceE editor: ขยับ >8px ระหว่างกดค้าง → ไม่สลับ', (await page.evaluate(() => document.querySelectorAll('#editorTbody .optE').length)) === 0);

    // กดค้าง 2.1 วิ → เป็น จ (เฉพาะข้อ 1)
    p = await box(rowSel(1, '.optToggle'));
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(2150); await page.mouse.up(); await page.waitForTimeout(250);
    const after1 = await page.evaluate(() => ({
      e: document.querySelectorAll('#editorTbody .optE').length,
      row1: document.querySelector('#editorTbody tr:nth-child(1) .optE')?.textContent,
      plus: document.querySelectorAll('#editorTbody .optToggle').length,
      sel: document.querySelector('#editorTbody tr:nth-child(1) .optE')?.classList.contains('selected'),
    }));
    check('choiceE editor: กดค้าง 2 วิ → ข้อ 1 เป็นปุ่ม จ, ข้ออื่นยังเป็น +', after1.e === 1 && after1.row1 === 'จ' && after1.plus === 2, JSON.stringify(after1));
    check('choiceE editor: ปล่อยนิ้วหลังสลับ ไม่เลือก จ เป็นเฉลยทันที (กลืน click)', after1.sel === false, JSON.stringify(after1));
    let s = await saved();
    check('choiceE editor: บันทึกแล้ว q1.optCount=5, ข้ออื่นไม่มี optCount, เฉลยเดิมไม่เปลี่ยน', s[0].o === 5 && s[1].o === undefined && s[2].o === undefined && s[0].c === 'A', JSON.stringify(s));

    // แตะ จ → เป็นเฉลย E
    await page.evaluate((s) => document.querySelector(s).click(), rowSel(1, '.optE'));
    s = await saved();
    check('choiceE editor: แตะ จ → q.correct==="E"', s[0].c === 'E', JSON.stringify(s));

    // กดค้าง จ → กลับเป็น + และล้างเฉลย E
    p = await box(rowSel(1, '.optE'));
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(2150); await page.mouse.up(); await page.waitForTimeout(250);
    s = await saved();
    const back = await page.evaluate(() => ({ e: document.querySelectorAll('#editorTbody .optE').length, plus: document.querySelectorAll('#editorTbody .optToggle').length }));
    check('choiceE editor: กดค้าง จ 2 วิ → กลับเป็น + และล้างเฉลย E (optCount หาย)', back.e === 0 && back.plus === 3 && s[0].o === undefined && s[0].c === '', JSON.stringify({ back, s }));
    await ctx.close();
  }

  // มือถือ: 5 ปุ่มในแถวเดียวไม่ล้น
  {
    const { ctx, page } = await newSeededPage({
      file: CE_FILE, viewport: { width: 375, height: 800 },
      cache: baseCache({ exams: [mkExam('ce1', 'ทดสอบ 5 ตัวเลือก', 'วิทยาศาสตร์', { questionCount: 3 })], questions: { ce1: mkQE().map((q, i) => i === 0 ? { ...q, optCount: 5 } : q) } }),
    });
    await page.evaluate(() => navigate('admin_editor', { id: 'ce1' }));
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const cell = document.querySelector('#editorTbody tr:nth-child(1) .correctBtns');
      const bs = [...cell.children].map(b => b.getBoundingClientRect());
      const wrap = document.querySelector('#page-admin_editor .tableBox');
      return { n: bs.length, minW: Math.min(...bs.map(b => b.width)), sameRow: new Set(bs.map(b => Math.round(b.y))).size, overflow: wrap.scrollWidth > wrap.clientWidth + 1 };
    });
    check('choiceE editor มือถือ 375px: 5 ปุ่มอยู่แถวเดียว กว้าง ≥30px ไม่ล้นแนวนอน', m.n === 5 && m.sameRow === 1 && m.minW >= 30 && !m.overflow, JSON.stringify(m));
    await ctx.close();
  }

  // ── หน้าทำข้อสอบ: ข้อ 5 ตัวเลือก + ให้คะแนน ──
  {
    const cache = baseCache({
      exams: [mkExam('ce2', 'ชุด 5 ตัวเลือก', 'วิทยาศาสตร์', { questionCount: 2 })],
      questions: { ce2: [
        { id: 'q1', no: 1, number: 1, page: 1, correct: 'E', optCount: 5, choices: { A: '', B: '', C: '', D: '' } },
        { id: 'q2', no: 2, number: 2, page: 1, correct: 'A', choices: { A: '', B: '', C: '', D: '' } },
      ] },
    });
    const { ctx, page } = await newSeededPage({ file: CE_FILE, cache, viewport: { width: 390, height: 844 } });
    await page.evaluate(() => navigate('take', { id: 'ce2', takerName: 'เด็กจ' }));
    await page.waitForTimeout(500);
    await page.evaluate(() => { const b = document.getElementById('takeStartBtn') || [...document.querySelectorAll('button')].find(x => /เริ่ม/.test(x.textContent)); if (b && !window._takeState?.started) b.click(); });
    await page.waitForTimeout(500);
    const labels = () => page.evaluate(() => [...document.querySelectorAll('#takeChoices .choice')].map(e => e.textContent.trim()));
    check('choiceE take: ข้อ 1 (optCount=5) มีตัวเลือก ก ข ค ง จ', JSON.stringify(await labels()) === JSON.stringify(['ก', 'ข', 'ค', 'ง', 'จ']), JSON.stringify(await labels()));
    const lay = await page.evaluate(() => {
      const cs = [...document.querySelectorAll('#takeChoices .choice')].map(e => e.getBoundingClientRect());
      const wrap = document.getElementById('takeChoices').getBoundingClientRect();
      const last = cs[4];
      return { n: cs.length, lastFull: Math.abs(last.width - wrap.width) < 3, rows: new Set(cs.map(c => Math.round(c.y))).size, tall: Math.min(...cs.map(c => c.height)) };
    });
    check('choiceE take มือถือ: จ เต็มแถวล่าง (2+2+1 = 3 แถว) และกดได้สูง ≥28px', lay.n === 5 && lay.lastFull && lay.rows === 3 && lay.tall >= 28, JSON.stringify(lay));
    await page.evaluate(() => [...document.querySelectorAll('#takeChoices .choice')].find(e => e.textContent.trim() === 'จ').click());
    await page.waitForTimeout(150);
    check('choiceE take: เลือก จ แล้วเก็บเป็น E', (await page.evaluate(() => _takeState.answers['q1'])) === 'E');
    await page.evaluate(() => document.querySelectorAll('#takeNums .numBtn')[1].click());
    await page.waitForTimeout(150);
    check('choiceE take: ข้อ 2 (ไม่มี optCount) ยังมี 4 ตัวเลือก', (await labels()).length === 4, JSON.stringify(await labels()));
    await page.evaluate(() => [...document.querySelectorAll('#takeChoices .choice')].find(e => e.textContent.trim() === 'ก').click());
    await page.waitForTimeout(150);
    await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
    await page.waitForTimeout(500);
    const att = await page.evaluate(() => Store.load().attempts[0]);
    check('choiceE take: ส่งแล้ว chosen=E ถูก (เฉลย E) คะแนน 2/2', att && att.score === 2 && att.total === 2 && att.perQuestion[0].chosen === 'E' && att.perQuestion[0].isCorrect === true, JSON.stringify(att && { s: att.score, t: att.total, p0: att.perQuestion[0] }));

    // ── หน้าทบทวน ──
    await page.evaluate((id) => navigate('review', { attemptId: id }), att.id);
    await page.waitForTimeout(500);
    const pills = await page.evaluate(() => ({
      q1: [...document.querySelectorAll('#rq-1 .qPill')].map(e => e.textContent.trim() + ':' + e.className.replace('qPill', '').trim()),
      q2: [...document.querySelectorAll('#rq-2 .qPill')].map(e => e.textContent.trim()),
    }));
    check('choiceE review: ข้อ 5 ตัวมี pill จ (ถูกที่เลือก), ข้อ 4 ตัวไม่มี pill จ',
      pills.q1.length === 5 && pills.q1[4] === 'จ:chosen-correct' && pills.q2.length === 4, JSON.stringify(pills));
    await ctx.close();
  }

  // review ของ attempt เก่าที่เคยเลือก E แต่ข้อถูกสลับกลับเป็น 4 ตัวแล้ว → ยังเห็น pill จ
  {
    const cache = baseCache({
      exams: [mkExam('ce3', 'ชุดเก่า', 'วิทยาศาสตร์', { questionCount: 1 })],
      questions: { ce3: [{ id: 'q1', no: 1, number: 1, page: 1, correct: 'E', choices: {} }] },
      attempts: [{ id: 'att_ce3', examId: 'ce3', examTitle: 'ชุดเก่า', examSubject: 'วิทยาศาสตร์', takerName: 'ครู', startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), usedSeconds: 60, score: 0, total: 1,
        answers: { q1: 'A' }, perQuestion: [{ qid: 'q1', no: 1, chosen: 'A', correct: 'E', isCorrect: false }] }],
    });
    const { ctx, page } = await newSeededPage({ file: CE_FILE, cache });
    await page.evaluate(() => navigate('review', { attemptId: 'att_ce3' }));
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => document.querySelectorAll('#rq-1 .qPill').length);
    check('choiceE review: เฉลยเป็น E แต่ข้อไม่มี optCount → ยังโชว์ pill จ (5)', n === 5, String(n));
    await ctx.close();
  }

  // ── แก้จุดอ่อน (practice) ──
  {
    const cache = baseCache({
      exams: [mkExam('ce4', 'ชุดฝึก 5 ตัวเลือก', 'วิทยาศาสตร์', { questionCount: 1, pdfUrl: 'about:blank' })],
      questions: { ce4: [{ id: 'q1', no: 1, number: 1, page: 1, correct: 'E', optCount: 5, choices: {} }] },
    });
    const { ctx, page } = await newSeededPage({ file: CE_FILE, cache, role: 'student', name: 'เด็กฝึก' });
    await page.evaluate(() => {
      WeaknessTracker.updateWeaknessAfterSubmit({
        takerName: 'เด็กฝึก', examId: 'ce4', examTitle: 'ชุดฝึก 5 ตัวเลือก', examSubject: 'วิทยาศาสตร์',
        submittedAt: new Date().toISOString(), perQuestion: [{ no: 1, isCorrect: false }],
      });
      navigate('practice', { examId: 'ce4' });
    });
    await page.waitForTimeout(600);
    const pl = await page.evaluate(() => [...document.querySelectorAll('#pracChoices .choice')].map(e => e.textContent.trim()));
    check('choiceE practice: ข้อ 5 ตัวมีปุ่ม ก ข ค ง จ', JSON.stringify(pl) === JSON.stringify(['ก', 'ข', 'ค', 'ง', 'จ']), JSON.stringify(pl));
    await page.evaluate(() => [...document.querySelectorAll('#pracChoices .choice')].find(e => e.textContent.trim() === 'จ').click());
    await page.evaluate(() => document.getElementById('pracConfirmBtn').click());
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => _pracState && _pracState.answers[0]);
    check('choiceE practice: ยืนยัน จ ถูกต้อง (chosen=E, isCorrect)', res && res.chosen === 'E' && res.isCorrect === true, JSON.stringify(res));
    await ctx.close();
  }

  // ── ทำย้อนหลัง (backfill) ──
  {
    const cache = baseCache({
      exams: [mkExam('ce5', 'ชุดย้อนหลัง 5 ตัวเลือก', 'วิทยาศาสตร์', { questionCount: 2 })],
      questions: { ce5: [
        { id: 'q1', no: 1, number: 1, page: 1, correct: 'E', optCount: 5, choices: {} },
        { id: 'q2', no: 2, number: 2, page: 1, correct: 'B', choices: {} },
      ] },
      members: [{ pin: '311257', name: 'เด็กย้อนหลัง' }],
    });
    const { ctx, page } = await newSeededPage({ file: CE_FILE, cache });
    await page.evaluate(() => navigate('admin_exams', {}));
    await page.waitForTimeout(400);
    await page.evaluate(() => document.getElementById('offlineBanner')?.remove());
    await page.evaluate(() => document.querySelector('[data-backfill="ce5"]').click());
    await page.waitForTimeout(300);
    const bf = await page.evaluate(() => ({
      q1: document.querySelectorAll('.correctBtns[data-qid="q1"] .correctBtn').length,
      q2: document.querySelectorAll('.correctBtns[data-qid="q2"] .correctBtn').length,
      hint: document.querySelector('#backfillRows')?.textContent.includes('จ'),
    }));
    check('choiceE backfill: ข้อ optCount=5 มี 5 ปุ่ม, ข้อปกติ 4 ปุ่ม', bf.q1 === 5 && bf.q2 === 4, JSON.stringify(bf));
    await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="E"]').click());
    await page.evaluate(() => document.querySelector('.correctBtns[data-qid="q2"] .correctBtn[data-val="B"]').click());
    const saveBtn = await page.evaluate(() => { const b = document.getElementById('backfillSaveBtn') || [...document.querySelectorAll('#backfillModal button')].find(x => /บันทึก/.test(x.textContent)); if (b) b.click(); return !!b; });
    await page.waitForTimeout(500);
    const at = await page.evaluate(() => Store.load().attempts[0]);
    check('choiceE backfill: บันทึก chosen=E ถูก คะแนน 2/2', saveBtn && at && at.score === 2 && at.perQuestion[0].chosen === 'E', JSON.stringify(at && { s: at.score, p0: at.perQuestion && at.perQuestion[0] }));
    await ctx.close();
  }

  // ── นำเข้าเฉลย: normalizeAnswer ──
  {
    const { ctx, page } = await newSeededPage({ file: CE_FILE, cache: baseCache() });
    const n = await page.evaluate(() => ['5', 'จ', 'E', 'e', '4', 'ง', 'D', '6', 'ฉ', ''].map(v => normalizeAnswer(v)));
    check('choiceE import: normalizeAnswer รับ 5/จ/E→E, 1-4/ก-ง/A-D เดิมยังถูก, ค่าอื่นเป็น null',
      JSON.stringify(n) === JSON.stringify(['E', 'E', 'E', 'E', 'D', 'D', 'D', null, null, null]), JSON.stringify(n));
    const lt = await page.evaluate(() => ({ a: getQLetters({}).length, b: getQLetters({ optCount: 5 }).length, c: getQLetters(null).length, d: getQLetters({ optCount: 4 }).length }));
    check('choiceE legacy: getQLetters ข้อไม่มี optCount = 4 ตัว, optCount=5 = 5 ตัว', lt.a === 4 && lt.b === 5 && lt.c === 4 && lt.d === 4, JSON.stringify(lt));
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────
// Section: รอบ review (v48.67p) — แบนเนอร์เตือนพื้นที่เต็ม (เฉพาะ Admin) + บั๊กเล็ก
// ─────────────────────────────────────────────────────────────────
currentSection = 'reviewFixes';
{
  const RF_FILE = 'index.html';
  const mkQ2 = () => [
    { id: 'q1', no: 1, number: 1, page: 1, correct: 'A', choices: { A: '', B: '', C: '', D: '' } },
    { id: 'q2', no: 2, number: 2, page: 1, correct: 'B', choices: { A: '', B: '', C: '', D: '' } },
  ];

  // ── 1) แบนเนอร์พื้นที่ ──
  {
    const { ctx, page } = await newSeededPage({
      file: RF_FILE, viewport: { width: 1180, height: 820 },
      cache: baseCache({ exams: [mkExam('rf1', 'ชุดทดสอบ', 'วิทยาศาสตร์', { questionCount: 2 })], questions: { rf1: mkQ2() } }),
    });
    await page.evaluate(() => document.getElementById('offlineBanner')?.remove());
    const setPct = (target) => page.evaluate((t) => {
      delete Store._cache.zz_pad;
      const base = getStoreUsage().bytes;
      Store._cache.zz_pad = 'x'.repeat(Math.max(0, Math.round(t * FS_DOC_LIMIT / 100) - base - 14));
      navigate('admin');
    }, target);
    const state = () => page.evaluate(() => {
      const b = document.getElementById('adminStorageBanner');
      return { shown: getComputedStyle(b).display !== 'none', text: document.getElementById('adminStorageBannerText').textContent,
        bg: b.style.background, info: document.getElementById('adminStorageInfo').textContent, pct: getStoreUsage().pct };
    });

    await page.evaluate(() => navigate('admin')); await page.waitForTimeout(200);
    let s = await state();
    check('banner: ข้อมูลน้อย (<80%) ไม่โชว์แบนเนอร์ แต่มีบรรทัดบอกเปอร์เซ็นต์ให้ครู', !s.shown && /พื้นที่เก็บข้อมูล \d+%/.test(s.info), JSON.stringify(s));

    await setPct(65); await page.waitForTimeout(200); s = await state();
    check('banner: 65% → ซ่อน', !s.shown && s.pct > 64 && s.pct < 66, JSON.stringify(s));
    await setPct(85.5); await page.waitForTimeout(200); s = await state();
    check('banner: 85% → แบนเนอร์เหลือง (เตือน) พร้อมตัวเลข', s.shown && s.bg.includes('255, 251, 235') && s.text.includes('85%') && s.pct > 85 && s.pct < 86, JSON.stringify(s));
    await setPct(97.5); await page.waitForTimeout(200); s = await state();
    check('banner: 97% → แบนเนอร์แดง (ใกล้เต็มมาก)', s.shown && s.bg.includes('254, 242, 242') && s.text.includes('ใกล้เต็มมาก') && s.pct > 97 && s.pct < 98, JSON.stringify(s));

    await setPct(79.5); await page.waitForTimeout(150); s = await state();
    check('banner: 79.5% → ยังไม่โชว์ (เกณฑ์เตือนเริ่มที่ 80%)', !s.shown, JSON.stringify(s));
    await setPct(80.5); await page.waitForTimeout(150); s = await state();
    check('banner: 80.5% → เริ่มเตือน (เหลือง)', s.shown && s.bg.includes('255, 251, 235'), JSON.stringify(s));
    await setPct(94.5); await page.waitForTimeout(150); s = await state();
    check('banner: 94.5% → ยังเป็นเหลือง ไม่ใช่แดง', s.shown && s.bg.includes('255, 251, 235'), JSON.stringify(s));
    await setPct(95.5); await page.waitForTimeout(150); s = await state();
    check('banner: 95.5% → เปลี่ยนเป็นแดง', s.shown && s.bg.includes('254, 242, 242'), JSON.stringify(s));

    const usage = await page.evaluate(() => ({ u: getStoreUsage().bytes, b: new Blob([JSON.stringify(Store.load())]).size }));
    check('banner: getStoreUsage ตรงกับขนาด JSON ที่ saveDoc เขียนจริง (UTF-8)', usage.u === usage.b, JSON.stringify(usage));

    await page.evaluate(() => document.querySelector('#adminStorageBanner button').click()); await page.waitForTimeout(300);
    check('banner: ปุ่ม "ไปหน้าสำรองข้อมูล" พาไป admin_backup', (await page.evaluate(() => window._currentPage)) === 'admin_backup');

    // นักเรียนต้องไม่เห็น: เรียก render ตรงๆ ตอน role เป็น student → ซ่อน + ไม่โชว์ตัวเลข
    await page.evaluate(() => { sessionStorage.setItem('appSession', JSON.stringify({ role: 'student', name: 'เด็ก', ts: Date.now() })); localStorage.removeItem('appSession'); });
    const stu = await page.evaluate(() => { renderAdminStorageUsage(); const b = document.getElementById('adminStorageBanner'); return { role: Auth.getRole(), disp: b.style.display, info: document.getElementById('adminStorageInfo').textContent }; });
    check('banner: role นักเรียนไม่เห็นแบนเนอร์/ตัวเลข', stu.role === 'student' && stu.disp === 'none' && stu.info === '', JSON.stringify(stu));
    await ctx.close();
  }
  // หน้านักเรียน (home/stats) ไม่มีแบนเนอร์ในหน้าที่มองเห็น
  {
    const { ctx, page } = await newSeededPage({
      file: RF_FILE, role: 'student', name: 'เด็กดู',
      cache: baseCache({ exams: [mkExam('rf1', 'ชุดทดสอบ', 'วิทยาศาสตร์', { questionCount: 2 })], questions: { rf1: mkQ2() } }),
    });
    await page.evaluate(() => { Store._cache.zz_pad = 'x'.repeat(1000000); navigate('home'); });
    await page.waitForTimeout(300);
    const vis = await page.evaluate(() => { const b = document.getElementById('adminStorageBanner'); return b.offsetParent !== null; });
    check('banner: หน้า home ของนักเรียนไม่เห็นแบนเนอร์แม้ข้อมูลเกือบเต็ม', vis === false);
    await ctx.close();
  }

  // ── 2) syncFromCloud ไม่รีสตาร์ทข้อสอบกลางคัน ──
  {
    const cache = baseCache({ exams: [mkExam('rf2', 'ชุด sync', 'วิทยาศาสตร์', { questionCount: 2 })], questions: { rf2: mkQ2() } });
    const { ctx, page } = await newSeededPage({ file: RF_FILE, cache });
    await page.evaluate(() => {
      window.__navs = [];
      const orig = window.navigate;
      window.navigate = function (p, a) { window.__navs.push(p); return orig.apply(this, arguments); };
      navigate = window.navigate;
      FirebaseSync.loadDoc = async () => JSON.parse(JSON.stringify(Store._cache));
    });
    await page.evaluate(() => navigate('take', { id: 'rf2', takerName: 'ครู' }));
    await page.waitForTimeout(700);
    const before = await page.evaluate(() => ({ att: _takeState && _takeState.attemptId, started: _takeState && _takeState.started, st: !!_takeState }));
    await page.evaluate(() => { window.__navs.length = 0; return Store.syncFromCloud(); });
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ att: _takeState && _takeState.attemptId, started: _takeState && _takeState.started, navs: window.__navs.slice(), pg: window._currentPage }));
    check('syncFromCloud ขณะอยู่หน้า take: ข้อสอบไม่ถูกเริ่มใหม่ (attemptId เดิม, ไม่เรียก navigate)',
      before.st && before.started && after.att === before.att && after.started === true && after.navs.length === 0 && after.pg === 'take', JSON.stringify({ before, after }));

    await page.evaluate(() => { cleanupTake(); navigate('exams'); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__navs.length = 0; return Store.syncFromCloud(); });
    await page.waitForTimeout(200);
    const navs2 = await page.evaluate(() => window.__navs.slice());
    check('syncFromCloud ขณะอยู่หน้า exams: ยัง re-navigate 1 ครั้งเหมือนเดิม', navs2.length === 1 && navs2[0] === 'exams', JSON.stringify(navs2));
    await ctx.close();
  }

  // ── 3) overlay/timer ของรอบที่ทิ้งไปแล้วต้องไม่ค้าง ──
  {
    const cache = baseCache({ exams: [mkExam('rf3', 'ชุด overlay', 'วิทยาศาสตร์', { questionCount: 2 })], questions: { rf3: mkQ2() } });
    const { ctx, page } = await newSeededPage({ file: RF_FILE, cache, role: 'student', name: 'เด็กผี' });
    await page.evaluate(() => navigate('take', { id: 'rf3', takerName: 'เด็กผี' }));
    await page.waitForTimeout(600);
    check('overlay: เข้าข้อสอบ (นักเรียน) → โผล่ overlay เลือกอารมณ์ 1 อัน', (await page.evaluate(() => document.querySelectorAll('.takeOverlay').length)) === 1);

    // เปิดข้อสอบซ้ำทันที 2 รอบ (เหมือน syncFromCloud เดิมที่ re-navigate) → ต้องเหลือ overlay อันเดียว
    await page.evaluate(() => { navigate('take', { id: 'rf3', takerName: 'เด็กผี' }); navigate('take', { id: 'rf3', takerName: 'เด็กผี' }); });
    await page.waitForTimeout(700);
    check('overlay: initTake ซ้ำหลายรอบ → ยังเหลือ overlay เดียว (ไม่ซ้อนกัน)', (await page.evaluate(() => document.querySelectorAll('.takeOverlay').length)) === 1);

    // callback ของ overlay เก่า (ถือ reference ไว้) หลัง cleanupTake ต้องไม่เริ่มข้อสอบผี
    const ghost = await page.evaluate(() => {
      const btn = document.querySelector('.takeOverlay button[data-val]');
      cleanupTake();
      const gone = document.querySelectorAll('.takeOverlay').length === 0;
      btn.click();
      return { gone, state: _takeState, interval: _takeInterval, timer: _takeStartTimer };
    });
    check('overlay: cleanupTake ลบ overlay และกด callback เก่าแล้วไม่เริ่มข้อสอบผี (_takeState/_takeInterval ว่าง)',
      ghost.gone && ghost.state === null && ghost.interval === null && ghost.timer === null, JSON.stringify(ghost));

    // timer เริ่มข้อสอบที่ยังไม่ทำงานต้องถูกยกเลิกเมื่อออกจากหน้า
    await page.evaluate(() => { navigate('take', { id: 'rf3', takerName: 'เด็กผี' }); cleanupTake(); });
    await page.waitForTimeout(700);
    const late = await page.evaluate(() => ({ ov: document.querySelectorAll('.takeOverlay').length, st: _takeState }));
    check('overlay: ออกจากหน้าก่อนครบ 300ms → ไม่มี overlay โผล่ตามหลัง', late.ov === 0 && late.st === null, JSON.stringify(late));
    await ctx.close();
  }

  // ── 4) กดส่งซ้ำหลังบันทึกล้ม → ไม่ได้ผลสอบซ้ำ ──
  {
    const cache = baseCache({ exams: [mkExam('rf4', 'ชุดส่งซ้ำ', 'วิทยาศาสตร์', { questionCount: 2 })], questions: { rf4: mkQ2() } });
    const { ctx, page } = await newSeededPage({ file: RF_FILE, cache });
    await page.evaluate(() => navigate('take', { id: 'rf4', takerName: 'ครู' }));
    await page.waitForTimeout(700);
    const attId = await page.evaluate(() => {
      const orig = Store.save.bind(Store); let n = 0;
      Store.save = function (d) { n++; if (n === 1) { this._cache = d; return false; } return orig(d); }; // จำลองบันทึกล้ม 1 ครั้งแล้วสำเร็จ
      [...document.querySelectorAll('#takeChoices .choice')][0].click();
      return _takeState.attemptId;
    });
    await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
    await page.waitForTimeout(400);
    const mid = await page.evaluate((id) => Store.load().attempts.filter(a => a.id === id).length, attId);
    check('ส่งซ้ำ: บันทึกล้มรอบแรก attempt ค้างใน cache 1 รายการ (ยังไม่ซ้ำ)', mid === 1, String(mid));
    await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
    await page.waitForTimeout(600);
    const cnt = await page.evaluate((id) => Store.load().attempts.filter(a => a.id === id).length, attId);
    check('ส่งซ้ำ: กดส่งอีกครั้งจนสำเร็จ → ผลสอบ id เดียวกันมีรายการเดียว (ไม่ซ้ำ 2)', cnt === 1, String(cnt));
    await ctx.close();
  }

  // ── 5) sync จุดอ่อนไม่ลองใหม่ ──
  {
    const { ctx, page } = await newSeededPage({ file: RF_FILE, cache: baseCache({ exams: [mkExam('rf5', 'ชุดจุดอ่อน', 'วิทยาศาสตร์', { questionCount: 1 })], questions: { rf5: mkQ2().slice(0, 1) } }), role: 'student', name: 'เด็กจุดอ่อน' });
    const flagKeys = () => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('nanont:weaknessSyncPending_') && localStorage.getItem(k) === '1'));
    await page.evaluate(() => {
      FirebaseSync.ready = () => true;
      FirebaseSync.saveDoc = async () => false; // จำลอง Firestore ปฏิเสธ/ล้ม
      WeaknessTracker.updateWeaknessAfterSubmit({ takerName: 'เด็กจุดอ่อน', examId: 'rf5', examTitle: 'ชุดจุดอ่อน', examSubject: 'วิทยาศาสตร์', submittedAt: new Date().toISOString(), perQuestion: [{ no: 1, isCorrect: false }] });
    });
    await page.waitForTimeout(300);
    check('จุดอ่อน: saveDoc ล้ม (คืน false) → flag pending ยังอยู่ (เดิมถูกลบทิ้งทันที)', (await flagKeys()).length === 1, JSON.stringify(await flagKeys()));

    // มี flag pending → fetchWeaknessFromCloud ต้องไม่เอาข้อมูล cloud มาทับของในเครื่อง
    const localBefore = await page.evaluate(() => localStorage.getItem('nanont:weaknesses_' + 'เด็กจุดอ่อน'));
    const kept = await page.evaluate(async () => {
      FirebaseSync.loadDoc = async () => ({ 'zzz__9': { examId: 'zzz', questionNo: 9, status: 'weak', wrongCount: 9 } });
      const k = 'nanont:weaknesses_' + 'เด็กจุดอ่อน';
      const before = localStorage.getItem(k);
      await fetchWeaknessFromCloud('เด็กจุดอ่อน');
      return { same: localStorage.getItem(k) === before, hasBefore: !!before };
    });
    check('จุดอ่อน: มี flag pending → fetchWeaknessFromCloud ไม่เขียนทับข้อมูลในเครื่อง', kept.hasBefore && kept.same, JSON.stringify(kept));

    await page.evaluate(() => { FirebaseSync.saveDoc = async () => true; });
    await page.evaluate(() => WeaknessTracker.flushPendingWeaknesses());
    await page.waitForTimeout(200);
    check('จุดอ่อน: flush ซ้ำเมื่อ saveDoc สำเร็จ → flag หาย', (await flagKeys()).length === 0, JSON.stringify(await flagKeys()));
    await ctx.close();
  }

  // ── 6) XSS: ชื่อชุดข้อสอบในตัวกรองหน้าสถิติ ──
  {
    const evil = '<img src=x onerror="window.__xss=1">ชุดอันตราย';
    const cache = baseCache({
      exams: [mkExam('rf6', evil, 'วิทยาศาสตร์', { questionCount: 1 })], questions: { rf6: mkQ2().slice(0, 1) },
      attempts: [{ id: 'att_rf6', examId: 'rf6', examTitle: evil, examSubject: 'วิทยาศาสตร์', takerName: 'เด็กสถิติ', startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), usedSeconds: 60, score: 1, total: 1, perQuestion: [], practiceMode: false }],
    });
    const { ctx, page } = await newSeededPage({ file: RF_FILE, cache, role: 'student', name: 'เด็กสถิติ' });
    await page.evaluate(() => navigate('stats'));
    await page.waitForTimeout(800);
    const x = await page.evaluate(() => ({ fired: window.__xss === 1, opt: [...document.querySelectorAll('#statsFilterExam option')].map(o => o.textContent) }));
    check('XSS: ชื่อชุดมี HTML ในตัวกรองหน้าสถิติ → ไม่ทำงานเป็นโค้ด และแสดงข้อความดิบ', !x.fired && x.opt.some(t => t.includes('<img src=x') && t.includes('ชุดอันตราย')), JSON.stringify(x));
    await ctx.close();
  }

  // ── 7) pdf.js: ปิด eval (CVE-2024-4367) ──
  {
    const src = fs.readFileSync(new URL('../' + RF_FILE, import.meta.url), 'utf8');
    check('pdf.js: getDocument ตั้ง isEvalSupported:false', /getDocument\(\{[^}]*isEvalSupported:\s*false/s.test(src));
  }
}

// ─────────────────────────────────────────────────────────────────
// Section: recDocs (v48.55 / preview v48.68p) — แยกที่เก็บ: ผลสอบใหม่ + ชุดข้อสอบใหม่ = 1 doc ต่อรายการ
// ใช้ Firestore ปลอม (tests/fake-firestore.js) ผ่าน addInitScript ก่อนแอปบูต → ทดสอบ listener/query/
// การเขียนจริงของ FirebaseSync + Store ได้ทั้งเส้นทาง (ไม่แตะ Firebase จริง) — ข้อมูลอยู่ใน localStorage
// ของ context จึงรีโหลดแล้วยังอยู่ และแท็บที่ 2 ใน context เดียวกัน = "อีกเครื่อง"
// ─────────────────────────────────────────────────────────────────
currentSection = 'recDocs';
{
  const REC_FILE = 'index.html';
  const NS = '127_0_0_1_';
  const FAKE_FS_PATH = new URL('./fake-firestore.js', import.meta.url).pathname;
  const oldStore = () => baseCache({
    exams: [mkExam('old1', 'ชุดเก่า 1', 'วิทยาศาสตร์', { questionCount: 2 }), mkExam('old2', 'ชุดเก่า 2', 'คณิตศาสตร์', { questionCount: 2, order: 2 })],
    questions: {
      old1: [{ id: 'q1', no: 1, number: 1, page: 1, correct: 'A' }, { id: 'q2', no: 2, number: 2, page: 1, correct: 'B' }],
      old2: [{ id: 'q1', no: 1, number: 1, page: 1, correct: 'C' }, { id: 'q2', no: 2, number: 2, page: 1, correct: 'D' }],
    },
    attempts: [
      { id: 'attOld1', examId: 'old1', examTitle: 'ชุดเก่า 1', examSubject: 'วิทยาศาสตร์', takerName: 'นนท์', score: 1, total: 2, startedAt: '2026-09-01T09:50:00Z', submittedAt: '2026-09-01T10:00:00Z', perQuestion: [{ qid: 'q1', no: 1, isCorrect: true, chosen: 'A', correct: 'A' }, { qid: 'q2', no: 2, isCorrect: false, chosen: 'A', correct: 'B' }] },
      { id: 'attOld2', examId: 'old2', examTitle: 'ชุดเก่า 2', examSubject: 'คณิตศาสตร์', takerName: 'นนท์', score: 2, total: 2, startedAt: '2026-08-01T09:50:00Z', submittedAt: '2026-08-01T10:00:00Z', perQuestion: [] },
    ],
    members: [{ pin: '1111', name: 'นนท์' }],
  });
  async function newFakeFsContext(store) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    await ctx.route('**/firebasejs/**', r => r.abort());
    await ctx.addInitScript({ path: FAKE_FS_PATH });
    await ctx.addInitScript(({ st, id }) => {
      if (localStorage.getItem('__fakeFS') === null) localStorage.setItem('__fakeFS', JSON.stringify({ [id]: { _d: JSON.stringify(st), _ts: 1 } }));
    }, { st: store, id: NS + 'mainStore' });
    return ctx;
  }
  async function openFakeFsPage(ctx, { role = 'teacher', name = 'Admin', page } = {}) {
    if (!page) { page = await ctx.newPage(); page.on('dialog', d => d.accept()); }
    await page.goto(BASE + '/' + REC_FILE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof Store !== 'undefined' && Store._cloudLoaded === true, {}, { timeout: 8000 }).catch(() => {});
    await page.evaluate(({ role, name }) => {
      sessionStorage.setItem('appSession', JSON.stringify({ role, name, ts: Date.now() }));
      document.getElementById('offlineBanner')?.remove();
      MemeScore.show = (score, total, onClose) => { if (onClose) onClose(); };
    }, { role, name });
    await page.waitForTimeout(300);
    return page;
  }
  const fsMain = (page) => page.evaluate((id) => JSON.parse(__fakeFS.get(id)._d), NS + 'mainStore');
  const fsRecs = (page, kind) => page.evaluate(({ p }) => Object.entries(__fakeFS.all()).filter(([id]) => id.startsWith(p))
    .map(([id, v]) => ({ id, d: JSON.parse(v._d) })), { p: NS + 'rec_' + kind + '_' });
  const seedJSON = JSON.stringify(oldStore().attempts);

  const ctx = await newFakeFsContext(oldStore());
  const page = await openFakeFsPage(ctx);

  // ── 1) บูตจาก mainStore เก่าล้วน ──
  const boot = await page.evaluate(() => ({ ready: FirebaseSync.ready(), ex: Store.load().exams.map(e => e.id), at: Store.load().attempts.map(a => a.id),
    recSets: __fakeFS.log.filter(l => l.id.includes('_rec_')).length }));
  check('boot: Firestore ปลอมพร้อม + โหลดข้อมูลเก่าครบ ไม่มีการเขียน doc แยก', boot.ready && boot.ex.join() === 'old1,old2' && boot.at.join() === 'attOld1,attOld2' && boot.recSets === 0, JSON.stringify(boot));

  // ── 2) ส่งผลสอบ (ชุดเก่า) ผ่านหน้า take จริง ──
  await page.evaluate(() => navigate('take', { id: 'old1', takerName: 'ครู' }));
  await page.waitForTimeout(500);
  await page.evaluate(() => { const b = [...document.querySelectorAll('#takeChoices .choice')].find(el => el.textContent.trim() === 'ก'); if (b) b.click(); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('takeSubmitBtn').click());
  await page.waitForFunction(() => window._currentPage === 'review', {}, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  let recAtt = await fsRecs(page, 'att');
  let main = await fsMain(page);
  const newAttId = recAtt[0] && recAtt[0].d.id;
  check('take: ส่งผลสอบ → เกิด doc rec_att_* 1 ตัว (มี _rec และ examId ถูก)', recAtt.length === 1 && recAtt[0].d._rec === 1 && recAtt[0].d.examId === 'old1' && recAtt[0].id === NS + 'rec_att_' + newAttId.replace(/[^A-Za-z0-9_-]/g, '_'), JSON.stringify(recAtt.map(r => r.id)));
  check('take: mainStore ไม่มีผลสอบใหม่ + ผลสอบเก่าเหมือนเดิมทุกตัวอักษร', JSON.stringify(main.attempts) === seedJSON && !main.attempts.some(a => a._rec), JSON.stringify(main.attempts.map(a => a.id)));
  check('take: ในแอปผลสอบใหม่อยู่บนสุด (เหมือน unshift เดิม)', (await page.evaluate(() => Store.load().attempts.map(a => a.id))).join() === [newAttId, 'attOld1', 'attOld2'].join());

  await openFakeFsPage(ctx, { page });
  const afterReload = await page.evaluate(() => Store.load().attempts.map(a => a.id));
  check('reload: ผลสอบใหม่ยังอยู่ และอยู่บนสุด', afterReload.join() === [newAttId, 'attOld1', 'attOld2'].join(), JSON.stringify(afterReload));

  // ── 3) ผลสอบย้อนหลัง (UI จริง) + ฝึกจุดอ่อน/นำเข้า Excel (static: ติดธงที่จุดสร้าง) ──
  await page.evaluate(() => navigate('admin_exams', {}));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-backfill="old2"]').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const nm = document.getElementById('backfillTakerName'); if (nm) { nm.value = 'นนท์'; nm.dispatchEvent(new Event('input')); nm.dispatchEvent(new Event('change')); }
    document.querySelector('.correctBtns[data-qid="q1"] .correctBtn[data-val="C"]').click();
    document.getElementById('backfillModalSave').click();
  });
  await page.waitForTimeout(400);
  recAtt = await fsRecs(page, 'att');
  check('backfill: บันทึกย้อนหลัง → เป็น doc แยก (manualEntry)', recAtt.length === 2 && recAtt.some(r => r.d.manualEntry && r.d.examId === 'old2' && r.d._rec === 1), JSON.stringify(recAtt.map(r => r.d.examId)));
  main = await fsMain(page);
  check('backfill: mainStore ผลสอบเก่ายังเหมือนเดิม', JSON.stringify(main.attempts) === seedJSON);
  const src = fs.readFileSync(new URL('../' + REC_FILE, import.meta.url), 'utf8');
  check('static: ฝึกแก้จุดอ่อน + นำเข้า Excel ติดธง _rec ที่จุดสร้าง', /mode:'weakness_practice',\s*\n\s*_rec:1, _recTs:Date\.now\(\)/.test(src) && /newOnes\.forEach\(a=>\{ a\._rec=1; a\._recTs=_impTs; \}\)/.test(src));

  // ── 4) สร้างชุดข้อสอบใหม่ (UI admin_new) → doc rec_exam_* พร้อมเฉลย ──
  const mainExamsBefore = JSON.stringify((await fsMain(page)).exams); // migrate() เติม uploadedAt ให้ข้อมูลเก่าตอนบูตแล้ว — เทียบกับตอนนี้
  await page.evaluate(() => navigate('admin_new'));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.getElementById('newTitle').value = 'ชุดใหม่หลังปล่อย';
    const sel = document.getElementById('newSubjectSelect'); sel.value = 'วิทยาศาสตร์'; sel.dispatchEvent(new Event('change'));
    document.getElementById('newQCount').value = '3';
    document.getElementById('newCreateBtn').click();
  });
  await page.waitForTimeout(800);
  let recEx = await fsRecs(page, 'exam');
  main = await fsMain(page);
  const newExamId = recEx[0] && recEx[0].d.exam.id;
  check('admin_new: เกิด doc rec_exam_* มี exam + questions 3 ข้อ', recEx.length === 1 && recEx[0].d.exam._rec === 1 && recEx[0].d.exam.title === 'ชุดใหม่หลังปล่อย' && recEx[0].d.questions.length === 3, JSON.stringify(recEx.map(r => r.d.exam && r.d.exam.title)));
  check('admin_new: mainStore ไม่มีชุดใหม่ (exams/questions เก่าเหมือนเดิม)', JSON.stringify(main.exams) === mainExamsBefore && !main.questions[newExamId], JSON.stringify(main.exams.map(e => e.id)));
  check('admin_new: ในแอปเห็นชุดใหม่ + เฉลย', await page.evaluate((id) => !!Store.load().exams.find(e => e.id === id) && (Store.load().questions[id] || []).length === 3, newExamId));

  // แก้เฉลย (แก้ object ในที่ แล้ว save) → อัปเดตเฉพาะ doc นั้น; แก้กลับค่าเดิม → ต้องเขียนอีกรอบ (ไม่ถูกมองเป็น object ค้าง)
  const editRound = (val) => page.evaluate(({ id, val }) => {
    __fakeFS.log.length = 0;
    const s = Store.load(); s.questions[id][0].correct = val; Store.save(s);
    return new Promise(r => setTimeout(() => r(__fakeFS.log.map(l => l.op + ':' + l.id)), 200));
  }, { id: newExamId, val });
  let log = await editRound('B');
  recEx = await fsRecs(page, 'exam');
  check('editor: แก้เฉลยชุดใหม่ → เขียน doc ของชุดนั้น (ไม่แตะ rec_att)', recEx[0].d.questions[0].correct === 'B' && log.includes('set:' + NS + 'rec_exam_' + newExamId) && !log.some(l => l.includes('rec_att_')), JSON.stringify(log));
  await editRound('C'); log = await editRound('B');
  recEx = await fsRecs(page, 'exam');
  check('editor: แก้กลับเป็นค่าที่เคยมี (B→C→B) ยังเขียนจริง', recEx[0].d.questions[0].correct === 'B' && log.includes('set:' + NS + 'rec_exam_' + newExamId), JSON.stringify(log));

  // ── 5) แก้ผลสอบ: rec → doc, เก่า → mainStore ──
  await page.evaluate((id) => { const s = Store.load(); s.attempts.find(a => a.id === id).revealedAt = '2026-10-10T00:00:00Z'; s.attempts.find(a => a.id === 'attOld1').revealedAt = '2026-10-10T00:00:00Z'; Store.save(s); }, newAttId);
  await page.waitForTimeout(200);
  recAtt = await fsRecs(page, 'att'); main = await fsMain(page);
  check('modify: แก้ผลสอบแยก → doc อัปเดต, แก้ผลสอบเก่า → mainStore อัปเดต', recAtt.find(r => r.d.id === newAttId).d.revealedAt && main.attempts.find(a => a.id === 'attOld1').revealedAt && main.attempts.length === 2);

  // ── 6) "อีกเครื่อง" (แท็บที่ 2) เห็นของใหม่ และ listener ส่งการแก้กลับมา ──
  const page2 = await openFakeFsPage(ctx, { role: 'student', name: 'นนท์' });
  check('device2: บูตแล้วเห็นผลสอบแยก + ชุดใหม่', await page2.evaluate(({ a, e }) => !!Store.load().attempts.find(x => x.id === a) && !!Store.load().exams.find(x => x.id === e), { a: newAttId, e: newExamId }));
  await page.evaluate(() => navigate('stats')); await page.waitForTimeout(300);
  await page2.evaluate((id) => { const s = Store.load(); s.attempts.find(a => a.id === id).feeling = 'จากอีกเครื่อง'; Store.save(s); }, newAttId);
  await page.waitForTimeout(4000); // teacher soft refresh 3s
  check('listener: แก้ผลสอบแยกจากอีกเครื่อง → เครื่องแรกได้ค่าใหม่', await page.evaluate((id) => Store.load().attempts.find(a => a.id === id).feeling === 'จากอีกเครื่อง', newAttId));

  // object ค้าง: ถือ s เก่า (snapshot ก่อนเครื่องอื่นแก้) แล้ว save → ห้ามเขียนทับ doc ด้วยเวอร์ชันเก่า
  await page.evaluate(() => { window.__staleS = Object.assign({}, Store.load(), { attempts: [...Store.load().attempts] }); window.__staleObj = Store.load().attempts[0]; });
  await page2.evaluate((id) => { const s = Store.load(); s.attempts.find(a => a.id === id).feeling = 'รอบสอง'; Store.save(s); }, newAttId);
  await page.waitForTimeout(600);
  const stale = await page.evaluate((id) => {
    const cur = Store.load().attempts.find(a => a.id === id);
    const s = window.__staleS; // ยังถือ object เวอร์ชันก่อน "รอบสอง"
    const before = s.attempts.find(a => a.id === id).feeling;
    Store.save(s);
    return { before, cur: cur.feeling };
  }, newAttId);
  await page.waitForTimeout(300);
  recAtt = await fsRecs(page, 'att');
  check('stale: หน้าที่ถือ object เก่า save → ไม่เขียนทับเวอร์ชันใหม่กว่า', stale.before === 'จากอีกเครื่อง' && recAtt.find(r => r.d.id === newAttId).d.feeling === 'รอบสอง' && (await page.evaluate((id) => Store.load().attempts.find(a => a.id === id).feeling, newAttId)) === 'รอบสอง', JSON.stringify(stale));

  // หน้า take ต้องไม่ถูกรีเฟรชเมื่อ doc แยกเปลี่ยน
  await page2.evaluate(() => navigate('take', { id: 'old2', takerName: 'นนท์' }));
  await page2.waitForTimeout(600);
  const t0 = await page2.evaluate(() => (window._takeState && window._takeState.attemptId) || (typeof _takeState !== 'undefined' && _takeState && _takeState.attemptId));
  await page.evaluate((id) => { const s = Store.load(); s.attempts.find(a => a.id === id).feeling = 'รอบสาม'; Store.save(s); }, newAttId);
  await page2.waitForTimeout(1200);
  const t1 = await page2.evaluate(() => ({ pg: window._currentPage, id: (typeof _takeState !== 'undefined' && _takeState && _takeState.attemptId), f: Store.load().attempts.find(a => a.feeling)?.feeling }));
  check('listener: หน้า take ไม่ถูกรีเฟรช (attemptId เดิม) แต่ข้อมูลใน store อัปเดต', t1.pg === 'take' && t0 && t1.id === t0 && t1.f === 'รอบสาม', JSON.stringify({ t0, t1 }));
  await page2.evaluate(() => { if (typeof cleanupTake === 'function') cleanupTake(); navigate('home'); });

  // ── 7) ลบ: ผลสอบแยกผ่านหน้าสถิติ (UI) ──
  await page.evaluate(() => navigate('stats')); await page.waitForTimeout(400);
  const delOk = await page.evaluate((id) => {
    const b = document.querySelector('[data-del="' + id + '"]'); if (!b) return false;
    b.click(); document.getElementById('statsConfirmOk').click(); return true;
  }, newAttId);
  await page.waitForTimeout(400);
  recAtt = await fsRecs(page, 'att');
  check('delete: ลบผลสอบแยกจากหน้าสถิติ → doc หาย', delOk && !recAtt.some(r => r.d.id === newAttId), JSON.stringify({ delOk, ids: recAtt.map(r => r.d.id) }));
  await page.waitForTimeout(800);
  check('delete: อีกเครื่องเห็นการลบ (listener removed)', await page2.evaluate((id) => !Store.load().attempts.some(a => a.id === id), newAttId));
  // อีกเครื่องที่ยังถือ object ของผลสอบที่ถูกลบ save → ต้องไม่ชุบชีวิต
  await page2.evaluate(() => { const s = window.__s2 = Object.assign({}, Store.load()); Store.save(s); });
  await page2.waitForTimeout(300);
  check('delete: ลบแล้วไม่กลับมาเอง', !(await fsRecs(page, 'att')).some(r => r.d.id === newAttId));

  // ลบผลสอบเก่า (UI) → mainStore อัปเดต (ด่านกันหายหมู่ต้องปล่อยผ่าน)
  await page.evaluate(() => navigate('stats')); await page.waitForTimeout(400);
  await page.evaluate(() => { const b = document.querySelector('[data-del="attOld2"]'); if (b) { b.click(); document.getElementById('statsConfirmOk').click(); } });
  await page.waitForTimeout(400);
  main = await fsMain(page);
  check('delete: ลบผลสอบเก่า → ออกจาก mainStore (ด่านกันหายปล่อยผ่านเพราะสั่งลบจริง)', main.attempts.map(a => a.id).join() === 'attOld1', JSON.stringify(main.attempts.map(a => a.id)));

  // ลบชุดใหม่ + ชุดเก่า ผ่าน modal ลบใน admin_exams
  const delExam = async (id) => {
    await page.evaluate(() => navigate('admin_exams', {})); await page.waitForTimeout(400);
    await page.evaluate((id) => { document.querySelector('[data-del="' + id + '"]').click(); document.getElementById('adminDeleteModalOk').click(); }, id);
    await page.waitForTimeout(400);
  };
  await delExam(newExamId);
  check('delete: ลบชุดใหม่ → doc rec_exam หาย', (await fsRecs(page, 'exam')).length === 0);
  await delExam('old2');
  main = await fsMain(page);
  check('delete: ลบชุดเก่า → ออกจาก mainStore (exams + questions)', main.exams.map(e => e.id).join() === 'old1' && !main.questions.old2, JSON.stringify(main.exams.map(e => e.id)));
  await openFakeFsPage(ctx, { page });
  const ra = await page.evaluate(() => ({ ex: Store.load().exams.map(e => e.id), at: Store.load().attempts.map(a => a.id) }));
  check('delete: รีโหลดแล้วสิ่งที่ลบไม่กลับมา', ra.ex.join() === 'old1' && !ra.at.includes(newAttId) && !ra.at.includes('attOld2'), JSON.stringify(ra));

  // ── 8) ด่านกันข้อมูลเก่าหายหมู่ ──
  const guard = await page.evaluate(() => new Promise(res => {
    const before = __fakeFS.get('127_0_0_1_mainStore')._d;
    const toasts = []; const _t = window.toast; window.toast = (m) => { toasts.push(m); return _t && _t(m); };
    const s = Store.load(); s.attempts = s.attempts.filter(a => a.id !== 'attOld1'); // โค้ดตัดผลสอบเก่าโดยไม่ผ่าน deleteRecords
    Store.save(s);
    setTimeout(() => { window.toast = _t; res({ same: __fakeFS.get('127_0_0_1_mainStore')._d === before, toasts }); }, 300);
  }));
  check('guard: ผลสอบเก่าหายโดยไม่ได้สั่งลบ → ไม่เขียน mainStore + เตือนให้เปิดหน้าใหม่', guard.same && guard.toasts.some(t => t.includes('เปิดหน้านี้ใหม่')), JSON.stringify(guard));
  await openFakeFsPage(ctx, { page }); // ล้าง state ที่ถูกตัดในหน่วยความจำ
  check('guard: รีโหลดแล้วผลสอบเก่ายังอยู่ครบ', (await page.evaluate(() => Store.load().attempts.map(a => a.id))).includes('attOld1'));

  // ── 9) เขียน doc แยกล้ม → recPending → flush ลองใหม่สำเร็จ ──
  const pend = await page.evaluate(async () => {
    __fakeFS.failWrites = true;
    const s = Store.load();
    s.attempts.unshift({ id: 'attPend', examId: 'old1', examTitle: 'ชุดเก่า 1', takerName: 'นนท์', score: 0, total: 2, submittedAt: new Date().toISOString(), perQuestion: [], _rec: 1, _recTs: Date.now() });
    Store.save(s);
    await new Promise(r => setTimeout(r, 200));
    const flagged = JSON.parse(localStorage.getItem('nanont:recPending') || '{}');
    __fakeFS.failWrites = false;
    localStorage.removeItem('nanont:syncPending');
    await Store.flushPendingSync();
    await new Promise(r => setTimeout(r, 300));
    return { flagged, after: localStorage.getItem('nanont:recPending'), doc: !!__fakeFS.get('127_0_0_1_rec_att_attPend') };
  });
  check('pending: เขียนล้ม → ติดธง recPending; flush → เขียนสำเร็จ + ล้างธง', pend.flagged['rec_att_attPend'] === 'save' && pend.after === null && pend.doc, JSON.stringify(pend));

  // ── 10) backup แบ่งส่วน + กู้คืน ──
  const bk = await page.evaluate(async () => {
    // ผลสอบแยก 2 รายการที่ใหญ่ (doc ละ ~600 KB) → backup รวม ~1.2 MB เกิน 1 MiB ถ้าไม่แบ่ง แต่กล่องหลักยังเล็ก
    const s = Store.load();
    ['attBig1', 'attBig2'].forEach((id, i) => s.attempts.unshift({ id, examId: 'old1', examTitle: 'ชุดเก่า 1', takerName: 'นนท์', score: 0, total: 2, submittedAt: new Date().toISOString(), perQuestion: [], note: 'ก'.repeat(200000), _rec: 1, _recTs: Date.now() + i }));
    Store.save(s);
    await new Promise(r => setTimeout(r, 300));
    const ok = await FirebaseSync.saveManualBackup(Store.load(), 'ทดสอบแบ่งส่วน');
    const list = await FirebaseSync.listBackups();
    const ids = Object.keys(__fakeFS.all()).filter(id => id.includes('_backup_manual_'));
    const data = await FirebaseSync.loadBackupData(list[0] && list[0].id);
    return { ok, listN: list.length, label: list[0] && list[0].label, ids, padOk: !!data && data.attempts.filter(a => a.note && a.note.length === 200000).length === 2, hasRec: !!data && data.attempts.some(a => a.id === 'attPend' && a._rec) };
  });
  check('backup: ใหญ่กว่า 1 ส่วน → แบ่งเป็นหลาย doc, รายการโชว์ตัวเดียว, โหลดกลับครบ (รวมผลสอบแยก)', bk.ok && bk.ids.length >= 2 && bk.listN === 1 && bk.label === 'ทดสอบแบ่งส่วน' && bk.padOk && bk.hasRec, JSON.stringify(bk));
  // ไม่ตัดกลาง emoji: ลองทั้งกรณีขอบส่วนตรงกลางคู่ surrogate และไม่ตรง → ทุกส่วนต้องไม่มีครึ่ง emoji ค้างที่ขอบ + โหลดกลับครบ
  const emo = await page.evaluate(async () => {
    const out = [];
    for (const pre of ['', 'a']) {
      const before = new Set(Object.keys(__fakeFS.all()));
      const txt = pre + '😀'.repeat(200000);
      await FirebaseSync.saveManualBackup({ x: txt }, 'emoji' + pre);
      const ids = Object.keys(__fakeFS.all()).filter(k => !before.has(k));
      const bad = ids.some(k => { const d = __fakeFS.get(k)._d; return /[\uD800-\uDBFF]$/.test(d) || /^[\uDC00-\uDFFF]/.test(d); });
      const main = ids.find(k => !/_p\d+$/.test(k));
      const back = await FirebaseSync.loadBackupData(main);
      out.push({ parts: ids.length, bad, same: !!back && back.x === txt });
      await FirebaseSync.deleteBackup(main);
    }
    return out;
  });
  check('backup: ไม่ตัดกลาง emoji ที่ขอบส่วน + โหลดกลับตรงทุกตัวอักษร (ลบแล้วไม่เหลือส่วนค้าง)', emo.every(e => e.parts >= 2 && !e.bad && e.same), JSON.stringify(emo));
  // backup แบบเก่า (doc เดียว ไม่มี _parts) ยังโหลดได้
  const oldBk = await page.evaluate(async () => {
    __fakeFS.put('127_0_0_1_backup_auto_2026-10-01', { _d: JSON.stringify({ exams: [], attempts: [{ id: 'x' }], members: [] }), _ts: 5, type: 'auto', date: '2026-10-01' });
    const list = await FirebaseSync.listBackups();
    const d = await FirebaseSync.loadBackupData('127_0_0_1_backup_auto_2026-10-01');
    return { n: list.length, att: d && d.attempts.length };
  });
  check('backup: แบบเก่า (doc เดียว) ยังโหลดได้', oldBk.n === 2 && oldBk.att === 1, JSON.stringify(oldBk));

  // กู้คืน backup แบบใหม่ผ่านหน้า backup (UI): สร้างผลสอบหลัง backup → กู้คืน → mainStore + doc แยก ตรงกับตอน backup
  await page.evaluate(async () => {
    const s = Store.load();
    s.attempts.unshift({ id: 'attAfter', examId: 'old1', examTitle: 'ชุดเก่า 1', takerName: 'นนท์', score: 2, total: 2, submittedAt: new Date().toISOString(), perQuestion: [], _rec: 1, _recTs: Date.now() });
    Store.save(s);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => navigate('admin_backup')); await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('backupTabManual').click()); await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#backupList [data-restore]').click()); await page.waitForTimeout(600);
  const warn = await page.evaluate(() => document.getElementById('backupRestoreCompare').textContent);
  check('restore: เตือนจำนวนผลสอบแยกที่จะหาย', warn.includes('ผลสอบ 1 รายการ'), warn);
  await page.evaluate(() => {
    const i = document.getElementById('backupRestoreConfirmInput'); i.value = 'กู้คืน'; i.dispatchEvent(new Event('input'));
    document.getElementById('backupRestoreOk').click(); // สำเร็จแล้วแอปรีโหลดเองหลัง 800ms
  });
  await page.waitForTimeout(1200);
  recAtt = await fsRecs(page, 'att'); main = await fsMain(page);
  check('restore: doc แยกตรงกับ backup (attPend กลับมา/คงอยู่, attAfter ถูกลบ) และ mainStore ไม่มี record แยก',
    recAtt.some(r => r.d.id === 'attPend') && !recAtt.some(r => r.d.id === 'attAfter') && !main.attempts.some(a => a._rec) && recAtt.some(r => r.d.id === 'attBig1'), JSON.stringify({ rec: recAtt.map(r => r.d.id), main: main.attempts.map(a => a.id) }));

  // ── 11) แบนเนอร์วัดเฉพาะกล่องหลัก ──
  await openFakeFsPage(ctx, { page });
  const usage = await page.evaluate(() => ({ u: getStoreUsage(), main: new Blob([JSON.stringify(Store._mainPayload(Store.load()))]).size, all: new Blob([JSON.stringify(Store.load())]).size }));
  check('usage: getStoreUsage วัดเฉพาะกล่องหลัก + นับจำนวนที่แยกเก็บ', usage.u.bytes === usage.main && usage.main < usage.all && usage.u.recAtt >= 1, JSON.stringify(usage));
  await page.evaluate(() => navigate('admin')); await page.waitForTimeout(200);
  check('usage: บรรทัดในหน้า Admin บอกจำนวนที่แยกเก็บ', /แยกเก็บแล้ว: ผลสอบ \d+ รายการ/.test(await page.evaluate(() => document.getElementById('adminStorageInfo').textContent)));

  await ctx.close();
}

await browser.close();
const fails = results.filter(r => !r.pass);
console.log('\n══════════════════════════════════════');
console.log(fails.length ? `FAILURES: ${fails.length}/${results.length}` : `ALL ${results.length} CHECKS PASSED`);
if (fails.length) fails.forEach(f => console.log('  ✗ ' + f.name + ' — ' + f.detail));
process.exit(fails.length ? 1 : 0);
