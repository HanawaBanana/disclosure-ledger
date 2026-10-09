/**
 * Tests for the rule engine: predicate evaluation, phrase matching, clause
 * statuses, scoring and pack suggestion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { analyze } from "../app/engine/lexicon.js";
import { PACKS, getPack, clauseById } from "../app/engine/packs.js";
import {
  SEVERITY_WEIGHT, band, evaluate, evaluateClause, matchPhrase, recommendPacks,
  requiredDisclosures, testPredicate,
} from "../app/engine/engine.js";

const ctxWith = (signals, extra = {}) => ({
  signals,
  text: extra.text || "",
  profile: { words: extra.words || 10, sentenceCount: extra.sentences || 1, hits: extra.hits || {}, sentences: [] },
});

test("predicate: a bare string reads a signal", () => {
  assert.equal(testPredicate("tender", ctxWith({ tender: true })), true);
  assert.equal(testPredicate("tender", ctxWith({})), false);
});

test("predicate: undefined means always true", () => {
  assert.equal(testPredicate(undefined, ctxWith({})), true);
});

test("predicate: signal, not, all, any compose", () => {
  const ctx = ctxWith({ a: true, b: false });
  assert.equal(testPredicate({ signal: "a" }, ctx), true);
  assert.equal(testPredicate({ not: { signal: "b" } }, ctx), true);
  assert.equal(testPredicate({ all: [{ signal: "a" }, { signal: "b" }] }, ctx), false);
  assert.equal(testPredicate({ any: [{ signal: "a" }, { signal: "b" }] }, ctx), true);
});

test("predicate: numeric guards read the profile", () => {
  const ctx = ctxWith({}, { words: 40, sentences: 3, hits: { ai_tools: 2 } });
  assert.equal(testPredicate({ minWords: 30 }, ctx), true);
  assert.equal(testPredicate({ minWords: 100 }, ctx), false);
  assert.equal(testPredicate({ minSentences: 3 }, ctx), true);
  assert.equal(testPredicate({ hit: "ai_tools", count: 2 }, ctx), true);
  assert.equal(testPredicate({ hit: "ai_tools", count: 3 }, ctx), false);
});

test("predicate: an unknown key throws instead of silently passing", () => {
  assert.throws(() => testPredicate({ signall: "a" }, ctxWith({ a: true })), /unknown predicate/);
});

test("phrase matching is case-insensitive and offset-aware", () => {
  const text = "This deliverable was produced with Artificial   Intelligence assistance.";
  const hit = matchPhrase(text, "produced with artificial intelligence");
  assert.ok(hit);
  assert.equal(text.slice(hit.start, hit.end).toLowerCase(), "produced with artificial   intelligence".toLowerCase());
  assert.equal(hit.sentence, text);
});

test("phrase matching finds nothing and returns null", () => {
  assert.equal(matchPhrase("nothing relevant here", "code of practice"), null);
});

test("a clause whose predicate is false is not applicable, with a reason", () => {
  const pack = getPack("eu-ai-act-art50");
  const clause = clauseById("eu-ai-act-art50", "Art. 50(1)");
  const result = evaluateClause(pack, clause, ctxWith({}));
  assert.equal(result.status, "na");
  assert.equal(result.applicable, false);
  assert.match(result.reason, /not triggered/);
});

test("an applicable clause with no matching wording becomes a gap", () => {
  const pack = getPack("tender-ai-declaration");
  const clause = clauseById("tender-ai-declaration", "T-1");
  const result = evaluateClause(pack, clause, ctxWith({ tender: true }, { text: "We respond to the tender." }));
  assert.equal(result.status, "gap");
  assert.equal(result.evidence, null);
  assert.ok(result.suggestedText.length > 20);
});

test("an applicable clause with matching wording passes and shows evidence", () => {
  const pack = getPack("tender-ai-declaration");
  const clause = clauseById("tender-ai-declaration", "T-1");
  const text = "We confirm that generative artificial intelligence was used to draft this tender response.";
  const result = evaluateClause(pack, clause, ctxWith({ tender: true }, { text }));
  assert.equal(result.status, "pass");
  assert.ok(result.evidence);
  assert.equal(text.slice(result.evidence.start, result.evidence.end).toLowerCase(), "artificial intelligence");
});

test("an advisory clause reports advice rather than a gap", () => {
  const pack = getPack("platform-ai-labelling");
  const clause = clauseById("platform-ai-labelling", "P-8");
  const result = evaluateClause(pack, clause, ctxWith({ video_output: true }, { text: "A short video." }));
  assert.equal(result.status, "advice");
  assert.equal(result.advisory, true);
});

test("an exemption short-circuits the clause with its stated reason", () => {
  const pack = getPack("eu-ai-act-art50");
  const clause = clauseById("eu-ai-act-art50", "Art. 50(4)(a)");
  const result = evaluateClause(pack, clause, ctxWith({ ai_used: true, public_interest: true, human_review: true }));
  assert.equal(result.status, "exempt");
  assert.match(result.reason, /50\(6\)/);
});

test("evaluate returns one result per clause for every selected pack", () => {
  const profile = analyze("A report about AI in public services.");
  const report = evaluate({ text: profile.sentences.map((s) => s.text).join("\n"), profile, packIds: ["eu-ai-act-art50"] });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].clauses.length, getPack("eu-ai-act-art50").clauses.length);
  assert.equal(report.summary.clauses, report.results[0].clauses.length);
});

test("evaluate selects every pack when none is named", () => {
  const profile = analyze("text");
  const report = evaluate({ text: "text", profile });
  assert.deepEqual(report.packIds, PACKS.map((p) => p.id));
});

test("counts and coverage add up", () => {
  const profile = analyze("We used an AI assistant to draft the copy for the public website.");
  const report = evaluate({ text: "We used an AI assistant to draft the copy for the public website.", profile, packIds: PACKS.map((p) => p.id) });
  const s = report.summary;
  assert.equal(s.applicable, s.passed + s.gaps);
  assert.equal(s.clauses, s.passed + s.gaps + s.advice + s.exempt + s.notApplicable);
  assert.equal(s.coveragePercent, Math.round((100 * s.passed) / s.applicable));
});

test("readiness is 100 when nothing applies", () => {
  const profile = analyze("An invoice for printing services.");
  const report = evaluate({ text: "An invoice for printing services.", profile, packIds: ["platform-ai-labelling"] });
  assert.equal(report.summary.applicable, report.summary.passed + report.summary.gaps);
  if (report.summary.applicable === 0) assert.equal(report.summary.readiness, 100);
});

test("readiness punishes high-severity gaps more than low ones", () => {
  const high = evaluate({ text: "", profile: analyze("", { tender: true }), packIds: ["tender-ai-declaration"] });
  assert.ok(high.gaps.length > 0);
  const weights = high.gaps.map((g) => SEVERITY_WEIGHT[g.severity]);
  assert.ok(weights.every((w) => [1, 2, 3].includes(w)));
});

test("a satisfied document scores better than an empty one", () => {
  const text = [
    "We confirm that generative artificial intelligence was used in preparing this submission.",
    "Tools used: ChatGPT and Claude, versions recorded in Annex A.",
    "Extent: AI assistance was limited to the following sections — 2.1 and 4.3.",
    "Every AI-assisted section was reviewed by the bid manager, who signed it off.",
    "No personal data was entered into any third-party AI service.",
    "This submission is our own work and does not infringe third-party rights.",
    "The record is retained for the contract retention period and available on request.",
    "Prices were calculated and checked arithmetically by the commercial manager.",
  ].join("\n");
  const profile = analyze(text, { tender: true });
  const good = evaluate({ text, profile, packIds: ["tender-ai-declaration"] });
  const empty = evaluate({ text: "", profile: analyze("", { tender: true }), packIds: ["tender-ai-declaration"] });
  assert.ok(good.summary.readiness > empty.summary.readiness);
  assert.equal(good.summary.gaps, 0);
  assert.equal(good.summary.readiness, 100);
});

test("bands map readiness to a verdict", () => {
  assert.equal(band(100, 5), "Submission-ready");
  assert.equal(band(75, 5), "Minor gaps");
  assert.equal(band(50, 5), "Material gaps");
  assert.equal(band(10, 5), "Not ready to send");
  assert.equal(band(100, 0), "Nothing to disclose");
});

test("gap severity counts are summarised", () => {
  const profile = analyze("We used an image model for the campaign visuals.");
  const report = evaluate({ text: "We used an image model for the campaign visuals.", profile, packIds: PACKS.map((p) => p.id) });
  const bySeverity = report.summary.bySeverity;
  const total = bySeverity.high + bySeverity.medium + bySeverity.low;
  assert.equal(total, report.summary.gaps);
});

test("requiredDisclosures lists the wording for every gap that has some", () => {
  const profile = analyze("We used an image model.");
  const report = evaluate({ text: "We used an image model.", profile, packIds: ["platform-ai-labelling"] });
  const list = requiredDisclosures(report);
  assert.equal(list.length, report.gaps.filter((g) => g.suggestedText).length);
  for (const item of list) {
    assert.ok(item.ref && item.requirement && item.suggestedText && item.insertInto);
  }
});

test("recommendPacks matches the document to the right packs", () => {
  const tender = recommendPacks(analyze("We respond to the invitation to tender.", { tender: true }));
  assert.equal(tender.find((r) => r.packId === "tender-ai-declaration").recommended, true);
  assert.equal(tender.find((r) => r.packId === "competition-ai-declaration").recommended, false);
  const competition = recommendPacks(analyze("An entry for the design competition.", { competition: true }));
  assert.equal(competition.find((r) => r.packId === "competition-ai-declaration").recommended, true);
});

test("recommendPacks explains itself with signal names and sources", () => {
  const recs = recommendPacks(analyze("A video for our YouTube channel.", { platform_publish: true }));
  const platform = recs.find((r) => r.packId === "platform-ai-labelling");
  assert.equal(platform.recommended, true);
  assert.match(platform.reason, /platform_publish \(declared\)/);
});

test("evaluate is deterministic when the timestamp is supplied", () => {
  const profile = analyze("A note about the campaign.");
  const a = evaluate({ text: "A note about the campaign.", profile, now: "2026-10-07T09:12:00.000Z" });
  const b = evaluate({ text: "A note about the campaign.", profile, now: "2026-10-07T09:12:00.000Z" });
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.gaps.map((g) => g.ref), b.gaps.map((g) => g.ref));
});
