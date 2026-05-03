# My Exam Academia — Claude Development Rules
## Project Overview
Single-page web app (SPA) for exam practice, targeting students preparing for ม.1 entrance exams.
All logic lives in one self-contained HTML file — no build step, no frontend server.
Backend: Firebase Cloud Functions (Node.js 22, asia-southeast1) สำหรับส่ง LINE notify เท่านั้น

## Version Update Rule (IMPORTANT)
**Every time any HTML file is modified or generated**, you MUST:
1. **Increment the version number** — bump the minor version (e.g. v45.2 → v45.3, v45.3 → v45.4)
2. **Update both version locations** in the HTML:
   - `<head>` comment: `<!-- APP_VERSION: v{new_version} -->`
   - Login page display (near bottom of `#page-login`): `>v{new_version}</div>`
3. **Save a local versioned copy** named `index_v{new_version}.html` (e.g. `index_v45.3.html`)
   - Keep `index.html` as the main working file (update it in place)
   - Save a local copy named `index_v{new_version}.html` — ไฟล์นี้ถูก .gitignore ไว้ ไม่ push ขึ้น GitHub

### Version locations in index.html
- Line ~7: `<!-- APP_VERSION: v45.69 -->`
- Line ~352: `<div style="text-align:right;margin-top:10px;font-size:11px;color:#9ca3af;opacity:0.6;">v45.69</div>`

### Current version: v45.69
When making the next change, bump to v45.70.

## GitHub Push (Deploy)
Token และข้อมูล deploy เก็บอยู่ใน `.claude-local` (gitignored — ไม่ push ขึ้น GitHub)
วิธี push ทุกครั้ง:
```bash
# อ่าน token จาก .claude-local แล้ว push
PAT=$(grep GITHUB_PAT /home/user/Quiz-app/.claude-local | cut -d= -f2)
git remote set-url origin https://${PAT}@github.com/smitharnonwattana-svg/Quiz-app.git
git push origin claude/review-webapp-structure-gaY4S:main
git push -u origin claude/review-webapp-structure-gaY4S
git remote set-url origin https://github.com/smitharnonwattana-svg/Quiz-app.git
```

## Deployment
- Production URL: https://smitharnonwattana-svg.github.io/Quiz-app/
- Platform: GitHub Pages (deploy จาก branch main เท่านั้น)
- Firebase project nanont-exam: ใช้สำหรับ Cloud Functions เท่านั้น (ไม่ใช้ Firebase Hosting)
- _headers: deprecated ไม่ได้ใช้แล้ว

## App Structure
- Navigation: `navigate('page-name')` function
- All pages: `div.page` elements, shown via `.page.active` CSS class
- Data storage: localStorage (client-side, no database)
- LINE notify: Firebase Cloud Functions → LINE Messaging API (Secrets: LINE_TOKEN, LINE_USER_ID)
- PDF viewer: custom canvas-based renderer using pdf.js
- Language: Thai (th)

## Important files / paths
- index.html — frontend ทั้งหมด (อย่าสร้างไฟล์ JS/CSS แยก)
- functions/index.js — Cloud Function lineNotify
  ⚠️ ทุกครั้งที่แก้ functions/index.js ต้อง deploy ผ่าน Cloud Shell:
  1. เปิด https://console.cloud.google.com → กด >_ Cloud Shell
  2. git stash && git pull origin main
  3. npx firebase-tools deploy --only functions --project nanont-exam
  4. รอ Deploy complete! แล้วทดสอบใน DevTools
  Claude Code deploy functions ตรงไม่ได้ — หลังแก้ functions/index.js ให้แจ้ง user ทุกครั้งว่าต้อง deploy เองผ่าน Cloud Shell
- functions/package.json — dependencies ของ Cloud Functions
- firebase.json — config deploy Cloud Functions (ไม่ใช่ Firebase Hosting)
- .firebaserc — Firebase project: nanont-exam
- _headers — deprecated ไม่ต้องแก้
- .claude-local — เก็บ GITHUB_PAT (gitignored ห้าม commit)
- index_v*.html — version backups (gitignored)

## Session Setup (ทำทุกครั้งที่เริ่ม session ใหม่)
ก่อนทำงานทุกครั้ง ให้รันตามลำดับนี้:

1. git pull origin main
   (sync โค้ดล่าสุดจาก GitHub)

2. ตรวจว่า .claude-local มีอยู่ไหม
   ถ้าไม่มี → สร้างจาก GITHUB_PAT ใน ~/.claude/settings.json:
   echo "GITHUB_PAT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.claude/settings.json','utf8')).env.GITHUB_PAT)")" > /home/user/Quiz-app/.claude-local

3. ทดสอบ push ได้เลยถ้าต้องการ deploy
   (ใช้ deploy script ใน ## GitHub Push section)

หมายเหตุ: ถ้า ~/.claude/settings.json ไม่มี GITHUB_PAT
→ แจ้งผู้ใช้ว่า "ต้องสร้าง .claude-local ก่อน กรุณาให้ GITHUB_PAT"
