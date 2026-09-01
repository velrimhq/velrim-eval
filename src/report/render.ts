/**
 * CLI-side rendering only — a fixed-width text table + a reliability/risk-coverage
 * SVG. This is PRESENTATION, not scoring math: every number here was computed by @velrim/scoring
 * (via score/aggregate). render.ts never derives a metric.
 */

import * as Plot from '@observablehq/plot';
import type { CalibrationPoint, RiskCoveragePoint } from '@velrim/scoring';
import { ACCENT, INK, INK_2, RULE, SURFACE, composeFigure, plot } from './plot-svg.js';

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
  opts: { title?: string; note?: string } = {},
): string {
  const W = 760;
  const PANEL = 300;
  const marginLeft = 48;
  const marginBottom = 44;
  const gap = 24;

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

  const ticks = [0, 0.5, 1];
  const scaffold = (xLabel: string, yLabel: string): Plot.Markish[] => [
    Plot.gridX(ticks, { stroke: RULE, strokeOpacity: 1 }),
    Plot.gridY(ticks, { stroke: RULE, strokeOpacity: 1 }),
    Plot.axisX(ticks, {
      tickFormat: (v: number) => v.toFixed(1),
      tickSize: 0,
      fontSize: 10,
      fill: INK_2,
      label: xLabel,
      labelAnchor: 'center',
      labelArrow: 'none',
      labelOffset: 30,
    }),
    Plot.axisY(ticks, {
      tickFormat: (v: number) => v.toFixed(1),
      tickSize: 0,
      fontSize: 10,
      fill: INK_2,
      label: yLabel,
      labelAnchor: 'center',
      labelArrow: 'none',
      labelOffset: 40,
    }),
  ];
  const frame = {
    width: PANEL + marginLeft,
    height: PANEL + marginBottom + 8,
    marginLeft,
    marginRight: 0,
    marginTop: 8,
    marginBottom,
    x: { domain: [0, 1], axis: null },
    y: { domain: [0, 1], axis: null },
  } as const;

  // Panel 1: reliability.
  const ordered =
    bands && bands.length > 1 ? [...bands].sort((a, b) => a.meanConfidence - b.meanConfidence) : [];
  const reliability = plot({
    ...frame,
    marks: [
      ...scaffold('confidence we served', 'share actually correct'),
      Plot.areaY(ordered, {
        x: 'meanConfidence',
        y1: 'lo',
        y2: 'hi',
        fill: ACCENT,
        fillOpacity: 0.14,
        className: 'consistency-band',
      }),
      Plot.line(
        [
          [0, 0],
          [1, 1],
        ],
        { stroke: INK_2, strokeDasharray: '3 3' },
      ),
      Plot.dot(dots, {
        x: 'conf',
        y: 'acc',
        r: 4,
        fill: ACCENT,
        stroke: SURFACE,
        strokeWidth: 2,
        className: 'bin',
      }),
    ],
  });

  // Panel 2: risk-coverage. A single point (no-confidence arm) is one honest dot, never a curve.
  const single = rc.length === 1 ? rc : [];
  const curve = rc.length > 1 ? rc : [];
  const riskCoverage = plot({
    ...frame,
    marks: [
      ...scaffold('share of fields used (most confident first)', 'share wrong among those'),
      Plot.line(curve, {
        x: 'coverage',
        y: 'error',
        stroke: ACCENT,
        strokeWidth: 2,
        className: 'rc-curve',
      }),
      Plot.dot(single, {
        x: 'coverage',
        y: 'error',
        r: 5,
        fill: ACCENT,
        stroke: SURFACE,
        strokeWidth: 2,
        className: 'single-dot',
      }),
      Plot.text([null], {
        frameAnchor: 'top-left',
        dx: 6,
        dy: 8,
        text: () => 'fields with a served score; blanks excluded',
        fill: INK_2,
        fontSize: 10,
        textAnchor: 'start',
      }),
      ...(single.length
        ? [
            Plot.text([null], {
              frameAnchor: 'bottom-left',
              dx: 6,
              dy: -8,
              text: () => 'no selective operation possible',
              fill: INK_2,
              fontSize: 10,
              textAnchor: 'start',
            }),
          ]
        : []),
    ],
  });

  const x0 = 12;
  const x1 = x0 + PANEL + marginLeft + gap;
  const top = 30;
  const panelTitle = (x: number, t: string): string =>
    `<text x="${x + marginLeft}" y="${top - 8}" font-size="13" font-weight="600" fill="${INK}">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`;
  const extra = [
    panelTitle(x0, opts.title ?? 'Reliability'),
    panelTitle(x1, 'Use the most confident fields first'),
  ];
  return composeFigure({
    width: W,
    ariaLabel: 'reliability and risk-coverage',
    panels: [
      { svg: reliability, x: x0, y: top },
      { svg: riskCoverage, x: x1, y: top },
    ],
    extra,
    notes: [
      ...(ordered.length ? ["Shaded: a perfectly reliable score's range at this n."] : []),
      ...(opts.note ? [opts.note] : []),
    ],
  });
}
