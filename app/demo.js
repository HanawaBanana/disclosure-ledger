/**
 * demo.js — the guided tour used by tools/make_video.py.
 *
 * `?demo=N` puts the app into tour step N. Each step performs the real actions
 * the buttons perform (load a sample, run the check, build the statement, verify
 * the ledger) and then records `data-metrics` on <body> with the scroll offset of
 * the element the step is about, so the video tool can crop a 1280×800 frame
 * around it. No step fabricates a result: if the engine returns something
 * different tomorrow, the frames will show the different thing.
 */

const FIXED_TIME = "2026-10-07T09:12:00.000Z";

export const SCENES = [
  { n: 0, title: "The app, before anything is pasted", focus: "#panel-scan" },
  { n: 1, title: "Sample deliverable loaded, text analysed", focus: "#doc-stats" },
  { n: 2, title: "Declared AI use and detected signals", focus: "#declared-grid" },
  { n: 3, title: "Rule packs suggested for this document", focus: "#pack-list" },
  { n: 4, title: "Run the check — readiness and gaps", focus: "#summary-card" },
  { n: 5, title: "Gap list with clause, evidence and wording", focus: "#gap-list" },
  { n: 6, title: "Clause-by-clause table with quotes", focus: "#clause-tables" },
  { n: 7, title: "A tender response: different packs, different gaps", focus: "#summary-card" },
  { n: 8, title: "Disclosure statement draft", focus: "#statement-preview" },
  { n: 9, title: "Audit ledger, hash chain", focus: "#ledger-rows" },
  { n: 10, title: "An edited ledger is rejected", focus: "#verify-result" },
  { n: 11, title: "The self-contained export verifies itself", focus: "#html-preview" },
  { n: 12, title: "Method, rule sources and privacy", focus: "#panel-method" },
];

async function settle(dl) {
  // one frame of breathing room for the browser to lay out the result
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return dl;
}

export async function apply(n, dl) {
  dl.freezeTime(FIXED_TIME);
  switch (n) {
    case 0:
      await dl.reset();
      dl.switchTab("scan");
      break;
    case 1:
      await dl.reset();
      dl.switchTab("scan");
      await dl.loadSample("agency-deliverable");
      break;
    case 2:
      await dl.loadSample("agency-deliverable");
      dl.switchTab("scan");
      await settle(dl);
      break;
    case 3:
      await dl.loadSample("agency-deliverable");
      dl.recommend();
      break;
    case 4:
      await dl.loadSample("agency-deliverable");
      dl.recommend();
      await dl.runCheck();
      break;
    case 5:
      await dl.loadSample("agency-deliverable");
      await dl.runCheck();
      break;
    case 6:
      await dl.loadSample("agency-deliverable");
      await dl.runCheck();
      break;
    case 7:
      await dl.loadSample("tender-response");
      dl.recommend();
      await dl.runCheck();
      break;
    case 8:
      await dl.loadSample("agency-deliverable");
      await dl.runCheck();
      dl.switchTab("statement");
      await dl.generateStatement();
      break;
    case 9:
      await dl.loadSample("agency-deliverable");
      await dl.runCheck();
      dl.switchTab("statement");
      await dl.generateStatement();
      dl.switchTab("ledger");
      await dl.verifyLocalLedger();
      break;
    case 10:
      await dl.loadSample("agency-deliverable");
      await dl.runCheck();
      dl.switchTab("ledger");
      await dl.verifyLocalLedger();
      dl.switchTab("verify");
      await dl.loadTampered();
      break;
    case 11:
      await dl.loadSample("agency-deliverable");
      await dl.runCheck();
      dl.switchTab("statement");
      await dl.generateStatement();
      dl.switchTab("ledger");
      await dl.verifyLocalLedger();
      await dl.previewHtml();
      break;
    case 12:
      dl.switchTab("method");
      break;
    default:
      dl.switchTab("scan");
  }
  await settle(dl);
  return dl.focusMetric(SCENES[n] ? SCENES[n].focus : "#panel-scan");
}

/** Mount the tour: ?demo=N runs that step, ?demo=1&list prints the plan. */
export async function mountDemo(dl) {
  const params = new URLSearchParams(location.search);
  if (params.get("demo") === "list") {
    document.title = "demo plan " + SCENES.length;
    document.body.dataset.demoPlan = JSON.stringify(SCENES);
    return SCENES;
  }
  const n = Number(params.get("demo"));
  if (!Number.isFinite(n)) return null;
  const metrics = await apply(n, dl);
  document.title = "Disclosure Ledger — step " + n + ": " + (SCENES[n] ? SCENES[n].title : "unknown");
  return metrics;
}
