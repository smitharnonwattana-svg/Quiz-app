// ═══════════════════════════════════════════════════════════════════════════
// Quiz-app regression suite — รวม checks จากการแก้บั๊ก v47.93 → v48.3
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
async function newSeededPage({ role = 'teacher', name = 'Admin', cache }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
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
  benchmarks: [], subjectTopics: {}, subjectSubTopics: {}, gamification: {}, ...over,
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
    return { ok: true, len: (Store.load().questions.eA1 || []).length };
  });
  check('applyQCount persists new count to store', qcount.ok && qcount.len === 5, JSON.stringify(qcount));

  const tmplErr = await page.evaluate(() => {
    let err = null;
    const orig = console.error;
    try { document.getElementById('editorDownloadTemplate')?.click(); } catch (e) { err = String(e); }
    console.error = orig;
    return err;
  });
  check('template download button does not throw (v47.94 exam-undefined fix)', tmplErr === null, String(tmplErr));
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

// ─────────────────────────────────────────────────────────────────
await browser.close();
const fails = results.filter(r => !r.pass);
console.log('\n══════════════════════════════════════');
console.log(fails.length ? `FAILURES: ${fails.length}/${results.length}` : `ALL ${results.length} CHECKS PASSED`);
if (fails.length) fails.forEach(f => console.log('  ✗ ' + f.name + ' — ' + f.detail));
process.exit(fails.length ? 1 : 0);
