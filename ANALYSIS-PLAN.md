# Analysis plan — pre-registration (DRAFT)

> **STATUS: DRAFT pre-registration.** This document becomes binding at its public git commit.
> Two commits govern the whole program, both public:
>
> 1. **This DRAFT:** committed publicly **before any paid smoke call**. _No paid smoke before
>    this draft's public commit._
> 2. **The FROZEN plan:** this draft with smoke-resolved trims applied (per the pre-written
>    rules in §12) and all artifact hashes finalized, committed publicly **before any paid
>    primary call**. _No paid primary call before the frozen plan's public commit._
>
> **How to verify this pre-registration:** git author dates are author-controlled; the public
> push is the timestamp. Check the commit dates of this file on the public host against the run
> window printed in the published results; every rule, metric, threshold, and branch below must
> predate every number. The frozen evaluation materials promised to any third party (including
> the vendors we contacted) ship only **after** this document's public commit, so no recipient
> can front-run the registration. Values that depend on the pre-run smoke or on freeze-time
> hashing are marked `[FINALIZED AT FREEZE]` throughout; for each, both possible resolutions are
> pre-written here — none is decided after seeing results.

---

## 1. Conflict of interest, and the publish-regardless commitment

**Velrim wrote this benchmark protocol, built the harness, and sells one of the products under
test.** Velrim is a paid document-extraction API; every other system in the lineup is a
competitor, a substitute, or the bare model Velrim itself runs on. There is no neutral party
here and this document does not pretend otherwise. What it offers instead is: every rule
committed before any money was spent, one open deterministic scorer for every arm (including
ours), frozen inputs with published hashes, raw per-field outputs published for every arm so
any cell can be re-derived by hand, and a standing right of reply for every vendor named.

**Publish-regardless.** Once paid runs complete, the run data (predictions, scores, request
and job IDs, manifests) is published to this repository in full, no matter what it shows. The
decision rules in §11 govern timing, framing, and amplification only; none of them can suppress
a number. Losses print. Ties print as ties. The one outcome that cancels promotion (§11 K6) is
pre-registered here, in advance, with its exact trigger.

Signature: the public commit of this document by the Velrim repository is its execution.

```
Signed: Velrim, by its founder
Date:   the public commit date of this file
```

---

## 2. Arms and frozen configurations

Five arms run in round 1. Two further vendors were asked for consent and did not grant it; they
are excluded and disclosed (§3). Every arm receives the **same frozen
per-class JSON Schema** and the **same PDF bytes**, through that vendor's documented happy
path, with zero arm-specific tuning. Full request construction for every arm is open source in
this repository.

**The A1–A3 block is a deliberate ablation, not padding.** The framing sentence printed above
the arm table in every render, byte-for-byte
(`ABLATION_FRAMING` in `src/report/arms.ts`; change both together):

_"same base model — deliberate ablation (A1–A3): the full pipeline vs its underlying model and decoding"_

It is the only design that can answer "what does the pipeline add?" with a controlled
measurement instead of a claim.

| #   | arm                                               | frozen configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | role                                                                                      |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A1  | **Velrim** (production, api.velrim.com)           | `POST /v1/extract`, standard non-ZDR API key (the default new-customer posture; disclosed). **One live pass** through the same public endpoint every customer uses, with the default request (§6.2): the served product (the fitted stack, Velrim's default served path). The served version stamp is read from every response and printed in the column label. Self-billed at list price (`$0.02/page`) through the real customer wallet; request and job IDs published.                                                 | The product under test                                                                    |
| A2  | **Gemini 2.5 Flash, free-decode** (Google-direct) | Google AI Studio API, **paid quota**. Schema in the prompt via the one shared instruction (§5.4); PDF inline base64; vendor-default generation settings except `temperature: 0` (the one pre-registered decoding rule, applied to every model-prompt arm); output parsed by this CLI's own bundled repair parser, never Velrim's production parser. Auth via the `x-goog-api-key` header. Model pin: `gemini-2.5-flash` (never `-latest`). Docs: ai.google.dev/gemini-api/docs/document-processing (accessed 2026-07-06). | **Headline bare-model control**: Velrim runs this model; this column is the ablation base |
| A3  | **Gemini 2.5 Flash, constrained** (same route)    | Identical prompt bytes to A2; the **only** difference is `generationConfig.responseJsonSchema` carrying the same frozen schema (2.5-flash acceptance is a smoke item, §12). Docs: ai.google.dev/gemini-api/docs/structured-output (accessed 2026-07-06).                                                                                                                                                                                                                                                                  | Constrained-vs-free split: independent replication of the ExtractBench 86.9→70.0 shape    |
| A4  | **Mistral Document AI (OCR 4)**, paid tier        | `POST /v1/ocr` with `document_annotation_format` carrying the frozen class schema; model pin `mistral-ocr-4-0` (never `-latest`). Primary corpus per the §4.3 branch pair; in the cap-confirmed branch a loud-fail guard treats any over-cap document reaching this arm as a protocol error, never a red cell. Docs: docs.mistral.ai/capabilities/document_ai/annotations (accessed 2026-07-06).                                                                                                                          | Hosted competitor product arm; the OCR-pipeline design point; cheapest competitor         |
| A5  | **OpenAI gpt-5.4-mini**, dated snapshot           | `gpt-5.4-mini-2026-03-17` pinned. Free-decode primary (schema in prompt, same shared instruction) + `--structured-mode` secondary (`response_format: json_schema, strict: true`) as the second model family for the constrained-vs-free replication. `temperature: 0`, `logprobs: true`; smoke decides parameter survival (§12). Labeled **"DIY baseline"** in every table. Docs: developers.openai.com/api/docs/guides/pdf-files, /models/gpt-5.4-mini (accessed 2026-07-06).                                            | The DIY path a real buyer tries first                                                     |

Mode-choice rule, pre-registered: a mode choice within a vendor is part of "documented happy
path" and carries a citation to the vendor document that makes it the default, frozen before
any paid run. The defensibility rule, verbatim:

> _Every arm is driven exactly as that vendor's public documentation tells a new customer to
> drive it, with the same schema and the same documents; no arm — including Velrim — gets
> prompt engineering, retries, or settings beyond its documented defaults. The full request
> construction for every arm is open source in this repository; any vendor may open a PR
> correcting how their arm is called, and we will re-run and re-publish with the correction._

**Paid-tier note, stated explicitly:** the Gemini arms run on **paid quota** because unpaid
Gemini API quota licenses Google to use submitted content to improve its products; paid quota
does not. The Mistral arm runs **paid** for the same reason (free-plan inputs feed training
under their §4.2(a)). Publishability itself is unchanged by tier; the tier choice is a
data-handling choice, disclosed.

