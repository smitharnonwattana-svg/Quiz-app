// Fake Firebase compat SDK (Firestore + Storage stub) สำหรับ regression tests — โหลดผ่าน page.addInitScript
// ก่อนแอปบูต แทน SDK จริง (ซึ่งโหลดไม่ได้ใน sandbox และห้ามแตะฐานข้อมูลจริง)
// รองรับเฉพาะ API ที่แอปใช้: collection('app').doc(id).get/set/delete/onSnapshot,
// where(FieldPath.documentId(), '>=' | '<', v).get/onSnapshot (+ docChanges), enablePersistence
// ข้อมูลเก็บใน localStorage['__fakeFS'] → รีโหลดแล้วยังอยู่ และหลายแท็บใน context เดียวกันเห็นข้อมูลเดียวกัน
// (event 'storage' แจ้ง listener ของแท็บอื่น = จำลอง "อีกเครื่อง")
// เครื่องมือทดสอบ: window.__fakeFS.{all(), get(id), put(id,obj), del(id), log, failWrites, reset()}
// จำลอง "เครื่องที่ถือข้อมูลเก่า" (ตั้งผ่าน page.addInitScript ก่อนแอปบูต: window.__fsInit = {...}):
//   staleCache[docId] = {_d,_ts}  → get() แบบไม่ระบุ source และ snapshot แรกของ listener คืนเอกสารเก่าชุดนี้ (metadata.fromCache=true)
//   failServerGet = true          → get({source:'server'}) ล้ม (แอปถอยไปอ่านแคช)
//   suppressUpdates[docId] = true → listener ไม่รับการอัปเดตจากเซิร์ฟเวอร์อีก (เหมือนออฟไลน์ค้างแคช)
// runTransaction: อ่านจากเซิร์ฟเวอร์จริงเสมอ; api.offline = true → ล้ม (จำลองออฟไลน์)
(() => {
  const KEY = '__fakeFS';
  const LIMIT = 1048576;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
  const write = (all) => localStorage.setItem(KEY, JSON.stringify(all));
  const listeners = new Set();
  const notify = () => setTimeout(() => listeners.forEach(fn => { try { fn(); } catch (e) { console.warn('[fakeFS] listener err', e); } }), 0);
  window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });

  // อ่านตอนเรียกใช้ (ไม่ใช่ตอนติดตั้ง) → ตั้ง window.__fsInit ผ่าน page.addInitScript ลำดับไหนก็ได้
  const flags = new Proxy({}, { get: (_, k) => Object.assign({ staleCache: {}, failServerGet: false, suppressUpdates: {} }, window.__fsInit || {})[k] });
  const api = {
    log: [],
    flags,
    offline: false,
    failWrites: false,
    all: read,
    get: (id) => read()[id] || null,
    put: (id, obj) => { const a = read(); a[id] = obj; write(a); notify(); },
    del: (id) => { const a = read(); delete a[id]; write(a); notify(); },
    reset: () => { localStorage.removeItem(KEY); notify(); },
  };
  window.__fakeFS = api;

  const docSnap = (id, v, fromCache) => ({ id, exists: !!v, metadata: { fromCache: !!fromCache }, data: () => (v ? JSON.parse(JSON.stringify(v)) : undefined) });
  const DOC_ID = '__name__';

  function docRef(id) {
    return {
      id,
      async get(opts) {
        const server = !!(opts && opts.source === 'server');
        if (server && flags.failServerGet) throw new Error('fake: server unreachable');
        if (!server && flags.staleCache[id]) return docSnap(id, flags.staleCache[id], true);
        return docSnap(id, read()[id]);
      },
      async set(obj) {
        if (api.failWrites) throw new Error('fake write failure');
        const json = JSON.stringify(obj);
        if (new TextEncoder().encode(json).length > LIMIT) throw new Error('fake: document exceeds 1 MiB');
        const a = read(); a[id] = JSON.parse(json); write(a);
        api.log.push({ op: 'set', id });
        notify();
      },
      async delete() {
        if (api.failWrites) throw new Error('fake delete failure');
        const a = read(); delete a[id]; write(a);
        api.log.push({ op: 'delete', id });
        notify();
      },
      onSnapshot(cb) {
        let last, first = true;
        const fire = () => {
          if (first && flags.staleCache[id]) { first = false; last = 'stale'; cb(docSnap(id, flags.staleCache[id], true)); return; }
          first = false;
          if (flags.suppressUpdates[id]) return;
          const v = read()[id];
          const j = JSON.stringify(v === undefined ? null : v);
          if (j === last) return;
          last = j;
          cb(docSnap(id, v));
        };
        listeners.add(fire); setTimeout(fire, 0);
        return () => listeners.delete(fire);
      },
    };
  }

  function query(conds) {
    const match = () => {
      const a = read();
      return Object.keys(a).sort().filter(id => conds.every(([op, v]) => (op === '>=' ? id >= v : op === '<' ? id < v : false)))
        .map(id => [id, a[id]]);
    };
    return {
      where(field, op, v) {
        if (field !== DOC_ID) throw new Error('fake: only documentId() queries supported');
        return query([...conds, [op, v]]);
      },
      async get() { const docs = match().map(([id, v]) => docSnap(id, v)); return { docs, size: docs.length, empty: !docs.length }; },
      onSnapshot(cb) {
        let prev = new Map();
        const fire = () => {
          const cur = new Map(match().map(([id, v]) => [id, JSON.stringify(v)]));
          const changes = [];
          cur.forEach((j, id) => {
            if (!prev.has(id)) changes.push({ type: 'added', doc: docSnap(id, JSON.parse(j)) });
            else if (prev.get(id) !== j) changes.push({ type: 'modified', doc: docSnap(id, JSON.parse(j)) });
          });
          prev.forEach((j, id) => { if (!cur.has(id)) changes.push({ type: 'removed', doc: docSnap(id, JSON.parse(j)) }); });
          const first = !fire.done; fire.done = true;
          prev = cur;
          if (!changes.length && !first) return;
          const docs = [...cur].map(([id, j]) => docSnap(id, JSON.parse(j)));
          cb({ docs, size: docs.length, empty: !docs.length, docChanges: () => changes });
        };
        listeners.add(fire); setTimeout(fire, 0);
        return () => listeners.delete(fire);
      },
    };
  }

  const db = {
    enablePersistence: () => Promise.resolve(),
    async runTransaction(fn) {
      if (api.offline || api.failWrites) throw new Error('fake: transaction failed (offline)');
      const writes = [];
      const tx = { get: async (ref) => docSnap(ref.id, read()[ref.id]), set: (ref, obj) => { writes.push([ref, obj]); } };
      await fn(tx);
      for (const [ref, obj] of writes) await ref.set(obj);
    },
    collection: (name) => {
      if (name !== 'app') throw new Error('fake: only collection app');
      return Object.assign(query([]), { doc: docRef });
    },
  };
  const storageRef = { put() { throw new Error('fake storage'); }, delete: async () => {}, getDownloadURL: async () => '' };
  const firestore = () => db;
  firestore.FieldPath = { documentId: () => DOC_ID };
  window.firebase = {
    apps: [],
    initializeApp(cfg) { this.apps.push(cfg); return {}; },
    firestore,
    storage: () => ({ ref: () => storageRef, refFromURL: () => storageRef }),
  };
})();
