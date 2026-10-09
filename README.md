# Disclosure Ledger

**Local-first AI-disclosure compliance.** Paste a deliverable, pick the rule packs that
apply to it, and get three things you can hand to a client, a buyer or a judge:

1. a **gap list** — clause by clause, with the obligation in one line, the wording to
   insert, and where in the document it belongs;
2. a **disclosure statement** draft, assembled from your own answers, with visible
   placeholders for anything you have not filled in;
3. a **tamper-evident audit ledger** — a SHA-256 hash chain of everything that happened,
   exportable as JSON, as a self-verifying HTML file, or as Markdown.

Everything runs inside the browser tab. There is no server, no account, no API key, no
analytics, and no request to any third party: the app works with the network switched
off, which is the point — agency work, tender bids and client deliverables are exactly
the documents you cannot paste into a web form.

* **Live app:** https://hanawabanana.github.io/disclosure-ledger/
* **Licence:** MIT
* **Runtime:** a browser. Nothing else. (Node.js ≥ 18 only to run the tests.)

---

## Contents

| Path | What it is |
|---|---|
| `index.html`, `app/styles.css` | the interface: two themes, no framework, no build step |
| `app/main.js` | wiring: reads the DOM, calls the engine, writes results back, appends to the ledger |
| `app/samples.js` | four realistic sample documents used by the tour, the tests and the demo video |
| `app/engine/lexicon.js` | the analyser: term lists, sentence spans, declared-vs-detected signals |
| `app/engine/packs.js` | the four rule packs, one clause at a time |
| `app/engine/engine.js` | predicate evaluator, phrase matcher, scoring, pack suggestion |
| `app/engine/chain.js` | canonical JSON, SHA-256 hash chain, chain verification, record builders |
| `app/engine/statement.js` | the disclosure statement draft |
| `app/engine/exporters.js` | JSON / self-verifying HTML / Markdown exports |
| `app/engine/store.js` | IndexedDB → localStorage → memory persistence |
| `app/demo.js` | the guided tour (`?demo=N`) used to record the demo video |
| `tests/` | 151 offline tests (`node --test tests/`) |
| `tools/verify_ledger.py` | verify an exported ledger without the app, standard library only |
| `tools/make_video.py`, `tools/cdp.py` | rebuild `docs/media/disclosure_ledger_demo.mp4` |
| `docs/BUSINESS.md` | market friction, architecture, target cohort, monetisation |

---

## Architecture

```
                    ┌───────────────────────────── one browser tab ─────────────────────────────┐
                    │                                                                           │
  paste / drop ────▶│  app/main.js ──▶ engine/lexicon.js  analyse(text, declared usage)          │
  (.txt .md .csv    │        │              └─ terms, sentence offsets, signals + their source   │
   .json .html)     │        │                                                                  │
                    │        ├──▶ engine/engine.js ──▶ rule packs (engine/packs.js)              │
                    │        │        · applies?   predicate over signals (declared | detected) │
                    │        │        · satisfied? one of the clause's phrase groups matches    │
                    │        │        └─ pass / gap / advice / exempt / n/a  + evidence offsets  │
                    │        │                                                                  │
                    │        ├──▶ engine/statement.js ──▶ statement draft (markdown + plain)     │
                    │        │                                                                  │
                    │        ├──▶ engine/chain.js ──▶ SHA-256 hash chain ──▶ engine/store.js      │
                    │        │        canonical JSON, prevHash linkage         IndexedDB          │
                    │        │                                                └─ localStorage    │
                    │        │                                                └─ memory          │
                    │        │                                                                  │
                    │        └──▶ engine/exporters.js ──▶ download                              │
                    │                 · ledger .json      (records + digest + verdict)          │
                    │                 · report .html      (self-contained, re-verifies itself)  │
                    │                 · report .md        (statement + every clause)            │
                    └───────────────────────────────────────────────────────────────────────────┘
```

Nothing above leaves the tab. The only way data leaves the page is a file the user
downloads, and the app never calls `fetch`, `XMLHttpRequest`, a remote image, or a CDN
script — the two local verification paths (the Verify tab and `tools/verify_ledger.py`)
exist so that a recipient can check a ledger without trusting either us or the exporter.

### Why the engine is shaped like this

* **A clause applies, or it does not.** Applicability is a predicate over signals, and a
  signal is on when it was *declared by the user* or *found as a literal term* in the
  text. The report says which of the two, per signal.
* **A clause is satisfied only by wording that is really there.** Every clause carries
  phrase groups; the engine matches them literally (case-insensitive, whitespace
  tolerant) and records the character offsets. No model, no inference, no guessing.
* **Clauses that do not apply say so.** A silent skip and a pass look the same in most
  tools; here they are different statuses with reasons.
* **Suggested wording satisfies its own clause.** A test enforces it, so the app cannot
  recommend text that would still fail its check.

Clause statuses: `pass`, `gap` (counted in the score), `advice` (advisory, not counted),
`exempt` (an exemption in the pack covers it, e.g. Article 50(6) for reviewed editorial
content), `n/a` (not applicable, with the reason).

---

## Rule packs

| Pack | Basis | Clauses |
|---|---|---|
| `eu-ai-act-art50` — EU AI Act Article 50 transparency | Regulation (EU) 2024/1689, Article 50 (with Articles 4 and 113) | 8 |
| `tender-ai-declaration` — Tender AI-use declaration | Consolidation of AI-use declaration clauses seen in public-sector ITTs | 8 |
| `platform-ai-labelling` — Platform AI-content labelling | Consolidation of the published AI-disclosure rules of major platforms | 8 |
| `competition-ai-declaration` — Competition AI declaration | Generic template drawn from competition entry rules that require an AI declaration | 8 |

