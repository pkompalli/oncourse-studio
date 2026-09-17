/**
 * Deterministic content-schema validation.
 *
 * The guidelines step materializes a JSON Schema per format under
 * guidelines.format_specs[format].content_schema. This module compiles that schema
 * (cached) and checks a question's normalized `content` against it — used by
 * generation (to enforce its own output) and the validator (as a deterministic
 * pre-pass). If no schema is present (older guidelines), it is a no-op so nothing
 * regresses.
 */
import Ajv, { type ValidateFunction } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

// Compiled validators are cached by the schema object's identity.
const cache = new WeakMap<object, ValidateFunction | null>();

/** Resolve the stored content schema for a format (handles the tbs/task alias). */
export function contentSchemaFor(
  guidelines: Record<string, unknown> | undefined,
  format: string
): Record<string, unknown> | null {
  const specs = guidelines?.format_specs as Record<string, Record<string, unknown>> | undefined;
  if (!specs) return null;
  const spec =
    specs[format] ||
    (format === 'tbs' ? specs['task_based_simulation'] : undefined) ||
    (format === 'task_based_simulation' ? specs['tbs'] : undefined);
  const schema = spec?.content_schema;
  return schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : null;
}

/** Return human-readable schema violations for a content object (empty = valid or no schema). */
export function schemaErrorsFor(
  guidelines: Record<string, unknown> | undefined,
  format: string,
  content: unknown
): string[] {
  const schema = contentSchemaFor(guidelines, format);
  if (!schema) return [];
  let validate = cache.get(schema);
  if (validate === undefined) {
    try { validate = ajv.compile(schema); } catch { validate = null; }
    cache.set(schema, validate);
  }
  if (!validate) return []; // un-compilable schema — don't block
  if (validate(content)) return [];
  return (validate.errors || [])
    .slice(0, 12)
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`.trim());
}
