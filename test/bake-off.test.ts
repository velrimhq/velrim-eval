/**
 * BAKE-OFF.md public-surface lint. The write-up is assembled from a draft by a script; these
 * assertions pin what must be true of the published file regardless of how it was produced:
 * no unfilled slots (the publication date is the one slot that stays open until release), no
 * internal reference IDs, every figure it embeds exists, the pre-registered sentences appear
 * byte-for-byte, and the banned word never appears reader-facing.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLE = join(ROOT, 'BAKE-OFF.md');
const PLAN = join(ROOT, 'ANALYSIS-PLAN.md');

const norm = (s: string): string => s.replace(/\s+/g, ' ');

describe('BAKE-OFF.md', () => {
  const md = readFileSync(ARTICLE, 'utf8');

  it('has no editorial residue: comments, unfilled slots (except the publication date), internal IDs', () => {
    expect(md).not.toContain('<!--');
    const slots = [...new Set(md.match(/\[\[[^\]]*\]\]/g) ?? [])];
    expect(slots.filter((s) => s !== '[[PUB-DATE]]')).toEqual([]);
    expect(md).not.toMatch(/\b(FD|FB|BO|RUL|Q)-\d+\b/);
  });

  it('embeds only figures that exist in ./figures', () => {
    const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) expect(existsSync(join(ROOT, ref))).toBe(true);
  });

  it('carries the pre-registered sentences byte-for-byte from ANALYSIS-PLAN.md', () => {
    const plan = norm(readFileSync(PLAN, 'utf8'));
    const tie =
      'is a statistical tie, and that tie is signed as publishable here, before any money is spent. A design that needs Velrim to win the F1 column is a failed design; this one does not.';
    const floor =
      'an arm whose confidence scores were perfectly reliable would still measure mean plug-in ECE 0.084 [0.058–0.114] at n=196';
    for (const s of [tie, floor]) {
      expect(plan).toContain(s);
      expect(norm(md)).toContain(s);
    }
  });

  it('never says "calibrated" to the reader (the CLI command name is the only allowed form)', () => {
    const body = md.replace(/`[^`]*calibrate[^`]*`/g, '').replace(/velrim-eval calibrate/g, '');
    expect(body).not.toMatch(/calibrat(ed|ion)\b/i);
  });

  it('escapes every dollar sign outside code fences (GitHub renders $…$ as math)', () => {
    const prose = md
      .split(/(\n```[\s\S]*?\n```)/)
      .filter((_, i) => i % 2 === 0)
      .join('');
    expect(prose).not.toMatch(/(^|[^\\])\$/);
    expect(prose).toContain('\\$26.42');
  });

  it('links the plan and the disclosure register', () => {
    expect(md).toContain('ANALYSIS-PLAN.md');
    expect(md).toContain('DISCLOSURES.md');
  });
});
