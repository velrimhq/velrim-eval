/**
 * Article figures, presentation only — every number arrives computed elsewhere (the analysis
 * driver, @velrim/scoring, src/fabrication/judge, src/stats/bootstrap). The only arithmetic here
 * is bucketing points for display (the same fixed-width bucketing a reader would do by hand).
 * Rendered with Observable Plot through plot-svg.ts into static, self-contained SVG.
 *
 * No cut-lines or shaded zones (the article makes no threshold recommendation). Every figure
 * carries a one-line plain-words subtitle that states the question it answers.
 */

import * as Plot from '@observablehq/plot';
import type { CalibrationPoint } from '@velrim/scoring';
import {
  ACCENT,
  ACCENT_SOFT,
  INK,
  INK_2,
  RULE,
  WRONG,
  composeFigure,
  esc,
  pct,
  plot,
} from './plot-svg.js';

const HEADER_H = 64;

export interface RateWithInterval {
  estimate: number;
  lo: number;
  hi: number;
}

export interface FabricationBarRow extends RateWithInterval {
  label: string;
  /** Marks the author's own arm; rendered as a label suffix, never as a different color. */
  ours?: boolean;
}

export interface FabricationBarsOptions {
  title?: string;
  subtitle?: string;
  /** Axis maximum as a rate (default: the largest `hi`, rounded up to the next 10%). */
  axisMax?: number;
}

/**
 * Horizontal bars, one per arm, sorted lowest first, with the doc-clustered interval drawn as a
 * whisker over each bar and the rate printed past the whisker.
 */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const word = (n: number): string => WORDS[n] ?? String(n);

/**
 * The reading the intervals support, and nothing more: the largest run of rows (from the lowest
 * up) whose ranges all overlap pairwise is one "cannot be told apart" group; a row whose whole
 * range sits above that group's highest edge is "clearly separated". No winner is named.
 */
function intervalGroups(sorted: readonly RateWithInterval[]): {
  tied: number[];
  separated: number[];
} {
  const tied: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const overlapsAll = tied.every((j) => {
      const o = sorted[j]!;
      return r.lo <= o.hi && o.lo <= r.hi;
    });
    if (overlapsAll) tied.push(i);
    else break;
  }
  const tiedHi = Math.max(...tied.map((j) => sorted[j]!.hi));
  const separated = sorted
    .map((r, i) => (tied.includes(i) ? -1 : r.lo > tiedHi ? i : -1))
    .filter((i) => i >= 0);
  return { tied, separated };
}

