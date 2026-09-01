/**
 * Article figures are presentation only: these tests pin the contract a reader relies on —
 * every input row/point is drawn, red marks only ever mean "wrong", no cut-line or shaded zone
 * exists (the figures recommend no threshold), every figure states its question in plain words,
 * and the SVG is self-contained (explicit xmlns, no script, no style, no dominant-baseline).
 */

import { describe, expect, it } from 'vitest';
import {
  renderConfidenceBucketsSvg,
  renderFabricationBarsSvg,
  renderKickerSvg,
} from '../src/report/figures.js';

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const ACCENT = '#7a6690';
const WRONG = '#e34948';

const selfContained = (svg: string): void => {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).not.toContain('<script');
  expect(svg).not.toContain('<style');
  expect(svg).not.toContain('dominant-baseline');
  expect(svg).not.toContain('currentColor');
  expect(svg).toContain('fill="#fcfcfb"');
};

describe('renderFabricationBarsSvg', () => {
  const rows = [
    { label: 'Velrim', estimate: 0.115, lo: 0.061, hi: 0.198, ours: true },
    { label: 'Gemini free-decode', estimate: 0.17, lo: 0.101, hi: 0.267 },
    { label: 'Mistral OCR 4', estimate: 0.403, lo: 0.31, hi: 0.525 },
  ];

  it('draws one bar and one interval per row, labels the tip, and marks ours by label only', () => {
    const svg = renderFabricationBarsSvg(rows);
    selfContained(svg);
    expect(count(svg, /data-role="bar"/g)).toBe(3);
    expect(count(svg, /data-role="interval"/g)).toBe(3);
    expect(count(svg, /data-role="value"/g)).toBe(3);
    expect(svg).toContain('Velrim (ours)');
    expect(svg).toContain('11.5%');
    expect(svg).toContain('40.3%');
    expect(svg).toContain('invented a value');
    expect(svg).toContain('The black line on each bar is the range');
    // One series color for every bar: "ours" is never a different hue, and red never appears.
    expect(svg).toMatch(new RegExp(`<g[^>]*class="bar"[^>]*fill="${ACCENT}"`));
    expect(count(svg, new RegExp(ACCENT, 'g'))).toBe(1);
    expect(svg).not.toContain(WRONG);
  });

  it('sorts rows lowest first', () => {
    const svg = renderFabricationBarsSvg(rows);
    const rowY = (label: string): number => {
      const at = svg.indexOf(`">${label}</text>`);
      const open = svg.lastIndexOf('<text', at);
      return Number(/translate\([\d.]+,([\d.]+)\)/.exec(svg.slice(open, at))![1]);
    };
    expect(rowY('Velrim (ours)')).toBeLessThan(rowY('Gemini free-decode'));
    expect(rowY('Gemini free-decode')).toBeLessThan(rowY('Mistral OCR 4'));
  });

  it('scales the axis to the widest interval and escapes labels', () => {
    const svg = renderFabricationBarsSvg([{ label: 'a<b>&"c"', estimate: 0.5, lo: 0.4, hi: 0.66 }]);
    expect(svg).toContain('a&lt;b&gt;&amp;"c"');
    expect(svg).toContain('>70%<');
    expect(svg).not.toContain('>80%<');
  });
});

describe('renderConfidenceBucketsSvg', () => {
  const points = [
    { confidence: 0.95, correct: true },
    { confidence: 0.92, correct: true },
    { confidence: 0.91, correct: false },
    { confidence: 0.55, correct: true },
    { confidence: 0.52, correct: false },
    { confidence: 0.05, correct: false },
  ];

  it('draws one bar per non-empty bucket with its share correct, its claimed mark, and its count', () => {
    const svg = renderConfidenceBucketsSvg(points);
    selfContained(svg);
    expect(count(svg, /data-role="bar"/g)).toBe(3);
    expect(count(svg, /data-role="claimed"/g)).toBe(3);
    expect(count(svg, /data-role="count"/g)).toBe(10);
    expect(svg).toContain('>90–100%<');
    expect(svg).toContain('>3 fields<');
    expect(svg).toContain('>67%<'); // 2 of 3 right in the top bucket
    expect(svg).toContain('>50%<'); // 1 of 2 in the 50–60% bucket
    expect(svg).toContain('>0%<'); // 0 of 1 in the bottom bucket (axis tick also prints 0%)
    expect(count(svg, />0 fields</g)).toBe(7); // the seven empty buckets
    expect(svg).toContain('how often it was right');
    expect(svg).toContain('share actually correct');
  });

  it('never uses red (nothing here is a "wrong value" mark) and has no cut-line or zone', () => {
    const svg = renderConfidenceBucketsSvg(points);
    expect(svg).not.toContain(WRONG);
    expect(svg).not.toMatch(/data-role="(cut|threshold|zone)"/);
    expect(svg.toLowerCase()).not.toContain('threshold');
  });

  it('renders an empty input as ten empty columns', () => {
    const svg = renderConfidenceBucketsSvg([]);
    expect(count(svg, />0 fields</g)).toBe(10);
    expect(count(svg, /data-role="bar"/g)).toBe(0);
  });
});

describe('renderKickerSvg', () => {
  const input = {
    invented: [0.3, 0.45, 0.5],
    rest: [0.9, 0.8, 0.7, 0.6, 0.5],
    inventedMean: { estimate: 0.4, lo: 0.31, hi: 0.52 },
    restMean: { estimate: 0.64, lo: 0.63, hi: 0.65 },
  };

  it('draws both rows as histograms over the same buckets, and both averages', () => {
    const svg = renderKickerSvg(input);
    selfContained(svg);
    expect(count(svg, /data-role="invented"/g)).toBe(3); // 0.3, 0.45, 0.5 → three of ten buckets
    expect(count(svg, /data-role="rest"/g)).toBe(5); // 0.5..0.9 → five buckets
    expect(count(svg, /data-role="mean"/g)).toBe(2);
    expect(count(svg, /data-role="interval"/g)).toBe(2);
    expect(svg).toContain('average 0.40');
    expect(svg).toContain('average 0.64');
    expect(svg).toContain('values we invented');
    expect(svg).toContain('>3 values<');
    expect(svg).toContain('>5 values<');
    expect(svg).toContain('Does our score notice');
    expect(svg).toContain('On everything else: 0.64.');
  });

  it('uses red for the invented values only and carries no cut-line', () => {
    const svg = renderKickerSvg(input);
    expect(count(svg, new RegExp(WRONG, 'g'))).toBe(2); // the invented row's fill + its swatch
    expect(svg).toMatch(new RegExp(`<g[^>]*class="invented"[^>]*fill="${WRONG}"`));
    expect(svg).not.toMatch(/data-role="(cut|threshold|zone)"/);
  });
});
