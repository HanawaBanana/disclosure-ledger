# SubmitNotes.md — Devpost submission sheet

Everything the form asks for, in one place, ready to paste. Nothing here claims more than
the code does; where a claim is a limit, it says so.

## Project

* **Project name:** Disclosure Ledger
* **Tagline (one line):**
  Local-first AI-disclosure compliance: paste a deliverable, get the gap list, the
  statement and a tamper-evident record — without uploading anything.
* **Elevator line (one sentence, if a longer field is offered):**
  A browser-only application that checks a deliverable against the AI-disclosure rule
  packs that apply to it, drafts the declaration the user has to publish, and writes the
  whole session to a SHA-256 hash chain that any third party can verify offline.
* **Built with (tags):** `HTML5` · `CSS3` · `JavaScript (ES modules)` · `WebCrypto` ·
  `IndexedDB` · `Node.js` · `Python`

  (No framework, no build step, no runtime dependency: the app is HTML, CSS and ES
  modules; hashing uses `crypto.subtle`; the Node.js and Python sides are the test suite,
  the independent ledger verifier and the video recorder.)

## The ~240-word project description (paste into the Devpost form)

> **Disclosure Ledger** answers one question that agencies, bid teams and creators now face per deliverable: given what we used AI for, does this document contain the disclosure the rules require?
>
> Paste the deliverable — a tender response, a client hand-over note, a caption, a competition entry — and tick what the AI actually did. The app merges what you declared with what the text itself mentions, then checks each clause of the rule packs you select: EU AI Act Article 50 transparency, tender AI-use declarations, platform AI-labelling rules, and competition entry declarations.
>
> Every clause gets an explicit status. A gap quotes the obligation in one line and offers wording to insert, with the place it belongs. A satisfied clause shows the sentence that satisfied it and the character offsets. A clause that cannot apply says why, and an exemption — Article 50(6) for editorially controlled content — is reported as an exemption rather than a pass.
>
> The report then becomes a disclosure statement draft, with visible placeholders for anything you have not filled in. Every step is appended to a SHA-256 hash-chained ledger: edit one record by a single character and the verifier names it.
>
> Client documents, though, cannot be pasted into a web service. There is no server here: no fetch, no analytics, no CDN, no account. The app runs with the network switched off and exports a self-contained report that re-verifies its own chain.
>
> 151 tests, offline. Standard library only, MIT licensed.

*Word count of the block above: 241 words (the same regex the app uses for its word count).*

## Links

* **Public repository:** https://github.com/HanawaBanana/disclosure-ledger
* **Live app (GitHub Pages):** https://hanawabanana.github.io/disclosure-ledger/
* **Demo video (3:24, 1280×800, H.264 + AAC, 5.06 MB):**
  `docs/media/disclosure_ledger_demo.mp4` in the repository — 204 s, recorded from the
  live app with the guided tour (`/?demo=N`), English narration.
* **Thumbnail:** `docs/media/thumbnail.jpg`
* **Business briefing:** `docs/BUSINESS.md` (Market Friction · Architecture · Target
  Cohort · Fiscal Architecture, including pricing tiers and unit economics)
* **Technical README:** `README.md` (architecture diagram, stack, data schema, run/test)

## How to run it

| Requirement | Version / note |
|---|---|
| A browser | Chrome, Firefox, Edge or Safari, current. That is the whole runtime. |
| A local web server (optional but recommended) | `python3 -m http.server 8788` or `npx serve .` — opening `index.html` from disk also works in Chrome and Firefox |
| Node.js | **≥ 18**, only to run the test suite (`node --test tests/`) |
| Python 3 | only for the independent ledger verifier (`tools/verify_ledger.py`) and the video recorder |
| Network | **not required** — the app makes no network requests at all |
| Install step | **none**: no `npm install`, no build, no bundler, no lockfile |

