import { basename, dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { formatJsonSync } from '../kulala-core';
import type { KulalaParsedDocument } from '../kulala-core/types';

interface PostmanVariable {
  key: string;
  value: string;
  type?: string;
}

interface PostmanHeader {
  key: string;
  value: string;
  type?: string;
}

interface PostmanUrl {
  raw: string;
  query?: Array<{
    key: string;
    value: string;
    disabled?: boolean;
  }>;
}

interface PostmanRequest {
  method: string;
  header: PostmanHeader[];
  url: PostmanUrl;
  body?: {
    mode: 'raw';
    raw: string;
    options?: {
      raw: {
        language: string;
      };
    };
  };
  description?: string;
}

interface PostmanItem {
  name: string;
  request: PostmanRequest;
  response: unknown[];
}

interface PostmanItemGroup {
  name: string;
  item: (PostmanItem | PostmanItemGroup)[];
  description?: string;
}

export interface PostmanCollection {
  info: {
    name: string;
    description?: string;
    schema: string;
  };
  item: (PostmanItem | PostmanItemGroup)[];
  variable?: PostmanVariable[];
}

function detectBodyLanguage(body: string, contentType?: string): string {
  if (contentType?.includes('json')) return 'json';
  if (contentType?.includes('xml')) return 'xml';
  if (contentType?.includes('javascript')) return 'javascript';
  if (body.trim().startsWith('{') || body.trim().startsWith('[')) return 'json';
  return 'text';
}

function parseUrl(rawUrl: string): PostmanUrl {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) {
    return { raw: rawUrl };
  }

  const queryString = rawUrl.slice(queryIndex + 1);
  const query = queryString.split('&').map((part) => {
    const [key, ...valueParts] = part.split('=');
    return {
      key: decodeURIComponent(key || ''),
      value: decodeURIComponent(valueParts.join('=')),
    };
  });

  return { raw: rawUrl, query };
}

function getBlockName(doc: KulalaParsedDocument, blockIndex: number): string {
  const block = doc.blocks[blockIndex];
  if (!block) return `Request ${blockIndex + 1}`;

  const nameOp = block.operators?.find((op) => op.name === 'name');
  if (nameOp?.args) return String(nameOp.args);

  if (block.name) return block.name;

  return `Request ${blockIndex + 1}`;
}

function isComment(entry: KulalaParsedDocument['blocks'][number]['preamble'][number]): entry is {
  content: string;
} {
  return 'content' in entry;
}

function getFolderPath(block: KulalaParsedDocument['blocks'][number]): string | null {
  for (const entry of block.preamble) {
    if (isComment(entry) && entry.content.startsWith('Folder: ')) {
      return entry.content.slice('Folder: '.length).trim();
    }
  }

  for (const comment of block.comments) {
    if (comment.content.startsWith('Folder: ')) {
      return comment.content.slice('Folder: '.length).trim();
    }
  }

  return null;
}

function getBlockDescription(block: KulalaParsedDocument['blocks'][number]): string {
  const lines: string[] = [];

  for (const entry of block.preamble) {
    if (isComment(entry) && !entry.content.startsWith('Folder: ')) {
      lines.push(entry.content);
    }
  }

  for (const comment of block.comments) {
    if (!comment.content.startsWith('Folder: ')) {
      lines.push(comment.content);
    }
  }

  return lines.join('\n').trim();
}

function buildPostmanRequest(block: KulalaParsedDocument['blocks'][number]): PostmanRequest {
  const headers: PostmanHeader[] = [];
  let contentType: string | undefined;

  for (const entry of block.request.headerSection) {
    if (entry.type === 'header' && entry.name) {
      headers.push({
        key: entry.name,
        value: entry.value ?? '',
      });
      if (entry.name.toLowerCase() === 'content-type') {
        contentType = entry.value;
      }
    }
  }

  const request: PostmanRequest = {
    method: block.request.method,
    header: headers,
    url: parseUrl(block.request.url),
    description: getBlockDescription(block) || undefined,
  };

  const body =
    typeof block.request.body === 'string'
      ? block.request.body
      : block.request.body
        ? formatJsonSync(block.request.body)
        : block.request.sourceBodyText;

  if (body) {
    request.body = {
      mode: 'raw',
      raw: body,
      options: {
        raw: {
          language: detectBodyLanguage(body, contentType),
        },
      },
    };
  }

  return request;
}

