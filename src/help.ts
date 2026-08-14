/**
 * Static per-verb --help strings for velrim-eval. Pure strings, no side effects;
 * the dispatcher prints these on `--help`/`-h` or bad usage. Keep them terse and honest — the
 * stub verbs (calibrate/curves) MUST say what they do NOT do.
 */

export const TOP_HELP = `velrim-eval — thin CLI to score document-extraction adapters on a 3-state golden set.

USAGE
  velrim-eval <command> [options]

COMMANDS
  run        Run an adapter over a golden set (fixture default; --live) -> predictions.jsonl + run-meta.json
  matrix     Orchestrate the full arm-mode x class x pass run matrix (composes run + score) -> cost-log.json
  score      Score predictions x golden -> scores.json + corpus aggregate (no model calls)
  report     Render per-field P/R/F1 + reliability/risk-coverage curves (+ ECE/AUROC/Brier)
  ci         Gate a report against thresholds (and an optional --baseline); exit 0/1/2
  calibrate  Fit a generic 1-D Platt logistic on (confidence, correct) -> reliability curve + tau
  curves     Reliability-diagram data + ECE/Brier/AUROC/risk-coverage + full-vs-logprobFree ablation

  -h, --help   Show this help. Per-command help: velrim-eval <command> --help

velrim-eval is a thin CLI, not a platform. It runs in your CI and writes files to your repo.
Every number it prints is YOUR measured result on YOUR golden set.
`;

export const RUN_HELP = `velrim-eval run — run an adapter over a golden set (fixture transport by default; --live for real calls).

USAGE
  velrim-eval run --golden <golden.jsonl> --adapter <id> --docs <dir> --out <dir> [options]

OPTIONS
  --golden <path>     golden.jsonl (drives the doc set + key space) [required]
  --adapter <id>      velrim | openai | llamaextract | mistral | gemini [required]
  --docs <dir>        directory of input doc bytes (keyed by golden's "doc" field) [required]
  --out <dir>         output dir for per-repeat predictions + health/meta [required]
  --repeat <N>        independent repeats per document (positive integer; default 1, bake-off 3)
  --live              make REAL (paid) API calls instead of reading recorded fixtures. The key is
                      read from the environment ONLY — VELRIM_API_KEY, OPENAI_API_KEY,
                      LLAMA_CLOUD_API_KEY, MISTRAL_API_KEY, or GEMINI_API_KEY
                      per --adapter; never a flag, never a file. A missing key
                      fails fast (exit 2) BEFORE any network call; --live never falls back to
                      fixtures. Requires a "schema" file on every golden row (resolved relative to
                      the golden.jsonl). Gemini auths via the x-goog-api-key header; every other
                      adapter uses Bearer.
  --expected-spend-usd <n>
                      expected USD for the full live run [required with --live]
  --pricing-basis <text>
                      rate/source behind the estimate [required with --live]
  --pricing-as-of <YYYY-MM-DD>
                      date the pricing source was checked [required with --live]
  --confirm-spend     acknowledge the printed preflight; without it live makes ZERO calls
  --resume-paused     after the required manual check, resume a circuit-paused checkpoint
  --recover-stale-lock
                      after inspection, reclaim a same-host run lock whose PID is confirmed dead
  --cal-test-manifest <class>=<path>
                      frozen source manifest to verify/hash (repeat per class; required live)
  --cal-test-golden-hash <class>=<sha256>
                      optional explicit hash cross-check against --cal-test-manifest
  --commit-sha <sha>  full velrim-eval commit id override when Git metadata is unavailable
  --allow-commit-drift
                      resume a fingerprint-matching checkpoint after an UNRELATED commit moved
                      HEAD; the manifest keeps the checkpoint's original run-start commit
  --structured-mode   re-run with constrained/structured decoding (openai: response_format
                      json_schema; gemini: generationConfig.responseJsonSchema)
  --trim-param <p>    drop a smoke-refused request param from the body (repeatable; openai:
                      logprobs | temperature; gemini: temperature). Recorded in run-meta and the
                      run manifest — the smoke observes the refusal, the maintainer reruns with the
                      trim, nothing is inferred from error bodies.
  --mistral-cap-branch <cap-confirmed|cap-removed>
                      the smoke-resolved page-cap branch (mistral only). cap-confirmed ARMS
                      the loud-fail over-cap guard: an over-cap doc reaching the adapter stops
                      the run as a protocol error, never a red cell.
  --gemini-vertex-project <gcp-project-id>
                      route the gemini arm to this project's Vertex generateContent endpoint
                      instead of AI Studio (gemini only). URL-only change — body, model pin,
                      and auth identical. The route is recorded in run-meta and the manifest;
                      the project id itself never appears in any output file.
  -h, --help          Show this help

Velrim served-stamp assertion (automatic, velrim + --live only): every live response's served
calibrator stamp must be a minted cal-YYYY.MM-n version — proof the run was served by the
shipped fitted stack, Velrim's default served path — or the run stops as a protocol error,
never a red cell ('identity-0' means the fitted stack was off: equally fatal). It never
changes the request. Fixture runs make no stamp assertion.

Writes independently scoreable <out>/predictions.repeat-001.jsonl (and so on), run-meta.json,
run-health.json, and the provenance-complete run-manifest.json. With one repeat only,
predictions.jsonl is a compatibility copy. Results and
failures are checkpointed after every doc-repeat; matching partial runs resume automatically.
Transport failures retry at most twice, contract failures do not retry, and every doc-repeat has a
five-minute wall-clock cap. Does NOT score. Without --live the fixture transport is used: recorded
responses, ZERO network.
`;

