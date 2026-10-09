/**
 * lexicon.js — term lists and the document analyser.
 *
 * The analyser is deliberately deterministic and dependency-free: the same text
 * always produces the same profile, byte for byte. It never guesses intent; it
 * records what is literally in the document (terms, counts, first hit) and
 * merges that with what the user declared about their AI usage.
 *
 * Exported surface
 *   ENGINE_VERSION   semantic version of the rule engine (written into every ledger record)
 *   LEXICON          signal name -> list of literal terms to look for
 *   DECLARABLE       signal names the user can declare by hand
 *   normalize()      case-insensitive whitespace-normalising view used for matching
 *   splitSentences() sentence spans with character offsets
 *   findTerm()       first occurrence of one literal term, with the sentence around it
 *   analyze()        text + declared usage -> profile
 */

export const ENGINE_VERSION = "1.0.0";
export const LEDGER_FORMAT = 1;

/**
 * Every list is literal terms matched case-insensitively on word boundaries.
 * They describe *what the document talks about*, not whether the document is
 * compliant — compliance is decided by the rule packs.
 */
export const LEXICON = {
  ai_mentioned: [
    "ai", "a.i.", "artificial intelligence", "machine learning", "large language model",
    "llm", "generative", "genai", "model", "algorithmic", "automat", "neural network",
  ],
  ai_tools: [
    "chatgpt", "gpt-4", "gpt-5", "claude", "gemini", "copilot", "midjourney",
    "dall-e", "stable diffusion", "flux", "sora", "runway", "elevenlabs", "whisper",
    "deepl", "grammarly", "notion ai", "github copilot", "perplexity",
  ],
  text_output: ["text", "copy", "article", "report", "proposal", "draft", "document", "writing"],
  visual_output: ["image", "illustration", "photograph", "photo", "render", "graphic", "artwork", "poster", "logo"],
  audio_output: ["audio", "voice", "speech", "narration", "sound", "podcast", "music"],
  video_output: ["video", "footage", "animation", "film", "clip", "storyboard"],
  synthetic_media: ["synthetic", "generated content", "deepfake", "voice clone", "face swap", "inpaint", "upscale"],
  interactive: ["chatbot", "chat bot", "assistant", "virtual agent", "conversational", "ticket bot", "support bot"],
  biometric: ["emotion recognition", "biometric", "facial recognition", "sentiment detection", "affect"],
  public_interest: [
    "public interest", "press release", "news", "journalism", "editorial", "public consultation",
    "government", "municipal", "policy", "citizens", "our website", "social media",
  ],
  platform_publish: [
    "youtube", "tiktok", "instagram", "facebook", "x.com", "twitter", "linkedin", "spotify",
    "app store", "marketplace", "publish", "upload", "post", "channel", "audience", "subscribers",
  ],
  tender: [
    "tender", "itt", "rfp", "rfq", "procurement", "invitation to tender", "framework agreement",
    "bid", "bidder", "tenderer", "contracting authority", "call for proposals", "evaluation committee",
  ],
  competition: [
    "competition", "contest", "call for entries", "jury", "entry", "entrant", "submission deadline",
    "prize", "shortlist", "awards", "exhibition",
  ],
  commercial: [
    "client", "deliverable", "statement of work", "invoice", "agency", "brief", "stakeholder",
    "kickoff", "milestone", "handover", "sow",
  ],
  code_generation: ["code", "source code", "repository", "function", "script", "backend", "api endpoint"],
  translation: ["translation", "translated", "localis", "localiz", "multilingual"],
  human_review: [
    "human review", "human oversight", "reviewed by", "editorial control", "editorial responsibility",
    "checked by", "approved by", "manually verified", "quality assurance", "proofread", "sign-off",
  ],
  provenance: [
    "c2pa", "content credentials", "provenance", "watermark", "invisible watermark", "metadata",
    "machine-readable", "iptc", "signed manifest",
  ],
  rights: ["licence", "license", "consent", "permission", "copyright", "rights", "stock", "terms of use"],
};

/** Signals a user can declare in the UI; the analyser merges them with detections. */
export const DECLARABLE = [
  "ai_used", "generative_output", "text_output", "visual_output", "audio_output",
  "video_output", "synthetic_media", "interactive", "biometric", "public_interest",
  "platform_publish", "tender", "competition", "commercial", "code_generation",
  "translation", "human_review", "provenance", "rights",
];

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(term) {
  return term.replace(ESCAPE, "\\$&");
}

/**
 * Literal term -> RegExp. Whitespace inside the term may be any run of
 * whitespace, and both ends are anchored on a non-word boundary so that "ai"
 * does not match "said" and "gpt-4" does not match "gpt-40".
 */
export function termPattern(term) {
  const body = escapeLiteral(term).replace(/\s+/g, "\\s+");
  return new RegExp("(?<![a-z0-9])" + body + "(?![a-z0-9])", "gi");
}

export function normalize(text) {
  return String(text == null ? "" : text).replace(/\r\n?/g, "\n");
}

/** Sentence spans (offset-aware) used to quote evidence. */
export function splitSentences(text) {
  const src = normalize(text);
  const out = [];
  const push = (start, end) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(src[s])) s += 1;
    while (e > s && /\s/.test(src[e - 1])) e -= 1;
    if (e > s) out.push({ start: s, end: e, text: src.slice(s, e) });
  };
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\n") {
      push(start, i);
      start = i + 1;
    } else if (ch === "." || ch === "!" || ch === "?") {
      const next = src[i + 1];
      if (next === undefined || /\s/.test(next)) {
        push(start, i + 1);
        start = i + 1;
      }
    }
  }
  push(start, src.length);
  return out;
}

