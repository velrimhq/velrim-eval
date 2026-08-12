/**
 * Build the bake-off's public CAL-TEST goldens from the calibration corpora.
 *
 * The calibration harness keeps the full native goldens under `data/<class>/` and identifies the
 * held-out split by the PDF filenames under `cal-test/<class>/`. This module joins those two
 * sources without looking at the salted split ids, rewrites each golden `doc` to the real PDF
 * filename, derives one nullable extraction schema per class, and measures the conditional
 * Mistral page-limit branch with pdfjs.
 *
 * No model/API call is possible here. All inputs are local files and all outputs are deterministic.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseGoldenJsonl, type LoadedGolden } from '../golden/loader.js';

export const CONDITIONAL_PAGE_LIMIT = 8;
export const COUNTS_FILENAME = 'corpus-counts.json';

interface SchemaNode {
  leaf?: true;
  array?: SchemaNode;
  props?: Map<string, SchemaNode>;
}

export interface CorpusCounts {
  documents: number;
  fields: number;
  goldenAbsentFields: number;
  pages: number;
}

export interface PageCountEntry {
  doc: string;
  pages: number;
}

export interface ConditionalExclusion extends PageCountEntry {
  docClass: string;
  fields: number;
  goldenAbsentFields: number;
}

export interface ClassCorpusSummary {
  full: CorpusCounts;
  atOrBelowPageLimit: CorpusCounts;
  pageHistogram: Record<string, number>;
  pageCounts: PageCountEntry[];
  conditionalExclusions: ConditionalExclusion[];
}

export interface CorpusBuildSummary {
  formatVersion: 1;
  conditionalPageLimit: number;
  classes: Record<string, ClassCorpusSummary>;
  branches: {
    capRemoved: CorpusCounts;
    capConfirmed: CorpusCounts;
  };
  conditionalExclusions: ConditionalExclusion[];
}

export interface BuildCorporaOptions {
  /** `calibration/corpora/data`-shaped root containing `<class>/golden.jsonl`. */
  sourceRoot: string;
  /** `calibration/corpora/cal-test`-shaped root containing `<class>/*.pdf`. */
  calTestRoot: string;
  /** Root containing the write-once `<class>.manifest.json` split manifests. */
  manifestRoot: string;
  /** Destination for `golden.<class>.jsonl`, `<class>.schema.json`, and the count manifest. */
  outDir: string;
  /** Optional explicit class list. By default classes are discovered from `calTestRoot`. */
  classes?: readonly string[];
  /** Injectable only for deterministic unit tests; production uses pdfjs-serverless. */
  countPages?: PageCounter;
}

export type PageCounter = (pdfPath: string) => Promise<number>;

interface ConvertedGoldenRow {
  doc: string;
  docClass: string;
  schema: string;
  fields: LoadedGolden['golden']['fields'];
}

interface PreparedDoc {
  row: ConvertedGoldenRow;
  pages: number;
  fields: number;
  goldenAbsentFields: number;
}

interface PreparedClass {
  docClass: string;
  schema: object;
  rows: ConvertedGoldenRow[];
  summary: ClassCorpusSummary;
}

function unescapePointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new Error(`JSON Pointer token "${token}" contains an invalid escape`);
  }
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Split an RFC-6901 JSON Pointer into unescaped path segments. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') {
    throw new Error('the root pointer is not a valid extraction leaf');
  }
  if (!pointer.startsWith('/')) {
    throw new Error(`field key "${pointer}" is not an RFC-6901 JSON Pointer`);
  }
  return pointer.split('/').slice(1).map(unescapePointerToken);
}

