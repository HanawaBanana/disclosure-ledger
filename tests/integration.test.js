/**
 * Integration tests: the whole pipeline in one go, on the documents the app
 * ships as samples, plus a cross-language check that the Python verifier accepts
 * (and rejects) what the JavaScript chain produces.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { SAMPLES, sampleById } from "../app/samples.js";
import { analyze } from "../app/engine/lexicon.js";
import { evaluate, recommendPacks } from "../app/engine/engine.js";
import { PACKS, TOTAL_CLAUSES } from "../app/engine/packs.js";
import { appendRecord, chainDigest, documentRecord, scanRecord, verifyChain } from "../app/engine/chain.js";
import { buildStatement } from "../app/engine/statement.js";
import { ledgerFile, toJson, toStandaloneHtml } from "../app/engine/exporters.js";

const run = promisify(execFile);
const VERIFIER = new URL("../tools/verify_ledger.py", import.meta.url).pathname;
const hasPython = async () => {
  try {
    await run("python3", ["--version"]);
    return true;
  } catch (err) {
    return false;
  }
};

function pipeline(sample, when = "2026-10-07T09:12:00.000Z") {
  const profile = analyze(sample.text, { ...sample.declared, tools: sample.tools, usageNote: sample.usageNote });
  const report = evaluate({ text: sample.text, profile, packIds: sample.packs, now: when });
  const statement = buildStatement({ profile, report, answers: sample.answers, date: when.slice(0, 10) });
  return { profile, report, statement };
}

test("there are four sample documents with everything they need", () => {
  assert.equal(SAMPLES.length, 4);
  for (const sample of SAMPLES) {
    assert.ok(sample.text.length > 200, sample.id + " text is too short");
    assert.ok(sample.packs.length > 0, sample.id + " selects no pack");
    assert.ok(Object.keys(sample.declared).length > 0, sample.id + " declares nothing");
    assert.ok(sample.tools && sample.answers.organisation, sample.id + " is missing statement fields");
    for (const packId of sample.packs) {
      assert.ok(PACKS.some((p) => p.id === packId), sample.id + " names an unknown pack: " + packId);
    }
  }
});

test("sampleById throws on an unknown id", () => {
  assert.throws(() => sampleById("nope"), /unknown sample/);
});

test("every sample runs end to end and produces a usable report", () => {
  for (const sample of SAMPLES) {
    const { report, statement } = pipeline(sample);
    assert.ok(report.summary.clauses > 0, sample.id);
    assert.equal(report.summary.applicable, report.summary.passed + report.summary.gaps, sample.id);
    assert.ok(statement.words > 120, sample.id + " statement is too thin");
    assert.ok(statement.markdown.includes(sample.answers.organisation), sample.id);
  }
});

test("the agency sample finds gaps, and the recommendation matches its packs", () => {
  const sample = sampleById("agency-deliverable");
  const { profile, report } = pipeline(sample);
  assert.ok(report.gaps.length >= 5, "expected the agency sample to have real gaps");
  const recommended = recommendPacks(profile).filter((r) => r.recommended).map((r) => r.packId);
  for (const packId of sample.packs) {
    assert.ok(recommended.includes(packId), "expected the engine to suggest " + packId);
  }
});

test("the newsroom sample exercises the Article 50(6) exemption", () => {
  const { report } = pipeline(sampleById("newsroom-note"));
  const exempt = report.results.flatMap((r) => r.clauses).filter((c) => c.status === "exempt");
  assert.equal(exempt.length, 1);
  assert.match(exempt[0].reason, /50\(6\)/);
});

test("the tender sample matches the rules a bid team would expect", () => {
  const { report } = pipeline(sampleById("tender-response"));
  const status = (ref) => report.results.flatMap((r) => r.clauses).find((c) => c.ref === ref).status;
  assert.equal(status("T-1"), "pass");
  assert.equal(status("T-3"), "gap");
  assert.equal(status("T-5"), "pass");
});

test("the same sample produces the same report twice", () => {
  const sample = sampleById("competition-entry");
  const first = pipeline(sample);
  const second = pipeline(sample);
  assert.deepEqual(first.report.summary, second.report.summary);
  assert.equal(first.statement.markdown, second.statement.markdown);
});

test("a sample can climb from gaps to ready when the suggested wording is added", () => {
  const sample = sampleById("tender-response");
  const before = pipeline(sample);
  assert.ok(before.report.gaps.length > 0);
  const patched = before.report.gaps.map((g) => g.suggestedText).join("\n");
  const text = sample.text + "\n" + patched;
  const profile = analyze(text, { ...sample.declared, tools: sample.tools });
  const after = evaluate({ text, profile, packIds: ["tender-ai-declaration"] });
  assert.ok(after.summary.gaps < before.report.summary.gaps, "adding the suggested wording should close gaps");
  assert.ok(after.summary.readiness >= before.report.summary.readiness);
});

test("the whole pipeline is written to a ledger that verifies", async () => {
  const sample = sampleById("agency-deliverable");
  const { profile, report, statement } = pipeline(sample);
  let records = await appendRecord([], { ...documentRecord({ name: sample.filename, digest: "a".repeat(64), chars: profile.chars, words: profile.words }), timestamp: "2026-10-07T09:12:00.000Z" });
  records = await appendRecord(records, { ...scanRecord({ report, digest: "a".repeat(64), profile }), timestamp: "2026-10-07T09:12:01.000Z" });
  records = await appendRecord(records, { type: "statement.generated", payload: { document: "a".repeat(64), statement: "b".repeat(64), words: statement.words, packs: sample.packs }, timestamp: "2026-10-07T09:12:02.000Z" });
  const digest = await chainDigest(records);
  const file = ledgerFile({ records, digest, generatedAt: "2026-10-07T09:12:03.000Z" });
  const result = await verifyChain(JSON.parse(toJson(file)).records);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 3);
});

test("TOTAL_CLAUSES matches what a full run evaluates", () => {
  const profile = analyze("We used an AI assistant to draft a public article for our website.");
  const report = evaluate({ text: "We used an AI assistant to draft a public article for our website.", profile });
  assert.equal(report.summary.clauses, TOTAL_CLAUSES);
});

test("the Python verifier accepts a ledger written by JavaScript", async (t) => {
  if (!(await hasPython())) return t.skip("python3 is not available");
  const sample = sampleById("tender-response");
  const { profile, report } = pipeline(sample);
  let records = await appendRecord([], { ...documentRecord({ name: sample.filename, digest: "a".repeat(64), chars: profile.chars, words: profile.words }), timestamp: "2026-10-07T09:12:00.000Z" });
  records = await appendRecord(records, { ...scanRecord({ report, digest: "a".repeat(64), profile }), timestamp: "2026-10-07T09:12:01.000Z" });
  const dir = mkdtempSync(join(tmpdir(), "dl-verify-"));
  const path = join(dir, "ledger.json");
  writeFileSync(path, toJson(ledgerFile({ records, digest: await chainDigest(records) })));

  const ok = await run("python3", [VERIFIER, path]);
  assert.match(ok.stdout, /^OK: 2 records, chain intact/);

  const tampered = records.map((r) => JSON.parse(JSON.stringify(r)));
  tampered[1].payload.gaps = 0;
  tampered[1].payload.note = "edited after the fact";
  const badPath = join(dir, "tampered.json");
  writeFileSync(badPath, JSON.stringify({ format: "disclosure-ledger/1", records: tampered }, null, 2));
  await assert.rejects(() => run("python3", [VERIFIER, badPath]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /FAILED/);
    return true;
  });
});

test("the Python verifier accepts a chain containing awkward strings and numbers", async (t) => {
  if (!(await hasPython())) return t.skip("python3 is not available");
  let records = await appendRecord([], {
    type: "check.run",
    payload: {
      note: 'quotes " and a backslash \\ and a newline\n plus café and 日本語',
      ratio: 0.1 + 0.2,
      whole: 42,
      empty: null,
      ok: true,
      list: ["a", 1, 2.5, { nested: true }],
    },
    timestamp: "2026-10-07T09:12:00.000Z",
  });
  records = await appendRecord(records, { type: "export.json", payload: { ledger: "d".repeat(64), records: 1 }, timestamp: "2026-10-07T09:12:01.000Z" });
  const dir = mkdtempSync(join(tmpdir(), "dl-verify-"));
  const path = join(dir, "awkward.json");
  writeFileSync(path, toJson(ledgerFile({ records, digest: await chainDigest(records) })));
  const ok = await run("python3", [VERIFIER, path]);
  assert.match(ok.stdout, /^OK: 2 records/);
});

test("the standalone export carries the same records the ledger holds", async () => {
  const sample = sampleById("competition-entry");
  const { report, statement } = pipeline(sample);
  const records = await appendRecord([], { type: "check.run", payload: { gaps: report.summary.gaps }, timestamp: "2026-10-07T09:12:00.000Z" });
  const digest = await chainDigest(records);
  const html = toStandaloneHtml({ report, statement, records, digest, generatedAt: "2026-10-07T09:12:01.000Z" });
  const embedded = JSON.parse(html.match(/<script id="ledger-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(embedded.records, records);
  assert.equal(embedded.digest, digest);
  assert.ok(html.includes(sample.answers.organisation));
});
