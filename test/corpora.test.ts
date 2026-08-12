import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCorpora,
  CONDITIONAL_PAGE_LIMIT,
  countPdfPages,
  formatCorpusSummary,
  nullableJsonSchemaFromPointers,
} from '../src/corpora/convert.js';
import { parseGoldenJsonl } from '../src/golden/loader.js';

const EVAL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

type Cell = { state: 'present'; value: unknown } | { state: 'null' } | { state: 'missing' };

interface GoldenFixtureRow {
  doc: string;
  docClass: string;
  fields: Record<string, Cell>;
}

interface FixturePaths {
  root: string;
  data: string;
  calTest: string;
  manifests: string;
  out: string;
}

function jsonl(rows: readonly GoldenFixtureRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

async function fixtureTree(
  docClass: string,
  sourceRows: readonly GoldenFixtureRow[],
  calTestRows: readonly GoldenFixtureRow[],
): Promise<FixturePaths> {
  const root = await mkdtemp(join(tmpdir(), 'velrim-eval-corpora-'));
  const paths = {
    root,
    data: join(root, 'data'),
    calTest: join(root, 'cal-test'),
    manifests: join(root, 'manifests'),
    out: join(root, 'out'),
  };
  await mkdir(join(paths.data, docClass), { recursive: true });
  await mkdir(join(paths.calTest, docClass), { recursive: true });
  await mkdir(paths.manifests, { recursive: true });
  await writeFile(join(paths.data, docClass, 'golden.jsonl'), jsonl(sourceRows));
  const frozen = jsonl(calTestRows);
  await writeFile(join(paths.calTest, docClass, 'golden.jsonl'), frozen);
  await writeFile(
    join(paths.manifests, `${docClass}.manifest.json`),
    JSON.stringify({
      class: docClass,
      calTestGoldenHash: createHash('sha256').update(frozen).digest('hex'),
    }),
  );
  for (const row of calTestRows) {
    await writeFile(join(paths.calTest, docClass, `${row.doc}.pdf`), '%PDF fixture');
  }
  return paths;
}

function buildOptions(paths: FixturePaths, pages: Readonly<Record<string, number>>) {
  return {
    sourceRoot: paths.data,
    calTestRoot: paths.calTest,
    manifestRoot: paths.manifests,
    outDir: paths.out,
    countPages(pdfPath: string): Promise<number> {
      const count = pages[basename(pdfPath)];
      if (count === undefined) throw new Error(`test has no page count for ${pdfPath}`);
      return Promise.resolve(count);
    },
  };
}

function blankPdf(pageCount: number): Uint8Array {
  const pageObjectIds = Array.from({ length: pageCount }, (_, index) => index + 3);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageObjectIds.map(
      () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>',
    ),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('nullableJsonSchemaFromPointers', () => {
  it('derives deterministic strict-compatible objects, shared arrays, and nullable leaves', () => {
    const pointers = [
      '/vendor',
      '/items/1/price',
      '/items/0/name',
      '/items/0/price',
      '/escaped~1key/~0value',
    ];
    const schema = nullableJsonSchemaFromPointers(pointers);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        'escaped/key': {
          type: 'object',
          properties: { '~value': { type: ['string', 'null'] } },
          required: ['~value'],
          additionalProperties: false,
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: ['string', 'null'] },
              price: { type: ['string', 'null'] },
            },
            required: ['name', 'price'],
            additionalProperties: false,
          },
        },
        vendor: { type: ['string', 'null'] },
      },
      required: ['escaped/key', 'items', 'vendor'],
      additionalProperties: false,
    });
    expect(JSON.stringify(nullableJsonSchemaFromPointers([...pointers].reverse()))).toBe(
      JSON.stringify(schema),
    );
  });

  it('fails closed on root, leaf/container, and object/array pointer conflicts', () => {
    expect(() => nullableJsonSchemaFromPointers([''])).toThrow(/root pointer/);
    expect(() => nullableJsonSchemaFromPointers(['/a~2b'])).toThrow(/invalid escape/);
    expect(() => nullableJsonSchemaFromPointers(['/a~'])).toThrow(/invalid escape/);
    expect(() => nullableJsonSchemaFromPointers(['/a', '/a/b'])).toThrow(/existing leaf/);
    expect(() => nullableJsonSchemaFromPointers(['/a/x', '/a/0'])).toThrow(/object path/);
  });
});

