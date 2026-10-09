/**
 * Tests for the hash chain: canonical form, digest, linkage, and every way a
 * ledger can be tampered with.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GENESIS, appendRecord, canonical, chainDigest, computeHash, coreOf, documentRecord,
  exportRecord, hashInput, isDigest, makeRecord, scanRecord, sha256Hex, statementRecord,
  verifyChain, verifyRecord, RECORD_TYPES, RECORD_LABELS,
} from "../app/engine/chain.js";

const at = (n) => "2026-10-07T09:1" + n + ":00.000Z";

async function sampleChain() {
  let records = [];
  records = await appendRecord(records, { type: "document.registered", payload: { name: "a.md", digest: "x".repeat(64), chars: 10, words: 2 }, timestamp: at(0) });
  records = await appendRecord(records, { type: "check.run", payload: { document: "x".repeat(64), gaps: 3, readiness: 62, packs: ["tender-ai-declaration"] }, timestamp: at(1) });
  records = await appendRecord(records, { type: "export.json", payload: { ledger: "y".repeat(64), records: 2 }, timestamp: at(2) });
  return records;
}

test("GENESIS is 64 zeros", () => {
  assert.equal(GENESIS.length, 64);
  assert.match(GENESIS, /^0+$/);
});

test("sha256Hex matches a known vector", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("sha256Hex hashes UTF-8, not code units", async () => {
  assert.equal(await sha256Hex("é"), "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
});

test("canonical sorts keys and drops whitespace", () => {
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonical([1, { d: true, c: null }]), '[1,{"c":null,"d":true}]');
});

test("canonical normalises numbers so Python can reproduce it", () => {
  assert.equal(canonical(1.0), "1");
  assert.equal(canonical(0.1 + 0.2), "0.3");
  assert.equal(canonical(11.5), "11.5");
  assert.equal(canonical(Number.NaN), "null");
  assert.equal(canonical(Infinity), "null");
});

test("canonical escapes quotes and unicode in strings", () => {
  assert.equal(canonical('say "hi"'), '"say \\"hi\\""');
  assert.equal(canonical("café"), '"café"');
});

test("canonical refuses values it cannot represent", () => {
  assert.throws(() => canonical(() => {}), /cannot canonicalise/);
});

test("isDigest accepts only 64 hex characters", () => {
  assert.equal(isDigest("a".repeat(64)), true);
  assert.equal(isDigest("A".repeat(64)), false);
  assert.equal(isDigest("a".repeat(63)), false);
  assert.equal(isDigest(null), false);
});

test("the first record links to GENESIS", async () => {
  const records = await sampleChain();
  assert.equal(records[0].prevHash, GENESIS);
  assert.equal(records[0].seq, 1);
});

test("each record links to the one before it", async () => {
  const records = await sampleChain();
  assert.equal(records[1].prevHash, records[0].hash);
  assert.equal(records[2].prevHash, records[1].hash);
  assert.equal(records[2].seq, 3);
});

test("hashInput is prevHash, a newline, then the canonical core", async () => {
  const records = await sampleChain();
  const first = records[0];
  const expected = first.prevHash + "\n" + canonical(coreOf(first));
  assert.equal(hashInput(first.prevHash, coreOf(first)), expected);
  assert.equal(await sha256Hex(expected), first.hash);
});

test("a fresh chain verifies", async () => {
  const records = await sampleChain();
  const result = await verifyChain(records);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 3);
  assert.deepEqual(result.issues, []);
  assert.equal(result.brokenAt, null);
});

test("an empty ledger does not verify", async () => {
  const result = await verifyChain([]);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "empty");
});

test("editing a payload is detected, and names the record", async () => {
  const records = await sampleChain();
  records[1].payload.gaps = 0;
  const result = await verifyChain(records);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.issues[0].detail, /check\.run/);
});

test("editing the timestamp is detected", async () => {
  const records = await sampleChain();
  records[0].timestamp = "2020-01-01T00:00:00.000Z";
  const result = await verifyChain(records);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "hash");
});

test("dropping a record from the middle is detected", async () => {
  const records = await sampleChain();
  records.splice(1, 1);
  const result = await verifyChain(records);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "seq"));
});

test("swapping two records is detected", async () => {
  const records = await sampleChain();
  const swapped = [records[0], records[2], records[1]];
  const result = await verifyChain(swapped);
  assert.equal(result.ok, false);
});

test("re-sealing one record breaks the link after it", async () => {
  const records = await sampleChain();
  records[1] = await makeRecord([records[0]], {
    type: records[1].type, payload: { ...records[1].payload, gaps: 0 }, timestamp: records[1].timestamp,
  });
  const result = await verifyChain(records);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "prev"));
});

test("a malformed record is reported rather than throwing", async () => {
  const records = await sampleChain();
  records.push("not a record");
  const result = await verifyChain(records);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "malformed"));
});

test("a record whose hash is not a digest is rejected", async () => {
  const records = await sampleChain();
  records[0].hash = "short";
  const result = await verifyChain(records);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "hash"));
});

test("a payload that cannot be canonicalised is reported", async () => {
  const records = await sampleChain();
  records[1].payload.bad = () => {};
  const result = await verifyChain(records);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "payload"));
});

test("chain digest fingerprints the sealed hashes", async () => {
  const records = await sampleChain();
  const before = await chainDigest(records);
  assert.match(before, /^[0-9a-f]{64}$/);
  // The digest is built from the stored hashes, so an edit that is not re-sealed
  // does not move it — verifyChain is what catches that edit.
  records[2].payload.records = 99;
  assert.equal(await chainDigest(records), before);
  // Appending, or re-sealing, does move it.
  const longer = await appendRecord(records, { type: "export.html", payload: {}, timestamp: at(3) });
  assert.notEqual(await chainDigest(longer), before);
  const resealed = await sampleChain();
  resealed[1] = await makeRecord([resealed[0]], { type: "check.run", payload: { gaps: 0 }, timestamp: at(1) });
  assert.notEqual(await chainDigest(resealed), before);
});

test("chain digest of an empty ledger is stable", async () => {
  assert.equal(await chainDigest([]), await chainDigest([]));
});

test("computeHash is stable for the same record and predecessor", async () => {
  const records = await sampleChain();
  assert.equal(await computeHash(records[0], GENESIS), records[0].hash);
});

test("record builders produce the documented types and payloads", () => {
  const doc = documentRecord({ name: "note.md", digest: "d".repeat(64), chars: 5, words: 1 });
  assert.equal(doc.type, "document.registered");
  assert.equal(doc.payload.name, "note.md");
  const scan = scanRecord({
    report: {
      engine: "1.0.0",
      packIds: ["b", "a"],
      summary: { clauses: 8, applicable: 6, passed: 4, gaps: 2, bySeverity: { high: 1, medium: 1, low: 0 }, readiness: 70, coveragePercent: 66 },
    },
    digest: "d".repeat(64),
    profile: { declared: { tender: true }, detected: { ai_used: true } },
  });
  assert.equal(scan.type, "check.run");
  assert.deepEqual(scan.payload.packs, ["a", "b"]);
  assert.deepEqual(scan.payload.declared, ["tender"]);
  const statement = statementRecord({ digest: "d".repeat(64), words: 120, packs: ["x"], statementDigest: "s".repeat(64) });
  assert.equal(statement.type, "statement.generated");
  const exported = exportRecord({ kind: "json", digest: "d".repeat(64), records: 4 });
  assert.equal(exported.type, "export.json");
  const verified = verifyRecord({ ok: true, checked: 4, brokenAt: null, digest: "d".repeat(64) });
  assert.equal(verified.type, "ledger.verified");
});

test("every record type has a human label", () => {
  for (const type of RECORD_TYPES) {
    assert.ok(RECORD_LABELS[type], "no label for " + type);
  }
  assert.equal(RECORD_TYPES.length, Object.keys(RECORD_LABELS).length);
});

test("appending to a stored chain does not mutate the original array", async () => {
  const records = await sampleChain();
  const longer = await appendRecord(records, { type: "export.html", payload: {}, timestamp: at(3) });
  assert.equal(records.length, 3);
  assert.equal(longer.length, 4);
});