export function sentenceAt(sentences, offset) {
  for (const s of sentences) {
    if (offset >= s.start && offset < s.end) return s;
  }
  return null;
}

/** First occurrence of one literal term, plus the sentence that contains it. */
export function findTerm(text, term, sentences) {
  const src = normalize(text);
  const rx = termPattern(term);
  const m = rx.exec(src);
  if (!m) return null;
  const full = m[0];
  const sentence = sentenceAt(sentences || splitSentences(src), m.index);
  return {
    term,
    start: m.index,
    end: m.index + full.length,
    quote: full,
    sentence: sentence ? sentence.text : full,
    sentenceStart: sentence ? sentence.start : m.index,
  };
}

function countTerms(text, sentences) {
  const src = normalize(text);
  const hits = {};
  const first = {};
  // One entry per signal: the earliest match of any term in that signal's list,
  // so the evidence a rule pack quotes is the first place a reader would look.
  for (const [signal, terms] of Object.entries(LEXICON)) {
    let total = 0;
    let earliest = null;
    for (const term of terms) {
      const rx = termPattern(term);
      let m = rx.exec(src);
      while (m) {
        total += 1;
        const hit = {
          term,
          start: m.index,
          end: m.index + m[0].length,
        };
        if (!earliest || hit.start < earliest.start) earliest = hit;
        if (!first[term.toLowerCase()]) first[term.toLowerCase()] = hit;
        m = rx.exec(src);
      }
    }
    hits[signal] = total;
    if (earliest) {
      const sentence = sentenceAt(sentences, earliest.start);
      const evidence = {
        ...earliest,
        quote: src.slice(earliest.start, earliest.end),
        sentence: sentence ? sentence.text : src.slice(earliest.start, earliest.end),
        sentenceStart: sentence ? sentence.start : earliest.start,
        signal,
      };
      first["__signal__" + signal] = evidence;
      first[earliest.term.toLowerCase()] = { ...first[earliest.term.toLowerCase()], ...evidence };
    }
  }
  return { hits, first };
}

/**
 * analyse(text, declared) -> profile
 *
 * `declared` is a plain object of booleans (see DECLARABLE) plus `tools` (string)
 * and `usageNote`. A signal is on when it is declared OR detected in the text;
 * `sources` records which one, so the UI can explain every rule that fired.
 */
export function analyze(text, declared = {}, now = null) {
  const src = normalize(text);
  const sentences = splitSentences(src);
  const words = (src.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length;

  const { hits, first } = countTerms(src, sentences);

  // Signals that are read straight off the term lists.
  const detected = {
    ai_mentioned: hits.ai_mentioned > 0,
    ai_tools: hits.ai_tools > 0,
    text_output: hits.text_output > 0,
    visual_output: hits.visual_output > 0,
    audio_output: hits.audio_output > 0,
    video_output: hits.video_output > 0,
    synthetic_media: hits.synthetic_media > 0,
    interactive: hits.interactive > 0,
    biometric: hits.biometric > 0,
    public_interest: hits.public_interest > 0,
    platform_publish: hits.platform_publish > 0,
    tender: hits.tender > 0,
    competition: hits.competition > 0,
    commercial: hits.commercial > 0,
    code_generation: hits.code_generation > 0,
    translation: hits.translation > 0,
    human_review: hits.human_review > 0,
    provenance: hits.provenance > 0,
    rights: hits.rights > 0,
  };
  detected.ai_used = detected.ai_mentioned || detected.ai_tools;
  detected.generative_output = detected.ai_used && (
    detected.text_output || detected.visual_output || detected.audio_output ||
    detected.video_output || detected.synthetic_media
  );

  const declaredSignals = {};
  for (const name of DECLARABLE) {
    if (declared[name] === true) declaredSignals[name] = true;
  }

  const signals = {};
  const sources = {};
  for (const name of DECLARABLE) {
    if (declaredSignals[name]) {
      signals[name] = true;
      sources[name] = "declared";
    } else if (detected[name]) {
      signals[name] = true;
      sources[name] = "detected";
    }
  }
  signals.ai_used = !!(declaredSignals.ai_used || detected.ai_used);
  if (declaredSignals.ai_used && sources.ai_used !== "detected") sources.ai_used = "declared";
  if (detected.ai_used && sources.ai_used !== "declared") sources.ai_used = "detected";

  const evidenceFor = {};
  for (const [name, on] of Object.entries(signals)) {
    if (!on) continue;
    const probe = first["__signal__" + name];
    if (probe) evidenceFor[name] = probe;
  }

  return {
    engine: ENGINE_VERSION,
    analysedAt: now,
    chars: src.length,
    words,
    sentenceCount: sentences.length,
    lineCount: src.split("\n").length,
    sentences,
    hits,
    first,
    detected,
    declared: declaredSignals,
    signals,
    sources,
    evidenceFor,
    tools: typeof declared.tools === "string" ? declared.tools.trim() : "",
    usageNote: typeof declared.usageNote === "string" ? declared.usageNote.trim() : "",
    empty: src.trim().length === 0,
  };
}