export const MATRIX_HELP = `velrim-eval matrix — run-matrix orchestrator: arm-modes x classes x repeats x {main, probe}.

USAGE
  velrim-eval matrix --config <matrix.json> --corpora <dir> --out <dir> [options]

OPTIONS
  --config <path>     matrix config JSON: { formatVersion: 1, capBranch, classes, repeats,
                      passes: ["main","probe"], armModes: [{ id, adapter, extraArgs?, spend? }],
                      calTestManifests? } [required]
  --corpora <dir>     committed corpora dir (golden.<class>.jsonl, normalizers.<class>.json,
                      probes/, corpus-counts.json) [required]
  --out <dir>         matrix output root; each cell writes to <out>/<armMode>/<class>/<pass> [required]
  --pdfs <dir>        docs root containing <class>/ dirs (default: <corpora>/pdfs)
  --live              real (paid) calls — every cell still runs its own spend preflight and
                      requires spend pricing per armMode in the config
  --confirm-spend / --resume-paused / --recover-stale-lock / --allow-commit-drift
                      passed through to every cell's run
  --cell <armMode>/<class>/<pass>
                      execute only the named cell(s) (repeatable) — targeted reruns
  --plan-only         print each cell's exact run argv and exit (no execution)
  -h, --help          Show this help

Cells run SEQUENTIALLY via the run command (checkpointed + resumable per cell); a failed or
circuit-paused cell is recorded and the matrix continues with the other arms. Each completed
cell is scored per repeat (score command, with the class's frozen normalizers table — the
FD-10 dual strict+normalized columns) into <cell>/score.repeat-NNN/ plus a per-class
<cell>/scores.json summary carrying both columns' means. Every class REQUIRES its
corpora/normalizers.<class>.json — validated up front, before any cell runs. Writes <out>/cost-log.json (spend preflights + request-id receipts)
and <out>/matrix-manifest.json (the authoritative matrix validation + publicationReady).
The cap branch is obeyed from the config: cap-confirmed derives capped goldens (frozen
exclusions from corpus-counts.json), runs Mistral on them with the armed over-cap guard, scores
PRIMARY against the capped golden for ALL arms, and adds the labeled full-set appendix scoring
for non-Mistral arms. Velrim is ONE arm-mode (the served product); live velrim cells assert a
minted fitted calibrator stamp on every response via the run command. Every CAL-FIT refit
pass is OUT — 'main' and 'probe' are the only pass kinds.
`;

