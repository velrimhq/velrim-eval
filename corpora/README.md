# Corpora — frozen golden sets for the extraction comparison

Four third-party, hand-labeled document classes (124 documents / 2,102 golden fields in the
full branch — see `corpus-counts.json` for both frozen branch counts). Provenance and licenses
per class: [`../ATTRIBUTIONS.md`](../ATTRIBUTIONS.md).

## Layout

```
corpora/
  golden.<class>.jsonl       # 3-state golden labels (present / null / missing), one doc per line
  <class>.schema.json        # the frozen per-class JSON Schema every arm receives (nullable leaves)
  corpus-counts.json         # exact doc/field/absent-field/page counts, both branches,
                             #   incl. the conditional page-cap exclusion list
  pdfs/<class>/<doc>.pdf     # the source documents (added by the publication packaging step;
                             #   every golden row's "doc" resolves here)
```

Classes: `cord-v2` (receipts, scans) · `deepform` (FCC political ad-buy invoices) ·
`vrdu-ad-buy` (FCC TV ad contracts) · `vrdu-registration` (US DOJ FARA forms).

## What "frozen" means

- The golden labels and schemas are byte-hashed into every run manifest and into the public
  analysis plan **before any paid run**; a published number that doesn't match these bytes is
  not a number from this protocol.
- The two branch counts in `corpus-counts.json` (`capRemoved` / `capConfirmed`) exist because
  one vendor's documented page cap is resolved by a live probe before the primary runs; the
  excluded-document list for the cap-confirmed branch is frozen here in advance, so no document
  can quietly disappear after results exist.

## Label provenance

The golden labels are third-party annotations on noisy real-world documents. Every "absent"
label (142) was hand-checked against the page before any competitor arm ran; 46 were struck
for every arm identically (`NATURAL-ABSENT-AUDIT.md`, `natural-strikes.json`). Present-value
labels were not re-audited and their noise rate is unmeasured. Corrections follow
the symmetric rule in [`../RIGHT-OF-REPLY.md`](../RIGHT-OF-REPLY.md): a golden label shown to
be wrong is reclassified or excluded **for every arm identically**, with the count disclosed
in the changelog.

## Run your own

The point of the CLI is that this directory is replaceable: point `--golden` at your own
labeled documents and the same commands produce the same tables for _your_ corpus. The golden
format is documented in the top-level README.