---

## 3. What we could not run: the consent protocol and its resolved outcome

Two vendors' terms prohibit the use their arms would require. Their governing clauses,
verbatim, from the live texts:

- **Reducto**, Terms of Use (effective 2026-04-17), Prohibited Uses: _"Access or use the
  Services for any competitive purpose."_
- **LlamaIndex (LlamaExtract)**, Terms of Service (last modified 2024-06-07), §2.2 preamble:
  _"you will not do, and will not assist, permit, or enable any third party to do, any of the
  following:"_; §2.2(h): _"use or display the Service in competition with us, to develop
  competing products or services, for benchmarking or competitive analysis of the Service, or
  otherwise to our detriment or disadvantage"_ (live text as captured 2026-07-12).

Both clauses are use-based: a paid account does not cure them, anonymization does not cure
them, and running through a third party is expressly foreclosed by the LlamaIndex preamble. So
neither arm ran (not even a smoke call) without written consent.

**The protocol, as executed:** written consent requests were sent from hello@velrim.com on
**2026-07-12** (describing the protocol, the exact metrics, an offer of pre-publication
replication access and a standing adapter-PR right of reply, and a pointer to each vendor's own
published competitor benchmarks) with a reply deadline of **2026-07-20** (7 calendar days).
The pre-registered outcomes were: (a) written consent before plan-freeze → the arm joins round
1; (b) written consent after plan-freeze → the arm joins the pre-announced round 2 (§15); (c)
refusal or silence at the deadline → drop-and-disclose.

**Resolved outcome: (c).** The window closed **2026-07-20** with no reply from either vendor.
Both arms are excluded from this evaluation, and the publication will print each clause
verbatim together with all three dates: the request date (2026-07-12), the window close
(2026-07-20), and the publication date `[FINALIZED AT FREEZE — printed when known]`; and the
outcome. No motive is attributed. The one sentence pre-registered for exactly this branch:

> _"Two of the best-funded extraction vendors have terms that prohibit being benchmarked; both
> publish named benchmarks of their competitors."_

(For the record: LlamaIndex publishes ParseBench, which scores competitors by name and ranks
Reducto 6th at 72.97%; Reducto publishes RD-TableBench, scoring Azure 82.7, Textract 80.9, and
Google Document AI 64.6.)

Should either vendor consent in writing after plan-freeze, the arm joins the pre-announced
round 2 under this same frozen protocol (§15). The evaluation adapters remain published: a
customer evaluating vendors for their own purchase runs them under their own account and their
own terms posture.

**Plain consequence for the confidence section (pre-registered):** with both consent-gated
arms out, **no non-Velrim system in this lineup surfaces a numeric per-field confidence.** The
confidence section is therefore Velrim's own measured confidence column (§6) plus the factual
"none surfaced" / "not requested" cells (§6.5), and any comparative confidence phrasing is
scoped to the arms we could legally test ("none surfaced among the arms we could legally test"
is the permitted residual). We say this here so no reader has to discover it.

---

## 4. Corpora and sample plan

Four third-party, hand-labeled, licensed document classes, all predating Velrim: `cord-v2`
(receipts, scans; CC BY 4.0), `deepform` (FCC political-ad invoices; MIT, 2020 slice only),
`vrdu-ad-buy` (FCC TV ad contracts; CC BY 4.0), `vrdu-registration` (US DOJ FARA forms; CC BY
4.0). The frozen goldens, schemas, and exact counts live in `corpora/` in this repository
(`corpora/corpus-counts.json` is the count source of record).

### 4.1 Counts, both branches

The primary corpus is a smoke-resolved branch pair (§4.3). Both branches are frozen here, in
advance:

| class             | full: docs / fields / golden-absent / pages | cap-confirmed (≤8pp): docs / fields / golden-absent / pages |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------- |
| cord-v2           | 15 / 196 / 66 / 15                          | 15 / 196 / 66 / 15                                          |
| deepform          | 39 / 195 / 1 / 159                          | 36 / 180 / 1 / 121                                          |
| vrdu-ad-buy       | 22 / 1,423 / 26 / 57                        | 21 / 1,404 / 25 / 46                                        |
| vrdu-registration | 48 / 288 / 49 / 88                          | 48 / 288 / 49 / 88                                          |
| **total**         | **124 / 2,102 / 142 / 319**                 | **120 / 2,068 / 141 / 270**                                 |

### 4.2 Tamper evidence

The evaluation set (CAL-TEST) is the held-out half of a split whose manifests were frozen
**2026-06-24, before this benchmark was designed**. The frozen split manifests carry salted
document IDs, a salt commitment, and a per-class golden hash (`calTestGoldenHash`); the
**salt is revealed at publication**, so any reader can verify after the fact that the published
membership matches the pre-benchmark commitment. The golden and schema bytes are hashed into
this plan at freeze `[FINALIZED AT FREEZE — hashes]` and into every run manifest. Numbers from
the split's other halves (the half Velrim's confidence stack was fit on, and the development
split Velrim's pipeline was built against) are excluded entirely: not even a labeled appendix
(FD-13).

### 4.3 The page-cap branch pair (pre-registered as a conditional pair)

One vendor's documentation has stated an 8-page cap on document annotations (Mistral); the
vendor's own changelog states _"Document Annotations update and improvements, 8 page limit
removed."_ (docs.mistral.ai/resources/changelogs, accessed 2026-07-06). The cap is therefore
**contested**, and the pre-freeze smoke probe is **bidirectional**: one over-cap document is
submitted to the Mistral arm at smoke; rejection selects the cap-confirmed branch, acceptance
with usable output selects the cap-removed branch. Either way, the corpus decision was made
here, before any result existed. `[FINALIZED AT FREEZE — branch selection]`

- **Cap-confirmed branch:** documents over 8 pages are excluded from **all** primary contrasts
  for **all** arms: pairing preserved, no Velrim-authored chunking inside anyone's arm, no
  manufactured failure cells. The four conditional exclusions are frozen now, by ID:
  - `deepform-53c10b8d-b592-db3f-9a30-e6729046e7ce.pdf` (12 pages, 5 fields, 0 golden-absent)
  - `deepform-7b0e54d3-76bc-5e87-6c44-0fe4e534cf80.pdf` (12 pages, 5 fields, 0 golden-absent)
  - `deepform-d42b3339-ef69-384f-3e5b-b21169b04816.pdf` (14 pages, 5 fields, 0 golden-absent)
  - `vrdu-ad-buy/030a8ffe-9abb-57ad-2e82-58312730c0f6.pdf` (11 pages, 19 fields, 1 golden-absent)

  The Mistral adapter carries a loud-fail guard: an over-cap document reaching it in this
  branch is a protocol error that stops the run (checkpoint preserved), never a red cell.
  **Full-set appendix row (this branch only):** non-Mistral arms also run the 4
  over-cap documents; their all-124-document numbers print in a labeled appendix with a
  one-sentence explanation: a robustness check, and the answer to "you dropped documents."