export const SCORE_HELP = `velrim-eval score — score predictions against a golden set (NO model calls).

USAGE
  velrim-eval score --predictions <predictions.jsonl> --golden <golden.jsonl> --out <dir> [options]

OPTIONS
  --predictions <path>  predictions.jsonl from \`velrim-eval run\` [required]
  --golden <path>       golden.jsonl [required]
  --out <dir>           output dir for scores.json [required]
  --normalizers <path>  frozen per-class normalizers.<class>.json (FD-10). Adds the NORMALIZED
                        column (primary at publication) to scores.json next to the strict one;
                        the pre-existing fields stay the strict column, byte-identical. The
                        table docClass must match every golden row. Malformed/missing table or
                        class mismatch is a hard error — never a silent strict-only run.
  -h, --help            Show this help

Runs scoreAgainstGolden (from @velrim/scoring) per doc, then micro-averages across the corpus.
Writes <out>/scores.json. Never calls a model.
`;

export const REPORT_HELP = `velrim-eval report — render per-field P/R/F1 + reliability/risk-coverage curves.

USAGE
  velrim-eval report --scores <scores.json> [--baseline <prev/scores.json>] [--out <dir>]

OPTIONS
  --scores <path>     scores.json from \`velrim-eval score\` [required]
  --baseline <path>   a prior scores.json to diff against (optional delta column)
  --out <dir>         write reliability.svg + report.txt here (default: alongside --scores)
  -h, --help          Show this help

Prints a table (corpus P/R/F1, ECE, AUROC, Brier) and writes an SVG reliability/risk-coverage
plot. smoothECE is not computed.
`;

export const CI_HELP = `velrim-eval ci — gate a report against thresholds; the red build is the conversion event.

USAGE
  velrim-eval ci --scores <scores.json> --min-f1 <n> --max-ece <n> [--baseline <prev/scores.json>] [options]

OPTIONS
  --scores <path>     scores.json to gate [required]
  --min-f1 <n>        minimum corpus F1 (e.g. 0.92) [required]
  --max-ece <n>       maximum corpus ECE (e.g. 0.05) [required]
  --baseline <path>   prior scores.json; also fail on regression beyond epsilon
  --eps-f1 <n>        max tolerated corpus-F1 DROP vs baseline (default 0.005)
  --eps-ece <n>       max tolerated corpus-ECE RISE vs baseline (default 0.005)
  -h, --help          Show this help

Gate: pass = corpusF1 >= min-f1 AND corpusECE <= max-ece AND (with --baseline) no regression.
Exit: 0 pass / 1 gate fail / 2 usage|IO. Thresholds are YOUR knobs, not a Velrim claim.
`;

export const CALIBRATE_HELP = `velrim-eval calibrate — fit a GENERIC 1-D Platt logistic on YOUR scores.

USAGE
  velrim-eval calibrate --scores <scores.json> [--max-error <n>] [--allow-stub]

OPTIONS
  --scores <path>     scores.json (from \`velrim-eval score\`) — its (confidence, correct) column [required]
  --max-error <n>     selective-prediction risk budget for tau, in [0,1] (default 0.05)
  --allow-stub        exit 0 instead of 3 when there is nothing to fit (pipeline wiring only)
  -h, --help          Show this help

Fits p = sigma(a*confidence + b) (pure, deterministic ridge-IRLS — NOT Velrim's internal
feature-fit), prints the coefficients, reliability bins, ECE/Brier (raw vs calibrated), AUROC, and
a selective-prediction tau derived from @velrim/scoring's riskCoverage(). With absent/empty or
single-class input it emits NO number and exits 3 (no fabricated curve).
`;

export const CURVES_HELP = `velrim-eval curves — reliability-diagram data + the full-vs-logprobFree ablation.

USAGE
  velrim-eval curves --manifest <manifest.json> [--allow-stub]

OPTIONS
  --manifest <path>   a JSON pointing at scored variant scores.json files [required]:
                        { "label"?, "link"?, "variants": { "logprobFree": <path>, "full"?: <path> } }
                      variant paths resolve relative to the manifest's directory.
  --allow-stub        exit 0 instead of 3 when there is nothing to score (pipeline wiring only)
  -h, --help          Show this help

Re-derives ECE, Brier, AUROC, risk-coverage, and 15-equal-mass reliability bins for the logprobFree
floor (and the full arm when given), ALL via @velrim/scoring. The full-vs-logprobFree ablation row
is marked "degenerate / not-published" when the two arms coincide (a logprob-less corpus) — never a
duplicated number implying a logprob lift. The publish/page half is a separate deliverable. With
absent/empty input it emits NO curve and exits 3.
`;
