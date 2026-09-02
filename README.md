# velrim-eval

velrim-eval scores a document extraction API against your own labeled documents and turns the result into a CI exit code. This repo also holds our bake-off: six extraction setups, ours included, run over 124 real documents and scored with this tool under a plan we published before spending a dollar.

Maintained by [Velrim](https://velrim.com), a document extraction API that returns a confidence score per field.

## Documentation

The bake-off write-up is [BAKE-OFF.md](./BAKE-OFF.md), also published at [velrim.com/research/fabrication-on-absent-fields](https://velrim.com/research/fabrication-on-absent-fields). The Velrim API docs are at [velrim.com/docs](https://velrim.com/docs).

## Installation

Requires Node 20 or newer.

```sh
git clone https://github.com/velrimhq/velrim-eval
cd velrim-eval && npm install
```

`npm install` builds the CLI. On Windows, run `git config --global core.longpaths true` before cloning; some source documents have long file names.

## Usage

Rescore one of the published arms from its raw outputs. No API keys, no cost:

```sh
npx velrim-eval score --predictions results/matrix-out/mistral/cord-v2/main/predictions.repeat-001.jsonl \
  --golden corpora/golden.cord-v2.jsonl --normalizers corpora/normalizers.cord-v2.json --out rescored/mistral-cord-v2
```

Judge one of the published arms for fabrication on absent fields, with the audit strikes applied the way the write-up applies them:

```sh
npx velrim-eval fabrication --arm-dir results/matrix-out/mistral --corpora corpora \
  --strikes corpora/natural-strikes.json --out rescored/mistral-fabrication
```

Score your own extraction against your own documents:

```sh
npx velrim-eval run --golden golden.jsonl --adapter velrim --docs docs/ --out report/velrim
npx velrim-eval score --predictions report/velrim/predictions.repeat-001.jsonl --golden golden.jsonl --out report/velrim
npx velrim-eval ci --scores report/velrim/scores.json --min-f1 0.92 --max-ece 0.05
```

`run` uses recorded responses by default and makes no network calls. Live, paid runs are described below.

## The bake-off

How often does an extraction API invent a value for a field that isn't in the document? Pooled across six setups, 17% of the time. Ours does it too.

- [BAKE-OFF.md](./BAKE-OFF.md) is the write-up.
- [ANALYSIS-PLAN.md](./ANALYSIS-PLAN.md) is the plan, frozen and committed before the first paid call.
- [DISCLOSURES.md](./DISCLOSURES.md) lists every conflict and limitation we know of.
- [SALT.md](./SALT.md) lets you verify that the held-out split was fixed in June, before the comparison was designed.
- [RIGHT-OF-REPLY.md](./RIGHT-OF-REPLY.md) is the vendor policy. If we're calling your API wrong, open a PR against the adapter and we re-run and re-publish.
- The archived copy has a DOI, [10.5281/zenodo.22233430](https://doi.org/10.5281/zenodo.22233430). Citation details are in [CITATION.cff](./CITATION.cff).
- The per-field outputs, the probe set and the label audit are on Hugging Face as [velrim/fabrication-on-absent-fields](https://huggingface.co/datasets/velrim/fabrication-on-absent-fields), generated from `results/` by `npm run hf-dataset`.

### Run data

| Path                                             | What's there                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `results/matrix-out/<arm>/<class>/{main,probe}/` | every raw per-field output (`predictions.repeat-NNN.jsonl`, with request IDs), per-repeat `score.repeat-NNN/scores.json`, run manifests, health and cost logs |
| `results/matrix-out/matrix-manifest.json`        | the matrix-level manifest; its `validation.publicationReady: true` is the gate the published numbers passed                                              |
| `results/archive/`                               | the first start's manifest and cost log, plus a copy of the final manifest                                                                               |
| `results/manifests/`                             | the frozen split manifests                                                                                                                               |
| `corpora/pdfs/<class>/`                          | the source documents                                                                                                                                     |
| `figures/`                                       | the charts in the write-up                                                                                                                               |

The runner was started three times. The second start's manifest was overwritten before we archived it, so only the first and third are here. Files ending in `.prior-<epoch>` or `.stale-<epoch>` are event trails and checkpoints from earlier starts into the same output directory, and an empty `run-events.jsonl` means the run finished without circuit or resume events.

Before publication we replaced local paths in the run metadata with `<local-pdfs>/…` and `<run-manifests>/…`, and the Vertex project id with `<gcp-project>`. The split-manifest `path` entries inside each `run-manifest.json` are left as recorded because they feed the run fingerprints. Nothing else was edited.

## How it works

```
golden.jsonl  --run-->  predictions.jsonl  --score-->  scores.json  --ci-->  exit 0 / 1
```

velrim-eval runs in your CI, reads your golden set, writes files into your repo, and exits 0 or 1. There is no hosted service, leaderboard or history store, and it bakes in no claim about Velrim's accuracy. Every number it prints is your result on your documents.

The scoring math (per-field precision, recall and F1, ECE, AUROC, Brier, risk-coverage) is the published [`@velrim/scoring`](https://www.npmjs.com/package/@velrim/scoring) package. Velrim's own reliability curves run the same code, and this tool imports it by its published name, so there is no second copy to drift.

### Commands

| Command     | What it does                                                                                                                                           | Exit code                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `run`       | runs an adapter over a golden set and writes per-repeat predictions plus health and meta files                                                         | 0, non-zero on error           |
| `score`     | compares `predictions.jsonl` with `golden.jsonl` and writes `scores.json`, per document and corpus micro-average. Makes no model calls.                 | 0, non-zero on malformed input |
| `fabrication` | judges `predictions.jsonl` against `golden.jsonl` for fabrication on absent fields and writes `fabrication.json`: the pooled rate with its interval, the strict and all-attempted rules, the answered-when-present rate, per-class rows. Makes no model calls. The definition is at [velrim.com/research/fabrication-on-absent-fields-metric](https://velrim.com/research/fabrication-on-absent-fields-metric). | 0, 2 on malformed input        |
| `report`    | renders per-field P/R/F1, reliability and risk-coverage curves, ECE, AUROC and Brier. `--baseline` adds a delta.                                       | 0, 2 on missing input          |
| `ci`        | gates `scores.json` against `--min-f1` and `--max-ece`, with an optional `--baseline` no-regression check                                              | 0 pass, 1 fail, 2 usage or IO  |
| `calibrate` | fits a 1-D Platt curve on your `(confidence, correct)` points from a `scores.json` and writes the reliability curve and a selective-prediction threshold | 0, 3 on absent or empty input  |
| `curves`    | reliability-curve data (ECE, Brier, AUROC, risk-coverage, plus the full-vs-logprob-free ablation row) from a scored manifest, as JSON                   | 0, 3 on absent or empty input  |

`calibrate` and `curves` refuse to emit a number when the input has no points. `npx velrim-eval <command> --help` lists the flags.

### The CI gate

The build fails when corpus F1 drops below `--min-f1`, corpus ECE rises above `--max-ece`, or, with `--baseline prev/scores.json`, either metric regresses by more than 0.005 (the default). The thresholds are yours to set.

### Golden set format

Three states per field: `present`, `null` and `missing`.

```jsonc
{
  "doc": "invoice-0042.pdf",
  "docClass": "invoice",
  "schema": "invoice.schema.json",
  "fields": {
    "/total": { "state": "present", "value": 1240.5 },
    "/tax": { "state": "null" },
    "/po_number": { "state": "missing" }
  }
}
```

`docClass` is required. A `present` field carries a value, the other two don't. An empty or whitespace string counts as `present`, because the model did emit something and coercing it to `null` would hide a fabrication.

## Adapters and live runs

Five adapters: `velrim`, `openai`, `gemini`, `llamaextract`, `mistral`. They all score the same golden set, so their columns compare directly. By default a run uses recorded responses from `test/recorded/`, which proves the pipeline works, not how the models perform.

`run --live` makes real, paid API calls:

```sh
VELRIM_API_KEY=... npx velrim-eval run --live --golden golden.jsonl --adapter velrim \
  --docs docs/ --out report/velrim --repeat 3 \
  --cal-test-manifest cord-v2=results/manifests/cord-v2.manifest.json \
  --expected-spend-usd 38 --pricing-basis "vendor pricing page" --pricing-as-of 2026-07-14 \
  --confirm-spend
```

- Keys come from the environment only: `VELRIM_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LLAMA_CLOUD_API_KEY`, `MISTRAL_API_KEY`. Never a flag or a config file, and the tool never prints or stores one. A missing key fails with exit 2 before any network call, and `--live` never falls back to fixtures.
- Every golden row needs a `schema` file, resolved relative to the golden file. All schemas load before the first paid call, so a malformed row can't abort a paid run halfway through.
- Every live run prints a spend estimate first and needs `--expected-spend-usd`, `--pricing-basis`, `--pricing-as-of`, one frozen `--cal-test-manifest <class>=<path>` per class, and `--confirm-spend`. Without confirmation it makes zero calls. The manifest's class and `calTestGoldenHash` are checked before the transport is built.
- `--repeat N` writes one predictions file per repeat. Every row records whether the call `completed`, hit a `transport_failure` or a `contract_failure`. Failures stay in the file as empty predictions rather than disappearing.
- Progress is checkpointed after every document-repeat. An interrupted run resumes without paying again for finished units. Three consecutive contract failures at `--repeat 3` pause the arm until you resume it explicitly with `--resume-paused`.
- A `run.lock.json` lease protects each output directory from a concurrent double-spend. A dead lock from the same host is reclaimed only after inspection and an explicit `--recover-stale-lock`, and the old owner record is kept.
- Transient transport failures get at most two retries, contract failures get none, and each document-repeat has a five-minute wall-clock cap. `run-health.json` is refreshed after every outcome.
- `run-manifest.json` records the commit and worktree state, hashes of every executed file and of the schemas and golden sets, the shared instruction, the installed scoring version, requested pins, returned versions and request IDs, and the run window. Its `publicationReady` flag stays false with a `missingFields` list until every later gate is present. For the published matrix that gate lives at the matrix level, so the per-run flags are false by design.

What goes on the wire, per adapter. `velrim` posts the schema and the base64 document to `/v1/extract`. `openai` attaches the PDF as a base64 file part with the schema in the prompt, Chat Completions with `logprobs: true`, and `--structured-mode` adds a `json_schema` response format. `gemini` sends the same schema-in-prompt text plus the inline PDF to `generateContent`, through AI Studio by default or through Vertex with `--gemini-vertex-project <id>`, which is how the published bake-off ran; `--structured-mode` adds `responseJsonSchema`. `llamaextract` uploads the file, creates a stateless extract job with your schema inline, and polls it. `mistral` posts the PDF as a base64 data URL to `/v1/ocr` with the schema as `document_annotation_format`.

Confidence per adapter. Velrim returns its own per-field score. OpenAI's comes from token logprobs when present, otherwise 0.5. Gemini's is not requested or derived, so it falls back to 0.5. LlamaExtract exposes no token logprobs and its optional `confidence_scores` feature is deliberately not requested, so every field falls back to 0.5.

Before publishing numbers from this tool, run a paid live smoke per adapter, roughly $2 to $5 each on a small golden set. Fixture numbers exercise the plumbing with recorded responses. Publishing them as a model comparison would be fabrication.

## Corpora

[`corpora/`](./corpora/README.md) holds four frozen, third-party, hand-labeled golden sets: CORD-v2 receipts, DeepForm 2020 FCC invoices, VRDU ad-buy contracts and VRDU registration forms, each with a JSON Schema and frozen counts. Or point `--golden` at your own labeled documents. That is the point of the tool.

Dataset provenance, licenses and the retained license texts are in [`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md) and [`NOTICE`](./NOTICE), with the trademark disclaimer.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
