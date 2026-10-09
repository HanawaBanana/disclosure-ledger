/**
 * main.js — the application.
 *
 * Wiring only: every decision lives in app/engine/*. This file reads the DOM,
 * calls the engine, writes results back, and appends to the ledger.
 *
 * The app holds no network capability: there is no fetch, no XMLHttpRequest, no
 * <img> to a remote host and no third-party script. The only way data leaves the
 * page is a file the user downloads.
 */

import { analyze, DECLARABLE, ENGINE_VERSION, LEXICON } from "./engine/lexicon.js";
import { PACKS, TOTAL_CLAUSES } from "./engine/packs.js";
import { evaluate, recommendPacks } from "./engine/engine.js";
import {
  GENESIS, appendRecord, chainDigest, documentRecord, exportRecord, scanRecord,
  statementRecord, verifyChain, verifyRecord, RECORD_LABELS, sha256Hex,
} from "./engine/chain.js";
import { buildStatement } from "./engine/statement.js";
import {
  APP_VERSION, downloadName, ledgerFile, reportToMarkdown, toJson, toStandaloneHtml, safeJsonForScript,
} from "./engine/exporters.js";
import {
  appendToStore, clearLedger, documentId, openStore, readAnswers, readDocuments,
  readLedger, removeDocument, saveAnswers, saveDocument,
} from "./engine/store.js";
import { SAMPLES, sampleById } from "./samples.js";

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const DECLARED_LABELS = {
  ai_used: "AI was used at all",
  generative_output: "Anything generative in the output",
  text_output: "Text: drafting, rewriting, translation",
  visual_output: "Images: generation, retouching, upscaling",
  audio_output: "Audio or voice",
  video_output: "Video or animation",
  synthetic_media: "Synthetic media or manipulated footage",
  interactive: "A user-facing AI assistant or bot",
  biometric: "Emotion recognition or biometric categorisation",
  public_interest: "Published to inform the public",
  platform_publish: "Uploaded to a content platform",
  tender: "Part of a tender or bid",
  competition: "Entered into a competition",
  commercial: "A paid client deliverable",
  code_generation: "Code was generated",
  translation: "Translated or localised",
  human_review: "A named human reviewed it",
  provenance: "Provenance metadata attached",
  rights: "Rights and consent checked",
};

const state = {
  text: "",
  docName: "pasted text",
  declared: {},
  tools: "",
  usageNote: "",
  profile: null,
  report: null,
  statement: null,
  answers: {},
  records: [],
  recommended: [],
  packs: [],
  verifyResult: null,
  store: null,
  digest: null,
  registeredDigest: null,
  busy: false,
};

let nowOverride = null;
const now = () => nowOverride || new Date().toISOString();

/* ------------------------------------------------------------------ *
 * analysis + rendering of the input side
 * ------------------------------------------------------------------ */

function currentAnswers() {
  const answers = { ...state.answers };
  document.querySelectorAll("[data-answer]").forEach((el) => { answers[el.dataset.answer] = el.value.trim(); });
  return answers;
}

function renderDeclaredGrid() {
  const grid = $("declared-grid");
  grid.innerHTML = DECLARABLE.map((name) => {
    const on = !!state.declared[name];
    const detected = !!(state.profile && state.profile.detected[name]);
    const src = on ? "<span class=\"src\">declared</span>" : (detected ? "<span class=\"src\">in text</span>" : "");
    return "<label class=\"check" + (detected ? " is-detected" : "") + "\">" +
      "<input type=\"checkbox\" data-declared=\"" + esc(name) + "\"" + (on ? " checked" : "") + ">" +
      "<span>" + esc(DECLARED_LABELS[name] || name) + "</span>" + src + "</label>";
  }).join("");
}

function renderSignalStrip() {
  const strip = $("signal-strip");
  if (!state.profile) { strip.innerHTML = ""; return; }
  const on = Object.keys(state.profile.signals).filter((k) => state.profile.signals[k]);
  strip.innerHTML = on.length
    ? "<span class=\"chip chip-accent\">" + on.length + " signals on</span>" +
      on.map((name) => "<span class=\"chip\">" + esc(name) + " · " + esc(state.profile.sources[name] || "detected") + "</span>").join("")
    : "<span class=\"chip chip-quiet\">no signals yet — nothing to disclose unless you declare something</span>";
}