describe('buildCorpora', () => {
  const docClass = 'invoices.v1';
  const selectedA: GoldenFixtureRow = {
    doc: 'alpha.v2',
    docClass,
    fields: {
      '/vendor': { state: 'present', value: 'ACME' },
      '/tax': { state: 'missing' },
      '/items/0/name': { state: 'present', value: 'Widget' },
    },
  };
  const selectedB: GoldenFixtureRow = {
    doc: 'beta',
    docClass,
    fields: {
      '/vendor': { state: 'present', value: 'Example LLC' },
      '/tax': { state: 'null' },
      '/items/0/name': { state: 'missing' },
      '/items/0/price': { state: 'present', value: '10.00' },
    },
  };
  const devOnly: GoldenFixtureRow = {
    doc: 'not-cal-test',
    docClass,
    fields: { '/vendor': { state: 'present', value: 'DEV' } },
  };

  it('filters by exact PDF filename, preserves fields, stamps schemas, and freezes both branches', async () => {
    // Source order is intentionally different from CAL-TEST filename order.
    const paths = await fixtureTree(
      docClass,
      [selectedB, devOnly, selectedA],
      [selectedB, selectedA],
    );
    const summary = await buildCorpora(
      buildOptions(paths, { 'alpha.v2.pdf': CONDITIONAL_PAGE_LIMIT, 'beta.pdf': 9 }),
    );

    const outputRows = (await readFile(join(paths.out, `golden.${docClass}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(outputRows.map((row) => row['doc'])).toEqual(['alpha.v2.pdf', 'beta.pdf']);
    expect(outputRows[0]).toEqual({
      doc: 'alpha.v2.pdf',
      docClass,
      schema: `${docClass}.schema.json`,
      fields: selectedA.fields,
    });
    expect(outputRows[1]?.['fields']).toEqual(selectedB.fields);

    expect(summary.branches).toEqual({
      capRemoved: { documents: 2, fields: 7, goldenAbsentFields: 2, pages: 17 },
      capConfirmed: { documents: 1, fields: 3, goldenAbsentFields: 1, pages: 8 },
    });
    expect(summary.conditionalExclusions).toEqual([
      {
        docClass,
        doc: 'beta.pdf',
        pages: 9,
        fields: 4,
        goldenAbsentFields: 1,
      },
    ]);
    expect(summary.classes[docClass]?.pageHistogram).toEqual({ '8': 1, '9': 1 });
    expect(JSON.parse(await readFile(join(paths.out, 'corpus-counts.json'), 'utf8'))).toEqual(
      summary,
    );
    expect(formatCorpusSummary(summary)).toContain(
      'cap-confirmed primary: 1 docs, 8 pages, 3 fields, 1 absent',
    );

    const schema = JSON.parse(
      await readFile(join(paths.out, `${docClass}.schema.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(schema['required']).toEqual(['items', 'tax', 'vendor']);
  });

  it('rejects a frozen golden whose bytes no longer match its write-once manifest', async () => {
    const paths = await fixtureTree(docClass, [selectedA], [selectedA]);
    await writeFile(
      join(paths.manifests, `${docClass}.manifest.json`),
      JSON.stringify({ class: docClass, calTestGoldenHash: '0'.repeat(64) }),
    );
    await expect(buildCorpora(buildOptions(paths, { 'alpha.v2.pdf': 1 }))).rejects.toThrow(
      /does not match manifest/,
    );
  });

  it('rejects drift between the full source golden and the frozen CAL-TEST copy', async () => {
    const changed = {
      ...selectedA,
      fields: { ...selectedA.fields, '/tax': { state: 'present', value: '99' } as const },
    };
    const paths = await fixtureTree(docClass, [changed], [selectedA]);
    await expect(buildCorpora(buildOptions(paths, { 'alpha.v2.pdf': 1 }))).rejects.toThrow(
      /differs from the frozen split/,
    );
  });

  it('rejects a CAL-TEST PDF without a matching source row and invalid page counts', async () => {
    const unmatched = await fixtureTree(docClass, [devOnly], [selectedA]);
    await expect(buildCorpora(buildOptions(unmatched, { 'alpha.v2.pdf': 1 }))).rejects.toThrow(
      /has no source golden row/,
    );

    const invalidPageCount = await fixtureTree(docClass, [selectedA], [selectedA]);
    await expect(
      buildCorpora(buildOptions(invalidPageCount, { 'alpha.v2.pdf': 0 })),
    ).rejects.toThrow(/invalid page count/);
  });
});

describe('committed bake-off corpus artifacts', () => {
  it('pin the full frozen counts, schema stamps, and strict-nullable pointer unions', async () => {
    const corporaDir = join(EVAL_ROOT, 'corpora');
    const summary = JSON.parse(await readFile(join(corporaDir, 'corpus-counts.json'), 'utf8')) as {
      branches: Record<
        string,
        { documents: number; fields: number; goldenAbsentFields: number; pages: number }
      >;
      conditionalExclusions: unknown[];
      classes: Record<string, unknown>;
    };
    expect(summary.branches).toEqual({
      capRemoved: { documents: 124, fields: 2102, goldenAbsentFields: 142, pages: 319 },
      capConfirmed: { documents: 120, fields: 2068, goldenAbsentFields: 141, pages: 270 },
    });
    expect(summary.conditionalExclusions).toEqual([
      {
        docClass: 'deepform',
        doc: 'deepform-53c10b8d-b592-db3f-9a30-e6729046e7ce.pdf',
        pages: 12,
        fields: 5,
        goldenAbsentFields: 0,
      },
      {
        docClass: 'deepform',
        doc: 'deepform-7b0e54d3-76bc-5e87-6c44-0fe4e534cf80.pdf',
        pages: 12,
        fields: 5,
        goldenAbsentFields: 0,
      },
      {
        docClass: 'deepform',
        doc: 'deepform-d42b3339-ef69-384f-3e5b-b21169b04816.pdf',
        pages: 14,
        fields: 5,
        goldenAbsentFields: 0,
      },
      {
        docClass: 'vrdu-ad-buy',
        doc: '030a8ffe-9abb-57ad-2e82-58312730c0f6.pdf',
        pages: 11,
        fields: 19,
        goldenAbsentFields: 1,
      },
    ]);

    const expectedRows: Record<string, number> = {
      'cord-v2': 15,
      deepform: 39,
      'vrdu-ad-buy': 22,
      'vrdu-registration': 48,
    };
    for (const docClass of Object.keys(expectedRows).sort()) {
      const goldenText = await readFile(join(corporaDir, `golden.${docClass}.jsonl`), 'utf8');
      const rows = parseGoldenJsonl(goldenText);
      expect(rows).toHaveLength(expectedRows[docClass]!);
      expect(rows.every((row) => row.doc.endsWith('.pdf'))).toBe(true);
      expect(rows.every((row) => row.schema === `${docClass}.schema.json`)).toBe(true);
      expect(rows.every((row) => row.golden.docClass === docClass)).toBe(true);

      const pointers = new Set(rows.flatMap((row) => Object.keys(row.golden.fields)));
      const schema = JSON.parse(
        await readFile(join(corporaDir, `${docClass}.schema.json`), 'utf8'),
      ) as object;
      expect(schema).toEqual(nullableJsonSchemaFromPointers(pointers));
    }
  });
});

describe('countPdfPages', () => {
  it('uses real pdfjs-serverless page-tree counting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velrim-eval-pdf-pages-'));
    const pdf = join(root, 'two-pages.pdf');
    await writeFile(pdf, blankPdf(2));
    await expect(countPdfPages(pdf)).resolves.toBe(2);
  });
});
