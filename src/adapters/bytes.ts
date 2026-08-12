/**
 * Byte helpers shared by the adapters' REQUEST CONSTRUCTION. The CLI is Node ≥20, so `Buffer`
 * is the canonical base64 encoder (no runtime dep). Kept out of `types.ts` so the frozen
 * adapter contract stays type-only.
 */

import { Buffer } from 'node:buffer';

/** Uint8Array → standard base64 (the encoding every adapter's wire body carries the doc in). */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
