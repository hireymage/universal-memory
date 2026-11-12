/**
 * Shrink the JSON Schema advertised by tools/list without changing the Zod
 * schema the server validates with. `$schema` is repeated on every tool, and
 * `z.iso.date()` / `z.iso.datetime()` embed a long calendar regex that clients
 * do not need: `format` is enough on the wire. Invalid values still fail
 * `~standard.validate` with the same Zod issue.
 */

type JsonSchema = Record<string, unknown>;

interface StandardSchema {
  jsonSchema?: {
    input: (params: { target: string }) => JsonSchema;
    output: (params: { target: string }) => JsonSchema;
  };
  [key: string]: unknown;
}

const ISO_FORMATS = new Set(['date', 'date-time']);
const slimmed = new WeakSet<object>();

export function slimAdvertisedSchema<T extends object>(schema: T): T {
  if (slimmed.has(schema)) return schema;
  const std = (schema as { '~standard'?: StandardSchema })['~standard'];
  if (!std?.jsonSchema) return schema;
  const original = std.jsonSchema;
  const jsonSchema = {
    input: (params: { target: string }) => slimJsonSchema(original.input(params)),
    output: (params: { target: string }) => slimJsonSchema(original.output(params)),
  };
  Object.defineProperty(schema, '~standard', {
    value: { ...std, jsonSchema },
    configurable: true,
    enumerable: false,
  });
  slimmed.add(schema);
  return schema;
}

export function slimJsonSchema<T>(schema: T): T {
  const copy = structuredClone(schema);
  stripAdvertisedNoise(copy);
  return copy;
}

function stripAdvertisedNoise(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) stripAdvertisedNoise(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  delete obj.$schema;
  if (typeof obj.format === 'string' && ISO_FORMATS.has(obj.format)) delete obj.pattern;
  for (const value of Object.values(obj)) stripAdvertisedNoise(value);
}
