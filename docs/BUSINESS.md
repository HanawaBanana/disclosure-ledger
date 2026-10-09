# Disclosure Ledger — executive briefing

Four sections: **Market Friction**, **Architecture**, **Target Cohort**, **Fiscal
Architecture**. Numbers marked *assumption* are working figures for a pricing model, not
measured results; everything else is either verifiable in the code or stated as a limit.

---

## 1. Market Friction

### The rule arrived before the tooling did

Three separate regimes started asking the same question in the same period, and all three
ask it of the *person who publishes*, not of the model vendor:

* **EU AI Act, Article 50** — transparency duties for AI-generated and manipulated
  content, applying from 2 August 2026 (Article 113 timetable). For an agency that ships
  a campaign, the duty lands on the studio and the client's channel, not on the model
  provider.
* **Public procurement** — invitations to tender increasingly require an "AI use
  declaration": whether AI was used, which tools and versions, which sections, who
  verified it, what happened to confidential material, and how long the record is kept.
  A missing or vague declaration is scored as a missing declaration.
* **Content platforms** — upload-time "altered or synthetic content" questions, AI labels,
  synthetic-voice rules, C2PA provenance expectations.

An agency or bid team now has to answer all of that per deliverable, and the answers have
to survive an audit months later.

### Where it breaks today

| Friction | What it costs |
|---|---|
| **The rules are prose, not checklists.** Article 50 alone has seven paragraphs with carve-outs; an ITT's AI clause is written by the buyer in their own words. | Whoever signs the deliverable reads legal text and guesses what applies — or does nothing and hopes. |
| **The obvious tools are unusable.** The cheapest way to "check" a document is to paste it into an online service. For an agency contract, an unannounced bid, or a client's unreleased campaign, that is a confidentiality breach. | Teams either expose client material or skip the check. |
| **Declarations are written from scratch every time,** with different wording per buyer. | Hours of unbillable work per bid, and inconsistent statements across a portfolio. |
| **Nobody can prove the record.** A Word document saying "we declared AI use" is worth what it costs; a buyer asking "when was this checked, and by whom, and has it changed since?" gets an unverifiable answer. | The declaration is not evidence, so it does not reduce risk, so it is not worth doing carefully. |
| **Detection tools answer the wrong question.** "Was this written by an AI?" is unanswerable and irrelevant. The obligation is "did you *disclose* what you used, in the wording the rule requires?" | Money spent on AI detectors that produce nothing a buyer will accept. |

### The gap this product fills

A **local-first checker**: the document stays in the browser, the rule packs are explicit
and numbered, the gap list quotes the clause and offers the wording, and the whole session
lands in a hash-chained record that a third party can verify without trusting the sender.

Positioning, in one line: *the compliance desk for people who have to sign the
deliverable, not the model vendor's compliance page.*

---

## 2. Architecture

### What the product actually is

A static, single-page application with no backend. That is not a limitation of the MVP —
it is the product's main commercial claim, because the sensitive step (reading the client's
document) never leaves the machine.

```
user's browser (the only place any data exists)
 ├─ analysis     argv: text + declared usage  →  signals + evidence offsets
 ├─ rule engine  predicates over signals, literal phrase matching → clause statuses
 ├─ drafting     statement assembled from the user's own answers
 ├─ ledger       SHA-256 hash chain over canonical JSON
 └─ storage      IndexedDB → localStorage → memory, with probe deadlines
        │
        └─ export: ledger .json · self-verifying report .html · statement .md
```

Trust properties, all implemented and tested rather than asserted:

* **No network in the app.** No `fetch`, no `XMLHttpRequest`, no remote font, image or
  script. The app runs with the network off.
* **Verification is independent.** Three verifiers agree: the app's own Verify tab, the
  script inside the exported HTML file (WebCrypto), and `tools/verify_ledger.py`
  (standard-library Python). A test asserts the JavaScript chain and the Python verifier
  agree, including after a deliberate edit.
* **No black box.** Applicability predicates, phrase lists, severities, remediation and
  the wording to insert are all literal data in one file (`app/engine/packs.js`) that a
  reviewer can read in a few minutes.

### Extension path (paid tiers, see §4)

Everything is designed to grow without a backend:

1. **`rule packs`** are data. A new jurisdiction or a specific buyer's ITT becomes another
   pack object. Packs are versioned (`2026.1`) and their version goes into every ledger
   record, so an audit shows which rules were applied.
2. **`org profiles`** (deliverable templates, standard wording, brand of the declaration)
   are local records today; a team tier syncs them through an object store the customer
   owns, or through a zero-knowledge sync where the server holds only ciphertext.
3. **`multi-document workspaces`** (a bid with forty attachments) extend the same ledger
   with one digest per document.
4. **`policy packs as an API`** for platforms that want to validate manifests, sold as a
   library, not as a service that sees the content.

---

