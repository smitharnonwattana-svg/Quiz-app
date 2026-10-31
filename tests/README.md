# Regression tests

ชุดตรวจสอบอัตโนมัติ รวม checks จากการแก้บั๊กช่วง v47.93 → v48.3
(editor persistence, admin reorder/member, gamification delta, resume warnings,
backup/restore merge-bypass, purge checkbox, loading state, subject-filter soft-refresh,
scratch pad: desktop mouse drawing + split-view ไม่บังโจทย์)

## วิธีรัน

```bash
bash tests/run.sh
```

ต้องมี: `node` (>=18), `playwright` (resolve ปกติ หรือ fallback ไป
`/opt/node22/lib/node_modules/playwright` ของ sandbox), Chromium
(`/opt/pw-browsers/chromium` ถ้ามี ไม่งั้นใช้ของ playwright เอง), `python3`

ใช้เวลา ~1 นาที (มี wait 10.6 วิ 1 ครั้งสำหรับทดสอบ timeout ของ loading state)

## หลักการ

- ไม่แตะ Firebase จริง — stub `FirebaseSync.*` ต่อ section + seed `Store._cache` ตรงๆ
- ทุก section เปิด browser context ใหม่ (state ไม่รั่วข้าม section)
- **รันก่อน push ทุกครั้งที่แก้ index.html** — ต้องเขียวทั้งชุด
- เพิ่ม check ใหม่ทุกครั้งที่แก้บั๊กใหม่ (กันบั๊กเดิมกลับมา)

## ข้อจำกัดที่รู้

- `location.reload()` เป็น native stub ไม่ได้ — section backup อ่านผลก่อน reload จริงยิง (800ms)
  แล้วปิด context ทันที
- Firebase SDK โหลดไม่ได้ใน sandbox (proxy บล็อก) — นั่นคือเหตุที่ต้อง stub ทุกอย่าง
  ซึ่งตรงกับที่แอปออกแบบไว้: ทุกอย่างผ่าน `FirebaseSync`/`Store` interface
- section `recDocs` (v48.55) ใช้ `tests/fake-firestore.js` แทน: Firebase compat SDK ปลอม ใส่ผ่าน
  `ctx.addInitScript` ก่อนแอปบูต (บล็อก `**/firebasejs/**`) → ทดสอบ `FirebaseSync` + `Store` ตัวจริงทั้งเส้นทาง
  (doc get/set/delete/onSnapshot, query ตาม id prefix + docChanges) — ข้อมูลอยู่ใน `localStorage['__fakeFS']`
  ของ context จึงรีโหลดแล้วยังอยู่ และแท็บที่ 2 ใน context เดียวกัน = "อีกเครื่อง" (event `storage`)
  รองรับเฉพาะ API ที่แอปใช้; จำลองเพดาน 1 MiB ต่อ doc; `__fakeFS.failWrites = true` จำลองการเขียนล้ม
- section `staleWrite` (v48.57): จำลอง "เครื่องที่ถือข้อมูลเก่า" ด้วย `window.__fsInit` (ตั้งผ่าน `page.addInitScript` ก่อนแอปบูต):
  `staleCache[docId]` (get/listener แรกคืนเอกสารเก่า fromCache=true), `failServerGet`, `suppressUpdates[docId]` (ไม่รับอัปเดตจากเซิร์ฟเวอร์)
  และ `__fakeFS.offline = true` (ทรานแซกชันล้ม) — ทดสอบ compare-and-set + merge 3 ทางของกล่องหลัก; หน้าทดสอบทุกหน้าใช้ localStorage ร่วมกัน
  (จริงๆ คือคนละเครื่อง) จึงต้องตั้ง `nanont:syncPending` เองก่อน flush ถ้าหน้าอื่นเพิ่งบันทึกสำเร็จ
- `Store` เป็น `const` ระดับ script ไม่ใช่ `window.Store` — รอบูตด้วย `typeof Store !== 'undefined' && Store._cloudLoaded`
- section `editorSplit` (v48.71p → production v48.58, ชี้ `index.html`): pdf.js โหลดจาก CDN ไม่ได้ใน sandbox → stub `PdfViewer.create`
  ให้บันทึกการเรียก (`window.__pdf`: load/page/destroy) แล้วตรวจว่าเลือกข้อแล้ว PDF เลื่อนไปหน้าถูก; ปุ่มลัดภาษาไทย (ก–จ)
  ส่งด้วย `KeyboardEvent` ตรงๆ เพราะ `page.keyboard.press` ไม่รู้จักตัวอักษรไทย
- จอกว้าง (≥901px) หน้ากรอกเฉลยพับ "ตั้งค่าชุดข้อสอบ" ไว้เมื่อมี PDF แล้ว — เทสต์ที่ใช้ `page.fill/click` กับช่องในตั้งค่าต้องกาง `#editorSetHead` ก่อน
- section `mobileA` (v48.74p → production v48.61, ชี้ `index.html`): หน้ามือถือแบบ A — การ์ดกรอกเฉลย (≤600px), แถบล่าง + แผ่น "ดูโจทย์" (≤900px), หน้าสร้างข้อสอบไม่ล้นจอ;
  stub `PdfViewer.create` แบบเดียวกับ editorSplit; ใน sandbox แถบ "Offline mode" แสดงเสมอ (Firebase โหลดไม่ได้) จึงใช้ทดสอบว่าหัวติดบนหลบแถบนี้ได้ด้วย
- section `summaryShot` (v48.76p → production v48.62, ชี้ `index.html`): ปุ่ม "📸 บันทึกรูปสรุป" → รูปสรุปผลสอบ; html2canvas โหลดจาก CDN ไม่ได้ใน sandbox จึงใส่ตัวแทนที่คืน canvas ตามขนาดจริง
  (ตัวจริงตรวจแยกด้วยภาพ — `npm pack html2canvas@1.4.1` แล้ว route ไฟล์ให้ URL cdnjs); ชื่อไฟล์ดาวน์โหลดต้องเป็น ASCII (ชื่อไทยถูกตัดเหลือ "download" ในบางเบราว์เซอร์)
- section `shareExam` (v48.77p/v48.78p → production v48.63, ชี้ `index.html`): หน้ารายการข้อสอบ (admin_exams) ปุ่ม "ฝากการบ้าน"/"แชร์ลิงก์" (ลิงก์ชี้หน้าจริงเสมอ), จำข้อสอบจากลิงก์ `?exam=` ข้ามรีโหลด, และ assignDup: ส่งการบ้านชุดเดิมซ้ำไม่ได้ (ปุ่มเปลี่ยนเป็น "ยกเลิก")
- section `liveView` (v48.79p, ชี้ `index_preview.html`): "ดูสด" ระดับ 1 — เครื่องลูกส่ง `live_<ชื่อ>` ระหว่างทำข้อสอบ (Firestore ปลอม 2 หน้าใน context เดียว): ทุกโหมด (จับเวลา mc/กรอกตัวเลข/ถ่วงน้ำหนัก/ข้อ 5 ตัวเลือก/ข้อฟรี, ฝึกซ้อม, คนละครึ่ง, ครึ่งหลัง, แก้จุดอ่อน), ถูก/ผิด/ข้าม/ไม่แน่ใจ, ไม่รั่วตัวเลือกที่เลือก, resume, ออกจากแอป, ส่ง/ออก/ล้มเหลว, throttle; ฝั่งครู: แบนเนอร์ + หน้า admin_live ทุกสถานะ (active/away/ขาดการเชื่อมต่อ/done/ซ่อนเก่า), นาฬิกา, เรียลไทม์, สิทธิ์