export function renderFabricationBarsSvg(
  rows: readonly FabricationBarRow[],
  opts: FabricationBarsOptions = {},
): string {
  const W = 760;
  const rowH = 36;
  const marginLeft = 236;
  const marginRight = 200;
  const maxHi = rows.reduce((m, r) => Math.max(m, r.hi), 0);
  const axisMax = opts.axisMax ?? Math.min(1, Math.ceil((maxHi + 0.02) * 10) / 10);
  const sorted = [...rows]
    .map((r) => ({ ...r, name: r.ours ? `${r.label} (ours)` : r.label }))
    .sort((a, b) => a.estimate - b.estimate);
  const ticks: number[] = [];
  for (let v = 0; v <= axisMax + 1e-9; v += 0.1) ticks.push(Math.round(v * 10) / 10);

  const svg = plot({
    width: W,
    height: rows.length * rowH + 36,
    marginLeft,
    marginRight,
    marginTop: 4,
    marginBottom: 32,
    x: { domain: [0, axisMax], axis: null },
    y: { domain: sorted.map((r) => r.name), axis: null, padding: 0.55 },
    marks: [
      Plot.gridX(ticks, { stroke: RULE, strokeOpacity: 1 }),
      Plot.axisX(ticks, {
        tickFormat: (v: number) => `${Math.round(100 * v)}%`,
        tickSize: 0,
        fontSize: 10,
        fill: INK_2,
        label: null,
      }),
      Plot.barX(sorted, { x: 'estimate', y: 'name', fill: ACCENT, rx2: 4, className: 'bar' }),
      Plot.ruleY(sorted, {
        y: 'name',
        x1: 'lo',
        x2: 'hi',
        stroke: INK,
        strokeWidth: 1.5,
        className: 'interval',
      }),
      Plot.tickX(sorted, { x: 'lo', y: 'name', stroke: INK, strokeWidth: 1.5, inset: 3 }),
      Plot.tickX(sorted, { x: 'hi', y: 'name', stroke: INK, strokeWidth: 1.5, inset: 3 }),
      Plot.text(sorted, {
        x: 'hi',
        y: 'name',
        text: (r: FabricationBarRow) => pct(r.estimate),
        textAnchor: 'start',
        dx: 10,
        fill: INK,
        fontSize: 12,
        fontVariant: 'tabular-nums',
        className: 'value',
      }),
      Plot.text(
        sorted.filter((r) => !r.ours),
        { x: 0, y: 'name', text: 'name', textAnchor: 'end', dx: -14, fill: INK, fontSize: 12 },
      ),
      Plot.text(
        sorted.filter((r) => r.ours),
        {
          x: 0,
          y: 'name',
          text: 'name',
          textAnchor: 'end',
          dx: -14,
          fill: INK,
          fontSize: 12,
          fontWeight: 600,
        },
      ),
    ],
  });

  // Annotations: the answer, written on the chart. Row centers follow Plot's band scale.
  const { tied, separated } = intervalGroups(sorted);
  const innerH = rows.length * rowH + 36 - 4 - 32;
  const rowCenter = (i: number): number => HEADER_H + 4 + ((i + 0.5) * innerH) / rows.length;
  const bx = W - marginRight + 56;
  const extra: string[] = [];
  if (tied.length >= 2) {
    const y1 = rowCenter(tied[0]!) - rowH * 0.38;
    const y2 = rowCenter(tied[tied.length - 1]!) + rowH * 0.38;
    extra.push(
      `<path d="M${bx + 6},${y1.toFixed(1)} H${bx} V${y2.toFixed(1)} H${bx + 6}" fill="none" stroke="${INK_2}" stroke-width="1.2" data-role="annotation"/>`,
    );
    const lines = [`these ${word(tied.length)}:`, 'ranges overlap,', 'cannot be told apart'];
    const ty = (y1 + y2) / 2 - ((lines.length - 1) * 13) / 2;
    lines.forEach((l, i) =>
      extra.push(
        `<text x="${bx + 12}" y="${(ty + i * 13 + 4).toFixed(1)}" font-size="11" fill="${INK_2}" data-role="annotation">${esc(l)}</text>`,
      ),
    );
  }
  for (const i of separated) {
    extra.push(
      `<text x="${bx + 12}" y="${(rowCenter(i) + 4).toFixed(1)}" font-size="11" fill="${INK_2}" data-role="annotation">the one clearly apart</text>`,
    );
  }

  return composeFigure({
    width: W,
    title: opts.title ?? 'How often each system invented a value for a field that was not there',
    subtitle: opts.subtitle ?? '96 fields that are absent from the documents. Lower is better.',
    panels: [{ svg, x: 0, y: HEADER_H }],
    extra,
    notes: [
      'The black line on each bar is the range the true rate likely sits in.',
      'Where two ranges overlap, this test cannot tell those systems apart.',
    ],
  });
}

export interface ConfidenceBucketsOptions {
  title?: string;
  subtitle?: string;
  /** Number of equal-width confidence buckets (default 10). */
  buckets?: number;
}

/**
 * "What we said vs what happened": fields bucketed by the confidence we served (10 equal-width
 * buckets by default), one column per bucket showing how often those fields were actually
 * right; a dark marker shows the average confidence we claimed in that bucket. A reliability
 * diagram, spoken in the reader's words. Empty buckets render as an empty column with "—".
 */
