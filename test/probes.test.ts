/**
 * Probe selection — the mechanics proven: zero-discretion seeded sampling from real
 * sibling-schema pools, class-level inapplicability by construction, nullable probe leaves,
 * all-`missing` probe goldens, worksheet completeness, and a drift tripwire pinning
 * the COMMITTED corpora/probes artifacts to regeneration from the committed schemas+goldens
 * (the probe list is hashed into the pre-registration — silent drift would fork it).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PROBES_PER_CLASS,
  PROBE_SELECTION_SEED,
  buildProbeGoldenJsonl,
  buildProbeSchema,
  buildWorksheetMarkdown,
  enumerateLeafFields,
  probeSearchTokens,
  selectProbes,
} from '../src/fabrication/probes.js';
import { parseGoldenJsonl } from '../src/golden/loader.js';

const CORPORA = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpora');
const PROBES_DIR = join(CORPORA, 'probes');

function loadCommittedSchemas(): Record<string, object> {
  const classes = readdirSync(CORPORA)
    .filter((name) => /^golden\.[^.]+\.jsonl$/.test(name))
    .map((name) => name.slice('golden.'.length, -'.jsonl'.length))
    .sort();
  return Object.fromEntries(
    classes.map((docClass) => [
      docClass,
      JSON.parse(readFileSync(join(CORPORA, `${docClass}.schema.json`), 'utf8')) as object,
    ]),
  );
}

describe('mechanical probe selection (published seed, zero discretion)', () => {
  const SCHEMAS: Record<string, object> = {
    alpha: {
      type: 'object',
      properties: {
        a1: { type: ['string', 'null'] },
        a2: { type: ['string', 'null'] },
        shared: { type: ['string', 'null'] },
        table: { type: 'array' },
      },
      required: ['a1', 'a2', 'shared', 'table'],
      additionalProperties: false,
    },
    beta: {
      type: 'object',
      properties: {
        b1: { type: ['string', 'null'] },
        b2: { type: ['string', 'null'] },
        b3: { type: ['string', 'null'] },
        shared: { type: ['string', 'null'] },
      },
      required: ['b1', 'b2', 'b3', 'shared'],
      additionalProperties: false,
    },
    gamma: {
      type: 'object',
      properties: {
        g1: { type: ['string', 'null'] },
        g2: { type: ['string', 'null'] },
        g3: { type: ['string', 'null'] },
      },
      required: ['g1', 'g2', 'g3'],
      additionalProperties: false,
    },
  };

  it('enumerates only nullable scalar leaves (arrays and containers never transplant)', () => {
    expect(enumerateLeafFields(SCHEMAS['alpha']!)).toEqual(['a1', 'a2', 'shared']);
  });

  it('pools exclude target-schema collisions — class-level inapplicability by construction', () => {
    const selection = selectProbes(SCHEMAS, 7, 2);
    for (const [target, pool] of Object.entries(selection.candidatePools)) {
      const targetFields = new Set(
        Object.keys((SCHEMAS[target] as { properties: object }).properties),
      );
      for (const candidate of pool) {
        expect(targetFields.has(candidate.field)).toBe(false);
        expect(candidate.sourceClass).not.toBe(target);
      }
    }
    // 'shared' exists in alpha AND beta → never a probe for either, but fine for gamma... no:
    // gamma does not define 'shared', so it IS a legitimate gamma candidate.
    expect(selection.candidatePools['alpha']!.some((c) => c.field === 'shared')).toBe(false);
    expect(selection.candidatePools['gamma']!.some((c) => c.field === 'shared')).toBe(true);
  });

  it('is deterministic per seed, samples without replacement, and publishes provenance', () => {
    const first = selectProbes(SCHEMAS, 42, 2);
    const second = selectProbes(SCHEMAS, 42, 2);
    expect(second).toEqual(first);
    const other = selectProbes(SCHEMAS, 43, 2);
    expect(JSON.stringify(other.probes)).not.toBe(JSON.stringify(first.probes));
    for (const probes of Object.values(first.probes)) {
      expect(probes).toHaveLength(2);
      expect(new Set(probes.map((p) => p.field)).size).toBe(2); // without replacement
      for (const probe of probes) expect(typeof probe.sourceClass).toBe('string');
    }
  });

  it('throws when a pool cannot supply the probe count (padding is never invented)', () => {
    expect(() =>
      selectProbes(
        {
          a: { properties: { x: { type: ['string', 'null'] } } },
          b: { properties: { x: { type: ['string', 'null'] } } },
        },
        1,
        1,
      ),
    ).toThrow(/candidate pool/);
  });
});

describe('probe schema variant + probe golden (every probe leaf nullable)', () => {
  const classSchema = {
    type: 'object',
    properties: { total: { type: ['string', 'null'] } },
    required: ['total'],
    additionalProperties: false,
  };
  const probes = [{ field: 'agency', sourceClass: 'vrdu-ad-buy' }];

  it('appends probes as nullable required leaves and never touches existing fields', () => {
    const variant = buildProbeSchema(classSchema, probes) as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(variant.properties['agency']).toEqual({ type: ['string', 'null'] });
    expect(variant.properties['total']).toEqual({ type: ['string', 'null'] });
    expect(variant.required).toEqual(['total', 'agency']);
    expect(variant.additionalProperties).toBe(false);
    // The input schema is not mutated (headline accuracy runs on the untouched original).
    expect((classSchema.properties as Record<string, unknown>)['agency']).toBeUndefined();
    expect(() => buildProbeSchema(classSchema, [{ field: 'total', sourceClass: 'x' }])).toThrow(
      /already exists/,
    );
  });

  it('emits one all-missing golden row per doc, referencing the probe schema variant', () => {
    const rows = parseGoldenJsonl(
      '{"doc":"a.pdf","docClass":"c","fields":{"/total":{"state":"present","value":"1"}}}\n' +
        '{"doc":"b.pdf","docClass":"c","fields":{"/total":{"state":"missing"}}}\n',
    );
    const jsonl = buildProbeGoldenJsonl(rows, probes, 'c.probe-schema.json');
    const parsed = parseGoldenJsonl(jsonl);
    expect(parsed).toHaveLength(2);
    for (const row of parsed) {
      expect(row.schema).toBe('c.probe-schema.json');
      expect(Object.keys(row.golden.fields)).toEqual(['/agency']);
      expect(row.golden.fields['/agency']!.state).toBe('missing');
    }
  });

  it('the worksheet has one row per probe×doc and names the seed', () => {
    const selection = selectProbes(
      {
        a: {
          properties: {
            x: { type: ['string', 'null'] },
            y: { type: ['string', 'null'] },
          },
        },
        b: {
          properties: {
            p: { type: ['string', 'null'] },
            q: { type: ['string', 'null'] },
          },
        },
      },
      9,
      2,
    );
    const sheet = buildWorksheetMarkdown(selection, { a: ['d1.pdf', 'd2.pdf'], b: ['d3.pdf'] });
    const dataRows = sheet.split('\n').filter((line) => /^\| [ab] \|/.test(line));
    expect(dataRows).toHaveLength(2 * 2 + 2 * 1); // probes×docs per class
    expect(sheet).toContain('Selection seed: 9');
    expect(sheet).toContain('visually absent?');
  });

  it('search tokens split snake_case into a spaced variant', () => {
    expect(probeSearchTokens('gross_amount')).toEqual(['gross_amount', 'gross amount']);
    expect(probeSearchTokens('agency')).toEqual(['agency']);
  });
});

describe('committed corpora/probes artifacts — drift tripwire (the probe list is pre-registered)', () => {
  it('probes.json regenerates bit-identically from the committed schemas at the published seed', () => {
    const committed = JSON.parse(readFileSync(join(PROBES_DIR, 'probes.json'), 'utf8')) as object;
    const regenerated = selectProbes(
      loadCommittedSchemas(),
      PROBE_SELECTION_SEED,
      PROBES_PER_CLASS,
    );
    expect(committed).toEqual(regenerated);
  });

  it('every committed probe-schema variant and probe golden matches regeneration', () => {
    const schemas = loadCommittedSchemas();
    const selection = selectProbes(schemas, PROBE_SELECTION_SEED, PROBES_PER_CLASS);
    for (const [docClass, schema] of Object.entries(schemas)) {
      const committedVariant = JSON.parse(
        readFileSync(join(PROBES_DIR, `${docClass}.probe-schema.json`), 'utf8'),
      ) as object;
      expect(committedVariant).toEqual(buildProbeSchema(schema, selection.probes[docClass]!));

      const goldenRows = parseGoldenJsonl(
        readFileSync(join(CORPORA, `golden.${docClass}.jsonl`), 'utf8'),
      );
      const committedGolden = readFileSync(
        join(PROBES_DIR, `golden.${docClass}.probe.jsonl`),
        'utf8',
      );
      expect(committedGolden).toBe(
        buildProbeGoldenJsonl(
          goldenRows,
          selection.probes[docClass]!,
          `${docClass}.probe-schema.json`,
        ),
      );
    }
  });

  it('every probe golden row is scoreable: docs match the class golden, all cells missing', () => {
    for (const docClass of Object.keys(loadCommittedSchemas())) {
      const classDocs = new Set(
        parseGoldenJsonl(readFileSync(join(CORPORA, `golden.${docClass}.jsonl`), 'utf8')).map(
          (row) => row.doc,
        ),
      );
      const probeRows = parseGoldenJsonl(
        readFileSync(join(PROBES_DIR, `golden.${docClass}.probe.jsonl`), 'utf8'),
      );
      expect(probeRows.length).toBe(classDocs.size);
      for (const row of probeRows) {
        expect(classDocs.has(row.doc)).toBe(true);
        expect(Object.keys(row.golden.fields)).toHaveLength(PROBES_PER_CLASS);
        for (const cell of Object.values(row.golden.fields)) expect(cell.state).toBe('missing');
      }
    }
  });
});
