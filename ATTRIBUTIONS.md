# Attributions

The evaluation corpora bundled with (and referenced by) velrim-eval are third-party,
hand-labeled datasets that pre-date this project. Full provenance, per class:

## CORD-v2 — receipts (scans)

- **License:** CC BY 4.0
- **Creator:** NAVER CLOVA — Park et al., _"CORD: A Consolidated Receipt Dataset for
  Post-OCR Parsing"_, Workshop on Document Intelligence at NeurIPS 2019.
- **Source:** the `naver-clova-ix/cord-v2` dataset (Hugging Face). Receipt images are
  re-packaged here as single-page image-only PDFs; the golden labels derive from the dataset's
  native `gt_parse` annotations.

## VRDU ad-buy + VRDU registration — FCC TV ad contracts / US DOJ FARA forms

- **License:** CC BY 4.0. The VRDU repository ships no LICENSE file; the grant is in Google
  Research's release announcement, _"Advances in document understanding"_ (2023-08-09):
  _"We are excited to announce the public release of the VRDU dataset and evaluation code
  under a Creative Commons license"_, where the "Creative Commons license" link resolves to
  <https://creativecommons.org/licenses/by/4.0/>.
  Live: <https://research.google/blog/advances-in-document-understanding/> (accessed
  2026-07-15). Archived:
  <https://web.archive.org/web/20260512200932/https://research.google/blog/advances-in-document-understanding/>
  (snapshot 2026-05-12; grant sentence and CC BY 4.0 link target verified in the archived copy).
- **Creator:** Google Research — Wang et al., _"VRDU: A Benchmark for Visually-rich Document
  Understanding"_, KDD 2023 (arXiv:2211.15421).
- **Repository:** <https://github.com/google-research-datasets/vrdu>
- **Underlying documents:** public records — FCC Public Inspection Files (ad-buy class) and
  US Department of Justice FARA public filings (registration class).

## DeepForm — FCC political ad-buy disclosure forms (2020 slice only)

- **License:** MIT — Copyright (c) 2020 Project DeepForm. The full license text is retained in
  the [`NOTICE`](./NOTICE) file, as the license requires.
- **Repository:** <https://github.com/project-deepform/deepform>
- **Scope note:** only the 2020 hand-labeled slice (`data/2020_manifest.csv`) is included.
  The project's 2012 slice carries ProPublica terms that forbid redistribution; it is excluded
  by a hard filter in the corpus build, and no 2012 document appears anywhere in this repo.
- **Underlying documents:** FCC Public Inspection Files (OPIF).

## Preprocessing

Documents are redistributed as PDFs; CORD-v2 receipt images were embedded into one-page PDFs
without alteration of the image content. Golden labels were converted to the 3-state format
documented in the README (`present` / `null` / `missing`); the per-class conversion code is in
this repository (`src/corpora/`) and the exact label bytes are hash-pinned in every run
manifest.

## Trademarks

All product names, logos, and brands referenced by this repository or the published results
are the property of their respective owners. Names are used nominatively, to identify what was
tested; no affiliation, sponsorship, or endorsement is implied.