- **Cap-removed branch** (the changelog-indicated outcome): all 124 documents are primary for
  every arm, the full-set appendix row is retired, and the exclusion machinery above remains in
  the frozen plan as expressly conditional dead text with the changelog cited.

### 4.4 Round 2: the never-seen class (pre-announced)

Round 2 adds one document class that no Velrim code has ever touched, with its protocol frozen
before labeling begins. The pre-registration names **selection criteria, never candidates**
(naming a candidate would let preparation start today):

1. **Zero occurrences in this repository's history at the pre-registration commit**:
   mechanically checkable (`git log --all` plus a text search over every historical blob); the
   check and its output are published.
2. **License-clean for public golden redistribution.**
3. **Minimal public-label exposure**: the class with the least published labeled data wins,
   because round 2 is also the designed check on pretraining contamination: these four classes'
   documents and labels have been public since 2019–2023, so held-out here means held out from
   _Velrim's confidence stack_, not from any arm's underlying model. Paired deltas rest on an
   approximate symmetric-exposure argument (every arm's underlying frontier model had the same
   public files available), and the fabrication direction is the one place symmetry can break:
   a model that memorized the labels "knows" which fields are absent. Round 2 exists for
   exactly that reason.

Round 2 does not gate round 1.

---

## 5. Accuracy metrics

### 5.1 One scorer, amended in public first

All arms are scored by `@velrim/scoring`, the same published bytes Velrim's own published
reliability curves use. Two pre-run amendments were made over the published 0.0.2 baseline,
version-bumped to **0.1.0** with their rationale in the package changelog, before any benchmark
number existed. Both apply to Velrim identically.

**Amendment 1: absent-equivalence (FD-8).** For the per-field correctness label, a predicted
state of `null` or `missing` matches a golden state of `null` or `missing`. The prior rule
required exact state equality, so an honest explicit-`null` abstention against a golden
`missing` field was labeled incorrect, a mislabeling that fell differentially on systems whose
APIs always emit a key for every schema field, poisoning their reliability and
selective-prediction columns with points marked wrong for a formatting difference. A golden
`present` field still requires a predicted `present` state and a matching value. Scope,
verified: the P/R/F1 cells were already absent-equivalent; this change is confined to the
correctness label consumed by ECE, Brier, AUROC, and risk–coverage. Because this amendment
changes the semantics under Velrim's own published curves, those curves are re-stamped once
under scoring 0.1.0 before the Velrim arm runs; the run manifest cites only the version serving
on the run date, never a pre-amendment stamp.

**Amendment 2: value normalization (FD-10).** Golden values carry source formatting
conventions ("`$1,880.00`", "02/07/20") that grew up beside Velrim's own pipeline; strict-only
byte matching would likely flatter Velrim. The scorer therefore accepts pre-registered
per-class normalization tables and **both columns publish for every arm: normalized (primary)
and strict.** If normalization shrinks Velrim's margin, that number is the one that ships. The
normalization rules, as shipped in scoring 0.1.0 (all pure and deterministic, applied to
**both** sides of a comparison):

- `currency` → canonical minimal decimal string: strips currency symbols (Unicode Sc) and
  whitespace; **commas are accepted only as strict US thousands grouping** (`1,234,567.89`):
  an EU decimal-comma string is never silently mangled, it falls back; parentheses **or** a
  leading `-` mean negative; number inputs accepted; `-0` renders as `"0"`. `"$1,880.00"` →
  `"1880"`; `"(1,880.00)"` → `"-1880"`.
- `date` → ISO-8601 `YYYY-MM-DD`. Accepted forms: `YYYY-MM-DD`; `MM/DD/YYYY` and `M/D/YY(YY)`;
  `Mon DD, YYYY` / `Month DD, YYYY` (optional period after the abbreviation; `Sept` accepted).
  **Pre-registered US-order rule: slash dates are read MM/DD**. The corpora are US documents
  (FCC filings, FARA forms). **Two-digit years: below 50 → 20xx, otherwise 19xx.**
  Calendar-validated including leap years.
- `text` → trim, collapse internal whitespace runs to one space, Unicode-aware lowercase.
- **Any parse failure falls back to `text` folding of the original value**: deterministic,
  never an error, never a silently different number.
- Booleans and `null` pass through unchanged; arrays and objects normalize recursively with the
  same kind.

Because the same function is applied to both sides, normalization can only ever add matches on
a listed leaf relative to strict scoring: identical byte strings remain equal under it. (One
known corpus quirk, disclosed: some cord-v2 receipts use a dot as a thousands grouping mark,
which the currency rule reads as a decimal point; since both sides normalize identically, this
cannot break a strict match. It only fails to add one.)

### 5.2 The normalization tables (frozen with this plan)

The per-field pointer→kind tables are **not** part of the scoring package. They are frozen
here, as four machine-readable files in this repository, whose hashes finalize with the frozen
plan `[FINALIZED AT FREEZE — hashes]`:

- `corpora/normalizers.cord-v2.json`
- `corpora/normalizers.deepform.json`
- `corpora/normalizers.vrdu-ad-buy.json`
- `corpora/normalizers.vrdu-registration.json`

Each file is `{ "docClass": …, "normalizers": { "<json-pointer>": "currency" | "date" |
"text" } }`. **Table semantics:** a listed pointer's kind normalizes **both** sides of that
leaf's value match; an unlisted leaf matches **strictly**. **Pointer-matching rule
(mechanical):** golden documents key leaves by concrete JSON Pointers with numeric array
indices (e.g. `/line_items/0/sub_amount`); a golden leaf is looked up in the table after
replacing every purely-numeric reference token with `*` (so `/line_items/0/sub_amount` and
`/line_items/17/sub_amount` both resolve to the table key `/line_items/*/sub_amount`); pointers
without numeric tokens match their table key literally. No other pattern syntax exists.