export function renderConfidenceBucketsSvg(
  points: readonly CalibrationPoint[],
  opts: ConfidenceBucketsOptions = {},
): string {
  const W = 760;
  const k = opts.buckets ?? 10;
  const bins = Array.from({ length: k }, (_, i) => ({
    label: `${Math.round((100 * i) / k)}–${Math.round((100 * (i + 1)) / k)}%`,
    n: 0,
    correct: 0,
    confSum: 0,
  }));
  for (const p of points) {
    const i = Math.min(k - 1, Math.max(0, Math.floor(p.confidence * k)));
    const b = bins[i]!;
    b.n++;
    b.confSum += p.confidence;
    if (p.correct) b.correct++;
  }
  const filled = bins
    .filter((b) => b.n > 0)
    .map((b) => ({ ...b, acc: b.correct / b.n, claimed: b.confSum / b.n }));
  const empty = bins.filter((b) => b.n === 0);

  const svg = plot({
    width: W,
    height: 312,
    marginLeft: 64,
    marginRight: 24,
    marginTop: 38,
    marginBottom: 74,
    x: { domain: bins.map((b) => b.label), padding: 0.45, axis: null },
    y: { domain: [0, 1], axis: null },
    marks: [
      Plot.gridY([0, 0.25, 0.5, 0.75, 1], { stroke: RULE, strokeOpacity: 1 }),
      Plot.axisY([0, 0.25, 0.5, 0.75, 1], {
        tickFormat: (v: number) => `${Math.round(100 * v)}%`,
        tickSize: 0,
        fontSize: 10,
        fill: INK_2,
        label: 'share actually correct',
        labelAnchor: 'center',
        labelArrow: 'none',
        labelOffset: 52,
      }),
      Plot.axisX(
        bins.map((b) => b.label),
        { tickSize: 0, fontSize: 10, fill: INK, label: null, tickPadding: 6 },
      ),
      // What we claimed: a hollow bar behind the solid one, so the gap is a shape, not a tick.
      Plot.barY(filled, {
        x: 'label',
        y: 'claimed',
        fill: 'none',
        stroke: INK_2,
        strokeWidth: 1.2,
        strokeDasharray: '3 2',
        rx2: 4,
        className: 'claimed',
      }),
      Plot.barY(filled, { x: 'label', y: 'acc', fill: ACCENT, rx2: 4, className: 'bar' }),
      Plot.text(filled, {
        x: 'label',
        y: (b: { acc: number; claimed: number }) => Math.max(b.acc, b.claimed),
        text: (b: { acc: number }) => `${Math.round(100 * b.acc)}%`,
        dy: -9,
        fill: INK,
        fontSize: 10.5,
        fontVariant: 'tabular-nums',
      }),
      // Two callouts, chosen by the data: the bucket where we most under-claimed and the one
      // where we most over-claimed (only when the gap is at least 8 points).
      ...(() => {
        const gaps = filled.map((b) => ({ b, gap: b.acc - b.claimed }));
        const under = gaps.reduce((m, g) => (g.gap > m.gap ? g : m), gaps[0]!);
        const over = gaps.reduce((m, g) => (g.gap < m.gap ? g : m), gaps[0]!);
        const call = (
          g: { b: { label: string; acc: number; claimed: number }; gap: number },
          t: string,
        ) => [
          Plot.ruleX([g.b], {
            x: 'label',
            y1: (b: { acc: number; claimed: number }) => Math.max(b.acc, b.claimed) + 0.06,
            y2: () => 0.94,
            stroke: INK_2,
            strokeWidth: 1,
            strokeDasharray: '2 2',
            className: 'annotation',
          }),
          Plot.text([g.b], {
            x: 'label',
            y: () => 1,
            text: () => t,
            dy: -4,
            lineAnchor: 'bottom',
            fill: INK_2,
            fontSize: 9.5,
            className: 'annotation',
          }),
        ];
        return [
          ...(gaps.length && under.gap >= 0.08 ? call(under, 'more right\nthan we claimed') : []),
          ...(gaps.length && over.gap <= -0.08
            ? call(over, 'claimed more\nthan we delivered')
            : []),
        ];
      })(),
      Plot.text(empty, { x: 'label', y: 0, text: () => '—', dy: -8, fill: INK_2, fontSize: 11 }),
      Plot.text(bins, {
        x: 'label',
        frameAnchor: 'bottom',
        text: (b: { n: number }) => `${b.n} fields`,
        dy: 30,
        fill: INK_2,
        fontSize: 9.5,
        className: 'count',
      }),
      Plot.text([null], {
        frameAnchor: 'bottom',
        text: () => 'confidence we served, in buckets (right = we were more sure)',
        dy: 52,
        fill: INK_2,
        fontSize: 11,
      }),
    ],
  });

  const legendY = HEADER_H + 312 + 12;
  return composeFigure({
    width: W,
    title: opts.title ?? 'What our confidence score said, and how often it was right',
    subtitle:
      opts.subtitle ??
      'Every field we scored, grouped by the confidence we served. Bar: share actually correct. Dashed outline: what we claimed.',
    panels: [{ svg, x: 0, y: HEADER_H }],
    extra: [
      `<rect x="64" y="${legendY - 7}" width="18" height="12" fill="none" stroke="${INK_2}" stroke-width="1.2" stroke-dasharray="3 2"/>`,
      `<text x="90" y="${legendY + 4}" font-size="10.5" fill="${INK_2}">what we claimed on average in that bucket. A perfectly honest score would fill every outline exactly.</text>`,
    ],
    notesGap: 18,
  });
}

