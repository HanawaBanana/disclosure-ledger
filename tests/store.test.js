/**
 * Tests for the store: the three backends, the fallback order, and the ledger /
 * document / answer helpers the interface uses.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEYS, appendToStore, clearLedger, documentId, localStorageBackend, memoryBackend,
  openStore, readAnswers, readDocuments, readLedger, removeDocument, saveAnswers, saveDocument,
} from "../app/engine/store.js";
import { verifyChain } from "../app/engine/chain.js";

function fakeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const noIdb = { open: () => { throw new Error("IndexedDB is not available"); } };

test("memory backend stores, reads and removes values", async () => {
  const store = memoryBackend();
  assert.equal(store.kind, "memory");
  assert.equal(await store.get("missing"), null);
  await store.set("a", { n: 1 });
  assert.deepEqual(await store.get("a"), { n: 1 });
  await store.remove("a");
  assert.equal(await store.get("a"), null);
  await store.set("b", 1);
  assert.deepEqual(await store.keys(), ["b"]);
});

test("memory backend returns copies, not references", async () => {
  const store = memoryBackend();
  await store.set("a", { list: [1] });
  const first = await store.get("a");
  first.list.push(2);
  assert.deepEqual((await store.get("a")).list, [1]);
});

test("localStorage backend round-trips JSON", async () => {
  const storage = fakeLocalStorage();
  const store = localStorageBackend(storage);
  assert.equal(store.kind, "localstorage");
  await store.set("k", { a: [1, 2] });
  assert.deepEqual(await store.get("k"), { a: [1, 2] });
  assert.equal(storage.getItem("k"), '{"a":[1,2]}');
  assert.deepEqual(await store.keys(), ["k"]);
  await store.remove("k");
  assert.equal(await store.get("k"), null);
});

test("localStorage backend needs a storage object", () => {
  assert.throws(() => localStorageBackend(null), /needs a storage object/);
});

test("openStore prefers IndexedDB when it answers", async () => {
  const store = await openStore({ idb: null, storage: fakeLocalStorage() });
  assert.equal(store.kind, "localstorage");
});

test("openStore falls back to localStorage when IndexedDB is broken", async () => {
  const store = await openStore({ idb: noIdb, storage: fakeLocalStorage(), timeoutMs: 200 });
  assert.equal(store.kind, "localstorage");
});

test("openStore falls back to memory when nothing else works", async () => {
  const store = await openStore({ idb: noIdb, storage: null, timeoutMs: 200 });
  assert.equal(store.kind, "memory");
});

test("a backend that never answers cannot hang the app", async () => {
  const never = { open: () => ({ set onupgradeneeded(_) {}, set onsuccess(_) {}, set onerror(_) {} }) };
  const started = Date.now();
  const store = await openStore({ idb: never, storage: null, timeoutMs: 120 });
  assert.equal(store.kind, "memory");
  assert.ok(Date.now() - started < 2000, "the probe should give up quickly");
});

test("readLedger returns an empty array for a fresh store", async () => {
  const store = memoryBackend();
  assert.deepEqual(await readLedger(store), []);
});

test("appendToStore writes a sealed record and keeps the chain valid", async () => {
  const store = memoryBackend();
  await appendToStore(store, { type: "document.registered", payload: { name: "a" }, timestamp: "2026-10-07T09:12:00.000Z" });
  await appendToStore(store, { type: "check.run", payload: { gaps: 1 }, timestamp: "2026-10-07T09:12:01.000Z" });
  const records = await readLedger(store);
  assert.equal(records.length, 2);
  assert.equal(records[1].prevHash, records[0].hash);
  const result = await verifyChain(records);
  assert.equal(result.ok, true);
});

test("appendToStore returns the new record", async () => {
  const store = memoryBackend();
  const record = await appendToStore(store, { type: "check.run", payload: {}, timestamp: "2026-10-07T09:12:00.000Z" });
  assert.equal(record.seq, 1);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
});

test("clearLedger leaves an empty, valid starting point", async () => {
  const store = memoryBackend();
  await appendToStore(store, { type: "check.run", payload: {}, timestamp: "2026-10-07T09:12:00.000Z" });
  await clearLedger(store);
  assert.deepEqual(await readLedger(store), []);
});

test("appendToStore uses the ledger key, not a new one", async () => {
  const store = memoryBackend();
  await appendToStore(store, { type: "check.run", payload: {}, timestamp: "2026-10-07T09:12:00.000Z" });
  assert.ok(await store.get(KEYS.ledger));
});

test("documentId is stable and readable", () => {
  const a = documentId("Harbour Festival.md", "abcdef0123456789");
  assert.equal(a, "Harbour-Festival.md@abcdef012345");
  assert.equal(a, documentId("Harbour Festival.md", "abcdef0123456789"));
  assert.notEqual(a, documentId("Harbour Festival.md", "bbbbbbbbbbbbbbbb"));
});

test("saving a document keeps the newest first and de-duplicates by id", async () => {
  const store = memoryBackend();
  await saveDocument(store, { id: "a", name: "A", words: 1 });
  await saveDocument(store, { id: "b", name: "B", words: 2 });
  await saveDocument(store, { id: "a", name: "A again", words: 3 });
  const docs = await readDocuments(store);
  assert.deepEqual(docs.map((d) => d.id), ["a", "b"]);
  assert.equal(docs[0].name, "A again");
});

test("the recent-document list is capped", async () => {
  const store = memoryBackend();
  for (let i = 0; i < 30; i += 1) await saveDocument(store, { id: "d" + i, name: "doc " + i });
  assert.equal((await readDocuments(store)).length, 25);
});

test("removing a document leaves the others", async () => {
  const store = memoryBackend();
  await saveDocument(store, { id: "a", name: "A" });
  await saveDocument(store, { id: "b", name: "B" });
  await removeDocument(store, "a");
  assert.deepEqual((await readDocuments(store)).map((d) => d.id), ["b"]);
});

test("answers round-trip and default to an empty object", async () => {
  const store = memoryBackend();
  assert.deepEqual(await readAnswers(store), {});
  await saveAnswers(store, { organisation: "Northlight Studio" });
  assert.deepEqual(await readAnswers(store), { organisation: "Northlight Studio" });
});

test("answers survive a reload through localStorage", async () => {
  const storage = fakeLocalStorage();
  const store = localStorageBackend(storage);
  await saveAnswers(store, { project: "Harbour Festival" });
  const reopened = await openStore({ idb: noIdb, storage, timeoutMs: 100 });
  assert.equal((await readAnswers(reopened)).project, "Harbour Festival");
});
