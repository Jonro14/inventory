// Data layer. Two interchangeable backends with the same interface:
//   - Firebase (Firestore + Auth): real-time sync between all devices, offline cache.
//   - Local demo: localStorage only, used while firebase-config.js is not filled in.
//
// Interface:
//   mode                      'cloud' | 'demo'
//   onAuth(cb)                cb(user | null), user = {email, uid}
//   signIn(email, password), signOut(), resetPassword(email)
//   watch(coll, cb, onErr)    cb(array of {id, ...data}) on every change; returns unsubscribe
//   get(coll, id)             one document or null
//   batch(ops)                ops = [{op: 'set'|'update'|'delete', coll, id, data}]
//   newId()
//
// Collections: units (closets, drawers, boxes), slots (shelves / cavities / drawers),
// items (things), photos (full-size photo of an item, id = item id).

import { firebaseConfig, HOME_ID } from '../firebase-config.js';

const FIREBASE_VERSION = '10.12.2';

export function isDemo() {
  return !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE');
}

export async function createStore() {
  return isDemo() ? createLocalStore() : createFirebaseStore();
}

function randomId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}

// ---------------------------------------------------------------- Firebase

async function createFirebaseStore() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [appMod, authMod, fs] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);

  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);

  let db;
  try {
    // Offline cache shared between tabs: the app opens instantly and works without network.
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn('Offline cache not available, using memory cache', e);
    db = fs.getFirestore(app);
  }

  const col = c => fs.collection(db, 'homes', HOME_ID, c);
  const ref = (c, id) => fs.doc(db, 'homes', HOME_ID, c, id);

  return {
    mode: 'cloud',
    onAuth(cb) {
      return authMod.onAuthStateChanged(auth, u => cb(u ? { email: u.email, uid: u.uid } : null));
    },
    signIn: (email, password) => authMod.signInWithEmailAndPassword(auth, email, password),
    signOut: () => authMod.signOut(auth),
    resetPassword: email => authMod.sendPasswordResetEmail(auth, email),
    watch(c, cb, onErr) {
      return fs.onSnapshot(
        col(c),
        snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
        err => onErr && onErr(err),
      );
    },
    async get(c, id) {
      const s = await fs.getDoc(ref(c, id));
      return s.exists() ? { id: s.id, ...s.data() } : null;
    },
    // Resolves when the server confirms. Offline it stays pending, but the change is
    // applied to the local cache (and to every watcher) immediately.
    async batch(ops) {
      for (let i = 0; i < ops.length; i += 400) {
        const b = fs.writeBatch(db);
        for (const o of ops.slice(i, i + 400)) {
          if (o.op === 'set') b.set(ref(o.coll, o.id), o.data);
          else if (o.op === 'update') b.update(ref(o.coll, o.id), o.data);
          else if (o.op === 'delete') b.delete(ref(o.coll, o.id));
        }
        await b.commit();
      }
    },
    newId: randomId,
  };
}

// ---------------------------------------------------------------- Local demo

function createLocalStore() {
  const KEY = 'home-inventory-demo-v1';
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('home-inventory-demo') : null;
  const listeners = {};
  let data = load();

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { console.warn('Demo storage full or blocked', e); }
    channel && channel.postMessage('changed');
  }
  const coll = c => (data[c] ||= {});
  const docs = c => Object.entries(coll(c)).map(([id, d]) => ({ id, ...d }));
  const emit = c => (listeners[c] || new Set()).forEach(cb => cb(docs(c)));

  if (channel) channel.onmessage = () => { data = load(); Object.keys(listeners).forEach(emit); };

  return {
    mode: 'demo',
    onAuth(cb) { setTimeout(() => cb({ email: 'demo@this-device', uid: 'demo' }), 0); return () => {}; },
    async signIn() {},
    async signOut() {},
    async resetPassword() {},
    watch(c, cb) {
      (listeners[c] ||= new Set()).add(cb);
      setTimeout(() => cb(docs(c)), 0);
      return () => listeners[c].delete(cb);
    },
    async get(c, id) {
      const d = coll(c)[id];
      return d ? { id, ...d } : null;
    },
    async batch(ops) {
      const touched = new Set();
      for (const o of ops) {
        const c = coll(o.coll);
        if (o.op === 'set') c[o.id] = { ...o.data };
        else if (o.op === 'update' && c[o.id]) c[o.id] = { ...c[o.id], ...o.data };
        else if (o.op === 'delete') delete c[o.id];
        touched.add(o.coll);
      }
      save();
      touched.forEach(emit);
    },
    newId: randomId,
  };
}