function renderPackList() {
  const list = $("pack-list");
  const suggested = new Map(state.recommended.map((r) => [r.packId, r]));
  list.innerHTML = PACKS.map((pack) => {
    const on = state.packs.includes(pack.id);
    const sug = suggested.get(pack.id);
    return "<label class=\"pack" + (on ? " is-on" : "") + (sug && sug.recommended ? " is-suggested" : "") + "\">" +
      "<input type=\"checkbox\" data-pack=\"" + esc(pack.id) + "\"" + (on ? " checked" : "") + ">" +
      "<span><span class=\"name\">" + esc(pack.name) + "</span>" +
      "<div class=\"meta\">" + esc(pack.jurisdiction) + " · pack " + esc(pack.version) + " · " + pack.clauses.length + " clauses</div>" +
      "<div class=\"short\">" + esc(pack.short) + "</div>" +
      (sug && sug.recommended ? "<div class=\"reason\">Suggested — " + esc(sug.reason) + "</div>" : "") +
      "</span></label>";
  }).join("");
}

async function refreshAnalysis() {
  state.text = $("doc-text").value;
  state.tools = $("tools").value;
  state.usageNote = $("usage-note").value;
  state.profile = analyze(state.text, { ...state.declared, tools: state.tools, usageNote: state.usageNote });
  $("stat-words").textContent = String(state.profile.words);
  $("stat-sentences").textContent = String(state.profile.sentenceCount);
  $("stat-chars").textContent = String(state.profile.chars);
  if (state.text.trim()) {
    state.digest = await sha256Hex(state.text);
    $("stat-digest").textContent = state.digest.slice(0, 24) + "…";
    $("stat-digest").title = state.digest;
  } else {
    state.digest = null;
    $("stat-digest").textContent = "—";
  }
  renderDeclaredGrid();
  renderSignalStrip();
  renderPackList();
}

/* ------------------------------------------------------------------ *
 * findings
 * ------------------------------------------------------------------ */

function severityChip(severity) {
  return "<span class=\"chip chip-" + esc(severity) + "\">" + esc(severity) + "</span>";
}

function renderGaps() {
  const report = state.report;
  const list = $("gap-list");
  const items = report.gaps.concat(report.advices);
  if (!items.length) {
    list.innerHTML = "<p class=\"hint\">No gaps: every clause that applies to this document is satisfied by the text. " +
      "That means the wording is really there — check the clause table below to see the sentence that satisfied each one.</p>";
    return;
  }
  list.innerHTML = items.map((clause) => {
    const advice = clause.status === "advice";
    const groups = (clause.groups || []).map((g) =>
      "<li>" + esc(g.label) + " — " + (g.matched
        ? "found: “" + esc(g.phrase) + "”"
        : "no match — none of this group's phrases occur in the text") + "</li>");
    return "<article class=\"gap sev-" + esc(clause.severity) + (advice ? " advice" : "") + "\" data-ref=\"" + esc(clause.ref) + "\">" +
      "<div class=\"gap-head\">" + severityChip(clause.severity) +
      "<span class=\"ref\">" + esc(clause.ref) + "</span>" +
      "<span class=\"gap-title\">" + esc(clause.title) + "</span>" +
      "<span class=\"pack\"></span>" +
      "<span class=\"gap-pack\">" + esc(clause.packName) + (advice ? " · advisory" : "") + "</span></div>" +
      "<p class=\"req\">" + esc(clause.requirement) + "</p>" +
      (clause.evidence
        ? "<div class=\"evidence\">“" + esc(clause.evidence.sentence) + "\"<span class=\"off\">characters " +
          clause.evidence.start + "–" + clause.evidence.end + "</span></div>"
        : "") +
      "<ul class=\"checklist\">" + groups + "</ul>" +
      "<div class=\"fix\"><div class=\"fix-head\">" + (advice ? "Consider adding" : "Add this") + "</div>" +
      esc(clause.suggestedText) +
      "<div class=\"hint\" style=\"margin-top:6px\">Where: " + esc(clause.insertInto) + ". Why: " + esc(clause.remediation) + "</div>" +
      "<div class=\"copy\"><button type=\"button\" class=\"ghost copy-idea\" data-copy=\"" + esc(clause.suggestedText) + "\">Copy this wording</button></div></div>" +
      "</article>";
  }).join("");
}