Assignment rationale, pre-registered: `currency` on monetary amounts, `date` on date fields,
`text` on free-text names, titles, addresses, and program descriptions where formatting noise
(case, whitespace, line breaks) is plausible transcription variance rather than content.
**Deliberately left strict (unlisted):** identifier-like fields where any variation is
substantive, not formatting: `deepform /contract_number`, `vrdu-ad-buy /contract_num`,
`vrdu-registration /registration_num`, and the broadcast-station code fields `vrdu-ad-buy
/property` and `/line_items/*/channel`.

### 5.3 Accuracy metric definitions

- **Primary:** per-field micro-averaged precision / recall / F1 **per class** (pooled TP/FP/FN
  over the class's golden leaves; the per-field confusion rules are in the published scorer). A
  field is positive iff its predicted state is `present`; a correct `present` requires a value
  match (normalized column primary, strict adjacent).
- **One summary number:** the **macro-average over the four classes, equal weights,
  pre-committed now** (FD-11). The reason is printed with it: `vrdu-ad-buy` is ~68% of pooled
  fields, so a pooled micro-average would mostly measure one class.
- **Nested-leaf fairness:** every non-Velrim adapter recursively flattens vendor output to
  RFC-6901 leaves through objects and arrays (shared helper, tested). Without this,
  competitors would score `missing` on every nested golden leaf (1,404 of the ad-buy labels in
  the cap-confirmed branch alone) and the comparison would be structurally rigged **for**
  Velrim.

### 5.4 Prompt parity (model-prompt arms A2/A3/A5)

One shared minimal instruction, **byte-identical across arms and modes**, schema appended,
built by one shared builder so the bytes cannot fork. The exact string:

```
Extract the following fields from the document. Return JSON matching this schema. Use null for fields not present in the document.
```

The abstention license ("Use null for fields not present in the document.") is non-negotiable:
without it, the fabrication section (§7) would measure the prompt, not the model. Constrained
modes differ from their free-decode siblings **only** in decoding configuration. Temperature:
`0` for every model-prompt arm (one rule, disclosed); smoke decides parameter survival per §12.
Hosted extraction APIs (A1, A4) take a schema, not a prompt; they receive the same frozen
schema bytes.

### 5.5 Vendor self-run rule (pre-registered)

Publishing goldens plus a pinned CLI hands any declining vendor a counter-kit ("we ran their
harness under our best configuration and beat them"). Therefore: vendor-produced numbers enter
the published table **only** when produced under the frozen schemas, frozen goldens, N=3, and
the pinned CLI commit, verified by our re-run, in a column labeled **"vendor self-run (their
account, their config)."** A tuned-configuration self-run is not a right-of-reply correction;
it is a different benchmark, and we will link it as one. The pre-staged reply:

> _"Run it under the frozen config and open a PR — we re-run, re-publish, and label it yours;
> here is the exact command."_

The standing right of reply for how an arm is called is in `RIGHT-OF-REPLY.md`: any vendor may
open a PR correcting their arm's request construction; we re-run and re-publish with a
changelog entry.

---

## 6. Confidence and reliability

### 6.1 Columns per arm, loudly labeled

- **(i) Velrim fitted column: THE Velrim confidence column, the product measurement.** The
  shipped dual-pass + selection + fitted confidence stack (**Velrim's default served path**):
  this is what a customer's request is served by, so this is the column the product is
  measured on. The serving source is read from the response's own version stamp (the wire
  field `meta.calibrator_version`) and printed in the column label. Fit provenance, stated as
  provenance: the served confidence stack was fit on the other half (CAL-FIT) of these same
  four classes, which is why scoring is CAL-TEST-only (§4.2), why the split manifests were
  frozen before this benchmark was designed, and why the salt reveal at publication lets any
  reader verify the membership after the fact.
- **(ii) Symmetric open refit column: deferred to phase 2 (FD-5), stated plainly.** Fitting
  the open Platt refit (the CLI's `calibrate` command) on every arm's scores is pre-announced
  as a phase-2 register slot (§15), not run in round 1. The open `calibrate` command exists
  today: any reader can run the identical refit on any arm's published scores, same split, same
  public code.

**No-consent consequence, restated from §3:** no non-Velrim numeric per-field confidence
exists in this lineup. The OpenAI arm surfaces raw token logprobs but no shipped
field-confidence; deriving a score from them is a pre-announced phase-2 column (deriving one
for OpenAI while refusing to construct one for Mistral would be an unstated asymmetry, and a
raw logprob aggregate without a refit is a construction made to be measured badly). The
Mistral arm surfaces word-level OCR confidence but nothing at the schema-field level;
constructing a field confidence from word confidences would inject our own aggregation into
their arm. We refuse and say why.

### 6.2 The Velrim served-version proof

The Velrim arm runs live through the **same public endpoint every customer uses, with the
default public request**: no internal builds, no special flags, no request parameter. The
stack a response was actually served by is **proven by its served version stamp** (the wire
field `meta.calibrator_version`): every response must stamp a minted version matching
`cal-YYYY.MM-n` `[FINALIZED AT FREEZE — the run-date stamp value]`: proof the run was served
by the shipped fitted stack, Velrim's default served path. The stamp is read from **every**
response; a response whose served stamp does not match (including `identity-0`, which means
the fitted stack was off) **aborts the run** (checkpoint preserved). A mislabeled column is
a protocol error, never a red cell. The column label reads from the served stamp, never from
a hardcoded value.

**Symmetric restart disclosure:** any Velrim mid-run abort/fix/restart is disclosed with both
windows' data in the repository, the same rule competitor re-runs get (§11 K4).

### 6.3 Estimators and statistics

- **ECE** at the pinned **15 equal-mass bins**, with a **10-bin sensitivity row**;
  doc-clustered bootstrap CIs on all ECE/Brier deltas.
- **Debiased-ECE sensitivity row** (Kumar, Liang & Ma, _Verified Uncertainty Calibration_,
  NeurIPS 2019).
- **Brier score co-primary** (unbiased at the point level; far better behaved at these n).
- **Reliability diagrams with consistency bands** (Bröcker & Smith 2007): bands resampled from
  the perfectly-reliable null at each arm's own confidence distribution and n, so a reader sees
  what "indistinguishable from reliable" looks like at n=196.
- Pooled curves headline; per-class in the appendix with the CI caveat printed in the figure.
- **The noise-floor table prints in methods**, and its reader-facing sentence is fixed here,
  verbatim: _"an arm whose confidence scores were perfectly reliable would still measure mean
  plug-in ECE 0.084 [0.058–0.114] at n=196 — per-class ECE differences of that order sit at or
  below the estimator's noise floor for 3 of 4 classes."_ Supporting simulation (perfectly
  reliable synthetic arm, Beta(5,1.5) confidence distribution, the shipped 15-equal-mass-bin
  plug-in estimator): n=196 → 0.084 [0.058–0.114]; n=288 → 0.070 [0.048–0.094]; n=1,423 →
  0.031 [0.022–0.042]; n=2,102 pooled → 0.026 [0.017–0.034].

### 6.4 The operational read: risk–coverage (headline of the confidence section)

Pre-registered coverage grid, per arm, doc-clustered bootstrap CIs:

- **Error at coverage ∈ {0.7, 0.8, 0.9, 1.0}**
- **Coverage at field-error ≤ {2%, 5%}**

This is the buyer-meaningful question ("how much can I auto-accept at a given error budget"),
it rewards rank-informative-but-unscaled scores fairly, and it requires believing nobody's
absolute probabilities. No correctness-prediction claims anywhere; no threshold guidance
anywhere.

### 6.5 No-confidence cell vocabulary (pre-registered)

ECE/AUROC are **never** computed from the neutral 0.5 imputation: a score you cannot get is
not a score of 0.5. Risk–coverage for such an arm renders as a **single dot at coverage = 1**,
labeled "no selective operation possible." Cell wording is split by what it is a fact about:

- **Product arms (A4):** _"none surfaced"_, a fact about the product.
- **Bare-model arms (A2/A3):** _"not requested"_. A bare model emits a self-score only if
  prompted, and adding a confidence ask would break byte-identical prompt parity (the
  pre-registered reason).
- **OpenAI (A5):** _"raw logprobs surfaced; no shipped field-confidence — a derived score is a
  pre-announced phase-2 column."_

---

## 7. Fabrication on absent fields

### 7.1 Primary probe: natural golden-absent cells

The natural golden-`missing` cells in the primary corpus: 142 in the cap-removed branch, 141
in the cap-confirmed branch (cord-v2 66, vrdu-ad-buy 26/25, vrdu-registration 49, deepform 1);
contamination-free, class schema untouched.

**Label-provenance disclaimer (printed with the fabrication table):** these cells rest on
third-party labels on noisy real-world corpora (cord-v2 is scans); their noise rate is
unmeasured, and prior in-house scoring found cases where a raw scoring failure was a label
artifact. They were **not** visually re-audited for this run. Instead, the **symmetric
correction rule** is pre-registered: any golden label shown to be wrong post-publication is
reclassified or excluded **for all arms symmetrically**, with the count disclosed in a
changelog entry (see `RIGHT-OF-REPLY.md`).

### 7.2 Scoring rule (tool-independent, symmetric, pre-registered verbatim)

> A golden-absent field answered with a **substantive value** counts as **one fabrication**.

**Frozen abstention-equivalence set.** The following count as abstention, never fabrication:
explicit `null`; an omitted key; `""`; whitespace-only strings; and a short frozen
case-insensitive string list (`n/a`, `not present`, `not applicable`, `none`, `unknown`),
subject to a **per-field vocabulary exclusion**: any listed token that appears in that field's
golden value vocabulary counts as substantive for that field, never as abstention. The
headline counts substantive values only: this is what keeps the sentence "returns a confident
value" literally true of every counted cell against the published `predictions.jsonl` (an
empty string is not a confident value). A **strict-rule sensitivity row** (any non-null
answer = fabrication) prints adjacent: same data, both rules, pick your read.

