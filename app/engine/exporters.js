/**
 * exporters.js — everything the user takes away from the app.
 *
 * Three artefacts, all produced locally:
 *   JSON     the ledger file, the thing you hand to a client or an auditor
 *   HTML     one self-contained file: report + statement + ledger, with the
 *            chain re-verified by the browser that opens it
 *   Markdown the disclosure statement, ready to paste into a deliverable
 *
 * The HTML export inlines the ledger as JSON inside a <script> tag, so the
 * escaping matters: `safeJsonForScript` neutralises `<` and the line separators
 * that would otherwise let arbitrary document text close the script element.
 */

export const APP_NAME = "Disclosure Ledger";
export const APP_VERSION = "1.0.0";

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The ledger file. Deliberately plain: a verifier needs nothing but this object. */
export function ledgerFile({ records, digest, verification = null, generatedAt = null, tools = {} }) {
  return {
    format: "disclosure-ledger/1",
    app: APP_NAME,
    appVersion: APP_VERSION,
    engine: tools.engine || null,
    generatedAt,
    digest,
    verification,
    recordCount: (records || []).length,
    records: records || [],
  };
}

export function toJson(file) {
  return JSON.stringify(file, null, 2) + "\n";
}

export function reportToMarkdown({ report, statement, digest, verification, generatedAt }) {
  const out = [];
  out.push("# Compliance check report");
  out.push("");
  out.push("* Generated: " + (generatedAt || "not recorded"));
  out.push("* Engine: " + report.engine);
  out.push("* Readiness: " + report.summary.readiness + "/100 (" + report.summary.band + ")");
  out.push("* Applicable clauses: " + report.summary.applicable + ", satisfied " + report.summary.passed +
    ", open " + report.summary.gaps + ", advisory " + report.summary.advice);
  out.push("* Ledger: " + (digest || "not recorded") + (verification
    ? " (" + (verification.ok ? "verified, " + verification.checked + " records" : "FAILED — " + JSON.stringify(verification.issues)) + ")"
    : ""));
  out.push("");
  for (const pack of report.results) {
    out.push("## " + pack.packName + " (" + pack.packVersion + ")");
    out.push("");
    out.push("Basis: " + pack.packBasis.label);
    out.push("");
    for (const clause of pack.clauses) {
      const marker = clause.status === "pass" ? "PASS"
        : clause.status === "gap" ? "GAP"
        : clause.status === "advice" ? "ADVICE"
        : clause.status === "exempt" ? "EXEMPT"
        : "n/a";
      out.push("### [" + marker + "] " + clause.ref + " — " + clause.title);
      out.push("");
      out.push("Requirement: " + clause.requirement);
      if (clause.evidence) {
        out.push("");
        out.push("> Evidence: \"" + clause.evidence.sentence + "\"");
      } else if (clause.reason) {
        out.push("");
        out.push("Note: " + clause.reason);
      }
      if (clause.status === "gap" && clause.suggestedText) {
        out.push("");
        out.push("Suggested wording: " + clause.suggestedText);
      }
      out.push("");
    }
  }
  if (statement) {
    out.push("---");
    out.push("");
    out.push(statement.markdown);
  }
  return out.join("\n");
}

const STATUS_LABEL = {
  pass: "satisfied",
  gap: "gap",
  advice: "advisory",
  exempt: "exempt",
  na: "not applicable",
};

export function reportRows(report) {
  const rows = [];
  for (const pack of report.results) {
    for (const clause of pack.clauses) {
      rows.push({ pack: pack.packName, clause });
    }
  }
  return rows;
}

/**
 * One file, everything in it. Opening it in a browser re-computes the whole hash
 * chain in front of the reader; the report and the statement are in the same
 * page, so a client can check the record without an account or a server.
 */