function renderClauseTables() {
  const host = $("clause-tables");
  host.innerHTML = state.report.results.map((pack) => {
    const rows = pack.clauses.map((clause) => {
      const what = clause.evidence
        ? "“" + esc(clause.evidence.sentence) + "”<span class=\"why\">matched: “" + esc(clause.evidence.phrase) + "” at characters " +
          clause.evidence.start + "–" + clause.evidence.end + "</span>"
        : esc(clause.requirement) + "<span class=\"why\">" + esc(clause.reason) + "</span>";
      return "<tr class=\"s-" + esc(clause.status) + "\">" +
        "<td><span class=\"ref\">" + esc(clause.ref) + "</span></td>" +
        "<td>" + esc(clause.title) + "</td>" +
        "<td><span class=\"status " + esc(clause.status) + "\">" + esc(clause.status) + "</span></td>" +
        "<td>" + what + "</td></tr>";
    }).join("");
    return "<div class=\"pack-table\"><h3>" + esc(pack.packName) + " — " + esc(pack.packVersion) + "</h3>" +
      "<p class=\"hint\">" + esc(pack.packBasis.label) + "</p>" +
      "<table class=\"clause-table\"><thead><tr><th>Clause</th><th>Obligation</th><th>Status</th><th>Evidence or reason</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table></div>";
  }).join("");
}

function renderSummary() {
  const s = state.report.summary;
  $("summary-card").hidden = false;
  $("score-dial").style.setProperty("--score", String(s.readiness));
  $("score-value").textContent = String(s.readiness);
  const bandEl = $("summary-band");
  bandEl.textContent = s.band;
  bandEl.className = "band " + (s.readiness >= 90 ? "is-good" : s.readiness >= 70 ? "is-warn" : "is-bad");
  $("summary-counts").textContent = s.passed + " of " + s.applicable + " applicable clauses satisfied · " +
    s.clauses + " clauses evaluated across " + s.packs + " pack(s)";
  $("summary-chips").innerHTML =
    "<span class=\"chip chip-high\">" + s.bySeverity.high + " high</span>" +
    "<span class=\"chip chip-medium\">" + s.bySeverity.medium + " medium</span>" +
    "<span class=\"chip\">" + s.bySeverity.low + " low</span>" +
    "<span class=\"chip chip-good\">" + s.passed + " satisfied</span>" +
    "<span class=\"chip chip-quiet\">" + s.advice + " advisory · " + s.exempt + " exempt · " + s.notApplicable + " n/a</span>";
  $("summary-generated").textContent = "engine " + state.report.engine + " · " + fmtUTC(state.report.generatedAt);
  $("findings-card").hidden = false;
  $("clauses-card").hidden = false;
}

function fmtUTC(iso) {
  if (!iso) return "—";
  return String(iso).replace("T", " ").replace(/\..*$/, "").replace("Z", " UTC");
}

/* ------------------------------------------------------------------ *
 * the check itself
 * ------------------------------------------------------------------ */

async function runCheck() {
  if (state.busy) return null;
  if (!state.text.trim()) {
    $("run-note").textContent = "Paste some text first — there is nothing to check yet.";
    return null;
  }
  if (!state.packs.length) {
    $("run-note").textContent = "Select at least one rule pack.";
    return null;
  }
  state.busy = true;
  $("run-note").textContent = "Checking…";
  try {
    if (state.digest === null || state.digest !== await sha256Hex(state.text)) await refreshAnalysis();
    const profile = state.profile;
    const report = evaluate({ text: state.text, profile, packIds: state.packs, now: now() });
    state.report = report;

    if (state.digest !== state.registeredDigest) {
      state.records = await pushRecord(documentRecord({
        name: state.docName, digest: state.digest, chars: profile.chars, words: profile.words,
      }));
      state.registeredDigest = state.digest;
    }
    state.records = await pushRecord(scanRecord({ report, digest: state.digest, profile }));

    await saveDocument(state.store, {
      id: documentId(state.docName, state.digest),
      name: state.docName,
      chars: profile.chars,
      words: profile.words,
      digest: state.digest,
      packs: state.packs.slice(),
      declared: { ...state.declared },
      tools: state.tools,
      usageNote: state.usageNote,
      text: state.text,
      at: now(),
    });
    await renderRecent();

    renderSummary();
    renderGaps();
    renderClauseTables();
    await renderLedger();
    $("run-note").textContent = "Done — readiness " + report.summary.readiness + "/100 (" + report.summary.band + ").";
    return report;
  } finally {
    state.busy = false;
  }
}

async function pushRecord(entry) {
  await appendToStore(state.store, { ...entry, timestamp: now() });
  state.records = await readLedger(state.store);
  return state.records;
}

