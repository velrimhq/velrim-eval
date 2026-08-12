/**
 * Multi-arm report layer — the pre-registered render rules, asserted as behavior:
 *  - cell vocabulary ("none surfaced" vs "not requested"), never a 0.5-imputed metric;
 *  - A1–A3 ablation framing sentence in EVERY table render that contains a block arm;
 *  - block arms hoisted above the rest in input order;
 *  - D17: the combined headline table is the only render with cost, and it always carries the
 *    differentiating columns; accuracy/confidence renders cannot receive cost at all;
 *  - normalized-primary + strict-adjacent dual columns;
 *  - version-stamp column labels on numeric confidence columns;
 *  - MDE + noise-floor tables; consistency bands + single-dot risk-coverage in the SVG.
 */

import { describe, expect, it } from 'vitest';
import {
  ABLATION_FRAMING,
  NONE_SURFACED,
  NOT_REQUESTED,
  renderAccuracyTable,
  renderConfidenceTable,
  renderHeadlineTable,
  renderMdeTable,
  renderNoiseFloorTable,
  type ArmRow,
} from '../src/report/arms.js';
import { renderReliabilitySvg } from '../src/report/render.js';

const cell = (v: number): { normalized: { value: number }; strict: { value: number } } => ({
  normalized: { value: v },
  strict: { value: v - 0.01 },
});

const arm = (over: Partial<ArmRow>): ArmRow => ({
  id: 'A2',
  label: 'raw Gemini 2.5 Flash (free-decode)',
  ablationBlock: true,
  macroF1: { normalized: { value: 0.71, ci: [0.66, 0.75] }, strict: { value: 0.68 } },
  perClassF1: { 'cord-v2': cell(0.7), deepform: cell(0.75) },
  fabricationRate: { value: 0.42, ci: [0.34, 0.5] },
  confidence: { kind: 'not-requested' },
  costPer1kPagesUsd: 2.5,
  ...over,
});

const velrim = arm({
  id: 'A1',
  label: 'Velrim (fitted stack, default served path)',
  confidence: {
    kind: 'numeric',
    versionStamp: 'calibrator: gbdt @ cal-2026.07-6',
    ece: { value: 0.041, ci: [0.03, 0.055] },
    brier: { value: 0.11 },
    errorAtCoverage90: { value: 0.06, ci: [0.04, 0.09] },
  },
  costPer1kPagesUsd: 20,
});

const mistral = arm({
  id: 'A4',
  label: 'Mistral Document AI',
  ablationBlock: false,
  confidence: { kind: 'none-surfaced' },
  costPer1kPagesUsd: 5,
});

describe('renderHeadlineTable (D17)', () => {
  const out = renderHeadlineTable([velrim, arm({}), mistral]);

  it('carries all four pre-registered columns — cost never renders without them', () => {
    expect(out).toContain('macro-F1');
    expect(out).toContain('fabrication');
    expect(out).toContain('err@cov-0.9');
    expect(out).toContain('$/1k pages');
    expect(out).toContain('$20.00');
    expect(out).toContain('cost never pairs with accuracy alone');
  });

  it('prints the ablation framing sentence and groups block arms first', () => {
    expect(out).toContain(ABLATION_FRAMING);
    const lines = out.split('\n');
    const velrimIdx = lines.findIndex((l) => l.includes('Velrim'));
    const mistralIdx = lines.findIndex((l) => l.includes('Mistral'));
    expect(velrimIdx).toBeLessThan(mistralIdx);
    expect(lines[velrimIdx]).toContain('▸'); // block marker
    expect(lines[mistralIdx]).not.toContain('▸');
  });

  it('uses the no-confidence vocabulary in the confidence column for non-numeric arms', () => {
    expect(out).toContain(NOT_REQUESTED);
    expect(out).toContain(NONE_SURFACED);
    expect(out).toContain('a score you cannot get is not a score of 0');
    expect(out).toContain('byte-identical prompt parity');
  });

  it('hoists block arms in input order — non-block arms never split the block', () => {
    // Gemini handed in first — the block keeps input order, Mistral stays below the block.
    const reordered = renderHeadlineTable([arm({}), mistral, velrim]);
    const lines = reordered.split('\n');
    const geminiIdx = lines.findIndex((l) => l.includes('raw Gemini'));
    const velrimIdx = lines.findIndex((l) => l.includes('Velrim'));
    const mistralIdx = lines.findIndex((l) => l.includes('Mistral'));
    expect(geminiIdx).toBeGreaterThan(-1);
    expect(geminiIdx).toBeLessThan(velrimIdx); // input order inside the block
    expect(velrimIdx).toBeLessThan(mistralIdx); // block arms above the rest
  });
});

