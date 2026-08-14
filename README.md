# velrim-eval

**velrim-eval is a thin CLI, not a platform.** Golden set in → per-field F1 + reliability curve out → CI exit code. Five adapters (Velrim, OpenAI, Gemini, LlamaExtract, Mistral). It is deliberately NOT a hosted service, leaderboard, dashboard, or eval history store. It runs in your CI and writes files to your repo — your golden sets and baselines are yours. Every number it prints is YOUR measured result on YOUR golden set; it bakes in no Velrim accuracy claim.

Maintained by [Velrim](https://velrim.com) — the document extraction API with measured per-field confidence. Docs: [velrim.com/docs](https://velrim.com/docs).

---

## What it does

Score a document-extraction adapter against a **3-state golden set** (`present` / `null` / `missing`) and turn the result into a CI gate:

```
golden.jsonl  ──run──▶  predictions.jsonl  ──score──▶  scores.json  ──ci──▶  exit 0 / 1
                (adapter, fixture or --live)   (@velrim/scoring math)   (your thresholds)
```

The scoring math (per-field P/R/F1, ECE, AUROC, Brier, risk-coverage) is the **same code** Velrim's own reliability curves run — it lives once, in the published [`@velrim/scoring`](https://www.npmjs.com/package/@velrim/scoring) package, and this CLI imports it by its published name. There is no second copy to drift.

## Commands

| command     | what it does                                                                                                                                                                    | exit                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `run`       | run an adapter over a golden set (fixture default) → per-repeat predictions + health/meta                                                                                       | 0 ok / non-0 on error              |
| `score`     | `predictions.jsonl` × `golden.jsonl` → `scores.json` (per-doc + corpus micro-average). **No model calls.**                                                                      | 0 / non-0 on malformed input       |
| `report`    | render per-field P/R/F1 + reliability/risk-coverage curves (+ ECE / AUROC / Brier); optional `--baseline` delta                                                                 | 0 / 2 on missing input             |
| `ci`        | gate `scores.json` against `--min-f1` / `--max-ece` (and an optional `--baseline` no-regression check)                                                                          | **0 pass / 1 fail / 2 usage\|IO**  |
| `calibrate` | fit a generic 1-D Platt curve on YOUR `(confidence, correct)` points from a `scores.json` → reliability curve + selective-prediction τ. Emits NO number on absent/empty points. | 0 / **3 on absent or empty input** |
| `curves`    | reliability-curve data (ECE / Brier / AUROC / risk-coverage + the full-vs-logprobFree ablation row) from a scored manifest, as JSON. Emits NO number on absent/empty points.    | 0 / **3 on absent or empty input** |

Run `velrim-eval <command> --help` for per-command flags.

## The CI gate

```sh
velrim-eval ci --scores report/scores.json --min-f1 0.92 --max-ece 0.05 --baseline prev/scores.json
```

The build goes **red** when corpus F1 drops below `--min-f1`, corpus ECE rises above `--max-ece`, or (with `--baseline`) either metric regresses beyond ε (default: F1 drop > 0.005 **or** ECE rise > 0.005). `0.92` and `0.05` are **your** knobs — velrim-eval bakes in no Velrim accuracy claim.

## Adapters & the `--live` path

The five adapters (`velrim`, `openai`, `gemini`, `llamaextract`, `mistral`) all score the **same** golden set, so their columns are directly comparable. By default every run uses the **fixture transport** (recorded responses under `test/recorded/`, ZERO network) — that proves the pipeline, not the models.

`run --live` makes **real, paid** API calls:

```sh
VELRIM_API_KEY=... velrim-eval run --live --golden golden.jsonl --adapter velrim \
  --docs docs/ --out report/velrim --repeat 3 \
  --cal-test-manifest invoice=../calibration/corpora/manifests/invoice.manifest.json \
  --expected-spend-usd 38 --pricing-basis "vendor pricing page" --pricing-as-of 2026-07-14 \
  --confirm-spend
```

- **Keys come from the environment only** — `VELRIM_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LLAMA_CLOUD_API_KEY`, `MISTRAL_API_KEY` per adapter. Never a flag, never a config file; the CLI never prints or persists a key. A missing key fails fast (exit 2) **before any network call**, and `--live` never silently falls back to fixtures.
- `--live` requires a `"schema"` file on every golden row (resolved relative to the golden.jsonl) and loads them **all before the first paid call** — a live extraction without your schema would measure nothing, and a malformed row must not abort a paid run halfway through.
- Every live invocation prints a spend preflight and requires `--expected-spend-usd`, `--pricing-basis`, `--pricing-as-of`, a frozen `--cal-test-manifest <class>=<path>` per class, and `--confirm-spend`; without confirmation it makes zero calls. The manifest's class and `calTestGoldenHash` are verified before transport construction (`--cal-test-golden-hash` is an optional explicit cross-check). The estimate and remaining-resume estimate are persisted in `run-meta.json`.
- `--repeat N` writes one independently scoreable `predictions.repeat-NNN.jsonl` per repeat. Every row carries availability (`completed`, `transport_failure`, or `contract_failure`); failures stay as empty predictions instead of disappearing.
- Progress is checkpointed after every doc-repeat. A matching interrupted run resumes without re-buying completed units. Three consecutive contract failures at `--repeat 3` pause the arm; after the required manual check, resume explicitly with `--resume-paused`.
- One atomic `run.lock.json` lease protects each output directory from concurrent double-spend. A same-host dead-owner lock is reclaimed only after inspection and explicit `--recover-stale-lock`; the old owner record is retained.
- Transient transport failures receive at most two retries, contract failures receive none, and one five-minute wall-clock cap covers each whole doc-repeat. `run-health.json` is refreshed after every outcome with per-repeat and aggregate availability.
- `run-manifest.json` records the commit/worktree state, individual executed-file hashes, exact schema/public-golden hashes, frozen source-golden hashes, shared instruction, actual installed scoring version, requested pins, allowlisted returned versions/request IDs, fixture corpus hash (fixture mode), and stable run-window timestamps. `publicationReady` stays false with an explicit `missingFields` list until every later protocol gate is present.
- What actually goes on the wire: **velrim** POSTs `{ schema, document: { bytes_base64 } }` to `/v1/extract`; **openai** attaches the PDF as a base64 `file` content part with the schema in the prompt (Chat Completions, `logprobs: true`; `--structured-mode` adds `response_format: json_schema` — constrained decoding); **gemini** POSTs the same schema-in-prompt text plus the PDF as inline base64 to AI Studio `generateContent` (key in the `x-goog-api-key` header; `--structured-mode` adds `generationConfig.responseJsonSchema`); **llamaextract** uploads the file, creates a stateless extract job with your schema inline (`data_schema`), and polls it to completion; **mistral** POSTs the PDF as a base64 data URL to `/v1/ocr` with the schema as `document_annotation_format` — the returned `document_annotation` JSON is what maps to fields.
- **Before publishing any numbers from this CLI, a paid live smoke per adapter is MANDATORY** (roughly $2–5 per adapter on a small golden set, with your keys in env). Fixture numbers exercise the plumbing with recorded responses — publishing them as a model comparison would be fabrication.

Per-adapter confidence semantics:

- **Velrim** carries native per-leaf confidence.
- **OpenAI** is a fair DIY baseline (free-decode + a small bundled JSON repair); confidence comes from token logprobs when present, else falls back to 0.5.
- **Gemini** is a bare-model control. Field confidence is not requested or derived; downstream scoring's documented fallback remains 0.5.
- **LlamaExtract** exposes no token logprobs (its optional `confidence_scores` feature is deliberately not requested, keeping this column logprob-free), so every leaf falls back to a 0.5 confidence — a degenerate-but-honest calibration column.

## The 3-state golden format

```jsonc
{
  "doc": "invoice-0042.pdf",
  "docClass": "invoice",
  "schema": "invoice.schema.json",
  "fields": {
    "/total": { "state": "present", "value": 1240.5 },
    "/tax": { "state": "null" },
    "/po_number": { "state": "missing" },
  },
}
```

`docClass` is required per row. A `present` field carries a `value`; `null` and `missing` carry none. An empty/whitespace string counts as `present` (the model emitted _something_ — coercing it to `null` would mask a fabrication).

## Bundled corpora, attributions & vendor policy

- [`corpora/`](./corpora/README.md) — four frozen, third-party, hand-labeled golden sets (CORD-v2, DeepForm 2020, VRDU ad-buy, VRDU registration) with per-class JSON Schemas and exact frozen counts. Or ignore them and point `--golden` at your own labeled docs — that is the point.
- [`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md) + [`NOTICE`](./NOTICE) — full dataset provenance, licenses, and retained license texts; trademark disclaimer.
- [`RIGHT-OF-REPLY.md`](./RIGHT-OF-REPLY.md) — the standing vendor policy: open a PR correcting how your arm is called and we re-run and re-publish; vendor self-run rules; the symmetric golden-label correction rule.