/* ------------------------------------------------------------------ *
 * statement
 * ------------------------------------------------------------------ */

function statementHtml(statement) {
  const body = statement.sections.map((section) => {
    const lines = section.kind === "bullets"
      ? "<ul>" + section.lines.map((l) => "<li>" + inline(l) + "</li>").join("") + "</ul>"
      : section.lines.map((l) => "<p>" + inline(l) + "</p>").join("");
    return "<h3>" + esc(section.heading) + "</h3>" + lines;
  }).join("");
  const missing = statement.missing.length
    ? "<h3>Still to fill in</h3><ul>" + statement.missing.map((m) => "<li class=\"ph\">〔" + esc(m) + "〕</li>").join("") + "</ul>"
    : "";
  return "<p class=\"meta-line\"><strong>" + esc(statement.project) + "</strong> · " + esc(statement.organisation) +
    " · " + esc(statement.date) + " · " + statement.words + " words</p>" + body + missing;
}

function inline(text) {
  return esc(text).replace(/〔([^〕]+)〕/g, "<span class=\"ph\">〔$1〕</span>");
}

async function generateStatement() {
  if (!state.report) {
    $("statement-preview").innerHTML = "<p class=\"hint\">Run a check on the first tab first — the statement is built from the report.</p>";
    return null;
  }
  state.answers = currentAnswers();
  await saveAnswers(state.store, state.answers);
  const date = now().slice(0, 10);
  const statement = buildStatement({ profile: state.profile, report: state.report, answers: state.answers, date });
  state.statement = statement;
  $("statement-preview").innerHTML = statementHtml(statement);
  $("statement-meta").textContent = statement.words + " words · " + statement.requirements.length +
    " required disclosure(s) folded in · " + statement.missing.length + " placeholder(s) left";
  $("copy-statement").disabled = false;
  $("download-statement").disabled = false;
  state.records = await pushRecord(statementRecord({
    digest: state.digest, words: statement.words, packs: state.packs,
    statementDigest: await sha256Hex(statement.markdown),
  }));
  await renderLedger();
  return statement;
}

/* ------------------------------------------------------------------ *
 * ledger + verification
 * ------------------------------------------------------------------ */

async function renderLedger() {
  const records = state.records;
  const rows = $("ledger-rows");
  rows.innerHTML = records.length
    ? records.slice().reverse().map((r) => "<tr>" +
        "<td>" + r.seq + "</td>" +
        "<td class=\"mono\">" + esc(fmtUTC(r.timestamp)) + "</td>" +
        "<td>" + esc(RECORD_LABELS[r.type] || r.type) + "<span class=\"why\"></span></td>" +
        "<td class=\"payload\">" + esc(summarisePayload(r.payload)) + "</td>" +
        "<td class=\"mono digest\">" + esc(String(r.hash).slice(0, 18)) + "…</td></tr>").join("")
    : "<tr><td colspan=\"5\" class=\"hint\">No records yet — run a check.</td></tr>";
  const digest = await chainDigest(records);
  $("ledger-digest").textContent = "digest " + digest.slice(0, 32) + "…";
  $("ledger-digest").title = digest;
  $("ledger-meta").textContent = records.length
    ? records.length + " records · first " + fmtUTC(records[0].timestamp) + " · last " + fmtUTC(records[records.length - 1].timestamp)
    : "No records yet.";
  state.ledgerDigest = digest;
  return digest;
}

function summarisePayload(payload) {
  if (!payload) return "—";
  if (payload.document && payload.gaps !== undefined) {
    return "packs " + (payload.packs || []).join(", ") + " · " + payload.passed + "/" + payload.applicable +
      " satisfied · " + payload.gaps + " gaps · readiness " + payload.readiness;
  }
  if (payload.name) return payload.name + " · " + payload.words + " words · sha256 " + String(payload.digest).slice(0, 12) + "…";
  if (payload.statement) return "statement " + String(payload.statement).slice(0, 12) + "… · " + payload.words + " words";
  if (payload.ok !== undefined) return "verified: " + payload.ok + " · " + payload.checked + " records" + (payload.brokenAt === null ? "" : " · broken at " + payload.brokenAt);
  if (payload.ledger) return "ledger " + String(payload.ledger).slice(0, 16) + "… · " + payload.records + " records";
  return JSON.stringify(payload).slice(0, 120);
}