The judge is a function of (golden state, output value) alone. No Velrim technology
participates: no anchoring, no production parser, no confidence. Every cell re-derives from
the published `predictions.jsonl` plus the goldens.

### 7.3 Estimator pin

- **Headline fabrication rate = per-cell mean over the N repeats, pooled** (never
  any-of-N), so "X% of the time" stays literally true per call. The kicker's "mean confidence
  on own fabrications" uses the same per-cell repeat-mean.
- **The pooled CI is doc-clustered.** 66 of ~141 absent cells sit in 15 cord-v2 documents, so
  the clustered interval is **wider** than a naive ±8pp binomial sketch. We print that
  expectation here so the wider interval is not discovered at read time, and CI-separation
  criteria (§11 K3) are correspondingly harder to meet than a binomial reading would suggest.

### 7.4 Denominator rule and dual accounting

The primary fabrication denominator counts golden-absent cells **only on contract-usable
responses**: a wholly-failed document contributes nothing, so an arm's fabrication rate is
never deflated by its own outage rate. A **dual-accounting row** (all attempted documents,
failures scored as abstentions) prints directly adjacent, next to the availability column, so
the interaction is shown rather than discovered.

### 7.5 Abstention cost, shown by adjacency

**Gold-present recall (equivalently, the false-omission rate) prints as a column in the
fabrication table itself, per arm.** Any arm that abstains more fabricates less by
construction, and Velrim's pipeline is designed to withhold unverifiable values, so Velrim's
own miss rate sits beside its fabrication rate in the same visual unit, for every arm
symmetrically. If an arm buys its low fabrication with a high miss rate, ours included, the
same table shows it.

### 7.6 Aggregation rationale and per-class floor

