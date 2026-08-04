import { formatJsonSync } from '../kulala-core';
import type { Document, Block, Header } from './DocumentParser';

interface OpenAPIServer {
  url: string;
  description?: string;
  variables?: Record<
    string,
    {
      default: string;
      description?: string;
      enum?: string[];
    }
  >;
}

interface OpenAPIParameter {
  $ref?: string;
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie' | 'body' | 'formData';
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  example?: string | number | boolean;
  schema?: OpenAPISchema;
  type?: string;
}

interface OpenAPISchema {
  $ref?: string;
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  format?: string;
  properties?: Record<string, OpenAPISchema>;
  items?: OpenAPISchema;
  required?: string[];
  description?: string;
  example?: OpenAPISchemaExample;
  default?: OpenAPISchemaExample;
}

type OpenAPISchemaExample =
  | string
  | number
  | boolean
  | null
  | OpenAPISchemaExample[]
  | { [key: string]: OpenAPISchemaExample };

interface OpenAPIRequestBody {
  $ref?: string;
  description?: string;
  required?: boolean;
  content: Record<
    string,
    {
      schema?: OpenAPISchema;
      example?: OpenAPISchemaExample;
    }
  >;
}

interface OpenAPIOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  consumes?: string[];
  produces?: string[];
  responses?: Record<
    string,
    {
      description: string;
      content?: Record<
        string,
        {
          schema: OpenAPISchema;
          example?: OpenAPISchemaExample;
        }
      >;
    }
  >;
}

interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  parameters?: OpenAPIParameter[];
}

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: OpenAPIServer[];
  paths: Record<string, OpenAPIPathItem>;
  components?: {
    schemas?: Record<string, OpenAPISchema>;
    parameters?: Record<string, OpenAPIParameter>;
    requestBodies?: Record<string, OpenAPIRequestBody>;
    responses?: Record<string, OpenAPIOperation['responses']>;
  };
}

interface Swagger2Spec {
  swagger: string;
  host?: string;
  basePath?: string;
  schemes?: string[];
  consumes?: string[];
  produces?: string[];
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Swagger2PathItem>;
  definitions?: Record<string, OpenAPISchema>;
  parameters?: Record<string, OpenAPIParameter>;
}

interface Swagger2PathItem {
  get?: Swagger2Operation;
  post?: Swagger2Operation;
  put?: Swagger2Operation;
  delete?: Swagger2Operation;
  patch?: Swagger2Operation;
  parameters?: OpenAPIParameter[];
}

type Swagger2Operation = OpenAPIOperation;

interface OpenAPIParser {
  parse(openAPISpec: OpenAPISpec): ParseResult;
}

interface ParseResult {
  documents: Document[];
  serverUrls: string[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

function isSwagger2Spec(spec: unknown): spec is Swagger2Spec {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    'swagger' in spec &&
    typeof (spec as Swagger2Spec).swagger === 'string'
  );
}

function rewriteSwaggerRefs<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteSwaggerRefs(item)) as T;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      if (record.$ref.startsWith('#/definitions/')) {
        return {
          ...record,
          $ref: record.$ref.replace('#/definitions/', '#/components/schemas/'),
        } as T;
      }
      if (record.$ref.startsWith('#/parameters/')) {
        return {
          ...record,
          $ref: record.$ref.replace('#/parameters/', '#/components/parameters/'),
        } as T;
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      result[key] = rewriteSwaggerRefs(entry);
    }
    return result as T;
  }

  return value;
}

function convertSwagger2ToOpenAPI(spec: Swagger2Spec): OpenAPISpec {
  const schemes = spec.schemes?.length ? spec.schemes : ['https'];
  const host = spec.host || 'localhost';
  const basePath = (spec.basePath || '').replace(/\/$/, '');

  const servers: OpenAPIServer[] = schemes.map((scheme) => ({
    url: `${scheme}://${host}${basePath}`,
  }));

  const paths: Record<string, OpenAPIPathItem> = {};

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const convertedPathItem: OpenAPIPathItem = {};

    if (pathItem.parameters) {
      convertedPathItem.parameters = pathItem.parameters;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const consumes = operation.consumes ?? spec.consumes ?? ['application/json'];
      const convertedOperation: OpenAPIOperation = { ...operation };
      const nonBodyParams: OpenAPIParameter[] = [];

      if (operation.parameters) {
        for (const param of operation.parameters) {
          if (param.in === 'body') {
            const contentType = consumes[0] || 'application/json';
            convertedOperation.requestBody = {
              required: param.required,
              content: {
                [contentType]: {
                  schema: param.schema,
                },
              },
            };
          } else if (param.in !== 'formData') {
            nonBodyParams.push(param);
          }
        }
        convertedOperation.parameters = nonBodyParams;
      }

      convertedPathItem[method] = convertedOperation;
    }

    paths[path] = convertedPathItem;
  }

  return rewriteSwaggerRefs({
    openapi: '3.0.0',
    info: spec.info,
    servers,
    paths,
    components: {
      schemas: spec.definitions,
      parameters: spec.parameters,
    },
  });
}

