/**
 * README copy-lint.
 *
 * The README carries the verbatim "thin CLI, not a platform" positioning statement; this test
 * pins it. Two assertions:
 *   1. the verbatim statement is PRESENT in the README, byte-for-byte;
 *   2. the forbidden self-description words `dashboard | leaderboard | hosted | platform |
 *      history store` NEVER appear as a self-description — they may appear ONLY inside the two
 *      sanctioned negation clauses ("not a platform" / "NOT a hosted service, leaderboard,
 *      dashboard, or eval history store"). Anywhere else is a positioning regression.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const README = join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md');

/**
 * The verbatim positioning statement — must appear byte-for-byte. The README must carry no
 * internal doc citations — internal references are forbidden in public artifacts — so the
 * pinned statement is the reader-facing wording.
 */
const VERBATIM =
  '**velrim-eval is a thin CLI, not a platform.** Golden set in → per-field F1 + reliability ' +
  'curve out → CI exit code. Five adapters (Velrim, OpenAI, Gemini, LlamaExtract, Mistral). It is deliberately ' +
  'NOT a hosted service, leaderboard, dashboard, or eval history store. It runs in your CI and ' +
  'writes files to your repo — your golden sets and baselines are yours. Every number it prints ' +
  'is YOUR measured result on YOUR golden set; it bakes in no Velrim accuracy claim.';

/** The two sanctioned negation clauses the forbidden words are ALLOWED to live inside. */
const SANCTIONED = [
  'not a platform',
  'NOT a hosted service, leaderboard, dashboard, or eval history store',
];

const FORBIDDEN = ['dashboard', 'leaderboard', 'hosted', 'platform', 'history store'];

describe('README copy-lint — thin CLI, not a platform', () => {
  const readme = readFileSync(README, 'utf8');

  it('contains the verbatim positioning statement', () => {
    expect(readme).toContain(VERBATIM);
  });

  it('never uses dashboard/leaderboard/hosted/platform/history store as a SELF-description', () => {
    // Remove the sanctioned negation clauses; whatever is left must not name a forbidden term.
    let residual = readme;
    for (const clause of SANCTIONED) {
      // Strip EVERY occurrence of each sanctioned clause (case-sensitive, as authored).
      residual = residual.split(clause).join('');
    }
    const lower = residual.toLowerCase();
    for (const word of FORBIDDEN) {
      expect(
        lower,
        `forbidden self-description "${word}" appears outside a sanctioned negation`,
      ).not.toContain(word);
    }
  });

  it('makes the "your number, not a Velrim claim" statement', () => {
    // The substance of the rule, stated without any internal rule citation (the README must carry none).
    expect(readme.toLowerCase()).toContain('your measured result on your golden set');
    expect(readme.toLowerCase()).toContain('bakes in no velrim accuracy claim');
  });
});
