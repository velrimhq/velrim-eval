/**
 * Recursively flatten a provider's JSON object into RFC 6901 pointer-keyed leaves.
 *
 * Objects and arrays are containers only: object keys become escaped pointer tokens and array
 * positions become numeric tokens. Primitive values, including `null`, are emitted as leaves;
 * empty containers emit nothing. The caller owns any provider-specific field metadata.
 */
export function flattenJsonLeaves(root: Record<string, unknown>): Record<string, unknown> {
  const leaves: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    emitJsonLeaves(`/${escapeJsonPointerToken(key)}`, value, leaves);
  }
  return leaves;
}

function emitJsonLeaves(pointer: string, value: unknown, leaves: Record<string, unknown>): void {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => emitJsonLeaves(`${pointer}/${index}`, item, leaves));
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      emitJsonLeaves(`${pointer}/${escapeJsonPointerToken(key)}`, child, leaves);
    }
    return;
  }

  leaves[pointer] = value;
}

/** RFC 6901 token escaping: `~` becomes `~0`, then `/` becomes `~1`. */
export function escapeJsonPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