export function normalizeSpec(spec: unknown): OpenAPISpec {
  if (isSwagger2Spec(spec)) {
    return convertSwagger2ToOpenAPI(spec);
  }
  return spec as OpenAPISpec;
}

export class OpenAPIDocumentParser implements OpenAPIParser {
  private resolveRef<T extends object>(ref: string, spec: OpenAPISpec): T | undefined {
    const normalizedRef = ref.startsWith('#/definitions/')
      ? ref.replace('#/definitions/', '#/components/schemas/')
      : ref;

    if (!normalizedRef.startsWith('#/')) return undefined;

    const parts = normalizedRef.slice(2).split('/');
    let current: unknown = spec;

    for (const part of parts) {
      if (typeof current !== 'object' || current === null || !(part in current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current as T;
  }

  private resolveParameter(param: OpenAPIParameter, spec: OpenAPISpec): OpenAPIParameter {
    if (param.$ref) {
      const resolved = this.resolveRef<OpenAPIParameter>(param.$ref, spec);
      if (resolved) {
        return this.resolveParameter(resolved, spec);
      }
    }
    return param;
  }

  private mergeParameters(
    pathParams: OpenAPIParameter[] = [],
    operationParams: OpenAPIParameter[] = [],
    spec: OpenAPISpec,
  ): OpenAPIParameter[] {
    const merged = new Map<string, OpenAPIParameter>();

    for (const param of [...pathParams, ...operationParams]) {
      const resolved = this.resolveParameter(param, spec);
      merged.set(`${resolved.in}:${resolved.name}`, resolved);
    }

    return Array.from(merged.values());
  }

  private getParameterValue(param: OpenAPIParameter): string {
    if (param.example !== undefined) {
      return String(param.example);
    }
    if (param.schema?.example !== undefined && typeof param.schema.example !== 'object') {
      return String(param.schema.example);
    }
    if (param.schema?.default !== undefined && typeof param.schema.default !== 'object') {
      return String(param.schema.default);
    }
    return `{{${param.name}}}`;
  }

  private applyParameters(
    url: string,
    parameters: OpenAPIParameter[],
    spec: OpenAPISpec,
  ): { url: string; headers: Header[] } {
    const headers: Header[] = [];
    const queryParts: string[] = [];

    for (const param of parameters) {
      const resolved = this.resolveParameter(param, spec);
      const value = this.getParameterValue(resolved);

      switch (resolved.in) {
        case 'query':
          queryParts.push(`${encodeURIComponent(resolved.name)}=${value}`);
          break;
        case 'path':
          url = url.replace(`{${resolved.name}}`, value);
          break;
        case 'header':
          headers.push({ key: resolved.name, value });
          break;
        case 'cookie':
          headers.push({ key: 'Cookie', value: `${resolved.name}=${value}` });
          break;
      }
    }

    if (queryParts.length > 0) {
      const separator = url.includes('?') ? '&' : '?';
      url += separator + queryParts.join('&');
    }

    return { url, headers };
  }

  private resolveRequestBody(
    requestBody: OpenAPIRequestBody | undefined,
    spec: OpenAPISpec,
  ): OpenAPIRequestBody | undefined {
    if (!requestBody) return undefined;

    if (requestBody.$ref) {
      const resolved = this.resolveRef<OpenAPIRequestBody>(requestBody.$ref, spec);
      return resolved ? this.resolveRequestBody(resolved, spec) : undefined;
    }

    return requestBody;
  }

  private generateExampleFromSchema(
    schema: OpenAPISchema,
    spec: OpenAPISpec,
    visited = new Set<string>(),
  ): unknown {
    if (schema.$ref) {
      if (visited.has(schema.$ref)) {
        return {};
      }
      visited.add(schema.$ref);
      const resolved = this.resolveRef<OpenAPISchema>(schema.$ref, spec);
      if (resolved) {
        return this.generateExampleFromSchema(resolved, spec, visited);
      }
      return {};
    }

    if (schema.example !== undefined) {
      return schema.example;
    }

    switch (schema.type) {
      case 'string':
        return schema.format === 'date-time' ? new Date().toISOString() : 'string';
      case 'number':
      case 'integer':
        return 0;
      case 'boolean':
        return false;
      case 'array':
        return schema.items ? [this.generateExampleFromSchema(schema.items, spec, visited)] : [];
      case 'object':
      default: {
        const example: Record<string, unknown> = {};
        if (schema.properties) {
          for (const [key, prop] of Object.entries(schema.properties)) {
            example[key] = this.generateExampleFromSchema(prop, spec, visited);
          }
        }
        return example;
      }
    }
  }

  private buildRequestBlock(
    path: string,
    method: string,
    operation: OpenAPIOperation,
    pathParameters: OpenAPIParameter[] = [],
    spec: OpenAPISpec,
  ): Block {
    const parameters = this.mergeParameters(pathParameters, operation.parameters, spec);
    const { url, headers: paramHeaders } = this.applyParameters(path, parameters, spec);

    const block: Block = {
      requestSeparator: {
        text: null,
      },
      metadata: [],
      comments: [],
      request: {
        method: method.toUpperCase(),
        url,
        httpVersion: 'HTTP/1.1',
        headers: [...paramHeaders],
        body: null,
      },
      preRequestScripts: [],
      postRequestScripts: [],
      responseRedirect: null,
    };

    if (operation.summary) {
      block.comments.push(
        operation.summary
          .split('\n')
          .map((l) => `# ${l}`)
          .join('\n') + '\n',
      );
    }
    if (operation.description) {
      block.comments.push(
        operation.description
          .split('\n')
          .map((l) => `# ${l}`)
          .join('\n') + '\n',
      );
    }

    if (operation.operationId) {
      block.metadata.push({
        key: 'name',
        value: operation.operationId,
      });
    }

    const requestBody = this.resolveRequestBody(operation.requestBody, spec);
    if (requestBody?.content && block.request) {
      const contentTypes = Object.keys(requestBody.content);
      const preferred = contentTypes.find((ct) => ct.includes('json')) ?? contentTypes[0];

      if (preferred) {
        block.request.headers.push({
          key: 'Content-Type',
          value: preferred,
        });

        const mediaTypeObject = requestBody.content[preferred];
        if (mediaTypeObject?.example) {
          block.request.body = formatJsonSync(mediaTypeObject.example);
        } else if (mediaTypeObject?.schema) {
          const example = this.generateExampleFromSchema(mediaTypeObject.schema, spec);
          if (example !== undefined) block.request.body = formatJsonSync(example);
        }
      }
    }

    return block;
  }

  private extractServerIdentifier(server: OpenAPIServer): string {
    let identifier = server.url.replace(/^https?:\/\//, '');

    if (server.variables) {
      Object.entries(server.variables).forEach(([key, variable]) => {
        identifier = identifier.replace(`{${key}}`, variable.default || `[${key}]`);
      });
    }

    identifier = identifier.split(':')[0].split('/')[0];

    return identifier;
  }

  parse(openAPISpec: OpenAPISpec): ParseResult {
    if (!openAPISpec.servers || openAPISpec.servers.length === 0) {
      return {
        documents: [this.createDocument(openAPISpec)],
        serverUrls: ['default'],
      };
    }

    const documents = openAPISpec.servers.map((server, index) =>
      this.createDocument(openAPISpec, server, index),
    );

    const serverUrls = openAPISpec.servers.map((server) => this.extractServerIdentifier(server));

    return {
      documents,
      serverUrls,
    };
  }

  private buildFullUrl(path: string, server?: OpenAPIServer, serverIndex?: number): string {
    if (!server) {
      return path;
    }

    const cleanPath = path.replace(/^\//, '');

    let url = server.url;

    if (server.variables) {
      Object.keys(server.variables).forEach((key) => {
        url = url.replace(`{${key}}`, `{{${key}}}`);
      });
    }

    url = `{{baseUrl${serverIndex || ''}}}/${cleanPath}`;

    return url;
  }

  private createDocument(
    openAPISpec: OpenAPISpec,
    server?: OpenAPIServer,
    serverIndex?: number,
  ): Document {
    const document: Document = {
      variables: [],
      blocks: [],
    };

    if (server) {
      let serverUrl = server.url.replace(/\/$/, '');

      if (server.variables) {
        Object.keys(server.variables).forEach((key) => {
          serverUrl = serverUrl.replace(`{${key}}`, `{{${key}}}`);
        });
      }

      document.variables.push({
        key: `baseUrl${serverIndex || ''}`,
        value: serverUrl,
      });

      if (server.variables) {
        Object.entries(server.variables).forEach(([key, variable]) => {
          document.variables.push({
            key: key,
            value: variable.default,
          });
        });
      }
    }

    for (const [path, pathItem] of Object.entries(openAPISpec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;

        const block = this.buildRequestBlock(
          this.buildFullUrl(path, server, serverIndex),
          method,
          operation,
          pathItem.parameters,
          openAPISpec,
        );

        if (server?.description) {
          block.comments.unshift(`# Server: ${server.description}\n`);
        }

        document.blocks.push(block);
      }
    }

    return document;
  }
}
