# My Exam Academia — Claude Development Rules

## Project Overview
Single-page web app (SPA) for exam practice, targeting students preparing for ม.1 entrance exams.
All logic lives in one self-contained HTML file — no build step, no server.

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
- Line ~7: `<!-- APP_VERSION: v45.2 -->`
- Line ~346: `<div style="text-align:right;margin-top:10px;font-size:11px;color:#9ca3af;opacity:0.6;">v45.2</div>`

### Current version: v45.8
When making the next change, bump to v45.9.

## Architecture Notes
- Navigation: `navigate('page-name')` function
- All pages: `div.page` elements, shown via `.page.active` CSS class
- Data storage: localStorage (no backend)
- PDF viewer: custom canvas-based renderer using pdf.js
- Language: Thai (th)