export function toStandaloneHtml({
  report,
  statement = null,
  records = [],
  digest = null,
  generatedAt = null,
  title = "Disclosure Ledger export",
}) {
  const rows = reportRows(report).map(({ pack, clause }) => {
    const evidence = clause.evidence
      ? "<blockquote>" + escapeHtml(clause.evidence.sentence) + "</blockquote>"
      : "<p class=\"note\">" + escapeHtml(clause.reason) + "</p>";
    const fix = clause.status === "gap" && clause.suggestedText
      ? "<p class=\"fix\"><strong>Suggested wording:</strong> " + escapeHtml(clause.suggestedText) + "</p>"
      : "";
    return "<tr class=\"s-" + clause.status + "\"><td><code>" + escapeHtml(clause.ref) + "</code></td>" +
      "<td>" + escapeHtml(clause.title) + "</td>" +
      "<td>" + STATUS_LABEL[clause.status] + "</td>" +
      "<td>" + escapeHtml(clause.requirement) + evidence + fix + "</td></tr>";
  }).join("\n");

  const payload = safeJsonForScript({ records, digest });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px 24px 64px; max-width: 980px; margin-inline: auto; color: #14181f; background: #fbfbfd; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 8px; border-bottom: 1px solid #d8dbe3; padding-bottom: 6px; }
.meta { color: #5a6273; font-size: 13px; }
.verdict { display: inline-block; margin: 16px 0; padding: 10px 14px; border-radius: 8px; font-weight: 600; }
.verdict.ok { background: #e6f6ec; color: #14602f; border: 1px solid #b6e0c4; }
.verdict.bad { background: #fdeaea; color: #8a1f1f; border: 1px solid #f0bcbc; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #e4e7ee; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5a6273; }
tr.s-gap td:first-child { box-shadow: inset 3px 0 0 #d94a4a; }
tr.s-pass td:first-child { box-shadow: inset 3px 0 0 #2f9e63; }
blockquote { margin: 6px 0 0; padding: 4px 0 4px 10px; border-left: 2px solid #b9c0cf; color: #3d4353; }
.note { color: #5a6273; margin: 6px 0 0; font-size: 13px; }
.fix { margin: 6px 0 0; background: #fff6e5; border: 1px solid #f0dcae; border-radius: 6px; padding: 6px 8px; }
pre { background: #f1f3f8; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (prefers-color-scheme: dark) {
  body { background: #14161c; color: #e7e9ef; }
  h2 { border-color: #2b3038; }
  th, td { border-color: #262b33; }
  .fix { background: #2a2415; border-color: #4a3f22; }
  pre { background: #1b1f27; }
  .verdict.ok { background: #14331f; color: #a9e6bd; border-color: #235c37; }
  .verdict.bad { background: #3a1a1a; color: #f0bcbc; border-color: #6b2b2b; }
  blockquote { border-color: #3a414d; color: #b9c0cf; }
}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">Generated ${escapeHtml(generatedAt || "not recorded")} · engine ${escapeHtml(report.engine)} · ${escapeHtml(APP_NAME)} ${escapeHtml(APP_VERSION)}</p>

<div id="verdict" class="verdict">Verifying the ledger in this browser…</div>

<h2>Summary</h2>
<ul>
<li>Readiness: <strong>${escapeHtml(String(report.summary.readiness))}/100</strong> (${escapeHtml(report.summary.band)})</li>
<li>Clauses evaluated: ${escapeHtml(String(report.summary.clauses))} across ${escapeHtml(String(report.summary.packs))} rule pack(s)</li>
<li>Satisfied ${escapeHtml(String(report.summary.passed))} · gaps ${escapeHtml(String(report.summary.gaps))} · advisory ${escapeHtml(String(report.summary.advice))} · exempt ${escapeHtml(String(report.summary.exempt))} · not applicable ${escapeHtml(String(report.summary.notApplicable))}</li>
<li>Ledger digest: <code>${escapeHtml(digest || "not recorded")}</code> — ${escapeHtml(String(records.length))} records</li>
</ul>

<h2>Clause by clause</h2>
<table>
<thead><tr><th>Clause</th><th>Title</th><th>Status</th><th>Requirement and evidence</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>

${statement ? "<h2>Disclosure statement draft</h2>\n<pre>" + escapeHtml(statement.plain) + "</pre>\n" : ""}

<h2>Ledger</h2>
<pre id="ledger">${escapeHtml(JSON.stringify(records, null, 2))}</pre>

<p class="meta">This file is self-contained. No network request is made when it is opened; the verification below runs
locally with WebCrypto. If your browser blocks WebCrypto on local files, paste the ledger JSON into the Verify tab of
the app, or run <code>python3 tools/verify_ledger.py ledger.json</code>.</p>

<script id="ledger-data" type="application/json">${payload}</script>
<script>
(async function () {
  var box = document.getElementById("verdict");
  function canonical(value) {
    if (value === null || value === undefined) return "null";
    var t = typeof value;
    if (t === "string") return JSON.stringify(value);
    if (t === "boolean") return value ? "true" : "false";
    if (t === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (t === "object") {
      var keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort();
      return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + canonical(value[k]); }).join(",") + "}";
    }
    throw new Error("cannot canonicalise " + t);
  }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }
  async function digest(text) {
    return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  }
  try {
    var data = JSON.parse(document.getElementById("ledger-data").textContent);
    var records = data.records || [];
    var genesis = new Array(65).join("0");
    var issues = [];
    for (var i = 0; i < records.length; i += 1) {
      var rec = records[i];
      var expectedPrev = i === 0 ? genesis : records[i - 1].hash;
      if (rec.prevHash !== expectedPrev) issues.push("record " + (i + 1) + ": broken link");
      var core = { seq: rec.seq, timestamp: rec.timestamp, type: rec.type, payload: rec.payload };
      var recomputed = await digest(rec.prevHash + "\\n" + canonical(core));
      if (recomputed !== rec.hash) issues.push("record " + (i + 1) + ": digest mismatch");
    }
    if (issues.length === 0) {
      box.className = "verdict ok";
      box.textContent = "Ledger verified in this browser: " + records.length + " records, chain intact.";
    } else {
      box.className = "verdict bad";
      box.textContent = "Ledger NOT verified: " + issues.join("; ");
    }
  } catch (err) {
    box.className = "verdict bad";
    box.textContent = "Could not verify here (" + err.message + "). Paste the ledger into the app's Verify tab, or run tools/verify_ledger.py.";
  }
})();
</script>
</body>
</html>
`;
}

export function downloadName(kind, { project, date }) {
  const slug = String(project || "deliverable")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "deliverable";
  const stamp = String(date || "").replace(/[^0-9]/g, "").slice(0, 8) || "undated";
  return "disclosure-ledger-" + slug + "-" + stamp + "." + kind;
}
