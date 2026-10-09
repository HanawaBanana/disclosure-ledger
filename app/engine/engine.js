/**
 * engine.js — the rule engine.
 *
 * Pure functions, no DOM, no network. Given a document text, an analysis profile
 * and a list of rule packs, it returns one result per clause with an explicit
 * status, the evidence it found, and what to do when nothing was found.
 *
 *   pass    the clause applies and the document satisfies it — evidence attached
 *   gap     the clause applies and nothing satisfies it — counted in the score
 *   advice  an advisory clause applies and nothing satisfies it — shown, not counted
 *   exempt  the clause applies but a stated exemption covers it (reason attached)
 *   n/a     the clause does not apply to this document (reason attached)
 */

import { splitSentences, sentenceAt, termPattern, normalize } from "./lexicon.js";
import { PACKS, getPack } from "./packs.js";

export const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

/**
 * Predicate evaluator. The DSL is intentionally tiny so that every rule pack can
 * be read and audited by a human:
 *
 *   "signal"                    shorthand for { signal: "signal" }
 *   { signal: "x" }             the signal is on
 *   { not: <pred> }             negation
 *   { all: [<pred>, ...] }      every predicate holds
 *   { any: [<pred>, ...] }      at least one holds
 *   { always: true|false }      constant
 *   { minWords: n }             document has at least n words
 *   { minSentences: n }         document has at least n sentences
 *   { hit: "ai_tools", count }  the named lexicon list matched at least count times
 *
 * Anything else throws: a pack with a typo must fail loudly rather than silently
 * pass every document.
 */
export function testPredicate(pred, ctx) {
  if (pred === undefined || pred === null) return true;
  if (typeof pred === "string") return pred === "always" ? true : !!ctx.signals[pred];
  if (pred.always !== undefined) return !!pred.always;
  if (pred.signal !== undefined) return !!ctx.signals[pred.signal];
  if (pred.not !== undefined) return !testPredicate(pred.not, ctx);
  if (pred.all !== undefined) return pred.all.every((p) => testPredicate(p, ctx));
  if (pred.any !== undefined) return pred.any.some((p) => testPredicate(p, ctx));
  if (pred.minWords !== undefined) return ctx.profile.words >= pred.minWords;
  if (pred.minSentences !== undefined) return ctx.profile.sentenceCount >= pred.minSentences;
  if (pred.hit !== undefined) return (ctx.profile.hits[pred.hit] || 0) >= (pred.count || 1);
  throw new Error("unknown predicate: " + JSON.stringify(pred));
}

/** Case-insensitive, whitespace-tolerant literal phrase match with offsets. */
export function matchPhrase(text, phrase, sentences) {
  const src = normalize(text);
  const m = termPattern(phrase).exec(src);
  if (!m) return null;
  const sentence = sentenceAt(sentences || splitSentences(src), m.index);
  return {
    phrase,
    quote: m[0],
    start: m.index,
    end: m.index + m[0].length,
    sentence: sentence ? sentence.text : m[0],
    sentenceStart: sentence ? sentence.start : m.index,
  };
}

function matchGroups(text, groups, sentences, mode) {
  const tried = groups.map((group) => {
    let best = null;
    for (const phrase of group.phrases) {
      const hit = matchPhrase(text, phrase, sentences);
      if (hit && (!best || hit.start < best.start)) best = hit;
    }
    return { label: group.label, matched: !!best, phrase: best ? best.phrase : null, hit: best };
  });
  const ok = mode === "all" ? tried.every((t) => t.matched) : tried.some((t) => t.matched);
  const hit = tried.find((t) => t.matched) || null;
  return { satisfied: ok, groups: tried, hit: hit ? hit.hit : null };
}

/** One clause against one document. */
export function evaluateClause(pack, clause, ctx) {
  const base = {
    packId: pack.id,
    packName: pack.name,
    ref: clause.ref,
    title: clause.title,
    requirement: clause.requirement,
    severity: clause.severity || "medium",
    advisory: !!clause.advisory,
    remediation: clause.remediation || "",
    suggestedText: clause.suggestedText || "",
    insertInto: clause.insertInto || "",
    evidence: null,
    groups: [],
    reason: "",
  };

  if (!testPredicate(clause.applies, ctx)) {
    return { ...base, status: "na", applicable: false, reason: "not triggered by this document or declared usage" };
  }
  if (clause.exemptIf && testPredicate(clause.exemptIf, ctx)) {
    return { ...base, status: "exempt", applicable: false, reason: clause.exemptReason || "exemption stated in the pack" };
  }

  const spec = clause.satisfied || { mode: "any", groups: [] };
  const matched = matchGroups(ctx.text, spec.groups || [], ctx.profile.sentences, spec.mode || "any");

  if (matched.satisfied) {
    return {
      ...base,
      status: "pass",
      applicable: true,
      groups: matched.groups,
      evidence: matched.hit,
      reason: "satisfied by the text",
    };
  }
  return {
    ...base,
    status: clause.advisory ? "advice" : "gap",
    applicable: true,
    groups: matched.groups,
    evidence: null,
    reason: clause.advisory
      ? "advisory: not a blocking requirement, but nothing in the document addresses it"
      : "nothing in the document satisfies this requirement",
  };
}

