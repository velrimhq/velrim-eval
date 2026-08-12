# Right of reply — standing policy

This repository produces published, vendor-named measurements. Every number is replicable from
the frozen golden sets, the pinned CLI commit, and the published raw outputs. Because a solo
publisher can still drive a vendor's API wrong, the following policy stands for every vendor
in the table, indefinitely.

## 1. Correcting how your arm is called

The full request construction for every arm is open source in this repository. If we drive
your API incorrectly — wrong mode, wrong defaults, missing documented option — **open a pull
request correcting how your arm is called.** We will:

1. review and merge the correction,
2. re-run your arm (one corrected re-run over the same frozen document set and schemas), and
3. re-publish the affected tables with a changelog entry naming the correction and the date.

Mode choices must remain your _documented_ happy path — the configuration your public
documentation gives a new customer — with the citation updated in the PR. A correction is a
fix to how the documented path is invoked, not a switch to a tuned configuration.

## 2. Vendor self-run numbers

If you run this harness yourself, your numbers enter the published table when they are
produced under:

- the frozen per-class schemas and frozen golden sets in `corpora/`,
- three repeats per document (the same repeat policy every arm ran),
- the pinned CLI commit named in the run manifest, and
- verification by our re-run of the same configuration.

They then publish in a column labeled **"vendor self-run (their account, their config)"**.
A run under a tuned configuration — custom prompts, non-default modes, post-processing — is a
different comparison; we will link it as one, but it does not replace the documented-default
column. The exact command for a conforming run is in the README's reproduction section.

## 3. Golden-label corrections (symmetric, always)

The golden labels are third-party annotations and their noise rate is unmeasured. If any
golden label is shown to be wrong after publication, that cell is reclassified or excluded
**for all arms symmetrically** — never for one arm — with the affected count disclosed in the
changelog. Evidence for a label correction is the document itself.

## 4. Re-runs over time

Hosted APIs ship silent updates, so every published claim is time-stamped with its run window
and pinned vendor version strings (or "no version surfaced", reported as such). A major vendor
version change, or any merged correction PR, triggers a re-run of the affected arm on request
— honestly budget-capped: re-runs cost real money, and we re-run affected arms rather than the
full matrix unless the correction demands it.
