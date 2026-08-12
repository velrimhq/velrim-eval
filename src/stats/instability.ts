/**
 * Output-instability rate (ANALYSIS-PLAN.md §9.1, pre-registered as a question, not a
 * claim): the % of doc-repeats whose field set or values differ. Between-repeat variability is
 * a reported per-arm finding — it exposes Velrim too if prod is flaky.
 *
 * Exact rule (pre-registered): a repeat's signature is the canonical JSON of its field map
 * (object keys sorted recursively, arrays kept in order). A doc's MODAL signature is its most
 * frequent one (tie → the lexicographically smallest among the tied). A doc-repeat is
 * DIVERGENT iff its signature differs from the modal; rate = divergent / total doc-repeats,
 * pooled. Repeat collapse (mean over N) happens elsewhere; this metric is computed on the raw
 * per-repeat field maps BEFORE any aggregation.
 */

export interface DocRepeats {
  doc: string;
  /** One field map per repeat, exactly as the adapter emitted it (pointer → value). */
  repeats: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface InstabilityResult {
  totalRepeats: number;
  divergentRepeats: number;
  /** divergent / total, 0 when there are no repeats at all. */
  rate: number;
  perDoc: Array<{ doc: string; repeats: number; divergent: number }>;
}

/** Canonical JSON: object keys sorted recursively; arrays ordered; primitives as JSON. */
export function canonicalSignature(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalSignature).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalSignature(obj[k])}`).join(',')}}`;
}

/** Pooled output-instability rate over docs × repeats. Single-repeat docs cannot diverge. */
export function instabilityRate(docs: ReadonlyArray<DocRepeats>): InstabilityResult {
  let total = 0;
  let divergent = 0;
  const perDoc: InstabilityResult['perDoc'] = [];
  for (const d of docs) {
    const sigs = d.repeats.map((r) => canonicalSignature(r));
    const counts = new Map<string, number>();
    for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1);
    let modal = '';
    let modalCount = -1;
    for (const [sig, c] of counts) {
      if (c > modalCount || (c === modalCount && sig < modal)) {
        modal = sig;
        modalCount = c;
      }
    }
    const div = sigs.filter((s) => s !== modal).length;
    total += sigs.length;
    divergent += div;
    perDoc.push({ doc: d.doc, repeats: sigs.length, divergent: div });
  }
  return {
    totalRepeats: total,
    divergentRepeats: divergent,
    rate: total === 0 ? 0 : divergent / total,
    perDoc,
  };
}