The fabrication headline is **pooled** (unlike accuracy's macro) because per-class absent-cell
counts (66 / 26 / 49 / ≤1) are too small and too uneven for macro CIs on a rate; per-class
fabrication rows with n print directly beside the pooled number, with CIs and no winner
language. **Per-class floor, pre-registered: a per-class fabrication rate prints only where
natural absent-n ≥ 20.** cord-v2, vrdu-ad-buy, and vrdu-registration qualify; deepform
(n ≤ 1) prints "n≤1; see probe table," never a rate.

### 7.7 Probe augmentation (fenced; primarily for deepform)

Three probe fields per class, **selected mechanically with zero discretion**: probes must be
class-level inapplicable (fields from real sibling-class schemas that cannot occur in the
target class); the candidate pool is the enumerated sibling-schema field set, sampled with the
**published seed 20260712**; provenance published per field. The frozen selection, pools, and
seed are in `corpora/probes/probes.json`; the per-class probe schema variants and all-`missing`
probe goldens are in `corpora/probes/`; a committed drift test pins the artifacts to
regeneration from the seed, so the list cannot quietly change.

Absence is verified tool-independently **and** visually: text-layer search alone is unreliable
on scan classes, so a **visual manual pass per probe×document is required and published**
(`corpora/probes/WORKSHEET.md` is the worksheet; the text-layer column is machine-filled, the
visual column is authoritative). Any probe whose value is visibly present in any document
image is **struck before the pre-registration hash** `[FINALIZED AT FREEZE — worksheet
completed; struck probes recorded]`.

Probes live in a **separate schema variant and a separate results table**: headline accuracy
is computed on the untouched class schema only, so no arm's F1 is affected by probes. One
extra 1-repeat pass per arm.

### 7.8 Kicker

For confidence-surfacing arms: mean confidence on their own fabrications, plus risk–coverage
restricted to golden-absent cells ("does the score know when it's inventing"). Applies to
Velrim identically; Velrim's own high-confidence fabrications will be visible. This natively
re-measures the published claim that frontier models fabricate on roughly 40–50% of absent
fields (arXiv 2603.08274, cited as corroboration only; primary-source re-verify before
publication).

---

## 8. Cost column

Per arm: list price per 1,000 pages for the configuration as run (vendor pricing-page URL +
access date), and **actual measured spend** (provider request and job IDs retained and
published; Velrim self-billed at list through the real customer wallet).

**No latency column**: async-poll arms are not comparable to sync arms; that exclusion and
reason are stated in one sentence wherever cost renders.

**Pre-registered render rule (D17): cost never renders in the same visual unit as accuracy
alone.** The one combined headline table is **F1 + fabrication rate + error@coverage-0.9 +
`$/1k pages`** per arm; no published figure, table, or README render pairs cost with accuracy
without the differentiating columns. The article body leads with what the delta buys
(fabrication catch on absent fields, confidence measured against published reliability curves,
span receipts, the open CLI), itemized inline, then prints the multiple before anyone derives
it: Velrim at `$20/1k` pages against `~$2–3/1k` for Gemini 2.5 Flash run bare (A2), roughly
7–10x.

Reference list prices as of 2026-07-06 (re-verified at smoke): Velrim `$0.02/page`; Gemini
2.5 Flash paid `$0.30/M` input, `$2.50/M` output; Mistral Document AI `$5/1k` pages; OpenAI
gpt-5.4-mini `$0.75/M` input, `$4.50/M` output.

**Reproduction cost, a feature of the design:** at these list prices, the entire primary run
reruns for roughly `$50–$90` (Velrim arm `$19`; Gemini both modes `$4–$6`; Mistral `$4–$6`;
OpenAI both modes `$15–$30`; the probe pass `$10–$25`). Every paid command prints its expected
spend and requires an explicit `--confirm-spend` before any transport sends, so the printed
figure is both an honesty artifact and the reader's rerun-it-in-an-evening device. A benchmark
this cheap to reproduce is a benchmark nobody has to take on faith.

---

## 9. Run protocol

### 9.1 Repeats

**N = 3 repeats per document per arm-mode, uniformly, no exemptions.** Per-document statistic = mean over its repeats; **no majority voting or
best-of-N anywhere** (that would silently build a new ensemble product for every arm).
**Output-instability rate** (% of doc-repeats whose field set or values differ) is reported
per arm, pre-registered as a question, not a claim; it exposes Velrim too if production is
flaky.

### 9.2 Failure taxonomy (identical policy, all arms)

- **Transport failures** (HTTP 5xx, timeout, rate limit, connection reset): up to **2
  automated retries** with backoff (500ms, 1s). Retrying is what any customer does.
- **Contract failures** (2xx but unusable/malformed/empty; job ends FAILED; poll cap
  exhausted): **no retry**. This is the product behaving badly. Scored as returned; a wholly
  unusable response scores as an empty prediction (FN on all gold-present fields) and is
  **excluded from the primary fabrication denominator** (§7.4).
- Whole-document failure after retries: scored empty **and** counted in a per-arm
  **availability column** (documents completed / attempted). Never silently drop a document
  from one arm; a for-cause drop drops from all arms and is disclosed.
- One wall-clock cap for every arm: **5 minutes per document**.

### 9.3 Runner safety

- **Checkpoint and resume:** predictions write incrementally; one throw cannot discard a paid
  batch; a resumed run re-verifies the input and implementation fingerprint.
- **Spend preflight:** every paid command prints its expected spend (with the pricing basis
  and its as-of date) and requires an explicit `--confirm-spend` before any transport can
  send (the same printed spend §8 counts as the reproduction-cost figure).
- **Circuit breaker:** N consecutive whole-document contract failures on one arm (default =
  the repeat count, 3) **pauses that arm** for a manual check, checkpoint-safe; pausing an arm
  is protocol, not discretion. Mid-run health is a sidecar sweep, never only a run-end summary
  line.

### 9.4 Version pinning and the run manifest (published)

The run manifest records: the CLI commit SHA; adapter file hashes; per-class JSON Schema
hashes; per-class golden hashes; the shared instruction string; `@velrim/scoring` 0.1.0; model
pins: `gemini-2.5-flash` (deprecation horizon ≥2026-10-16 noted; the pre-written answer to
"why not a newer Flash": 2.5-flash is what Velrim serves), `mistral-ocr-4-0`,
`gpt-5.4-mini-2026-03-17`; Velrim's served version stamp as returned on the run
date; vendor version strings as returned ("no version surfaced" is itself reported); and the
run window dates `[FINALIZED AT FREEZE — window recorded at run time]`. Declared re-run
policy: a major competitor version bump or a vendor PR triggers a re-run, budget-capped
honestly ("re-runs cost `~$X`; we re-run on request via PR").

---

## 10. Statistics

- **Paired at the document level.** Every arm sees identical (document, schema) pairs; fields
  cluster within documents, so the resampling unit is the **document**, never the field.
- **Cluster bootstrap: 10,000 resamples, BCa 95% CIs**, stratified by class for macro numbers;
  per-document contribution = mean over the N repeats; repeat noise reported separately.
- **One primary metric per section:** accuracy = per-class micro-F1 delta vs Velrim;
  fabrication = pooled fabrication-rate delta; confidence-utility = error@coverage-0.9 delta.
- **Holm–Bonferroni within each primary family** over the arm-vs-Velrim contrasts; nothing
  between families (they are separate pre-registered questions, stated as such). Everything
  else is **descriptive**: CIs shown, no stars, no winner language. No post-hoc subgroup
  claims; anything discovered gets "exploratory, n=…" and a round-2 promise.
- **Kill-criteria CI convention, pinned per criterion** (no post-hoc freedom in the kill
  rules): K1/K1b read the Holm-adjusted accuracy-family interval; K3 reads the fabrication
  family's Holm-adjusted arm-vs-Velrim interval; K2's threshold and its competitor contrast
  read the raw doc-clustered BCa interval.
- **Ties are reported as ties.** Arms closer than the per-class MDE report as "not
  distinguishable on this corpus", including gaps in Velrim's favor; no winner language where
  the 95% CI on the delta includes 0; "not distinguishable" is a publishable headline.
  Prior-art anchor: Card, Henderson, Khandelwal, Jia, Mahowald & Jurafsky, _With Little Power
  Comes Great Responsibility_, EMNLP 2020.

**Minimum detectable effects (current simulation; the simulation is re-run at the frozen
primary counts, 124 or 120 documents per the §4.3 branch, before plan-freeze, and the
re-simulated numbers are what the frozen plan and the article print `[FINALIZED AT FREEZE —
re-simulated MDE table]`).** Assumptions: paired doc-level comparison, 80% power, α=.05
two-sided, latent shared-difficulty fraction 0.60, document random effect τ=0.7 (probit
scale):

| class             | docs × fields/doc | MDE @ base acc ≈ .75 | MDE @ base acc ≈ .90 |
| ----------------- | ----------------- | -------------------- | -------------------- |
| cord-v2           | 15 × 13           | ~10 pp               | ~7 pp                |
| deepform          | 39 × 5            | ~10 pp               | ~6.5 pp              |
| vrdu-ad-buy       | 22 × 65           | ~4 pp                | ~3 pp                |
| vrdu-registration | 48 × 6            | ~8 pp                | ~5.5 pp              |
| pooled (124 docs) | —                 | ~4–5 pp              | —                    |

Implication, pre-committed: per class, this evaluation cannot distinguish arms closer than
~4–10 pp. The expected accuracy outcome between Velrim and the bare model it runs on (A2) is a
statistical tie, and that tie is signed as publishable here, before any money is spent. A
design that needs Velrim to win the F1 column is a failed design; this one does not.

---

## 11. Kill criteria (pre-registered decision rules)

Paid runs are discoverable in vendor logs; an unpublished benchmark after paid runs is
strictly worse than none. **The run data always publishes once runs complete.** These criteria
govern timing, framing, and amplification only.

**Pre-run gates (stop cleanly, zero publication debt):**

| #    | trigger                                                                                 | decision                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K0-a | Any committed arm's terms change to a benchmark/competitive prohibition pre-run         | Arm drops, disclosed. The two consent-gated vendors never run without written consent; no exceptions, including smokes                                                     |
| K0-b | Velrim production unhealthy at the run window                                           | The Velrim arm does not run against an unhealthy production, or before its curves are re-stamped under scoring 0.1.0; synthetic-probe monitoring must be green at run time |
| K0-c | Smoke structural failure (a vendor rejects the frozen request shape or a required mode) | Arm-mode drops or trims **per the pre-written framings in §12**: no column quietly disappears; framing pre-built per trim                                                  |

**Post-run gates (data always publishes; these choose lead, timing, amplification):**

| #   | trigger (measured)                                                                                                                                                                                                                       | decision                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | Velrim macro-F1 (normalized-primary) below raw Gemini free-decode (A2), 95% CI excluding 0                                                                                                                                               | Hold amplification ≤14 days for root cause. (a) Bug → fix, re-run affected arm(s), publish BOTH runs with the diff explained. (b) Real cost → publish as-is, the loss led honestly. Data never suppressed                                                                                                                                                                                                                               |
| K1b | Any hosted competitor product arm beats Velrim on macro-F1 (normalized-primary) OR on ≥3 of 4 classes, 95% CI excluding 0                                                                                                                | Same ≤14-day root-cause hold and fork as K1; if real, published as-is with the pre-committed sentence: _"[vendor] out-extracts us on [classes] at [price]; here is that table, and here is what we measured that they don't surface"_, and the headline carries it (§13). Never spun, never buried. Extends to round-2 results                                                                                                          |
| K2  | Velrim pooled **fitted-column** ECE > **0.12** (clearly above both the published-curve regime and the pooled noise floor 0.026 [0.017–0.034]) OR any competitor's SHIPPED numeric confidence beats the fitted column with CI excluding 0 | Confidence-meaningfulness lead demoted; fabrication leads; investigation before the article links the published curves. Extends to round-2 results (a consented arm joining round 2 is gated by this same rule)                                                                                                                                                                                                                         |
| K3  | Velrim pooled fabrication rate NOT lower than every no-verification arm's, with CI separation (delta CI includes 0 or favors them)                                                                                                       | **Demote-and-proceed:** the lead flips to the pre-registered vendor-neutral fallback: _"N% fabrication across every extraction API we could legally test — including ours; here is the open CLI."_ Publication proceeds on schedule. Never a fix-until-we-win loop                                                                                                                                                                      |
| K4  | Velrim availability < **95%** or synthetic-probe monitoring red during the run window; any competitor arm < **90%** availability                                                                                                         | Velrim: abort mid-flight (checkpointing preserves paid work), fix production, restart the Velrim arm; never publish a known-broken-production window; **any Velrim abort/fix/restart is disclosed with BOTH windows' data in the repo, the same rule competitor re-runs get.** Competitor: status-page check + one manual reproduction before that column publishes; never publish an outage as a product property; disclose any re-run |
| K5  | Lineup floor: fewer than {A2 + one hosted competitor product arm} runnable                                                                                                                                                               | Delay publication until met. **Headline rule rides here:** no "multi-vendor comparison of extraction products" phrasing unless ≥2 hosted competitor product arms are in the table                                                                                                                                                                                                                                                       |
| K6  | **Net-negative rule:** Velrim loses with CI excluding 0 on ALL THREE of {macro-F1 vs A2; pooled fabrication vs every competitor; error@coverage-0.9 vs every numeric-confidence competitor}                                              | The product story is falsified by our own referee. Data still publishes to the repository (the §1 commitment); promotion of the result is cancelled. The one outcome where amplifying is net-negative, and this pre-registration says so in advance                                                                                                                                                                                     |

One standing rule sits above every trim decision: **repeats are never trimmed, and no trim is
ever silent**: any change of scope lands in §12's pre-written framings or not at all.

---

## 12. Smoke-trim decision rules (pre-written, per K0-c)

The pre-freeze smoke (2 documents/class × 1 repeat, exact frozen adapter bodies) resolves the
items below. For each, the trim action **and the exact framing sentence** the publication uses
are fixed now, so no column can quietly disappear. `[FINALIZED AT FREEZE — outcomes recorded
per item]`

1. **gpt-5.4-mini rejects `logprobs`.** Trim: the parameter is removed from the frozen request
   body; the trim is recorded in run-meta. Framing sentence: _"gpt-5.4-mini declined the
   `logprobs` parameter at smoke; the parameter was removed and the trim is recorded in the
   run manifest — no confidence column is derived for this arm in round 1 either way (§6.1)."_
2. **gpt-5.4-mini rejects `temperature`.** Trim: the parameter is omitted (vendor-default
   decoding); recorded in run-meta. Framing sentence: _"gpt-5.4-mini declined `temperature: 0`
   at smoke; this arm runs vendor-default decoding, disclosed here — the one arm where the
   shared temperature rule could not be applied."_
3. **gemini-2.5-flash rejects `responseJsonSchema`.** Trim: A3 (constrained Gemini) drops.
   Framing sentence: _"the constrained-decoding Gemini arm was dropped at smoke:
   gemini-2.5-flash declined `responseJsonSchema` under the frozen request shape; the
   constrained-vs-free comparison proceeds on the OpenAI family alone, and this table says
   so."_
4. **A constrained mode fails the null-abstention assertion.** The frozen schemas keep **every
   leaf nullable** (`"type": ["string", "null"]`), and the constrained-mode request carries
   the **same frozen schema bytes** (the only free-vs-constrained delta is decoding
   configuration), so the abstention affordance survives constrained decoding by construction.
   The smoke asserts it structurally: one known-absent-field document must return an explicit
   `null` in constrained mode. If a vendor's constrained decoder cannot produce that `null`,
   that constrained mode drops. Framing sentence: _"the [arm] constrained mode was dropped at
   smoke: its decoder could not emit a null abstention on a known-absent field, so its
   fabrication cells would have measured the schema, not the model."_
5. **Mistral annotation shape surprises.** Trim: the arm drops or trims to what the actual
   contract supports; the raw smoke responses publish. Framing sentence: _"the Mistral arm
   [was dropped / runs without X] because its annotation response at smoke did not match the
   documented contract; the raw smoke responses are in the repository."_
6. **Mistral bidirectional page-cap probe.** Not a trim, a branch selection (§4.3): rejection
   of an over-cap document selects the cap-confirmed branch; acceptance with usable output
   selects the cap-removed branch. Both branches, and the framing for each, are already
   written into §4.3.
7. **Velrim fitted-stamp capture fails.** Not a trim, a protocol stop: the Velrim arm does
   not run until the served stamp is a minted fitted version (§6.2). Framing sentence: _"the
   Velrim arm was held until the served version stamp was captured as a minted fitted
   version; a mismatch is a protocol failure and is disclosed, never scored."_

---

## 13. Headline framing: the pre-registered outcome→lead mapping

The publication's headline framing is chosen by rule, not by the results. The rules below
predate every run; the reader's check is the timestamp order of this plan's public commit
against the results commit, nothing grander. The mapping, pre-registered (the literal headline
wording is copy, chosen at publication under these rules and §14):

1. **Fabrication lead**: the pooled fabrication number leads, IF Velrim's delta vs the best
   no-verification arm has CI separation AND the vendor spread is ≥ 10pp.
2. **Vendor-neutral fallback lead** (if K3 fires: no separation): the pooled rate across
   every arm, ours included, with no per-vendor winner framing.
3. **Tie-plus-measurement lead** (otherwise): the expected accuracy tie with the bare model,
   plus the per-field data on what the pipeline adds.

**K1b branch:** if K1b fires and the root-cause fork lands on "real," the chosen headline must
carry the competitor's win in the clause; pre-committed suffix: _"— [vendor] beat us on
accuracy; the table is inside."_ No headline may hide a K1b loss.

**Wording rules:** no "multi-vendor comparison of extraction products" phrasing unless ≥2
hosted competitor product arms are in the table; counts in headlines match the final arm
count; no threshold guidance; no correctness-prediction claims.

---

## 14. Phrasing rules (binding on every reader-facing render)

1. **No winner language where the 95% CI on the delta includes 0.** "Not distinguishable on
   this corpus" is a headline, not a hedge, including for gaps in Velrim's favor.
2. **The adjective "calibrated" is banned from every reader-facing artifact of this program**:
   no fenced exceptions; its only permitted appearance is inside this rule and in verbatim
   citation titles and wire-field identifiers. The permitted framings are "confidence,
   measured" and "published reliability curves." The methods noise-floor sentence ships in the
   exact adjective-free wording fixed in §6.3.
3. **No motive attribution**: outcomes and clauses print as facts with dates; why a vendor
   declined, priced, or built something is never asserted.
4. Plain-text nominative vendor names only; no vendor logos; no implied endorsement or
   relationship; a trademark disclaimer prints in the publication ("all trademarks are the
   property of their respective owners; no affiliation or endorsement is implied").

---

## 15. Phase-2 register (pre-announced)

Nothing below was cut after seeing results. This list predates every run:

| slot                                               | trigger                                    | status                                                                                          |
| -------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Reducto arm                                        | written consent                            | adapter spec ready; built only on consent                                                       |
| LlamaExtract arm                                   | written consent                            | adapter built and wire-current; zero live calls without consent                                 |
| Never-seen holdout class (§4.4)                    | round 2; protocol frozen now               | selected by the pre-registered criteria, never named candidates                                 |
| Symmetric open Platt refit column (FD-5, deferred) | round 2                                    | the CLI `calibrate` command exists today; any reader can run the identical refit on any arm now |
| OpenAI logprob-derived confidence column           | round 2; derivation pre-registered with it | raw logprobs already surfaced by the adapter                                                    |
| Latency appendix                                   | round 2 (scope cut, stated)                | cheap re-run                                                                                    |
| N=5 repeats                                        | only if instability becomes a headline     | cheap re-run                                                                                    |

---

## 16. Prior art and references

- **ExtractBench** (arXiv 2602.12247, accessed 2026-07-06): nearest published protocol for
  PDF→JSON per-field evaluation; source of the published constrained-decoding degradation
  (86.9% → 70.0% on credit agreements) that A3/A5-structured independently re-test on a
  different corpus.
- Card, Henderson, Khandelwal, Jia, Mahowald & Jurafsky, _With Little Power Comes Great
  Responsibility_, EMNLP 2020: publishing MDEs beside results; underpowered comparisons are
  the norm, saying so is the fix.
- Kumar, Liang & Ma, _Verified Uncertainty Calibration_, NeurIPS 2019: the debiased-ECE
  sensitivity row.
- Bröcker & Smith, _Increasing the Reliability of Reliability Diagrams_, Weather and
  Forecasting 2007: consistency bands.
- arXiv 2603.08274: the ~40–50% fabrication-on-absent-fields figure this program natively
  re-measures. **Cited as corroboration only; primary-source re-verify before publication.**

---

_This draft becomes binding at its public commit. The frozen plan (with §12 trims applied,
the §4.3 branch selected, the re-simulated MDE table, and all artifact hashes) follows before
any paid primary call, and its run book carries the line, verbatim: **"No paid primary call
before this commit exists publicly."**_
