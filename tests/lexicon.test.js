/**
 * Tests for the analyser: lexicon matching, sentence spans, and the merge of
 * declared usage with detected usage.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_VERSION, LEDGER_FORMAT, LEXICON, DECLARABLE, analyze, findTerm,
  normalize, sentenceAt, splitSentences, termPattern,
} from "../app/engine/lexicon.js";

test("engine version and ledger format are declared", () => {
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(LEDGER_FORMAT, 1);
});

test("normalize converts CRLF to LF and tolerates null", () => {
  assert.equal(normalize("a\r\nb\rc"), "a\nb\nc");
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
});

test("term pattern matches on word boundaries only", () => {
  const pattern = termPattern("ai");
  assert.ok(pattern.test("we used an AI tool"));
  pattern.lastIndex = 0;
  assert.equal(pattern.test("the said artist"), false);
});

test("term pattern tolerates inner whitespace runs", () => {
  const pattern = termPattern("stable diffusion");
  assert.ok(pattern.test("a Stable   Diffusion render"));
});

test("term pattern does not fire on a numeric suffix", () => {
  const pattern = termPattern("gpt-4");
  assert.equal(pattern.test("gpt-40 turbo"), false);
  const yes = termPattern("gpt-4");
  assert.ok(yes.test("gpt-4 turbo"));
});

test("splitSentences returns offsets that slice back to the sentence", () => {
  const text = "First sentence. Second one!\nThird?";
  const sentences = splitSentences(text);
  assert.equal(sentences.length, 3);
  for (const sentence of sentences) {
    assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
  }
});

test("splitSentences keeps abbreviations inside one sentence", () => {
  const sentences = splitSentences("See Annex 4.2 for figures. Then stop.");
  assert.equal(sentences.length, 2);
});

test("sentenceAt finds the containing span", () => {
  const text = "Alpha beta. Gamma delta.";
  const sentences = splitSentences(text);
  const found = sentenceAt(sentences, text.indexOf("delta"));
  assert.equal(found.text, "Gamma delta.");
  assert.equal(sentenceAt(sentences, 9999), null);
});

test("findTerm returns the quote and its sentence", () => {
  const text = "The image model produced frames. Nothing else.";
  const hit = findTerm(text, "image model");
  assert.equal(hit.quote.toLowerCase(), "image model");
  assert.equal(hit.sentence, "The image model produced frames.");
});

test("findTerm returns null when the term is absent", () => {
  assert.equal(findTerm("nothing here", "midjourney"), null);
});

test("analyse counts words, sentences and characters", () => {
  const profile = analyze("Two words. Three more words.");
  assert.equal(profile.words, 5);
  assert.equal(profile.sentenceCount, 2);
  assert.equal(profile.chars, 28);
});

test("analyse marks empty input", () => {
  assert.equal(analyze("   \n ").empty, true);
  assert.equal(analyze("something").empty, false);
});

test("analyse detects AI tool names as a signal source", () => {
  const profile = analyze("We drafted the text with Claude and edited it by hand.");
  assert.equal(profile.detected.ai_tools, true);
  assert.equal(profile.signals.ai_used, true);
  assert.equal(profile.sources.ai_used, "detected");
});

test("declared usage turns a signal on that the text never mentions", () => {
  const profile = analyze("A short deliverable note.", { visual_output: true });
  assert.equal(profile.signals.visual_output, true);
  assert.equal(profile.sources.visual_output, "declared");
  assert.equal(profile.detected.visual_output, false);
});

test("declared usage wins the source label when both are true", () => {
  const profile = analyze("An AI-assisted image was produced.", { visual_output: true });
  assert.equal(profile.signals.visual_output, true);
  assert.equal(profile.sources.visual_output, "declared");
});

test("generative output needs both AI and an output type", () => {
  const withOutput = analyze("We used an AI model to write the copy.", {});
  assert.equal(withOutput.detected.generative_output, true);
  const aiOnly = analyze("The tender mentions AI in the introduction only.", {});
  assert.equal(aiOnly.detected.ai_used, true);
});

test("declared false values are ignored rather than stored", () => {
  const profile = analyze("text", { ai_used: false, visual_output: false });
  assert.deepEqual(profile.declared, {});
});

test("every declarable signal has a lexicon list or is derived", () => {
  const derived = new Set(["ai_used", "generative_output"]);
  for (const name of DECLARABLE) {
    if (derived.has(name)) continue;
    assert.ok(LEXICON[name], "missing lexicon list for " + name);
  }
});

test("tools and usage note are trimmed into the profile", () => {
  const profile = analyze("text", { tools: "  model x  ", usageNote: "  note  " });
  assert.equal(profile.tools, "model x");
  assert.equal(profile.usageNote, "note");
});

test("evidenceFor points at the first matching term", () => {
  const profile = analyze("First line about images.\nAn image model was used later.");
  assert.ok(profile.evidenceFor.visual_output);
  assert.match(profile.evidenceFor.visual_output.sentence, /image model was used later/);
  assert.equal(profile.evidenceFor.visual_output.term, "image");
});

test("analyse is deterministic for the same input", () => {
  const text = "Same input, same profile.";
  assert.deepEqual(analyze(text), analyze(text));
});

test("analyse counts characters after normalising line endings", () => {
  assert.equal(analyze("a\r\nb").chars, 3);
});
