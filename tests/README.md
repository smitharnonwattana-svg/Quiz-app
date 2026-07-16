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