Every clause is a **short paraphrase written by hand** — rule name, clause number, and
one line of what it requires — not a quotation of the source. Each pack states its basis
and its limits in `basis.note`, and the app repeats them on the Method tab. This is a
drafting aid, not legal advice: read the source, and read your own ITT or brief.

Adding a pack is one object in `app/engine/packs.js`: metadata, basis note, and clauses
with `applies` / `satisfied` / `remediation` / `suggestedText` / `insertInto`. The tests
check the whole set for completeness, unknown signals, duplicate references, and
self-consistency of the suggested wording.

---

## Data schema

### Ledger record (the thing you export)

```jsonc
{
  "format": 1,                       // LEDGER_FORMAT
  "seq": 3,                          // 1-based position; verified against the index
  "timestamp": "2026-10-07T09:12:01.000Z",
  "type": "check.run",               // see RECORD_TYPES in app/engine/chain.js
  "payload": { /* per-type, canonical-safe: strings, booleans, null, integers, arrays, objects */ },
  "prevHash": "…64 hex…",            // the hash of seq-1, or 64 zeros for the first record
  "hash": "…64 hex…"                 // sha256(prevHash + "\n" + canonical({seq, timestamp, type, payload}))
}
```

Record types: `document.registered`, `check.run`, `statement.generated`, `export.json`,
`export.html`, `export.markdown`, `ledger.verified`.

`canonical` is JSON with object keys sorted, no insignificant whitespace, and numbers
reduced to the form JavaScript's `String()` produces. That is what makes the chain
verifiable from Python, or from the exported HTML page.

### Ledger export file

```jsonc
{
  "format": "disclosure-ledger/1",
  "app": "Disclosure Ledger",
  "appVersion": "1.0.0",
  "engine": "1.0.0",
  "generatedAt": "2026-10-07T09:12:03.000Z",
  "digest": "…64 hex…",              // fingerprint of the chain: sha256 of every record hash
  "verification": { "ok": true, "checked": 4, "issues": [], "brokenAt": null },
  "recordCount": 4,
  "records": [ /* the records above */ ]
}
```

### Locally stored state (IndexedDB, one object store, one record per key)

| Key | Value |
|---|---|
| `dl.ledger` | the array of records — the whole chain |
| `dl.documents` | up to 25 recent documents: `{ id, name, chars, words, digest, packs, declared, tools, usageNote, text, at }` |
| `dl.answers` | the statement fields, so the form survives a reload |

`id` is `documentId(name, digest)` → `"<slug>@<first 12 chars of sha256>"`. Clearing site
data, or the Clear button on the ledger tab, removes all of it.

### Analysis profile (`app/engine/lexicon.js`)

```jsonc
{
  "engine": "1.0.0", "chars": 1234, "words": 163, "sentenceCount": 21,
  "sentences": [{ "start": 0, "end": 42, "text": "…" }],
  "hits": { "ai_mentioned": 5, "visual_output": 3 },
  "detected": { "visual_output": true },   // literally found in the text
  "declared": { "synthetic_media": true }, // ticked by the user
  "signals": { "visual_output": true },    // the union the predicates read
  "sources": { "visual_output": "detected" },
  "evidenceFor": { "visual_output": { "term": "image", "start": 28, "sentence": "…" } }
}
```

---

## Run it locally

```bash
git clone https://github.com/HanawaBanana/disclosure-ledger
cd disclosure-ledger
python3 -m http.server 8788          # or: npx serve .
# open http://127.0.0.1:8788/
```

There is no build step and no dependency to install. Opening `index.html` from the file
system works in Chrome and Firefox, but a local server is what the instructions above
use, because ES modules from `file://` are blocked in some browsers.

Query parameters used by the recording tool and by anyone reviewing the app:

| URL | Effect |
|---|---|
| `/?demo=N` | jump to guided-tour step N (0–12) — the real actions, run automatically |
| `/?demo=list` | print the tour plan into `data-demo-plan` on `<body>` |
| `/?store=indexeddb` / `/?store=localstorage` | pin the persistence backend |

## Test it

```bash
node --test tests/                   # 151 tests, offline, no dependencies
python3 tools/verify_ledger.py ledger.json      # independent verifier, exit code 0/1
python3 tools/make_video.py          # rebuild docs/media/disclosure_ledger_demo.mp4
```

The suite covers the analyser, every engine status, the pack structure (including
"suggested wording satisfies its own clause"), the hash chain (tamper, reorder, drop,
re-seal, malformed records), the statement, all three exporters including hostile
escaping, all three storage backends and their fallbacks, the four sample documents
end to end, and a cross-language check where the **Python verifier must accept** a chain
written by the JavaScript engine and **reject** the same chain after one payload is edited.

## Deployment

Static hosting, nothing else. GitHub Pages serves this repository's `main` branch:

```
Settings → Pages → Source: Deploy from a branch → main → / (root)
```

The app is at `https://<user>.github.io/disclosure-ledger/`; the same files run on
Netlify, Cloudflare Pages, S3 + CloudFront or any web server, because the only
requirement is "serve these files over HTTPS".

## Privacy and limits

* **Local by construction.** No network calls at all: no analytics, no fonts, no CDN.
  A ledger or a document leaves the machine only when the user downloads it.
* **Not legal advice.** Paraphrased rules with named sources; the app tells you to read
  the source and your own tender or brief.
* **Not a detector.** The app does not try to guess whether a text was written by a
  model. It checks the *declaration*: given what you used, does the deliverable contain
  the wording the rule requires?
* **The pack list is short on purpose.** Four packs, each written by hand, each with its
  basis and its caveats on the Method tab.

## Licence

MIT — see [LICENSE](LICENSE).