export interface KickerInput {
  /** Served confidence of every value the arm invented (golden-absent field, substantive answer). */
  invented: readonly number[];
  /** Served confidence of every other scored value. */
  rest: readonly number[];
  inventedMean: RateWithInterval;
  restMean: RateWithInterval;
}

export interface KickerOptions {
  title?: string;
  subtitle?: string;
  inventedLabel?: string;
  restLabel?: string;
}

/**
 * "Does our score notice our own inventions?" — two rows, one idiom: the values we invented and
 * everything else, each as a histogram over the same ten confidence buckets, heights as the
 * share of that row (so 33 values and 5,000 compare), each row's average drawn as a vertical
 * line labelled in the same spot. Red marks only ever mean "invented". No cut-line.
 */
export function renderKickerSvg(input: KickerInput, opts: KickerOptions = {}): string {
  const W = 760;
  const marginLeft = 176;
  const marginRight = 24;
  const laneH = 118;
  const nb = 10;
  const gridTicks = [0, 0.25, 0.5, 0.75, 1];

  const shares = (values: readonly number[]): Array<{ x1: number; x2: number; share: number }> => {
    const counts = new Array<number>(nb).fill(0);
    for (const c of values) counts[Math.min(nb - 1, Math.max(0, Math.floor(c * nb)))]!++;
    const n = Math.max(1, values.length);
    return counts.map((c, i) => ({ x1: i / nb, x2: (i + 1) / nb, share: c / n }));
  };
  const rowA = shares(input.invented);
  const rowB = shares(input.rest);
  const peak = Math.max(0.05, ...rowA.map((b) => b.share), ...rowB.map((b) => b.share));

  const lane = (
    bins: ReadonlyArray<{ x1: number; x2: number; share: number }>,
    m: RateWithInterval,
    fill: string,
    role: string,
    withAxis: boolean,
  ): SVGSVGElement =>
    plot({
      width: W,
      height: laneH + (withAxis ? 40 : 0),
      marginLeft,
      marginRight,
      marginTop: 26,
      marginBottom: withAxis ? 40 : 0,
      x: { domain: [0, 1], axis: null },
      y: { domain: [0, peak * 1.15], axis: null },
      marks: [
        Plot.gridX(gridTicks, { stroke: RULE, strokeOpacity: 1 }),
        ...(withAxis
          ? [
              Plot.axisX(gridTicks, {
                tickFormat: (v: number) => v.toFixed(2),
                tickSize: 0,
                fontSize: 10,
                fill: INK_2,
                label: 'confidence score we served (right = more sure)',
                labelAnchor: 'center',
                labelArrow: 'none',
                labelOffset: 34,
              }),
            ]
          : []),
        Plot.rectY(
          bins.filter((b) => b.share > 0),
          { x1: 'x1', x2: 'x2', y1: 0, y2: 'share', fill, inset: 1, rx2: 3, className: role },
        ),
        Plot.ruleY([0], { stroke: RULE }),
        Plot.ruleX([m], {
          x: 'estimate',
          y1: 0,
          y2: () => peak * 1.15,
          stroke: INK,
          strokeWidth: 2,
          className: 'mean',
        }),
        Plot.ruleY([m], {
          y: () => peak * 1.08,
          x1: 'lo',
          x2: 'hi',
          stroke: INK,
          strokeWidth: 1.5,
          className: 'interval',
        }),
        Plot.text([m], {
          x: 'estimate',
          y: () => peak * 1.15,
          text: () => `average ${m.estimate.toFixed(2)}`,
          textAnchor: 'start',
          dx: 8,
          dy: -8,
          lineAnchor: 'bottom',
          fill: INK,
          fontSize: 11,
          fontWeight: 600,
          fontVariant: 'tabular-nums',
        }),
      ],
    });

  const laneA = lane(rowA, input.inventedMean, WRONG, 'invented', false);
  const laneB = lane(rowB, input.restMean, ACCENT_SOFT, 'rest', true);

  const laneLabel = (yMid: number, text: string, n: number, swatch: string): string[] => [
    `<rect x="${marginLeft - 25}" y="${(yMid - 9).toFixed(1)}" width="10" height="10" rx="2" fill="${swatch}"/>`,
    `<text x="${marginLeft - 32}" y="${yMid.toFixed(1)}" text-anchor="end" fill="${INK}" font-weight="600">${esc(text)}</text>`,
    `<text x="${marginLeft - 32}" y="${(yMid + 15).toFixed(1)}" text-anchor="end" fill="${INK_2}" font-size="10.5">${n} values</text>`,
  ];

  const yA = HEADER_H + 4;
  const yB = yA + laneH + 36;
  // The answer on the chart: how far the two averages sit apart, drawn between the rows from the
  // displayed (rounded) means so it agrees with the subtitle.
  const sx = (v: number): number => marginLeft + v * (W - marginLeft - marginRight);
  const diff =
    Number(input.restMean.estimate.toFixed(2)) - Number(input.inventedMean.estimate.toFixed(2));
  const gy = yB - 14;
  const xa = sx(input.inventedMean.estimate);
  const xb = sx(input.restMean.estimate);
  const gapMarks = [
    `<path d="M${xa.toFixed(1)},${gy - 5} V${gy + 5} M${xa.toFixed(1)},${gy} H${xb.toFixed(1)} M${xb.toFixed(1)},${gy - 5} V${gy + 5}" fill="none" stroke="${INK_2}" stroke-width="1.2" data-role="annotation"/>`,
    `<text x="${((xa + xb) / 2).toFixed(1)}" y="${gy - 8}" text-anchor="middle" font-size="10.5" fill="${INK_2}" data-role="annotation">${esc(`${Math.abs(diff).toFixed(2)} ${diff > 0 ? 'lower' : 'higher'} on the values we invented`)}</text>`,
  ];
  return composeFigure({
    width: W,
    title: opts.title ?? 'Does our score notice when we invent a value?',
    subtitle:
      opts.subtitle ??
      `Average confidence on the values we invented: ${input.inventedMean.estimate.toFixed(2)}. On everything else: ${input.restMean.estimate.toFixed(2)}.`,
    panels: [
      { svg: laneA, x: 0, y: yA },
      { svg: laneB, x: 0, y: yB },
    ],
    extra: [
      ...gapMarks,
      ...laneLabel(
        yA + laneH / 2 + 6,
        opts.inventedLabel ?? 'values we invented',
        input.invented.length,
        WRONG,
      ),
      ...laneLabel(
        yB + laneH / 2 + 6,
        opts.restLabel ?? 'everything else',
        input.rest.length,
        ACCENT_SOFT,
      ),
    ],
    notes: [
      'Bar height: share of that row\u2019s values in the bucket, so the two rows compare despite their sizes.',
    ],
    notesGap: 4,
  });
}
