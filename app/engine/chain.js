/**
 * chain.js — the tamper-evident ledger.
 *
 * Every action that matters (a document entered, a check run, a statement
 * generated, an export produced, a verification performed) becomes a record.
 * Records are linked by SHA-256:
 *
 *     hash[0] = sha256( GENESIS + "\n" + canonical({seq, timestamp, type, payload}) )
 *     hash[n] = sha256( hash[n-1] + "\n" + canonical({seq, timestamp, type, payload}) )
 *
 * Changing any byte of any stored record breaks the link from that record
 * onwards, and `verifyChain` reports the first index where it breaks. The
 * canonical form is JSON with sorted keys and no insignificant whitespace, so a
 * verifier in another language (see tools/verify_ledger.py) can recompute it.
 *
 * Payloads must be canonical-safe: strings, booleans, null, integers, and arrays
 * or objects of those. Non-integer numbers are rounded to six decimals on the
 * way in, which is enough for a percentage and keeps JavaScript and Python
 * number formatting identical.
 */

import { LEDGER_FORMAT } from "./lexicon.js";

export const GENESIS = "0".repeat(64);

const HEX64 = /^[0-9a-f]{64}$/;

export function isDigest(value) {
  return typeof value === "string" && HEX64.test(value);
}

/** Stable JSON: object keys sorted, no whitespace, canonical-safe numbers/strings. */
export function canonical(value) {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) return "null";
    if (Number.isInteger(value)) return String(value);
    const rounded = Number(value.toFixed(6));
    return String(rounded);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  throw new Error("cannot canonicalise a " + t);
}

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

/** SHA-256 as lowercase hex. Uses WebCrypto, so it runs in the browser and in Node. */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error("WebCrypto is not available in this environment");
  const buf = await subtle.digest("SHA-256", bytesOf(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The part of a record that is hashed. Everything else is metadata about the chain. */
export function coreOf(record) {
  return {
    seq: record.seq,
    timestamp: record.timestamp,
    type: record.type,
    payload: record.payload,
  };
}

export function hashInput(prevHash, core) {
  return prevHash + "\n" + canonical(core);
}

export async function computeHash(record, prevHash) {
  return sha256Hex(hashInput(prevHash, coreOf(record)));
}

/** Build a record that is ready to append (seq and prevHash come from the chain). */
export async function makeRecord(records, { type, payload, timestamp }) {
  const list = Array.isArray(records) ? records : [];
  const prev = list.length ? list[list.length - 1].hash : GENESIS;
  const record = {
    format: LEDGER_FORMAT,
    seq: list.length + 1,
    timestamp,
    type,
    payload: payload === undefined ? null : payload,
  };
  record.prevHash = prev;
  record.hash = await computeHash(record, prev);
  return record;
}

export async function appendRecord(records, entry) {
  const list = Array.isArray(records) ? records.slice() : [];
  list.push(await makeRecord(list, entry));
  return list;
}

/**
 * Verify a whole ledger. Returns every problem it finds rather than stopping at
 * the first, so the UI can show a real audit result.
 */
export async function verifyChain(records) {
  const list = Array.isArray(records) ? records : [];
  const issues = [];
  if (list.length === 0) {
    return { ok: false, checked: 0, issues: [{ index: -1, code: "empty", detail: "the ledger has no records" }] };
  }
  for (let i = 0; i < list.length; i += 1) {
    const rec = list[i];
    if (!rec || typeof rec !== "object") {
      issues.push({ index: i, code: "malformed", detail: "record is not an object" });
      continue;
    }
    if (rec.seq !== i + 1) {
      issues.push({ index: i, code: "seq", detail: "expected seq " + (i + 1) + ", found " + rec.seq });
    }
    const expectedPrev = i === 0 ? GENESIS : list[i - 1].hash;
    if (rec.prevHash !== expectedPrev) {
      issues.push({ index: i, code: "prev", detail: "previous-hash link does not match record " + i });
    }
    if (!isDigest(rec.hash)) {
      issues.push({ index: i, code: "hash", detail: "hash is not a 64-character hex digest" });
      continue;
    }
    let recomputed = null;
    try {
      recomputed = await computeHash(rec, rec.prevHash);
    } catch (err) {
      issues.push({ index: i, code: "payload", detail: "payload cannot be canonicalised: " + err.message });
      continue;
    }
    if (recomputed !== rec.hash) {
      issues.push({
        index: i,
        code: "hash",
        detail: "record " + rec.seq + " (" + rec.type + ") does not match its stored digest",
      });
    }
  }
  return {
    ok: issues.length === 0,
    checked: list.length,
    issues,
    brokenAt: issues.length ? issues[0].index : null,
  };
}

/** Fingerprint of the whole ledger: one digest that stands for the chain. */
export async function chainDigest(records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return sha256Hex("empty-ledger");
  return sha256Hex(list.map((r) => (r && r.hash) || "?").join("\n"));
}

/* ------------------------------------------------------------------ *
 * Ledger operations. Each one describes something that actually happened.
 * ------------------------------------------------------------------ */

export function documentRecord({ name, digest, chars, words }) {
  return {
    type: "document.registered",
    payload: { name: name || "pasted text", digest, chars, words },
  };
}

export function scanRecord({ report, digest, profile }) {
  return {
    type: "check.run",
    payload: {
      document: digest,
      engine: report.engine,
      packs: report.packIds.slice().sort(),
      clauses: report.summary.clauses,
      applicable: report.summary.applicable,
      passed: report.summary.passed,
      gaps: report.summary.gaps,
      bySeverity: report.summary.bySeverity,
      readiness: report.summary.readiness,
      coverage: report.summary.coveragePercent,
      declared: Object.keys(profile.declared).sort(),
      detected: Object.keys(profile.detected).filter((k) => profile.detected[k]).sort(),
    },
  };
}

export function statementRecord({ digest, words, packs, statementDigest }) {
  return {
    type: "statement.generated",
    payload: { document: digest, statement: statementDigest, words, packs: packs.slice().sort() },
  };
}

export function exportRecord({ kind, digest, records }) {
  return { type: "export." + kind, payload: { ledger: digest, records } };
}

export function verifyRecord({ ok, checked, brokenAt, digest }) {
  return {
    type: "ledger.verified",
    payload: { ok: !!ok, checked, brokenAt: brokenAt === undefined ? null : brokenAt, ledger: digest },
  };
}

export const RECORD_TYPES = [
  "document.registered",
  "check.run",
  "statement.generated",
  "export.json",
  "export.html",
  "export.markdown",
  "ledger.verified",
];

export const RECORD_LABELS = {
  "document.registered": "Document registered",
  "check.run": "Compliance check run",
  "statement.generated": "Disclosure statement generated",
  "export.json": "Ledger exported (JSON)",
  "export.html": "Ledger exported (HTML)",
  "export.markdown": "Statement exported (Markdown)",
  "ledger.verified": "Ledger verified",
};