function isArrayIndex(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function insertPointer(root: SchemaNode, pointer: string): void {
  let node = root;
  for (const segment of pointerSegments(pointer)) {
    if (node.leaf) {
      throw new Error(`field pointer "${pointer}" extends an existing leaf`);
    }
    if (isArrayIndex(segment)) {
      if (node.props !== undefined) {
        throw new Error(`field pointer "${pointer}" conflicts with an object path`);
      }
      node.array ??= {};
      node = node.array;
      continue;
    }
    if (node.array !== undefined) {
      throw new Error(`field pointer "${pointer}" conflicts with an array path`);
    }
    node.props ??= new Map<string, SchemaNode>();
    let child = node.props.get(segment);
    if (child === undefined) {
      child = {};
      node.props.set(segment, child);
    }
    node = child;
  }
  if (node.array !== undefined || node.props !== undefined) {
    throw new Error(`field pointer "${pointer}" terminates at an existing container`);
  }
  node.leaf = true;
}

function nodeToNullableSchema(node: SchemaNode): object {
  if (node.array !== undefined) {
    return { type: 'array', items: nodeToNullableSchema(node.array) };
  }
  if (node.props !== undefined) {
    const properties: Record<string, object> = {};
    const required = [...node.props.keys()].sort();
    for (const key of required) {
      properties[key] = nodeToNullableSchema(node.props.get(key)!);
    }
    // OpenAI's strict JSON-Schema mode requires every property to be named in `required` and
    // forbids additional properties. Nullable leaves preserve the abstention affordance even
    // though the key itself is required.
    return { type: 'object', properties, required, additionalProperties: false };
  }
  // Nullability is load-bearing for the constrained-mode fabrication comparison: an absent leaf
  // must be allowed to resolve to JSON null rather than being forced to fabricate a string.
  return { type: ['string', 'null'] };
}

/**
 * Port of Velrim's internal corpus JSON-Schema builder, with every terminal string leaf explicitly
 * nullable. Object keys remain sorted so schema bytes are stable regardless of golden row order.
 */
export function nullableJsonSchemaFromPointers(pointers: Iterable<string>): object {
  const root: SchemaNode = {};
  for (const pointer of pointers) insertPointer(root, pointer);
  if (root.props === undefined && root.array === undefined) {
    root.props = new Map<string, SchemaNode>();
  }
  return nodeToNullableSchema(root);
}

/** Count a PDF with the same pdfjs-serverless distribution used by the production extractor. */
export async function countPdfPages(pdfPath: string): Promise<number> {
  const bytes = new Uint8Array(await readFile(pdfPath));
  const { getDocument } = await import('pdfjs-serverless');
  const loadingTask = getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  try {
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      throw new Error(`pdfjs returned invalid page count ${String(document.numPages)}`);
    }
    return document.numPages;
  } finally {
    await document.destroy();
  }
}

function zeroCounts(): CorpusCounts {
  return { documents: 0, fields: 0, goldenAbsentFields: 0, pages: 0 };
}

function addCounts(target: CorpusCounts, source: CorpusCounts): void {
  target.documents += source.documents;
  target.fields += source.fields;
  target.goldenAbsentFields += source.goldenAbsentFields;
  target.pages += source.pages;
}

function countsForDocs(docs: readonly PreparedDoc[]): CorpusCounts {
  const counts = zeroCounts();
  for (const doc of docs) {
    counts.documents += 1;
    counts.fields += doc.fields;
    counts.goldenAbsentFields += doc.goldenAbsentFields;
    counts.pages += doc.pages;
  }
  return counts;
}

function sortedPdfNames(entries: readonly string[]): string[] {
  return entries.filter((name) => name.toLowerCase().endsWith('.pdf')).sort();
}