function renderChainState(result, prefix) {
  const chip = prefix === "verify" ? $("verify-meta") : $("chain-state");
  if (prefix === "verify") {
    chip.textContent = result.checked + " records checked";
    return;
  }
  chip.innerHTML = "<span class=\"verdict-chip " + (result.ok ? "ok" : "bad") + "\">" +
    (result.ok ? "chain intact" : "chain broken") + "</span>";
}

function renderVerification(host, result) {
  if (result.ok) {
    host.innerHTML = "<p class=\"verdict-chip ok\">Verified: " + result.checked + " records, every digest and link matches.</p>" +
      "<p class=\"hint\">Each record's SHA-256 was recomputed from its own fields and the digest of the record before it. Nothing was changed since the record was written.</p>";
    return;
  }
  host.innerHTML = "<p class=\"verdict-chip bad\">Not verified: " + result.issues.length + " problem(s) found.</p>" +
    "<ul class=\"issues\">" + result.issues.map((i) => "<li>record " + (i.index + 1) + " · " + esc(i.code) + " — " + esc(i.detail) + "</li>").join("") + "</ul>" +
    "<p class=\"hint\">The first problem is at index " + result.brokenAt + ". A ledger that fails here has been edited after the fact, or was not the ledger that was exported.</p>";
}

async function verifyLocalLedger() {
  const result = await verifyChain(state.records);
  state.verifyResult = result;
  renderChainState(result);
  renderVerification($("verify-result"), result);
  $("verify-meta").textContent = result.checked + " records checked";
  $("verify-input").value = JSON.stringify({ format: "disclosure-ledger/1", records: state.records }, null, 2).slice(0, 200000);
  await pushRecord(verifyRecord({ ok: result.ok, checked: result.checked, brokenAt: result.brokenAt, digest: state.ledgerDigest }));
  await renderLedger();
  return result;
}

async function verifyPasted() {
  const raw = $("verify-input").value.trim();
  if (!raw) { $("verify-result").innerHTML = "<p class=\"hint\">Paste a ledger file or load one.</p>"; return null; }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    $("verify-result").innerHTML = "<p class=\"verdict-chip bad\">That is not valid JSON: " + esc(err.message) + "</p>";
    return null;
  }
  const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.records) ? parsed.records : null);
  if (!records) {
    $("verify-result").innerHTML = "<p class=\"verdict-chip bad\">No records array found in that file.</p>";
    return null;
  }
  const result = await verifyChain(records);
  state.verifyResult = result;
  $("verify-meta").textContent = records.length + " records in the file";
  renderVerification($("verify-result"), result);
  return result;
}

/* ------------------------------------------------------------------ *
 * exports
 * ------------------------------------------------------------------ */

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  return filename;
}

async function exportLedger() {
  const digest = await chainDigest(state.records);
  const verification = await verifyChain(state.records);
  const file = ledgerFile({
    records: state.records, digest, verification, generatedAt: now(), tools: { engine: ENGINE_VERSION },
  });
  await pushRecord(exportRecord({ kind: "json", digest, records: state.records.length }));
  await renderLedger();
  return download(downloadName("json", { project: state.docName, date: now() }), toJson(file), "application/json");
}

async function buildHtmlExport() {
  const digest = await chainDigest(state.records);
  const verification = await verifyChain(state.records);
  return {
    digest,
    verification,
    html: toStandaloneHtml({
      report: state.report,
      statement: state.statement,
      records: state.records,
      digest,
      generatedAt: now(),
      title: "AI disclosure compliance report — " + (state.report ? state.statement ? state.statement.project : state.docName : "deliverable"),
    }),
  };
}

async function exportHtml() {
  if (!state.report) { $("run-note").textContent = "Run a check first."; return null; }
  const built = await buildHtmlExport();
  await pushRecord(exportRecord({ kind: "html", digest: built.digest, records: state.records.length }));
  await renderLedger();
  return download(downloadName("html", { project: state.docName, date: now() }), built.html, "text/html");
}

async function previewHtml() {
  if (!state.report) { $("run-note").textContent = "Run a check first, then preview the export."; return null; }
  const built = await buildHtmlExport();
  const frame = $("html-frame");
  frame.srcdoc = built.html;
  $("html-preview").hidden = false;
  return built.html;
}