function ensureFolder(
  root: (PostmanItem | PostmanItemGroup)[],
  folderPath: string,
): PostmanItemGroup {
  const parts = folderPath.split('/').filter(Boolean);
  let currentItems = root;

  let currentFolder: PostmanItemGroup | undefined;

  for (const part of parts) {
    let folder = currentItems.find(
      (item): item is PostmanItemGroup => 'item' in item && item.name === part,
    );

    if (!folder) {
      folder = { name: part, item: [] };
      currentItems.push(folder);
    }

    currentFolder = folder;
    currentItems = folder.item;
  }

  return currentFolder ?? { name: parts[parts.length - 1] || 'Requests', item: [] };
}

function addItemToFolder(
  root: (PostmanItem | PostmanItemGroup)[],
  folderPath: string | null,
  item: PostmanItem,
): void {
  if (!folderPath) {
    root.push(item);
    return;
  }

  const folder = ensureFolder(root, folderPath);
  folder.item.push(item);
}

export function buildPostmanCollection(
  documents: Array<{ doc: KulalaParsedDocument; relativePath?: string }>,
  collectionName: string,
  extraVariables: Record<string, string> = {},
): PostmanCollection {
  const variables = new Map<string, string>();

  for (const { doc } of documents) {
    if (doc.fileHeaderVariables) {
      for (const [key, value] of Object.entries(doc.fileHeaderVariables)) {
        variables.set(key, value);
      }
    }

    if (doc.variables) {
      for (const [key, value] of Object.entries(doc.variables)) {
        variables.set(key, String(value));
      }
    }

    for (const block of doc.blocks) {
      if (block.preambleVariables) {
        for (const [key, value] of Object.entries(block.preambleVariables)) {
          variables.set(key, value);
        }
      }
    }
  }

  for (const [key, value] of Object.entries(extraVariables)) {
    variables.set(key, value);
  }

  const item: (PostmanItem | PostmanItemGroup)[] = [];

  for (const { doc, relativePath } of documents) {
    const fileFolder =
      documents.length > 1 && relativePath
        ? relativePath.replace(/\.(http|rest)$/i, '').replace(/\\/g, '/')
        : null;

    doc.blocks.forEach((block, index) => {
      if (!block.request?.method) return;

      const folderFromComment = getFolderPath(block);
      const folderPath = folderFromComment
        ? fileFolder
          ? `${fileFolder}/${folderFromComment}`
          : folderFromComment
        : fileFolder;

      addItemToFolder(item, folderPath, {
        name: getBlockName(doc, index),
        request: buildPostmanRequest(block),
        response: [],
      });
    });
  }

  return {
    info: {
      name: collectionName,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item,
    variable: Array.from(variables.entries()).map(([key, value]) => ({
      key,
      value,
      type: 'string',
    })),
  };
}

export function resolveCollectionName(files: string[], fallback = 'kulala-collection'): string {
  if (files.length === 1) {
    return basename(files[0]!).replace(/\.(http|rest)$/i, '');
  }

  const dirs = new Set(files.map((file) => dirname(resolve(file))));
  if (dirs.size === 1) {
    return basename([...dirs][0]!);
  }

  return fallback;
}

export function loadEnvVariables(envPath: string): Record<string, string> {
  const content = readFileSync(envPath, 'utf-8').trim();

  if (envPath.endsWith('.json')) {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const firstEnv = Object.values(parsed).find((v) => typeof v === 'object' && v !== null) as
      | Record<string, string>
      | undefined;
    const env = firstEnv ?? (parsed as Record<string, string>);
    return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]));
  }

  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed
      .slice(eqIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) vars[key] = value;
  }
  return vars;
}