/**
 * Run several packs over one document.
 *
 * evaluate({ text, profile, packIds, now }) -> report
 * `now` is injected rather than read from the clock so that runs are reproducible.
 */
export function evaluate({ text, profile, packIds, now = null }) {
  const ids = (packIds && packIds.length ? packIds : PACKS.map((p) => p.id));
  const ctx = { text: normalize(text), profile, signals: profile.signals };
  const results = ids.map((id) => {
    const pack = getPack(id);
    const clauses = pack.clauses.map((clause) => evaluateClause(pack, clause, ctx));
    return {
      packId: pack.id,
      packName: pack.name,
      packVersion: pack.version,
      packBasis: pack.basis,
      clauses,
      counts: countStatuses(clauses),
    };
  });

  const all = results.flatMap((r) => r.clauses);
  const gaps = all.filter((c) => c.status === "gap");
  const advices = all.filter((c) => c.status === "advice");
  const passes = all.filter((c) => c.status === "pass");
  const counted = all.filter((c) => c.status === "pass" || c.status === "gap");

  const maxWeight = counted.reduce((n, c) => n + (SEVERITY_WEIGHT[c.severity] || 1), 0);
  const lost = gaps.reduce((n, c) => n + (SEVERITY_WEIGHT[c.severity] || 1), 0);
  const readiness = maxWeight === 0 ? 100 : Math.round(100 * (1 - lost / maxWeight));

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const gap of gaps) bySeverity[gap.severity] = (bySeverity[gap.severity] || 0) + 1;

  return {
    engine: profile.engine,
    generatedAt: now,
    packIds: ids,
    results,
    gaps,
    advices,
    passes,
    summary: {
      packs: ids.length,
      clauses: all.length,
      applicable: counted.length,
      passed: passes.length,
      gaps: gaps.length,
      advice: advices.length,
      exempt: all.filter((c) => c.status === "exempt").length,
      notApplicable: all.filter((c) => c.status === "na").length,
      coveragePercent: counted.length === 0 ? 100 : Math.round((100 * passes.length) / counted.length),
      readiness,
      band: band(readiness, counted.length),
      bySeverity,
    },
  };
}

function countStatuses(clauses) {
  const counts = { pass: 0, gap: 0, advice: 0, exempt: 0, na: 0 };
  for (const c of clauses) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

export function band(readiness, applicable) {
  if (applicable === 0) return "Nothing to disclose";
  if (readiness >= 90) return "Submission-ready";
  if (readiness >= 70) return "Minor gaps";
  if (readiness >= 40) return "Material gaps";
  return "Not ready to send";
}

/**
 * Suggest the packs that fit a document. Suggestion only — the user always makes
 * the final selection, and the UI shows why each pack was suggested.
 */
export const PACK_TRIGGERS = {
  "eu-ai-act-art50": ["ai_used", "generative_output", "synthetic_media", "interactive", "public_interest", "platform_publish", "biometric"],
  "tender-ai-declaration": ["tender"],
  "platform-ai-labelling": ["platform_publish", "synthetic_media", "audio_output", "video_output"],
  "competition-ai-declaration": ["competition"],
};

export function recommendPacks(profile) {
  return PACKS.map((pack) => {
    const triggers = PACK_TRIGGERS[pack.id] || [];
    const hits = triggers.filter((t) => profile.signals[t]);
    return {
      packId: pack.id,
      packName: pack.name,
      recommended: hits.length > 0,
      triggers: hits,
      reason: hits.length === 0
        ? "no signal in the document or the declaration points at this pack"
        : "signals: " + hits.map((h) => h + " (" + (profile.sources[h] || "detected") + ")").join(", "),
    };
  });
}

/** The disclosure statement draft: one list of sentences the deliverable must contain. */
export function requiredDisclosures(report) {
  return report.gaps
    .filter((g) => g.suggestedText)
    .map((g) => ({
      ref: g.ref,
      packId: g.packId,
      severity: g.severity,
      requirement: g.requirement,
      suggestedText: g.suggestedText,
      insertInto: g.insertInto,
    }));
}
