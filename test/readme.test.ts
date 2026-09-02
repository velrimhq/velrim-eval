/**
 * README copy-lint.
 *
 * The README carries the verbatim positioning statement; this test pins it. Two assertions:
 *   1. the verbatim statement is PRESENT in the README, byte-for-byte;
 *   2. the forbidden self-description words `dashboard | leaderboard | hosted | platform |
 *      history store` NEVER appear as a self-description — they may appear ONLY inside the
 *      sanctioned negation clause ("There is no hosted service, leaderboard or history store").
 *      Anywhere else is a positioning regression.
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
  'velrim-eval runs in your CI, reads your golden set, writes files into your repo, and exits 0 ' +
  'or 1. There is no hosted service, leaderboard or history store, and it bakes in no claim ' +
  "about Velrim's accuracy. Every number it prints is your result on your documents.";

/** The sanctioned negation clause the forbidden words are ALLOWED to live inside. */
const SANCTIONED = ['There is no hosted service, leaderboard or history store'];

const FORBIDDEN = ['dashboard', 'leaderboard', 'hosted', 'platform', 'history store'];

describe('README copy-lint — your number, not a Velrim claim', () => {
  const readme = readFileSync(README, 'utf8');

  it('contains the verbatim positioning statement', () => {
    expect(readme).toContain(VERBATIM);
  });

  it('never uses dashboard/leaderboard/hosted/platform/history store as a SELF-description', () => {
    // Remove the sanctioned negation clause; whatever is left must not name a forbidden term.
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
    expect(readme.toLowerCase()).toContain('your result on your documents');
    expect(readme.toLowerCase()).toContain("bakes in no claim about velrim's accuracy");
  });
});
