import { spawnSync } from 'child_process';
import { downloader } from '../downloader';
import { configparser } from '../configparser';
import type { KulalaParsedDocument } from './types';
import type { Config } from '../configparser';

export type { KulalaParsedDocument } from './types';

export type FormatOptions = {
  formatBody?: boolean;
  filepath?: string;
  kulalaCoreExecutablePath?: string;
  config?: Config;
};

type FormatSuccess = {
  success: true;
  formatted: string;
};

type FormatFailure = {
  success: false;
  error: string;
};

type FormatResponse = FormatSuccess | FormatFailure;

let cachedExecutable: string | null = null;

async function executablePath(override?: string): Promise<string> {
  if (override && override.trim()) {
    cachedExecutable = override.trim();
    return cachedExecutable;
  }
  if (!cachedExecutable) cachedExecutable = await downloader.ensureInstalled();
  return cachedExecutable;
}

function invoke(payload: Record<string, unknown>): unknown {
  const exe = cachedExecutable;
  if (!exe) {
    throw new Error('kulala-core executable not resolved');
  }

  const result = spawnSync(exe, [], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || `kulala-core exited with code ${result.status ?? 'unknown'}`,
    );
  }

  const stdout = result.stdout?.trim();
  if (!stdout) {
    throw new Error('kulala-core returned empty output');
  }

  return JSON.parse(stdout);
}

export async function formatHttp(content: string, options: FormatOptions = {}): Promise<string> {
  await executablePath(options.kulalaCoreExecutablePath);
  const config = options.config ?? configparser.parse();

  const response = invoke({
    action: 'format',
    content,
    filepath: options.filepath,
    formatBody: options.formatBody ?? true,
    bodyFormat: config.body.format,
    defaults: config.defaults,
  }) as FormatResponse;

  if (!response.success) {
    throw new Error(response.error);
  }

  return response.formatted;
}

export type FormatJsonOptions = {
  indent?: number;
  expand_tabs?: boolean;
  sort_keys?: boolean;
  text?: string;
};

export async function ensureKulalaCore(override?: string): Promise<string> {
  return executablePath(override);
}

export function formatJsonSync(value: unknown, opts: FormatJsonOptions = {}): string {
  const payload: Record<string, unknown> = {
    action: 'format_json',
    indent: opts.indent,
    expand_tabs: opts.expand_tabs,
    sort_keys: opts.sort_keys,
  };
  if (opts.text !== undefined) payload.text = opts.text;
  else payload.value = value;

  const response = invoke(payload) as { success?: boolean; content?: string; error?: string };
  if (!response.success || typeof response.content !== 'string') {
    throw new Error(response.error || 'kulala-core format_json failed');
  }
  return response.content;
}

export async function formatJson(value: unknown, opts: FormatJsonOptions = {}): Promise<string> {
  await executablePath();
  return formatJsonSync(value, opts);
}

export async function parseHttp(content: string, filepath?: string): Promise<KulalaParsedDocument> {
  await executablePath();

  return invoke({
    action: 'parse',
    content,
    filepath,
  }) as KulalaParsedDocument;
}

export const kulalaCore = {
  formatHttp,
  parseHttp,
  ensureKulalaCore,
  formatJson,
  formatJsonSync,
};