async function exportMarkdown() {
  if (!state.report) { $("run-note").textContent = "Run a check first."; return null; }
  const digest = await chainDigest(state.records);
  const verification = await verifyChain(state.records);
  const md = reportToMarkdown({ report: state.report, statement: state.statement, digest, verification, generatedAt: now() });
  await pushRecord(exportRecord({ kind: "markdown", digest, records: state.records.length }));
  await renderLedger();
  return download(downloadName("md", { project: state.docName, date: now() }), md, "text/markdown;charset=utf-8");
}

/* ------------------------------------------------------------------ *
 * documents
 * ------------------------------------------------------------------ */

async function renderRecent() {
  const docs = await readDocuments(state.store);
  const host = $("recent-docs");
  if (!docs.length) { host.hidden = true; return; }
  host.hidden = false;
  $("recent-list").innerHTML = docs.map((d) => "<li>" +
    "<button type=\"button\" class=\"recent-open\" data-open=\"" + esc(d.id) + "\">" + esc(d.name) +
    " · " + d.words + " words · " + esc(fmtUTC(d.at)) + "</button>" +
    "<button type=\"button\" class=\"link\" data-forget=\"" + esc(d.id) + "\">remove</button></li>").join("");
}

async function openDocument(id) {
  const docs = await readDocuments(state.store);
  const doc = docs.find((d) => d.id === id);
  if (!doc) return null;
  state.docName = doc.name;
  state.declared = { ...(doc.declared || {}) };
  state.tools = doc.tools || "";
  state.usageNote = doc.usageNote || "";
  state.packs = doc.packs && doc.packs.length ? doc.packs.slice() : state.packs;
  $("doc-text").value = doc.text || "";
  $("tools").value = state.tools;
  $("usage-note").value = state.usageNote;
  await refreshAnalysis();
  return doc;
}

/* ------------------------------------------------------------------ *
 * startup + wiring
 * ------------------------------------------------------------------ */

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === "panel-" + name));
  state.tab = name;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("dl.theme", theme); } catch (err) { /* private mode */ }
}

function renderPackAbout() {
  $("pack-about").innerHTML = PACKS.map((pack) => "<div class=\"pa\">" +
    "<div class=\"name\">" + esc(pack.name) + "</div>" +
    "<div class=\"basis\">" + esc(pack.basis.label) + "</div>" +
    "<div class=\"note\">" + esc(pack.basis.note) + "</div>" +
    "<div class=\"count\">" + pack.clauses.length + " clauses · pack version " + esc(pack.version) +
    " · lexicon terms " + Object.keys(LEXICON).length + " lists</div></div>").join("");
}

function renderSamples() {
  $("sample-row").innerHTML = "<span class=\"hint\">Try a sample:</span>" +
    SAMPLES.map((s) => "<button type=\"button\" class=\"ghost\" data-sample=\"" + esc(s.id) + "\">" + esc(s.label) + "</button>").join("");
}

async function loadSample(id) {
  const sample = sampleById(id);
  state.docName = sample.filename;
  state.declared = { ...sample.declared };
  state.tools = sample.tools;
  state.usageNote = sample.usageNote;
  state.packs = sample.packs.slice();
  state.answers = { ...sample.answers };
  state.report = null;
  state.statement = null;
  state.registeredDigest = null;
  $("doc-text").value = sample.text;
  $("tools").value = state.tools;
  $("usage-note").value = state.usageNote;
  Object.entries(state.answers).forEach(([key, value]) => {
    const input = document.querySelector("[data-answer=\"" + key + "\"]");
    if (input) input.value = value;
  });
  $("summary-card").hidden = true;
  $("findings-card").hidden = true;
  $("clauses-card").hidden = true;
  await refreshAnalysis();
  return sample;
}

function wireFileInput(input, dropzone, onText) {
  const read = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result), file.name);
    reader.readAsText(file);
  };
  input.addEventListener("change", () => read(input.files[0]));
  ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault(); dropzone.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault(); dropzone.classList.remove("is-over");
  }));
  dropzone.addEventListener("drop", (event) => read(event.dataTransfer && event.dataTransfer.files[0]));
}