async function discoverClasses(calTestRoot: string): Promise<string[]> {
  const entries = await readdir(calTestRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function normalizeClasses(classes: readonly string[]): string[] {
  const normalized = [...new Set(classes.map((value) => value.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) throw new Error('no corpus classes selected');
  for (const docClass of normalized) {
    if (docClass === '.' || docClass === '..' || /[\\/]/.test(docClass)) {
      throw new Error(`invalid corpus class "${docClass}"`);
    }
  }
  return normalized;
}

async function prepareClass(
  docClass: string,
  options: Required<Pick<BuildCorporaOptions, 'sourceRoot' | 'calTestRoot' | 'manifestRoot'>>,
  countPages: PageCounter,
): Promise<PreparedClass> {
  const classCalTestDir = join(options.calTestRoot, docClass);
  const dirEntries = await readdir(classCalTestDir, { withFileTypes: true });
  const pdfNames = sortedPdfNames(
    dirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  if (pdfNames.length === 0) throw new Error(`${docClass}: CAL-TEST contains no PDF files`);

  const sourceGoldenPath = join(options.sourceRoot, docClass, 'golden.jsonl');
  const sourceRows = parseGoldenJsonl(await readFile(sourceGoldenPath, 'utf8'));
  const frozenGoldenText = await readFile(join(classCalTestDir, 'golden.jsonl'), 'utf8');
  const frozenRows = parseGoldenJsonl(frozenGoldenText);
  const manifestRaw = JSON.parse(
    await readFile(join(options.manifestRoot, `${docClass}.manifest.json`), 'utf8'),
  ) as unknown;
  if (typeof manifestRaw !== 'object' || manifestRaw === null || Array.isArray(manifestRaw)) {
    throw new Error(`${docClass}: split manifest is not a JSON object`);
  }
  const manifest = manifestRaw as Record<string, unknown>;
  if (manifest['class'] !== docClass || typeof manifest['calTestGoldenHash'] !== 'string') {
    throw new Error(`${docClass}: split manifest class/hash contract is invalid`);
  }
  const frozenHash = createHash('sha256').update(frozenGoldenText).digest('hex');
  if (frozenHash !== manifest['calTestGoldenHash']) {
    throw new Error(
      `${docClass}: frozen CAL-TEST golden hash ${frozenHash} does not match manifest ${manifest['calTestGoldenHash']}`,
    );
  }
  const sourceByPdfName = new Map<string, LoadedGolden>();
  for (const row of sourceRows) {
    if (row.golden.docClass !== docClass) {
      throw new Error(`${docClass}: source row "${row.doc}" has docClass "${row.golden.docClass}"`);
    }
    if (row.doc.toLowerCase().endsWith('.pdf')) {
      throw new Error(`${docClass}: source row "${row.doc}" already carries a .pdf suffix`);
    }
    const pdfName = `${row.doc}.pdf`;
    if (sourceByPdfName.has(pdfName)) {
      throw new Error(`${docClass}: duplicate source golden row for "${pdfName}"`);
    }
    sourceByPdfName.set(pdfName, row);
  }
  const frozenByPdfName = new Map<string, LoadedGolden>();
  for (const row of frozenRows) {
    const pdfName = row.doc.toLowerCase().endsWith('.pdf') ? row.doc : `${row.doc}.pdf`;
    if (frozenByPdfName.has(pdfName)) {
      throw new Error(`${docClass}: duplicate frozen CAL-TEST row for "${pdfName}"`);
    }
    frozenByPdfName.set(pdfName, row);
  }
  if (frozenByPdfName.size !== pdfNames.length) {
    throw new Error(
      `${docClass}: frozen CAL-TEST golden has ${frozenByPdfName.size} rows for ${pdfNames.length} PDFs`,
    );
  }

  const schemaFilename = `${docClass}.schema.json`;
  const preparedDocs: PreparedDoc[] = [];
  const pointers = new Set<string>();

  // Deliberately count sequentially: the real set is small (124 docs), while parsing every PDF in
  // parallel creates a needless peak-memory spike in the build step.
  for (const pdfName of pdfNames) {
    const source = sourceByPdfName.get(pdfName);
    if (source === undefined) {
      throw new Error(`${docClass}: CAL-TEST PDF "${pdfName}" has no source golden row`);
    }
    const frozen = frozenByPdfName.get(pdfName);
    if (frozen === undefined) {
      throw new Error(`${docClass}: CAL-TEST PDF "${pdfName}" has no frozen golden row`);
    }
    if (JSON.stringify(source.golden) !== JSON.stringify(frozen.golden)) {
      throw new Error(`${docClass}: source golden for "${pdfName}" differs from the frozen split`);
    }
    const fields = source.golden.fields;
    for (const pointer of Object.keys(fields)) {
      pointerSegments(pointer); // fail closed before writing an invalid public golden
      pointers.add(pointer);
    }
    const pages = await countPages(join(classCalTestDir, pdfName));
    if (!Number.isSafeInteger(pages) || pages < 1) {
      throw new Error(`${docClass}/${pdfName}: invalid page count ${String(pages)}`);
    }
    const fieldValues = Object.values(fields);
    preparedDocs.push({
      row: {
        doc: pdfName,
        docClass,
        schema: schemaFilename,
        fields,
      },
      pages,
      fields: fieldValues.length,
      // The bake-off's golden-absent denominator is the explicit `missing` state. `null` remains
      // a distinct third state and is never silently folded into this count.
      goldenAbsentFields: fieldValues.filter((field) => field.state === 'missing').length,
    });
  }

  const included = preparedDocs.filter((doc) => doc.pages <= CONDITIONAL_PAGE_LIMIT);
  const excluded = preparedDocs.filter((doc) => doc.pages > CONDITIONAL_PAGE_LIMIT);
  const histogram = new Map<number, number>();
  for (const doc of preparedDocs) histogram.set(doc.pages, (histogram.get(doc.pages) ?? 0) + 1);
  const pageHistogram: Record<string, number> = {};
  for (const pages of [...histogram.keys()].sort((a, b) => a - b)) {
    pageHistogram[String(pages)] = histogram.get(pages)!;
  }

  return {
    docClass,
    schema: nullableJsonSchemaFromPointers(pointers),
    rows: preparedDocs.map((doc) => doc.row),
    summary: {
      full: countsForDocs(preparedDocs),
      atOrBelowPageLimit: countsForDocs(included),
      pageHistogram,
      pageCounts: preparedDocs.map((doc) => ({ doc: doc.row.doc, pages: doc.pages })),
      conditionalExclusions: excluded.map((doc) => ({
        docClass,
        doc: doc.row.doc,
        pages: doc.pages,
        fields: doc.fields,
        goldenAbsentFields: doc.goldenAbsentFields,
      })),
    },
  };
}

function serializeSchema(schema: object): string {
  // Match the repository's Prettier JSON shape without taking a runtime formatter dependency in
  // the standalone public CLI. For these schemas, Prettier's only transformation beyond the
  // two-space JSON.stringify form is collapsing string-only arrays when they fit printWidth=100.
  const lines = JSON.stringify(schema, null, 2).split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const opener = /^(\s*"[^"]+": )\[$/.exec(lines[index]!);
    if (opener === null) {
      out.push(lines[index]!);
      continue;
    }
    const values: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const value = /^\s*("(?:[^"\\]|\\.)*")(?:,)?$/.exec(lines[cursor]!);
      if (value === null) break;
      values.push(value[1]!);
      cursor++;
    }
    const closer = /^\s*\](,?)$/.exec(lines[cursor] ?? '');
    const collapsed = `${opener[1]}[${values.join(', ')}]${closer?.[1] ?? ''}`;
    if (closer !== null && values.length > 0 && collapsed.length <= 100) {
      out.push(collapsed);
      index = cursor;
    } else {
      out.push(lines[index]!);
    }
  }
  return out.join('\n') + '\n';
}

/** Build and write every selected class. All reads/counts finish before the first output write. */
export async function buildCorpora(options: BuildCorporaOptions): Promise<CorpusBuildSummary> {
  const classes = normalizeClasses(options.classes ?? (await discoverClasses(options.calTestRoot)));
  const countPages = options.countPages ?? countPdfPages;
  const prepared: PreparedClass[] = [];
  for (const docClass of classes) {
    prepared.push(await prepareClass(docClass, options, countPages));
  }

  const full = zeroCounts();
  const atOrBelowPageLimit = zeroCounts();
  const classSummaries: Record<string, ClassCorpusSummary> = {};
  const conditionalExclusions: ConditionalExclusion[] = [];
  for (const corpus of prepared) {
    classSummaries[corpus.docClass] = corpus.summary;
    addCounts(full, corpus.summary.full);
    addCounts(atOrBelowPageLimit, corpus.summary.atOrBelowPageLimit);
    conditionalExclusions.push(...corpus.summary.conditionalExclusions);
  }

  const summary: CorpusBuildSummary = {
    formatVersion: 1,
    conditionalPageLimit: CONDITIONAL_PAGE_LIMIT,
    classes: classSummaries,
    branches: { capRemoved: full, capConfirmed: atOrBelowPageLimit },
    conditionalExclusions,
  };

  await mkdir(options.outDir, { recursive: true });
  for (const corpus of prepared) {
    await writeFile(
      join(options.outDir, `golden.${corpus.docClass}.jsonl`),
      corpus.rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      join(options.outDir, `${corpus.docClass}.schema.json`),
      serializeSchema(corpus.schema),
      'utf8',
    );
  }
  await writeFile(
    join(options.outDir, COUNTS_FILENAME),
    JSON.stringify(summary, null, 2) + '\n',
    'utf8',
  );
  return summary;
}

function formatCounts(counts: CorpusCounts): string {
  return `${counts.documents} docs, ${counts.pages} pages, ${counts.fields} fields, ${counts.goldenAbsentFields} absent`;
}

/** Human-readable exact counts intended to paste into the public analysis plan. */
export function formatCorpusSummary(summary: CorpusBuildSummary): string {
  const lines: string[] = [];
  for (const docClass of Object.keys(summary.classes).sort()) {
    const classSummary = summary.classes[docClass]!;
    lines.push(`${docClass}: full ${formatCounts(classSummary.full)}`);
    lines.push(
      `${docClass}: <=${summary.conditionalPageLimit}pp ${formatCounts(classSummary.atOrBelowPageLimit)}`,
    );
  }
  lines.push(`cap-removed primary: ${formatCounts(summary.branches.capRemoved)}`);
  lines.push(`cap-confirmed primary: ${formatCounts(summary.branches.capConfirmed)}`);
  lines.push(`conditional exclusions (>${summary.conditionalPageLimit}pp):`);
  if (summary.conditionalExclusions.length === 0) {
    lines.push('  none');
  } else {
    for (const excluded of summary.conditionalExclusions) {
      lines.push(
        `  ${excluded.docClass}/${excluded.doc}: ${excluded.pages} pages, ${excluded.fields} fields, ${excluded.goldenAbsentFields} absent`,
      );
    }
  }
  return lines.join('\n') + '\n';
}
