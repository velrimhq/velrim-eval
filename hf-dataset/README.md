---
license: apache-2.0
pretty_name: Fabrication on absent fields (round 1)
language:
  - en
tags:
  - document-extraction
  - hallucination
  - benchmark
  - information-extraction
size_categories:
  - 10K<n<100K
configs:
  - config_name: predictions
    default: true
    data_files: data/predictions.jsonl
  - config_name: probes
    data_files: data/probes.jsonl
  - config_name: absent-label-audit
    data_files: data/absent-label-audit.jsonl
---

# Fabrication on absent fields (round 1)

Per-field outputs of six document-extraction setups over 124 real documents, with the answer key and a mechanical verdict on every field the document does not contain: did the system return a value anyway. Pooled across the six setups, 17% of the absent fields came back with an invented value.

The metric is defined at [velrim.com/research/fabrication-on-absent-fields-metric](https://velrim.com/research/fabrication-on-absent-fields-metric). The write-up is [velrim.com/research/fabrication-on-absent-fields](https://velrim.com/research/fabrication-on-absent-fields). The plan was published before the first paid call, the raw outputs and the scorer are in the repository, and the archived copy has a DOI: [10.5281/zenodo.22233430](https://doi.org/10.5281/zenodo.22233430).

Velrim ran the comparison and sells one of the six setups. Read the disclosures in the repository before you read the numbers.

## Setups

| arm                  | what ran                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `velrim`             | Velrim production API, served confidence stack `cal-2026.08-4`           |
| `gemini-free`        | Gemini 2.5 Flash, schema in the prompt, free-decode                      |
| `gemini-constrained` | Gemini 2.5 Flash, schema in the prompt, `responseJsonSchema` constrained |
| `openai-free`        | gpt-5.4-mini, schema in the prompt, free-decode                          |
| `openai-structured`  | gpt-5.4-mini, `json_schema` response format                              |
| `mistral`            | Mistral Document AI (OCR 4), schema as `document_annotation_format`      |

Every arm saw the same documents, the same schemas and the same instruction. The main pass ran three times per document. The probe pass ran once.

## Files

### `data/predictions.jsonl`

One row per (arm, pass, document, repeat, golden field). 39,024 rows.

| column              | type           | meaning                                                                                                                                                    |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arm`               | string         | setup id from the table above                                                                                                                              |
| `pass`              | string         | `main` (the class schema) or `probe` (the schema with planted trap fields)                                                                                 |
| `doc_class`         | string         | `cord-v2`, `deepform`, `vrdu-ad-buy` or `vrdu-registration`                                                                                                |
| `doc`               | string         | source document file name, resolves to `corpora/pdfs/<doc_class>/<doc>` in the repository                                                                  |
| `repeat`            | int            | 1 to 3 on the main pass, 1 on the probe pass                                                                                                               |
| `field`             | string         | JSON Pointer of the golden field                                                                                                                           |
| `gold_state`        | string         | `present` or `missing` (no golden cell in this round is `null`)                                                                                            |
| `gold_value`        | any or null    | the annotated value when present                                                                                                                           |
| `availability`      | string         | `completed`, `transport_failure` or `contract_failure` for the whole call                                                                                  |
| `predicted_state`   | string         | `value` (a substantive value), `null`, `omitted` (key absent), `declined` (empty, whitespace or an abstention token), `failed` (the call did not complete) |
| `value`             | any or null    | the raw value the system returned, untouched                                                                                                               |
| `confidence`        | float or null  | the per-field confidence when the system surfaced one (only `velrim` does, and `openai-*` where token logprobs were present)                               |
| `struck`            | bool           | the absent label was struck by the audit, so the cell is out of every denominator for every arm                                                            |
| `fabricated`        | bool or null   | headline rule: the field is absent, not struck, the call completed, and the value is substantive. Null wherever the rule does not apply                    |
| `fabricated_strict` | bool or null   | strict rule: any value other than `null` or an omitted key counts. Same null cases                                                                         |
| `request_id`        | string or null | the vendor's request id for the call, as returned                                                                                                          |

Rows are ordered by arm, pass, document class, document, repeat and golden field. The order is deterministic and the file regenerates byte for byte from the repository.

### `data/probes.jsonl`

The twelve planted trap fields, three per document class, drawn with the published seed 20260712 from the sibling classes' schemas. `struck` marks the four whose value turned out to be visible on at least one page during the visual pass, with `visible_docs` giving the count. Struck probes were removed before the plan was hashed and never ran.

### `data/absent-label-audit.jsonl`

All 142 fields the original annotators labeled absent, each with its audit verdict: `confirmed` (96), `visible` (40, the value is printed in the document, with the page and what was seen) or `unverifiable` (6, the region is illegible or redacted). The 46 non-confirmed labels are the `struck` cells above. Golden files were not edited.

## The verdict

A field the document does not contain, answered with a substantive value, counts as one fabrication. Declining is not a fabrication: an explicit `null`, an omitted key, an empty or whitespace-only string, or one of the tokens `n/a`, `not present`, `not applicable`, `none`, `unknown`, matched without regard to case. A listed token that appears as a real value for that field anywhere in the answer key counts as substantive for that field. The judge reads only the golden state and the raw value. No model grades the output and no confidence score enters the decision.

The headline rate is the mean over absent cells of each cell's mean over its repeats, pooled across document classes. Intervals in the write-up are 95% bootstrap intervals over documents with 10,000 resamples, since fields cluster within documents.

## Reproduce

```sh
git clone https://github.com/velrimhq/velrim-eval
cd velrim-eval && npm install && npm test

# the three files above, from the published run data
npm run hf-dataset

# one arm's fabrication table, the way the write-up computes it
npx velrim-eval fabrication --arm-dir results/matrix-out/velrim --corpora corpora \
  --strikes corpora/natural-strikes.json --out rescored/velrim-fabrication
```

No API keys, no cost.

## Licenses

The outputs, the verdicts and this packaging are Apache-2.0. The `gold_value` column and the document names come from third-party, hand-labeled datasets that predate this work, under their own licenses: CORD-v2 (CC BY 4.0, NAVER CLOVA, Park et al. 2019), VRDU ad-buy and registration (CC BY 4.0, Google Research, Wang et al. KDD 2023, documents from FCC Public Inspection Files and US DOJ FARA public filings) and DeepForm (MIT, Project DeepForm, 2020 slice only, FCC OPIF). Full notices are in `ATTRIBUTIONS.md` and `NOTICE` in the repository. All trademarks are the property of their respective owners. No affiliation or endorsement is implied.

## Citation

```bibtex
@dataset{velrim_2026_fabrication_round1,
  author    = {Velrim},
  title     = {Fabrication on absent fields: a pre-registered six-arm document-extraction bake-off (round 1)},
  year      = {2026},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.22233430},
  url       = {https://velrim.com/research/fabrication-on-absent-fields}
}
```