## 3. Target Cohort

Primary buyers are small, non-legal teams that sign deliverables and are exposed when a
buyer, a platform or a regulator asks the disclosure question.

| Segment | Size signal *(assumption)* | What they buy |
|---|---|---|
| **Design and creative studios, 5–50 people** | tens of thousands in the EU alone | Campaign and content disclosure, platform labelling, competition entries |
| **Bid and proposal teams in SMEs** | every firm responding to public tenders | AI use declaration, extent statement, tool register, retention record |
| **Independent consultants and freelancers** writing for public bodies | very large, price-sensitive | One-off declarations, statement wording, a verifiable record to attach |
| **In-house content and comms teams in public bodies** | municipal and agency level | Reverse direction: checking that what suppliers hand them is declared |
| **Agencies serving regulated clients** (finance, health, public) | smaller, higher value | Client-specific rule packs and evidence packs for their client's audit |

Who is *not* the target: model vendors (they have their own compliance obligations as
providers), enterprises with a legal department and a GRC platform (they buy integrations,
later, if ever), and anyone looking for an AI detector.

**Wedge and expansion.** The wedge is the bid team: the pain is acute (a missing
declaration loses the bid), the deadline is hard, and the artefact produced — the
statement plus the verifiable record — is exactly what the buyer asked for. The same
engine then covers the studio's campaign work and the competition entry, which is how a
single-user licence becomes a team licence.

---

## 4. Fiscal Architecture

### Model: per-seat subscription, with a usage-based tier for programme work

Disclosure checking is periodic and deadline-driven, so a flat per-seat subscription fits
the buyer's mental model ("the cost of one bid") better than pure consumption, while a
usage tier captures firms that process hundreds of assets a month.

| Tier | Price *(assumption)* | For | Includes |
|---|---|---|---|
| **Free — local** | €0 | anyone, forever | all four packs, gap list, statement, hash-chained ledger, JSON/HTML/MD export, unlimited local checks. No account. |
| **Studio** | €29 / seat / month | 1–10 person teams | branded statement templates, saved organisation profile, pack updates as they ship, priority pack requests |
| **Team** | €99 / seat / month | 10–50, bid and comms teams | shared workspace, client-specific packs, role-based approval (who reviewed what), audit export bundle per bid, SSO |
| **Programme / API** | €490 / month, or €0.40 per document over 1,000 | high-volume agencies, platforms | batch checking, pack-as-library embedding, manifest validation, support SLA |

The free tier is deliberately complete: the differentiator is not the checker, it is the
**team workflow and the branded, auditable evidence bundle**. That keeps trust (nobody
has to pay to find out whether their document is compliant) and turns the paid tiers into
a collaboration purchase rather than a paywall.

### Unit economics *(assumption — validate with 20 customer interviews)*

Static hosting plus a per-seat subscription has unusually clean maths, because the
sensitive computation runs on the customer's machine:

| Line | Figure | Note |
|---|---|---|
| Cost to serve one Studio seat | **< €0.10 / month** | static hosting (GitHub Pages / Cloudflare Pages free-to-cheap tier), no per-document compute, no storage of customer content |
| Payment + tax overhead | ~4.5% of revenue | Stripe-class processing and VAT handling |
| Support, first line | ~0.3 h / seat / month | mostly pack questions |
| **Contribution margin per Studio seat** | **≈ 94%** | €29 → ≈€27 after fees and hosting |
| CAC, content and community led | €120–€250 *(assumption)* | agency newsletters, bid-team communities, pack launches |
| Payback | **≈ 5–9 months** | at €27 contribution per seat |
| Gross margin, Programme tier | 80–88% | support and SLA are the variable cost |

Break-even at a €60k/year operating cost (one founder-engineer, part-time support)
requires roughly **190 Studio seats**, or ~60 Studio seats plus 12 Team seats, before any
Programme revenue. The free tier is expected to dominate headcount and to be the main
top-of-funnel; the model is designed so that its marginal cost stays near zero.

### Why this can be defended

* **Rule packs are the moat that accumulates.** Whoever maintains accurate, versioned,
  hand-written packs per jurisdiction and per buyer is the one whose output a bid team
  can attach to a submission. The engine is deliberately simple; the corpus is the work.
* **The evidence format is a wedge into the buyer's process.** Once a contracting
  authority has seen a verifiable ledger, "send us one of these" is a short conversation —
  and that pulls the supplier's tooling along with it.
* **No data liability.** Because no customer content is stored or transmitted, the privacy
  and breach-exposure cost that normally scales with usage simply is not there.

### What would falsify this plan

* Buyers accepting a one-line declaration without evidence (then the wedge is weak).
* Rule packs proving impossible to keep current without a legal team on staff.
* Agencies deciding that "paste it into the tool we already pay for" is good enough
  (then we lose the confidentiality argument, which is our strongest one).
