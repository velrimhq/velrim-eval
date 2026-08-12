/**
 * CLI-side rendering only — a fixed-width text table + a reliability/risk-coverage
 * SVG. This is PRESENTATION, not scoring math: every number here was computed by @velrim/scoring
 * (via score/aggregate). render.ts never derives a metric.
 */

import type { CalibrationPoint, RiskCoveragePoint } from '@velrim/scoring';

export interface ReportMetrics {
  corpusPrecision: number;
  corpusRecall: number;
  corpusF1: number;
  corpusECE: number;
  corpusBrier: number;
  corpusAUROC: number;
  docs: number;
  leaves: number;
}

const f = (n: number, d = 4): string => (Number.isFinite(n) ? n.toFixed(d) : 'NaN');

/** Fixed-width metrics table. `baseline` adds a delta column when present. */
export function renderTable(label: string, m: ReportMetrics, baseline?: ReportMetrics): string {
  const rows: Array<[string, number, number | undefined]> = [
    ['precision', m.corpusPrecision, baseline?.corpusPrecision],
    ['recall', m.corpusRecall, baseline?.corpusRecall],
    ['f1', m.corpusF1, baseline?.corpusF1],
    ['ece', m.corpusECE, baseline?.corpusECE],
    ['brier', m.corpusBrier, baseline?.corpusBrier],
    ['auroc', m.corpusAUROC, baseline?.corpusAUROC],
  ];
  const lines: string[] = [];
  lines.push(`${label}  (docs=${m.docs}, leaves=${m.leaves})`);
  const head = baseline ? `  metric      value     baseline  delta` : `  metric      value`;
  lines.push(head);
  for (const [name, val, base] of rows) {
    let line = `  ${name.padEnd(10)}  ${f(val).padStart(8)}`;
    if (baseline) {
      const b = base ?? NaN;
      const delta = val - b;
      const sign = delta >= 0 ? '+' : '';
      line += `  ${f(b).padStart(8)}  ${sign}${f(delta)}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Per-bin band under the perfectly-calibrated null (computed by src/stats/ece). */
export interface ReliabilityBand {
  meanConfidence: number;
  lo: number;
  hi: number;
}

/**
 * Reliability diagram + risk-coverage curve as a single self-contained SVG string. Equal-mass
 * binning of the pooled points produces the (mean-confidence, accuracy) dots; the diagonal is
 * perfect calibration; the risk-coverage curve is overlaid in a second panel.
 *
 * Two presentation-only additions: `bands` shades the consistency band (Bröcker & Smith
 * 2007) behind the dots so a reader sees what "indistinguishable from perfectly reliable"
 * looks like at this n; a SINGLE risk-coverage point (a no-confidence arm) renders as one dot
 * at coverage=1 labeled "no selective operation possible" — never a fake curve.
 */
export function renderReliabilitySvg(
  points: CalibrationPoint[],
  rc: RiskCoveragePoint[],
  bins = 15,
  bands?: ReliabilityBand[],
): string {
  const W = 520;
  const H = 260;
  const pad = 36;
  const panel = (W - 3 * pad) / 2; // two square panels

  // Equal-mass binning (mirrors expectedCalibrationError's binning; presentation only).
  const sorted = points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.confidence - b.p.confidence || a.i - b.i)
    .map((x) => x.p);
  const n = sorted.length;
  const k = Math.min(bins, Math.max(1, n));
  const dots: Array<{ conf: number; acc: number }> = [];
  for (let b = 0; b < k && n > 0; b++) {
    const start = Math.floor((b * n) / k);
    const end = Math.floor(((b + 1) * n) / k);
    const slice = sorted.slice(start, end);
    if (slice.length === 0) continue;
    let cs = 0;
    let cc = 0;
    for (const pt of slice) {
      cs += pt.confidence;
      if (pt.correct) cc += 1;
    }
    dots.push({ conf: cs / slice.length, acc: cc / slice.length });
  }

  const x0 = pad;
  const y0 = pad;
  const sx = (v: number, base: number): number => base + v * panel;
  const sy = (v: number): number => y0 + panel - v * panel;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace" font-size="9">`,
  );
  parts.push(`<rect width="${W}" height="${H}" fill="white"/>`);

  // Panel 1: reliability.
  parts.push(
    `<rect x="${x0}" y="${y0}" width="${panel}" height="${panel}" fill="none" stroke="#888"/>`,
  );
  parts.push(
    `<line x1="${x0}" y1="${sy(0)}" x2="${sx(1, x0)}" y2="${sy(1)}" stroke="#ccc" stroke-dasharray="3 3"/>`,
  );
  parts.push(`<text x="${x0}" y="${y0 - 6}">reliability (conf vs acc)</text>`);
  if (bands && bands.length > 1) {
    // Consistency band: lo edge left→right, hi edge right→left, closed and lightly filled.
    const ordered = [...bands].sort((a, b) => a.meanConfidence - b.meanConfidence);
    const loEdge = ordered.map(
      (b, i) =>
        `${i === 0 ? 'M' : 'L'}${sx(b.meanConfidence, x0).toFixed(1)},${sy(b.lo).toFixed(1)}`,
    );
    const hiEdge = [...ordered]
      .reverse()
      .map((b) => `L${sx(b.meanConfidence, x0).toFixed(1)},${sy(b.hi).toFixed(1)}`);
    parts.push(
      `<path d="${loEdge.join(' ')} ${hiEdge.join(' ')} Z" fill="#1f6feb" fill-opacity="0.12" stroke="none" data-role="consistency-band"/>`,
    );
  }
  for (const d of dots) {
    parts.push(
      `<circle cx="${sx(d.conf, x0).toFixed(1)}" cy="${sy(d.acc).toFixed(1)}" r="2.5" fill="#1f6feb"/>`,
    );
  }

  // Panel 2: risk-coverage.
  const x1 = 2 * pad + panel;
  parts.push(
    `<rect x="${x1}" y="${y0}" width="${panel}" height="${panel}" fill="none" stroke="#888"/>`,
  );
  parts.push(`<text x="${x1}" y="${y0 - 6}">risk-coverage (cov vs err)</text>`);
  if (rc.length === 1) {
    // No-confidence arm: one honest dot, never a fake curve (FD-6; ANALYSIS-PLAN.md §6.5).
    const p = rc[0]!;
    parts.push(
      `<circle cx="${sx(p.coverage, x1).toFixed(1)}" cy="${sy(p.error).toFixed(1)}" r="3.5" fill="#d29922" data-role="single-dot"/>`,
    );
    parts.push(`<text x="${x1 + 4}" y="${y0 + panel - 6}">no selective operation possible</text>`);
  } else if (rc.length > 0) {
    const path = rc
      .map(
        (p, i) =>
          `${i === 0 ? 'M' : 'L'}${sx(p.coverage, x1).toFixed(1)},${sy(p.error).toFixed(1)}`,
      )
      .join(' ');
    parts.push(`<path d="${path}" fill="none" stroke="#d29922" stroke-width="1.5"/>`);
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}
