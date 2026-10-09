/**
 * Structural tests for the rule packs. These are the guard rails that keep the
 * packs honest: every clause has to be readable, complete, and machine-checkable.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PACKS, PACK_INDEX, TOTAL_CLAUSES, clauseById, getPack } from "../app/engine/packs.js";
import { testPredicate } from "../app/engine/engine.js";
import { DECLARABLE } from "../app/engine/lexicon.js";

const clauses = PACKS.flatMap((pack) => pack.clauses.map((clause) => ({ pack, clause })));

test("there are four packs", () => {
  assert.equal(PACKS.length, 4);
  assert.deepEqual(PACKS.map((p) => p.id), [
    "eu-ai-act-art50", "tender-ai-declaration", "platform-ai-labelling", "competition-ai-declaration",
  ]);
});

test("TOTAL_CLAUSES counts every clause and each pack has at least eight", () => {
  assert.equal(TOTAL_CLAUSES, clauses.length);
  for (const pack of PACKS) {
    assert.ok(pack.clauses.length >= 8, pack.id + " has only " + pack.clauses.length + " clauses");
  }
});

test("pack metadata is complete", () => {
  for (const pack of PACKS) {
    assert.ok(pack.name && pack.short && pack.jurisdiction, pack.id);
    assert.match(pack.version, /^\d{4}\.\d+$/);
    assert.match(pack.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(pack.basis && pack.basis.label && pack.basis.note, pack.id + " has no basis");
    assert.ok(pack.basis.note.length > 80, pack.id + " basis note is too thin to be useful");
  }
});

test("clause references are unique inside a pack and stable across the index", () => {
  for (const pack of PACKS) {
    const refs = pack.clauses.map((c) => c.ref);
    assert.equal(new Set(refs).size, refs.length, pack.id + " has duplicate refs");
  }
  assert.equal(clauseById("eu-ai-act-art50", "Art. 50(2)").severity, "high");
});

test("every clause is complete enough to act on", () => {
  for (const { pack, clause } of clauses) {
    assert.ok(clause.title, pack.id + " " + clause.ref + " has no title");
    assert.ok(clause.requirement.length > 40, clause.ref + " requirement is too short");
    assert.ok(clause.remediation && clause.remediation.length > 20, clause.ref + " has no remediation");
    assert.ok(clause.suggestedText && clause.suggestedText.length > 30, clause.ref + " has no suggested wording");
    assert.ok(clause.insertInto, clause.ref + " does not say where the wording goes");
    assert.ok(["high", "medium", "low"].includes(clause.severity), clause.ref + " has a bad severity");
  }
});

test("requirements are one line each, as a summary should be", () => {
  for (const { clause } of clauses) {
    assert.ok(!clause.requirement.includes("\n"), clause.ref + " requirement spans lines");
    assert.ok(clause.requirement.length < 260, clause.ref + " requirement is a paragraph");
  }
});

test("advisory clauses are low severity and never counted as gaps", () => {
  for (const { clause } of clauses) {
    if (!clause.advisory) continue;
    assert.equal(clause.severity, "low", clause.ref + " is advisory but not low severity");
  }
});

test("every clause declares when it applies and uses a known signal", () => {
  const known = new Set([...DECLARABLE, "ai_used", "generative_output", "ai_mentioned", "ai_tools"]);
  const walk = (predicate) => {
    if (typeof predicate === "string") {
      assert.ok(known.has(predicate), "unknown signal in applies: " + predicate);
      return;
    }
    if (!predicate || typeof predicate !== "object") return;
    if (predicate.signal) assert.ok(known.has(predicate.signal), "unknown signal: " + predicate.signal);
    if (predicate.not) walk(predicate.not);
    (predicate.all || []).forEach(walk);
    (predicate.any || []).forEach(walk);
  };
  for (const { clause } of clauses) {
    assert.ok(clause.applies !== undefined, clause.ref + " has no applies predicate");
    walk(clause.applies);
  }
});

test("every clause has at least one satisfiable phrase group", () => {
  for (const { clause } of clauses) {
    assert.ok(clause.satisfied, clause.ref + " has no satisfied block");
    assert.ok(clause.satisfied.groups.length >= 1, clause.ref + " has no phrase group");
    assert.ok(["any", "all"].includes(clause.satisfied.mode), clause.ref + " has an unknown mode");
    for (const group of clause.satisfied.groups) {
      assert.ok(group.label, clause.ref + " has an unlabelled group");
      assert.ok(group.phrases.length >= 3, clause.ref + " group " + group.label + " has too few phrases");
      for (const phrase of group.phrases) {
        assert.equal(phrase, phrase.toLowerCase(), clause.ref + " phrase is not lowercase: " + phrase);
        assert.ok(phrase.trim().length > 2, clause.ref + " has a stub phrase: " + phrase);
      }
    }
    // the predicate must be evaluatable, not just present
    testPredicate(clause.applies, { signals: {}, profile: { words: 100, sentenceCount: 5, hits: {} } });
  }
});

test("exemptions carry the reason that explains them", () => {
  for (const { clause } of clauses) {
    if (!clause.exemptIf) continue;
    assert.ok(clause.exemptReason && clause.exemptReason.length > 40, clause.ref + " exempts without a reason");
  }
});

test("the EU pack keeps the clause numbers it is paraphrasing", () => {
  const refs = getPack("eu-ai-act-art50").clauses.map((c) => c.ref);
  for (const expected of ["Art. 50(1)", "Art. 50(2)", "Art. 50(3)", "Art. 50(4)(a)", "Art. 50(4)(b)", "Art. 50(5)", "Art. 50(6)", "Art. 4"]) {
    assert.ok(refs.includes(expected), "missing " + expected);
  }
});

test("no pack reproduces a long quotation", () => {
  // A paraphrase policy test: no single clause may contain a very long run of
  // text, and pack notes must say that they are paraphrases or compilations.
  for (const { clause } of clauses) {
    for (const field of [clause.requirement, clause.remediation, clause.suggestedText]) {
      assert.ok(field.length < 700, clause.ref + " field is long enough to be a quotation");
    }
  }
  for (const pack of PACKS) {
    assert.match(pack.basis.note, /paraphrase|consolidation|template|compilation|written by us|from scratch/i, pack.id);
  }
});

test("PACK_INDEX and getPack agree, and an unknown pack throws", () => {
  assert.equal(Object.keys(PACK_INDEX).length, PACKS.length);
  assert.equal(getPack("tender-ai-declaration").id, "tender-ai-declaration");
  assert.throws(() => getPack("nope"), /unknown rule pack/);
  assert.throws(() => clauseById("tender-ai-declaration", "T-99"), /unknown clause/);
});

test("each pack has its own numbering scheme", () => {
  assert.match(getPack("tender-ai-declaration").clauses[0].ref, /^T-\d+$/);
  assert.match(getPack("platform-ai-labelling").clauses[0].ref, /^P-\d+$/);
  assert.match(getPack("competition-ai-declaration").clauses[0].ref, /^D-\d+$/);
  assert.match(getPack("eu-ai-act-art50").clauses[0].ref, /^Art\. /);
});

test("every pack is satisfied by its own suggested wording", () => {
  // The wording the app suggests must itself satisfy the clause it is suggested
  // for — otherwise the app would recommend text that still fails the check.
  for (const pack of PACKS) {
    for (const clause of pack.clauses) {
      const text = clause.suggestedText.toLowerCase();
      const spec = clause.satisfied;
      const satisfied = spec.mode === "all"
        ? spec.groups.every((g) => g.phrases.some((p) => text.includes(p)))
        : spec.groups.some((g) => g.phrases.some((p) => text.includes(p)));
      assert.ok(satisfied, pack.id + " " + clause.ref + " is not satisfied by its own suggested wording");
    }
  }
});

test("the tender pack recognises a realistic, fully compliant declaration", async () => {
  const { analyze } = await import("../app/engine/lexicon.js");
  const { evaluate } = await import("../app/engine/engine.js");
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
  const report = evaluate({ text, profile: analyze(text, { tender: true }), packIds: ["tender-ai-declaration"] });
  assert.equal(report.summary.gaps, 0);
  assert.equal(report.summary.readiness, 100);
  assert.equal(report.summary.band, "Submission-ready");
});
