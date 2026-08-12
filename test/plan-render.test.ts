/**
 * ANALYSIS-PLAN.md render-safety tripwire: KaTeX-aware markdown renderers (GitHub included)
 * treat bare `$…$` pairs as inline math and typeset everything between them as an italic
 * formula — silently destroying the prose. Every dollar amount in the plan must therefore
 * live inside a backtick code span, where no renderer interprets it. This test fails on ANY
 * bare `$` outside a code span, so an edit can never reintroduce the mangling.
 *
 * Code spans may legitimately straddle a prettier line wrap (CommonMark allows newlines
 * inside a span), so the checks are document-scoped: fenced blocks are removed first, then
 * every `…` span (spans cannot nest), and the remainder must be dollar-free with an even
 * backtick count.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLAN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ANALYSIS-PLAN.md');

/** The plan text with fenced code blocks removed (never math-parsed by renderers). */
function withoutFences(text: string): string {
  return text.replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, '');
}

describe('ANALYSIS-PLAN.md — render safety', () => {
  const unfenced = withoutFences(readFileSync(PLAN_PATH, 'utf8'));

  it('has an even number of backticks outside fences (an unpaired tick un-protects its span)', () => {
    const ticks = (unfenced.match(/`/g) ?? []).length;
    expect(ticks % 2).toBe(0);
  });

  it('has no bare $ outside code spans (KaTeX/GitHub math-mangling guard)', () => {
    // Strip every `…` span (spans cannot nest; [^`]* crosses prettier line wraps).
    const prose = unfenced.replace(/`[^`]*`/g, '');
    const offenders = prose
      .split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes('$'))
      .map(({ line, i }) => `stripped-line ${i + 1}: ${line.trim()}`);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
