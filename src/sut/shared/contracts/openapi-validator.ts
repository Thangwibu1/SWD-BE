import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

/**
 * Validates SUT responses against schemas/sut-openapi.json. OpenAPI 3.1 schemas
 * are JSON Schema 2020-12, so component schemas are lifted into $defs and
 * compiled with Ajv in strict mode (no coercion, no property removal).
 */
export interface OpenApiDocument {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId: string;
        responses: Record<
          string,
          { $ref?: string; content?: { 'application/json'?: { schema: unknown } } }
        >;
      }
    >
  >;
  components: {
    schemas: Record<string, unknown>;
    responses: Record<string, { content: { 'application/json': { schema: unknown } } }>;
  };
}

export const SUT_OPENAPI_PATH = path.resolve('schemas/sut-openapi.json');

export function loadSutOpenApi(file = SUT_OPENAPI_PATH): OpenApiDocument {
  return JSON.parse(readFileSync(file, 'utf8')) as OpenApiDocument;
}

const rewriteRefs = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replaceAll('#/components/schemas/', 'sut#/$defs/')) as T;

export class SutContractValidator {
  private readonly ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
  });
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(private readonly doc: OpenApiDocument = loadSutOpenApi()) {
    // `description` is a standard annotation; nothing else non-standard is allowed.
    this.ajv.addSchema({ $id: 'sut', $defs: rewriteRefs(doc.components.schemas) });
  }

  /** Returns the response schema for (method, openapiPath, status) or throws if undeclared. */
  private responseSchema(method: string, openapiPath: string, status: number): unknown {
    const operation = this.doc.paths[openapiPath]?.[method.toLowerCase()];
    if (!operation) throw new Error(`Operation ${method} ${openapiPath} is not in the contract`);
    const response = operation.responses[String(status)];
    if (!response) throw new Error(`Status ${status} is not declared for ${method} ${openapiPath}`);
    if (response.$ref) {
      const name = response.$ref.split('/').pop() ?? '';
      return this.doc.components.responses[name]?.content['application/json'].schema;
    }
    return response.content?.['application/json']?.schema;
  }

  validate(
    method: string,
    openapiPath: string,
    status: number,
    body: unknown,
  ): { valid: boolean; errors: ErrorObject[] } {
    const key = `${method} ${openapiPath} ${status}`;
    let fn = this.cache.get(key);
    if (!fn) {
      const schema = this.responseSchema(method, openapiPath, status);
      fn = this.ajv.compile(rewriteRefs(schema as object));
      this.cache.set(key, fn);
    }
    const valid = fn(body) as boolean;
    return { valid, errors: valid ? [] : [...(fn.errors ?? [])] };
  }

  operations(): Array<{ method: string; path: string; operationId: string }> {
    return Object.entries(this.doc.paths).flatMap(([p, ops]) =>
      Object.entries(ops).map(([method, op]) => ({ method, path: p, operationId: op.operationId })),
    );
  }
}