describe('renderAccuracyTable (dual columns, no cost)', () => {
  const out = renderAccuracyTable([velrim, mistral], ['cord-v2', 'deepform'], 'MDE: see methods.');

  it('renders normalized primary before strict for each class', () => {
    const header = out.split('\n').find((l) => l.includes('cord-v2 (norm.)'))!;
    expect(header.indexOf('cord-v2 (norm.)')).toBeLessThan(header.indexOf('cord-v2 (strict)'));
    expect(out).toContain('normalized is the primary column');
    expect(out).toContain('MDE: see methods.');
  });

  it('never contains a dollar sign — cost cannot pair with accuracy alone', () => {
    expect(out).not.toContain('$');
  });

  it('prints the framing sentence when a block arm is present, omits it otherwise', () => {
    expect(out).toContain(ABLATION_FRAMING);
    const noBlock = renderAccuracyTable([mistral], ['cord-v2']);
    expect(noBlock).not.toContain(ABLATION_FRAMING);
  });
});

describe('renderConfidenceTable (no-confidence vocabulary + version stamps)', () => {
  const out = renderConfidenceTable([velrim, arm({}), mistral]);

  it('labels numeric columns with the served version stamp', () => {
    expect(out).toContain('calibrator: gbdt @ cal-2026.07-6');
  });

  it('renders vocabulary cells across every metric column for non-numeric arms', () => {
    const mistralLine = out.split('\n').find((l) => l.includes('Mistral'))!;
    expect(mistralLine.match(/none surfaced/g)!.length).toBe(3);
    const geminiLine = out.split('\n').find((l) => l.includes('raw Gemini'))!;
    expect(geminiLine.match(/not requested/g)!.length).toBe(3);
  });

  it('states the single-dot risk-coverage rule and has no cost column', () => {
    expect(out).toContain('no selective operation possible');
    expect(out).not.toContain('$');
  });
});

describe('MDE + noise-floor tables', () => {
  it('renders per-class MDE rows with assumptions and the ties-are-ties sentence', () => {
    const out = renderMdeTable(
      [
        { className: 'cord-v2', docs: 15, fields: 196, mdeAtBase75: 0.1, mdeAtBase90: 0.07 },
        { className: 'vrdu-ad-buy', docs: 21, fields: 1404, mdeAtBase75: 0.04, mdeAtBase90: null },
      ],
      'assumptions: shared difficulty 0.60, doc effect τ=0.7 probit, seeded.',
    );
    expect(out).toContain('~10.0 pp');
    expect(out).toContain('> grid');
    expect(out).toContain('shared difficulty 0.60');
    expect(out).toContain('not distinguishable on this corpus');
  });

  it('renders the noise floor with the adjective-free perfectly-reliable wording', () => {
    const out = renderNoiseFloorTable([
      { label: 'cord-v2 (n=196)', n: 196, mean: 0.084, p05: 0.058, p95: 0.114 },
    ]);
    expect(out).toContain('perfectly reliable');
    expect(out).toContain('0.084 [0.058–0.114]');
    expect(out).not.toMatch(/calibrated/i); // the copy ban has no fenced exception
  });
});

describe('SVG: consistency bands + single-dot risk-coverage', () => {
  const pts = Array.from({ length: 60 }, (_, i) => ({
    confidence: (i + 1) / 61,
    correct: i % 2 === 0,
  }));

  it('shades the consistency band when bands are provided', () => {
    const bands = [
      { meanConfidence: 0.2, lo: 0.1, hi: 0.35 },
      { meanConfidence: 0.5, lo: 0.4, hi: 0.62 },
      { meanConfidence: 0.8, lo: 0.7, hi: 0.9 },
    ];
    const svg = renderReliabilitySvg(
      pts,
      [
        { coverage: 0.5, error: 0.1 },
        { coverage: 1, error: 0.2 },
      ],
      15,
      bands,
    );
    expect(svg).toContain('data-role="consistency-band"');
    const without = renderReliabilitySvg(pts, [
      { coverage: 1, error: 0.2 },
      { coverage: 0.5, error: 0.1 },
    ]);
    expect(without).not.toContain('consistency-band');
  });

  it('renders one labeled dot — not a curve — for a single risk-coverage point', () => {
    const svg = renderReliabilitySvg(pts, [{ coverage: 1, error: 0.25 }]);
    expect(svg).toContain('data-role="single-dot"');
    expect(svg).toContain('no selective operation possible');
    expect(svg).not.toContain('<path d="M'); // no curve path in the rc panel
  });
});
