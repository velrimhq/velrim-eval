/**
 * Server-side Observable Plot → static SVG. Plot renders into a jsdom document; the pieces are
 * composed into one self-contained root `<svg>` (explicit xmlns, explicit background, explicit
 * fills, no `<script>`, no `<style>`, no `dominant-baseline`) so the figure renders identically
 * inside Markdown on any host and through a rasterizer.
 *
 * Shared grammar for every figure: one light surface, text in ink tokens (never a data color),
 * one accent hue plus its soft tint, red reserved for "wrong" and nothing else.
 */

import * as Plot from '@observablehq/plot';
import { JSDOM } from 'jsdom';

export const SURFACE = '#fcfcfb';
export const INK = '#0b0b0b';
export const INK_2 = '#52514e';
export const RULE = '#e4e3df';
export const ACCENT = '#7a6690';
export const ACCENT_SOFT = '#d8cfe3';
export const WRONG = '#e34948';
export const FONT = 'Geist, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';

let doc: Document | undefined;
const document = (): Document => (doc ??= new JSDOM('<!doctype html><body>').window.document);

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const pct = (v: number, d = 1): string => `${(100 * v).toFixed(d)}%`;

/**
 * Render a Plot spec to an SVG element. Mark groups given a `className` get that name copied
 * onto every child as `data-role`, which is the vocabulary the figure tests pin.
 */
export function plot(spec: Plot.PlotOptions): SVGSVGElement {
  const el = Plot.plot({
    ...spec,
    document: document(),
    style: { fontFamily: FONT, background: 'transparent', color: INK, overflow: 'visible' },
  });
  const svg = (el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg')) as SVGSVGElement;
  svg.querySelectorAll('style').forEach((s) => s.remove());
  svg
    .querySelectorAll('[dominant-baseline]')
    .forEach((n) => n.removeAttribute('dominant-baseline'));
  svg.querySelectorAll('g[class]').forEach((g) => {
    const role = g.getAttribute('class');
    if (!role) return;
    for (const child of Array.from(g.children)) child.setAttribute('data-role', role);
  });
  svg.setAttribute('font-family', FONT);
  svg.removeAttribute('class');
  return svg;
}

export interface Panel {
  svg: SVGSVGElement;
  x: number;
  y: number;
}

export interface FigureSpec {
  width: number;
  title?: string | undefined;
  ariaLabel?: string;
  subtitle?: string | undefined;
  panels: Panel[];
  /** Raw SVG fragments drawn on the root (labels, swatches, captions). */
  extra?: string[];
  /** Plain-words notes under the panels, one line each (wrapped to the width). */
  notes?: string[];
  /** Vertical space reserved above the notes (default 8). */
  notesGap?: number;
}

const HEADER_H = 64;
const NOTE_LINE = 15;

/** Wrap on spaces to a character budget derived from the width at the note font size. */
export function wrap(text: string, width: number, fontSize = 10.5): string[] {
  const budget = Math.floor((width - 32) / (fontSize * 0.52));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > budget) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Compose panels + header + notes into one root SVG string. */
export function composeFigure(spec: FigureSpec): string {
  const W = spec.width;
  let panelsBottom = spec.title ? HEADER_H : 0;
  const nested: string[] = [];
  for (const p of spec.panels) {
    const h = Number(p.svg.getAttribute('height'));
    p.svg.setAttribute('x', String(p.x));
    p.svg.setAttribute('y', String(p.y));
    panelsBottom = Math.max(panelsBottom, p.y + h);
    nested.push(p.svg.outerHTML.replace(/currentColor/g, INK));
  }
  const noteLines = (spec.notes ?? []).flatMap((n) => wrap(n, W));
  const notesTop = panelsBottom + (spec.notesGap ?? 8);
  const H = Math.ceil(notesTop + noteLines.length * NOTE_LINE + (noteLines.length ? 12 : 8));

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}" font-size="12" role="img" aria-label="${esc(spec.ariaLabel ?? spec.title ?? '')}">`,
  );
  out.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
  if (spec.title)
    out.push(
      `<text x="16" y="26" font-size="15" font-weight="600" fill="${INK}">${esc(spec.title)}</text>`,
    );
  if (spec.subtitle)
    out.push(`<text x="16" y="46" font-size="11.5" fill="${INK_2}">${esc(spec.subtitle)}</text>`);
  out.push(...nested);
  out.push(...(spec.extra ?? []));
  noteLines.forEach((line, i) => {
    out.push(
      `<text x="16" y="${(notesTop + 10 + i * NOTE_LINE).toFixed(1)}" font-size="10.5" fill="${INK_2}">${esc(line)}</text>`,
    );
  });
  out.push('</svg>');
  return out.join('\n');
}
