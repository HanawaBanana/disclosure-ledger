/**
 * store.js — persistence.
 *
 * The app keeps three things locally and never sends them anywhere:
 *   ledger      the hash-chained record of what was done
 *   documents   the texts that were checked (name, size, digest, usage declaration)
 *   answers     the fields that go into the statement
 *
 * Three backends, chosen at startup in this order: IndexedDB (browser default),
 * localStorage (older or restricted contexts, e.g. some private windows), memory
 * (tests, and a last-resort fallback so the app still runs).
 *
 * A backend is a tiny async key/value interface, which is what makes the whole
 * store testable without a browser.
 */

import { appendRecord } from "./chain.js";

export const KEYS = { ledger: "dl.ledger", documents: "dl.documents", answers: "dl.answers" };

export function memoryBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    kind: "memory",
    async get(key) {
      return map.has(key) ? structuredCloneish(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, structuredCloneish(value));
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}

function structuredCloneish(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function localStorageBackend(storage) {
  if (!storage) throw new Error("localStorageBackend needs a storage object");
  return {
    kind: "localstorage",
    async get(key) {
      const raw = storage.getItem(key);
      return raw === null || raw === undefined ? null : JSON.parse(raw);
    },
    async set(key, value) {
      storage.setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      storage.removeItem(key);
    },
    async keys() {
      const out = [];
      for (let i = 0; i < storage.length; i += 1) out.push(storage.key(i));
      return out;
    },
  };
}

/** Minimal IndexedDB key/value store: one object store, one record per key. */
export function indexedDbBackend(factory, { dbName = "disclosure-ledger", storeName = "kv" } = {}) {
  if (!factory) throw new Error("indexedDbBackend needs an IDBFactory");
  const open = () => new Promise((resolve, reject) => {
    const request = factory.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("could not open the database"));
  });
  const tx = async (mode, run) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = run(store);
      transaction.oncomplete = () => resolve(request && "result" in request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error || new Error("transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("transaction aborted"));
    });
  };
  return {
    kind: "indexeddb",
    async get(key) {
      const value = await tx("readonly", (store) => store.get(key));
      return value === undefined ? null : value;
    },
    async set(key, value) {
      await tx("readwrite", (store) => store.put(structuredCloneish(value), key));
    },
    async remove(key) {
      await tx("readwrite", (store) => store.delete(key));
    },
  };
}

/**
 * Pick the best backend that actually works in this environment.
 *
 * IndexedDB first. Every probe is raced against a short deadline: a database that
 * never answers (some private windows, some headless and kiosk contexts) must not
 * leave the app hanging on a white page — it falls back to localStorage, then to
 * memory, so the app always starts.
 */
export async function openStore({ idb, storage, timeoutMs = 1500, prefer = "auto" } = {}) {
  const factory = idb === undefined ? (globalThis.indexedDB || null) : idb;
  const local = storage === undefined ? (safeLocalStorage() || null) : storage;
  // `prefer` comes from the ?store= query parameter. Even when the caller asks for
  // IndexedDB by name, the probe keeps a deadline: a database that never answers
  // must not leave the app on a blank page, it just falls back.
  const patience = prefer === "indexeddb" ? 3000 : timeoutMs;
  if (factory && prefer !== "localstorage") {
    const backend = await probe(indexedDbBackend(factory), patience);
    if (backend) return backend;
  }
  if (local && prefer !== "indexeddb") {
    const backend = await probe(localStorageBackend(local), timeoutMs);
    if (backend) return backend;
  }
  return memoryBackend();
}

async function probe(backend, timeoutMs) {
  const roundTrip = (async () => {
    await backend.set("dl.probe", { ok: true });
    await backend.remove("dl.probe");
    return backend;
  })();
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([roundTrip, deadline]);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The ledger, as the app uses it.
 * ------------------------------------------------------------------ */

export async function readLedger(store) {
  const records = await store.get(KEYS.ledger);
  return Array.isArray(records) ? records : [];
}

/** Append one entry to the stored chain and return the new record. */
export async function appendToStore(store, entry) {
  const records = await readLedger(store);
  const next = await appendRecord(records, entry);
  await store.set(KEYS.ledger, next);
  return next[next.length - 1];
}

export async function clearLedger(store) {
  await store.set(KEYS.ledger, []);
}

/* ------------------------------------------------------------------ *
 * Documents and answers.
 * ------------------------------------------------------------------ */

export async function readDocuments(store) {
  const docs = await store.get(KEYS.documents);
  return Array.isArray(docs) ? docs : [];
}

export async function saveDocument(store, doc) {
  const docs = await readDocuments(store);
  const rest = docs.filter((d) => d.id !== doc.id);
  const next = [doc, ...rest].slice(0, 25);
  await store.set(KEYS.documents, next);
  return next;
}

export async function removeDocument(store, id) {
  const docs = await readDocuments(store);
  const next = docs.filter((d) => d.id !== id);
  await store.set(KEYS.documents, next);
  return next;
}

export function documentId(name, digest) {
  return (String(name || "pasted-text").replace(/\s+/g, "-").slice(0, 32) || "pasted-text") +
    "@" + String(digest || "").slice(0, 12);
}

export async function readAnswers(store) {
  const answers = await store.get(KEYS.answers);
  return answers && typeof answers === "object" ? answers : {};
}

export async function saveAnswers(store, answers) {
  await store.set(KEYS.answers, answers || {});
  return answers || {};
}