async function boot() {
  const stage = (name) => { document.body.dataset.stage = name; };
  applyTheme((() => {
    try { return localStorage.getItem("dl.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
    catch (err) { return "light"; }
  })());
  renderSamples();
  renderPackAbout();

  stage("store");
  const params = new URLSearchParams(location.search);
  const prefer = ["indexeddb", "localstorage"].includes(params.get("store")) ? params.get("store") : "auto";
  state.store = await openStore({ prefer });
  stage("ledger");
  state.records = await readLedger(state.store);
  state.answers = await readAnswers(state.store);
  Object.entries(state.answers).forEach(([key, value]) => {
    const input = document.querySelector("[data-answer=\"" + key + "\"]");
    if (input) input.value = value;
  });
  stage("analysis");
  state.packs = PACKS.map((p) => p.id);
  await refreshAnalysis();
  stage("recent");
  await renderRecent();
  stage("render-ledger");
  await renderLedger();
  stage("wired");

  document.body.dataset.backend = state.store.kind + " · engine " + ENGINE_VERSION + " · " + TOTAL_CLAUSES + " clauses";


  $("theme-toggle").addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));

  $("declared-grid").addEventListener("change", async (event) => {
    const box = event.target.closest("[data-declared]");
    if (!box) return;
    state.declared[box.dataset.declared] = box.checked;
    if (!box.checked) delete state.declared[box.dataset.declared];
    await refreshAnalysis();
  });
  $("pack-list").addEventListener("change", (event) => {
    const box = event.target.closest("[data-pack]");
    if (!box) return;
    state.packs = box.checked
      ? [...new Set([...state.packs, box.dataset.pack])]
      : state.packs.filter((id) => id !== box.dataset.pack);
    renderPackList();
  });
  $("doc-text").addEventListener("input", () => {
    state.registeredDigest = null;
    debounce(refreshAnalysis, 220)();
  });
  $("tools").addEventListener("input", () => debounce(refreshAnalysis, 250)());
  $("usage-note").addEventListener("input", () => debounce(refreshAnalysis, 250)());

  $("recommend").addEventListener("click", async () => {
    state.recommended = recommendPacks(state.profile);
    const suggested = state.recommended.filter((r) => r.recommended);
    renderPackList();
    $("recommend-note").textContent = suggested.length
      ? "Suggested: " + suggested.map((s) => s.packName).join("; ")
      : "Nothing in this document points at a pack — pick one by hand.";
  });
  $("run-check").addEventListener("click", runCheck);
  $("go-statement").addEventListener("click", () => switchTab("statement"));
  $("go-ledger").addEventListener("click", () => switchTab("ledger"));
  $("generate-statement").addEventListener("click", generateStatement);
  $("copy-statement").addEventListener("click", async () => {
    if (!state.statement) return;
    try {
      await navigator.clipboard.writeText(state.statement.markdown);
      $("statement-meta").textContent = "copied to the clipboard";
    } catch (err) {
      $("statement-meta").textContent = "clipboard blocked by the browser — use Download .md instead";
    }
  });
  $("download-statement").addEventListener("click", () => {
    if (!state.statement) return;
    download(downloadName("md", { project: state.statement.project, date: now() }), state.statement.markdown, "text/markdown;charset=utf-8");
  });
  $("verify-ledger").addEventListener("click", verifyLocalLedger);
  $("export-json").addEventListener("click", exportLedger);
  $("export-html").addEventListener("click", exportHtml);
  $("export-md").addEventListener("click", exportMarkdown);
  $("preview-html").addEventListener("click", previewHtml);
  $("clear-ledger").addEventListener("click", async () => {
    await clearLedger(state.store);
    state.records = [];
    state.registeredDigest = null;
    await renderLedger();
    $("chain-state").innerHTML = "<span class=\"chip chip-quiet\">not verified yet</span>";
  });
  $("verify-run").addEventListener("click", verifyPasted);
  $("verify-clear").addEventListener("click", () => {
    $("verify-input").value = "";
    $("verify-result").innerHTML = "<p class=\"hint\">Nothing verified yet.</p>";
  });
  $("verify-tamper").addEventListener("click", async () => {
    const tampered = state.records.map((r) => JSON.parse(JSON.stringify(r)));
    if (tampered.length > 2) {
      tampered[2].payload = { ...tampered[2].payload, gaps: (tampered[2].payload.gaps || 0) + 1, note: "edited after the fact" };
    }
    $("verify-input").value = JSON.stringify({ format: "disclosure-ledger/1", records: tampered }, null, 2);
    await verifyPasted();
  });
  $("browse").addEventListener("click", () => $("file-input").click());
  $("verify-browse").addEventListener("click", () => $("verify-file").click());
  wireFileInput($("file-input"), $("dropzone"), async (text, name) => {
    state.docName = name;
    state.registeredDigest = null;
    $("doc-text").value = text;
    await refreshAnalysis();
  });
  wireFileInput($("verify-file"), $("verify-dropzone"), (text) => {
    $("verify-input").value = text;
  });

  $("recent-list").addEventListener("click", async (event) => {
    const open = event.target.closest("[data-open]");
    const forget = event.target.closest("[data-forget]");
    if (open) await openDocument(open.dataset.open);
    if (forget) { await removeDocument(state.store, forget.dataset.forget); await renderRecent(); }
  });
  document.body.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = "Copied"; }
      catch (err) { copy.textContent = "Clipboard blocked — select the text instead"; }
    }
  });

  $("run-note").textContent = "engine " + ENGINE_VERSION + " · " + TOTAL_CLAUSES + " clauses in " + PACKS.length +
    " packs · storage: " + state.store.kind;

  document.body.dataset.metrics = JSON.stringify(metrics());

  // The guided tour runs last and owns data-metrics, so that the frame the video
  // tool crops is the one the step is about.
  if (params.has("demo")) {
    const { mountDemo } = await import("./demo.js");
    await mountDemo(window.__DL);
  }
}

