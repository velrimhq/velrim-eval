/**
 * The four FROZEN normalizer tables (ANALYSIS-PLAN.md §5.2) — pinned against the committed
 * goldens they score.
 *
 * These files finalize with the frozen plan; this suite guards the two defects a diff review
 * can miss:
 *   1. a table that stops parsing under the CLI's validator (the run would hard-fail at Day 9);
 *   2. an UNREACHABLE table key — a pointer that no committed golden leaf wildcards onto, i.e.
 *      a normalizer that silently never fires (a typo'd pointer would otherwise publish a
 *      strict-scored leaf while the plan claims it normalizes).
 *
 * The kind ASSIGNMENTS themselves are pre-registered judgment calls (plan §5.2) — not asserted
 * here beyond validity.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoldenJsonl } from '../src/golden/loader.js';
import { parseNormalizerTable, wildcardPointer } from '../src/score/normalizers.js';

const EVAL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPORA = join(EVAL_ROOT, 'corpora');

const CLASSES = ['cord-v2', 'deepform', 'vrdu-ad-buy', 'vrdu-registration'] as const;

describe.each(CLASSES)('frozen normalizers.%s.json', (docClass) => {
  const tableText = readFileSync(join(CORPORA, `normalizers.${docClass}.json`), 'utf8');

  it('parses under the CLI validator, is non-empty, and is frozen for its own class', () => {
    const table = parseNormalizerTable(tableText);
    expect(table.docClass).toBe(docClass);
    expect(Object.keys(table.normalizers).length).toBeGreaterThan(0);
  });

  it('every table key is REACHED by at least one committed golden leaf', () => {
    const table = parseNormalizerTable(tableText);
    const goldenText = readFileSync(join(CORPORA, `golden.${docClass}.jsonl`), 'utf8');
    const reachable = new Set<string>();
    for (const row of parseGoldenJsonl(goldenText)) {
      for (const pointer of Object.keys(row.golden.fields)) {
        reachable.add(wildcardPointer(pointer));
      }
    }
    for (const key of Object.keys(table.normalizers)) {
      expect(reachable, `table key ${key} never matches a golden leaf`).toContain(key);
    }
  });
});
