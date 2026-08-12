/** Frozen request-language shared by every model-prompt bake-off arm. */

export const SHARED_EXTRACTION_INSTRUCTION =
  'Extract the following fields from the document. Return JSON matching this schema. ' +
  'Use null for fields not present in the document.';
