/** Caché persistente (IndexedDB) para los modelos de MediaPipe: la segunda carga
 *  del juego es instantánea y funciona incluso sin red. */

const DB = 'robovisor-cache';
const STORE = 'files';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB no disponible'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB bloqueado'));
    setTimeout(() => reject(new Error('timeout IndexedDB')), 4000);
  }).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

export async function cacheGet(key) {
  const db = await open();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      tx.onsuccess = () => resolve(tx.result ?? null);
      tx.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function cachePut(key, buffer) {
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(buffer, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch { return false; }
}

export async function cacheClear() {
  try {
    const db = await open();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = tx.onerror = tx.onabort = resolve;
    });
    return true;
  } catch { return false; }
}