```bash
git clone https://github.com/HanawaBanana/disclosure-ledger
cd disclosure-ledger
python3 -m http.server 8788
# open http://127.0.0.1:8788/  → press "Try a sample" → "Run the check"
```

```bash
node --test tests/                     # 151 tests, all offline
python3 tools/verify_ledger.py <ledger.json>   # independent verification, exit code 0/1
python3 tools/make_video.py            # rebuild the demo video (Chrome + ffmpeg + edge-tts)
```

## How this meets the event requirements

| Requirement | Where it is met | Honest status |
|---|---|---|
| 1. Production-ready deployment (live, stable, judge-accessible URL) | GitHub Pages, served from `main` at https://hanawabanana.github.io/disclosure-ledger/ | **Met.** Static hosting on a global CDN; verified live and rendering the app (not a placeholder). |
| 2. Verifiable infrastructure (public repo, professional README, architecture, stack, DB schema, local reproduction, real commit history) | `README.md`: architecture diagram, stack table, data schema for the ledger record, export file, local storage keys and the analysis profile; local run and test commands; `LICENSE` (MIT); `.gitignore`; incremental commits | **Met.** The "database schema" here is the ledger record shape plus the three IndexedDB keys, because the product deliberately has no server-side database. |
| 3. Operational MVP (end-to-end workflow, real state management, works for a real person) | Check → statement → ledger → export, with IndexedDB persistence, recent-document list, reload-safe answers, verification and three export formats | **Met.** Exercised end to end in the video and in `tests/integration.test.js`. |
| 4. Executive briefing (market friction, architecture, target cohort) | `docs/BUSINESS.md` §1–§3 | **Met.** |
| 5. Fiscal architecture (monetisation engine) | `docs/BUSINESS.md` §4: free/Studio/Team/Programme tiers, contribution margin, CAC and payback, break-even, falsification tests | **Met, with the caveat stated in the document:** prices and unit economics are a modelled proposal marked *assumption*, not measured revenue. There is no billing integration in this build. |
| 6. Technical keynote (2–5 minute product demo video) | `docs/media/disclosure_ledger_demo.mp4` — 3 min 24 s, 1280×800, H.264 + AAC, English narration, recorded from the running app | **Met.** All 13 scenes are real frames of the app performing the real actions; the narration describes what is on screen. |

### Theme fit

"Build fully functional, revenue-generating SaaS platforms… software the world will
actually pay for." The build is a complete, working product with state, exports and an
audit trail, and the revenue model in `docs/BUSINESS.md` is specific (per-seat
subscription with a usage tier for programme work). The billing layer itself is not built
— the free tier is fully functional and the paid tiers are specified, not implemented.
That is the largest gap between this submission and "revenue-generating".

### Originality

Written from scratch for this event. No part of a competing product was copied; the rule
packs are hand-written paraphrases with their sources named, not quotations of the
regulations or of any vendor's policy, and the packs are the only place where
subject-matter content lives.

## What the demo video shows

| Scene | On screen |
|---|---|
| 0 | the app, before anything is pasted — the "runs in your browser" claim |
| 1 | a sample agency hand-over note loaded: word count and SHA-256 of the text |
| 2 | the usage declaration, and the declared/detected merging |
| 3 | rule-pack selection with the app's own suggestion and its reasons |
| 4 | the check: 10 of 11 applicable clauses open, readiness 11/100 |
| 5 | a gap card: clause, obligation, the wording to insert, where it belongs |
| 6 | the clause-by-clause table with the sentence and character range that satisfied each clause |
| 7 | a tender response: different packs, different gaps (5 open, readiness 48) |
| 8 | the disclosure statement draft, with placeholders for unfinished fields |
| 9 | the audit ledger, verified end to end (chain intact) |
| 10 | an edited ledger rejected, with the record that no longer matches named |
| 11 | the self-contained HTML export re-verifying its own chain |
| 12 | the method page: sources, limits and where the data lives |
