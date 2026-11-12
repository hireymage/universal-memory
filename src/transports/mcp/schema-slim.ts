/**
 * Shrink the JSON Schema advertised by tools/list without changing the Zod
 * schema the server validates with.
 *
 * Verbose mode (the previous catalog) drops only the draft `$schema` keyword
 * and the long ISO calendar regex. Compact mode, the default, also flattens
 * discriminated unions, drops defaults the server still applies, and removes
 * keywords that repeat on every field (`additionalProperties: false`,
 * `minLength: 1`, record `propertyNames`).
 */

export type SchemaAdvertiseMode = 'compact' | 'verbose';

type JsonSchema = Record<string, unknown>;

interface StandardSchema {
  jsonSchema?: {
    input: (params: { target: string }) => JsonSchema;
    output: (params: { target: string }) => JsonSchema;
  };
  [key: string]: unknown;
}

const ISO_FORMATS = new Set(['date', 'date-time']);

export function advertiseSchema<T extends object>(schema: T, mode: SchemaAdvertiseMode): T {
  const std = (schema as { '~standard'?: StandardSchema })['~standard'];
  if (!std?.jsonSchema) return schema;
  const original = std.jsonSchema;
  const wrapped = Object.create(schema) as T;
  Object.defineProperty(wrapped, '~standard', {
    value: {
      ...std,
      jsonSchema: {
        input: (params: { target: string }) => projectSchema(original.input(params), mode),
        output: (params: { target: string }) => projectSchema(original.output(params), mode),
      },
    },
    configurable: true,
    enumerable: false,
  });
  return wrapped;
}

/** @deprecated Use advertiseSchema. Kept so older call sites keep the verbose strip. */
export function slimAdvertisedSchema<T extends object>(schema: T): T {
  return advertiseSchema(schema, 'verbose');
}

export function slimJsonSchema<T>(schema: T, mode: SchemaAdvertiseMode = 'verbose'): T {
  return projectSchema(schema, mode);
}

function projectSchema<T>(schema: T, mode: SchemaAdvertiseMode): T {
  const copy = structuredClone(schema);
  if (mode === 'compact') compactNode(copy);
  else stripAdvertisedNoise(copy);
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

function compactNode(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) compactNode(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const value of Object.values(obj)) compactNode(value);
  collapseOneOf(obj);
  stripCompactKeywords(obj);
}

function stripCompactKeywords(obj: Record<string, unknown>): void {
  delete obj.$schema;
  delete obj.default;
  if (typeof obj.format === 'string' && ISO_FORMATS.has(obj.format)) delete obj.pattern;
  if (obj.minLength === 1) delete obj.minLength;
  if (obj.additionalProperties === false) delete obj.additionalProperties;
  if (isEmptySchema(obj.additionalProperties)) delete obj.additionalProperties;
  if (isStringTypeOnly(obj.propertyNames)) delete obj.propertyNames;
  if ((obj.enum !== undefined || obj.const !== undefined || typeof obj.format === 'string') && obj.type === 'string') {
    delete obj.type;
  }
  if (Array.isArray(obj.required) && obj.required.length === 0) delete obj.required;
}

function isEmptySchema(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0;
}

function isStringTypeOnly(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return obj.type === 'string' && Object.keys(obj).length === 1;
}

/**
 * A Zod discriminated union advertises one full object per action. Models only
 * need the field names and the action enum; the server still rejects a branch
 * that is missing its own required fields.
 */
function collapseOneOf(obj: Record<string, unknown>): void {
  const branches = obj.oneOf;
  if (!Array.isArray(branches) || branches.length < 2) return;
  if (!branches.every(branch => isSchemaObject(branch) && isSchemaObject(branch.properties))) return;
  const objects = branches as Array<Record<string, unknown> & { properties: Record<string, unknown> }>;
  const shared = Object.keys(objects[0]!.properties).filter(key => objects.every(branch => key in branch.properties));
  const preferred = ['action', 'kind'].find(key => shared.includes(key) && objects.every(branch => enumValues(branch.properties[key])));
  const discriminator = preferred ?? shared.find(key => objects.every(branch => enumValues(branch.properties[key])));
  if (!discriminator) return;

  const values: string[] = [];
  const properties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  for (const branch of objects) {
    for (const value of enumValues(branch.properties[discriminator]) ?? []) {
      if (!values.includes(value)) values.push(value);
    }
    for (const [key, schema] of Object.entries(branch.properties)) {
      if (key === discriminator) continue;
      properties[key] = properties[key] === undefined ? schema : mergeSchemas(properties[key], schema);
    }
    const required = Array.isArray(branch.required) ? branch.required.filter((key): key is string => typeof key === 'string') : [];
    for (const key of required) {
      if (key === discriminator) continue;
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }
  const required = [discriminator, ...[...requiredCounts.entries()].filter(([, count]) => count === objects.length).map(([key]) => key)];
  delete obj.oneOf;
  obj.type = 'object';
  obj.properties = { [discriminator]: { enum: values }, ...properties };
  obj.required = required;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function enumValues(schema: unknown): string[] | undefined {
  if (!isSchemaObject(schema)) return undefined;
  if (typeof schema.const === 'string') return [schema.const];
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(item => typeof item === 'string')) {
    return schema.enum as string[];
  }
  return undefined;
}

function mergeSchemas(left: unknown, right: unknown): unknown {
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  const leftValues = enumValues(left);
  const rightValues = enumValues(right);
  if (leftValues && rightValues) {
    const enumValuesMerged = [...leftValues];
    for (const value of rightValues) if (!enumValuesMerged.includes(value)) enumValuesMerged.push(value);
    return { enum: enumValuesMerged };
  }
  return JSON.stringify(left).length >= JSON.stringify(right).length ? left : right;
}