let debounceTimer = null;
function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), ms);
  };
}

function metrics(extra = {}) {
  return {
    visible: state.report ? state.report.summary.gaps : 0,
    page: state.records.length,
    clauses: state.report ? state.report.summary.clauses : 0,
    readiness: state.report ? state.report.summary.readiness : null,
    tab: state.tab || "scan",
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * automation surface: used by app/demo.js for the guided tour video
 * and by the screenshot tool. Everything here calls the same code the
 * buttons call.
 * ------------------------------------------------------------------ */

window.__DL = {
  version: APP_VERSION,
  engine: ENGINE_VERSION,
  state,
  samples: () => SAMPLES.map((s) => ({ id: s.id, label: s.label })),
  loadSample,
  setDeclared: async (declared) => { state.declared = { ...declared }; await refreshAnalysis(); },
  setPacks: (ids) => { state.packs = ids.slice(); renderPackList(); },
  setText: async (text, name) => {
    state.docName = name || "pasted text";
    state.registeredDigest = null;
    $("doc-text").value = text;
    await refreshAnalysis();
  },
  recommend: () => { state.recommended = recommendPacks(state.profile); renderPackList(); return state.recommended; },
  runCheck,
  switchTab,
  generateStatement,
  verifyLocalLedger,
  verifyPasted,
  exportLedger,
  exportHtml,
  exportMarkdown,
  previewHtml,
  buildHtmlExport,
  loadTampered: async () => {
    const tampered = state.records.map((r) => JSON.parse(JSON.stringify(r)));
    if (tampered.length > 2) {
      tampered[2].payload = { ...tampered[2].payload, gaps: (tampered[2].payload.gaps || 0) + 1, note: "edited after the fact" };
    }
    $("verify-input").value = JSON.stringify({ format: "disclosure-ledger/1", records: tampered }, null, 2);
    return verifyPasted();
  },
  freezeTime: (iso) => { nowOverride = iso; },
  unfreezeTime: () => { nowOverride = null; },
  reset: async () => {
    await clearLedger(state.store);
    state.records = [];
    state.registeredDigest = null;
    state.report = null;
    state.statement = null;
    state.recommended = [];
    $("summary-card").hidden = true;
    $("findings-card").hidden = true;
    $("clauses-card").hidden = true;
    await renderLedger();
    $("chain-state").innerHTML = "<span class=\"chip chip-quiet\">not verified yet</span>";
  },
  metrics,
  focusMetric: (selector) => {
    const el = typeof selector === "string" ? document.querySelector(selector) : selector;
    if (!el) return null;
    const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY - 16));
    const next = metrics({ pageTop: top, focus: typeof selector === "string" ? selector : "element" });
    document.body.dataset.metrics = JSON.stringify(next);
    return next;
  },
  markup: (selector) => {
    const el = document.querySelector(selector);
    return el ? el.innerHTML : null;
  },
  genesis: GENESIS,
  helper: { appendRecord, chainDigest, sha256Hex, safeJsonForScript },
};

boot().catch((err) => {
  document.body.dataset.bootError = String(err && err.message);
  const note = document.createElement("p");
  note.className = "noscript";
  note.textContent = "The app failed to start: " + (err && err.message) +
    (err && err.stack ? " — " + err.stack.split("\n").slice(0, 4).join(" | ") : "");
  document.body.prepend(note);
});
