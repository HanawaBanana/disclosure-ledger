/**
 * statement.js — turns a report into a disclosure statement you can paste into a
 * deliverable.
 *
 * The statement is assembled from facts the app already holds: the declared and
 * detected usage signals, the tools the user named, and the per-clause wording
 * the rule packs say should be present. Nothing is invented: where an answer is
 * missing, a visible placeholder `〔…〕` is written and listed under "still to
 * fill in" so it cannot be shipped by accident.
 *
 * Deterministic: the date is passed in, placeholders are stable, and the same
 * inputs always produce the same document (which is what makes the ledger digest
 * of the statement meaningful).
 */

import { requiredDisclosures } from "./engine.js";

export const PLACEHOLDER = (label) => "〔" + label + "〕";

/** Signals worth naming in the statement, in the order a reader wants them. */
export const USAGE_LINES = [
  ["text_output", "drafting and editing of text"],
  ["visual_output", "image generation and retouching"],
  ["audio_output", "audio and voice production"],
  ["video_output", "video and animation production"],
  ["code_generation", "code generation"],
  ["translation", "translation and localisation"],
  ["synthetic_media", "synthetic media or likeness work"],
  ["interactive", "an interactive AI system facing users"],
  ["biometric", "emotion recognition or biometric categorisation"],
];

export function usageSummary(profile) {
  const on = USAGE_LINES.filter(([signal]) => profile.signals[signal]).map(([signal, label]) => ({ signal, label }));
  return on;
}

function fill(value, label, missing) {
  if (value && String(value).trim()) return String(value).trim();
  missing.push(label);
  return PLACEHOLDER(label);
}

/**
 * buildStatement({ profile, report, answers, date }) -> statement
 *
 * answers: { organisation, project, owner, reviewer, tools, dataHandling,
 *            contact, licenceNote }
 */
export function buildStatement({ profile, report, answers = {}, date }) {
  const missing = [];
  const org = fill(answers.organisation, "organisation", missing);
  const project = fill(answers.project, "deliverable / project", missing);
  const owner = fill(answers.owner, "responsible person", missing);
  const reviewer = fill(answers.reviewer, "reviewer", missing);
  const tools = fill(answers.tools || profile.tools, "tools and versions used", missing);
  const contact = fill(answers.contact, "contact for questions", missing);
  const dataHandling = answers.dataHandling && String(answers.dataHandling).trim()
    ? String(answers.dataHandling).trim()
    : "No client-confidential or personal data was entered into any third-party AI service.";
  const licenceNote = answers.licenceNote && String(answers.licenceNote).trim()
    ? String(answers.licenceNote).trim()
    : "The tools used were operated under terms that permit this kind of use, and the output was checked before use.";

  const usage = usageSummary(profile);
  const requirements = requiredDisclosures(report);
  const packs = report.results.map((r) => ({ id: r.packId, name: r.packName, version: r.packVersion }));

  const sections = [];

  sections.push({
    heading: "Statement of AI use",
    kind: "prose",
    lines: [
      org + " is the author of " + project + ". " +
        "This statement records the use of artificial intelligence in producing it, and is dated " + date + ".",
    ],
  });

  sections.push({
    heading: "What AI was used for",
    kind: "bullets",
    lines: usage.length
      ? usage.map((u) => u.label + (profile.sources[u.signal] === "declared" ? " (declared)" : " (declared and visible in the document)"))
      : ["No AI assistance was used in this deliverable."],
  });

  if (profile.usageNote) {
    sections.push({ heading: "Note from the author", kind: "prose", lines: [profile.usageNote] });
  }

  sections.push({
    heading: "Tools and versions",
    kind: "prose",
    lines: [
      "Tools used: " + tools + ". " +
        "Where a version is listed it is the version in use on the date above; the full record is kept with the audit ledger for this deliverable.",
    ],
  });

  sections.push({
    heading: "Extent and limits",
    kind: "prose",
    lines: [
      "AI was used for the tasks listed above. All other work — the concept, the selection of what to keep, " +
        "and the final wording and layout — was done by " + owner + " without AI assistance.",
    ],
  });

  sections.push({
    heading: "Human review and responsibility",
    kind: "prose",
    lines: [
      reviewer + " reviewed and fact-checked the AI-assisted parts of this deliverable and takes responsibility " +
        "for its content. " + owner + " holds editorial responsibility for this deliverable and for the record below.",
    ],
  });

  sections.push({
    heading: "Data handling",
    kind: "prose",
    lines: [
      dataHandling + " The compliance check recorded in the ledger below ran entirely inside the browser on " +
        "the author's own machine: no part of this deliverable was uploaded to any service for the check.",
    ],
  });

  sections.push({
    heading: "Rights",
    kind: "prose",
    lines: [licenceNote],
  });

  if (requirements.length) {
    sections.push({
      heading: "Disclosures required by the selected rule packs",
      kind: "bullets",
      lines: requirements.map((r) => "[" + r.ref + "] " + r.suggestedText),
    });
  }

  sections.push({
    heading: "How to verify this statement",
    kind: "prose",
    lines: [
      "The actions behind this statement — registering the document, running the check, generating this text — " +
        "were written to a SHA-256 hash-chained ledger with " + report.summary.clauses + " clause evaluations " +
        "across " + packs.length + " rule pack(s). Open " + contact + " to request the ledger file, or verify the " +
        "copy you were given with the verifier in the app or tools/verify_ledger.py.",
    ],
  });

  const markdown = renderMarkdown({ org, project, date, sections, report, packs, missing });
  const plain = stripMarkdown(markdown);

  return {
    date,
    organisation: org,
    project,
    sections,
    packs,
    requirements,
    missing,
    markdown,
    plain,
    words: countWords(plain),
  };
}

export function renderMarkdown({ org, project, date, sections, report, packs, missing }) {
  const out = [];
  out.push("# AI use and disclosure statement");
  out.push("");
  out.push("* " + "**Deliverable:** " + project);
  out.push("* " + "**Prepared by:** " + org);
  out.push("* " + "**Date:** " + date);
  out.push("* " + "**Checked against:** " + packs.map((p) => p.name + " " + p.version).join("; "));
  out.push("* " + "**Readiness:** " + report.summary.readiness + "/100 (" + report.summary.band +
    ") — " + report.summary.passed + " of " + report.summary.applicable + " applicable clauses satisfied, " +
    report.summary.gaps + " open");
  out.push("");
  for (const section of sections) {
    out.push("## " + section.heading);
    out.push("");
    if (section.kind === "bullets") {
      for (const line of section.lines) out.push("- " + line);
    } else {
      for (const line of section.lines) out.push(line);
    }
    out.push("");
  }
  if (missing.length) {
    out.push("## Still to fill in before this statement is sent");
    out.push("");
    for (const item of missing) out.push("- " + PLACEHOLDER(item));
    out.push("");
  }
  out.push("---");
  out.push("");
  out.push("*Generated by Disclosure Ledger (engine " + report.engine + "). This statement is a draft wording aid, " +
    "not legal advice.*");
  out.push("");
  return out.join("\n");
}

export function stripMarkdown(markdown) {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^\*\s+/, "- ").replace(/\*\*/g, "").replace(/^---$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countWords(text) {
  return (String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length;
}
