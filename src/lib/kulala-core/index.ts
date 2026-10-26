import { downloader } from '../downloader';
import { createDaemonClient, defaultKulalaCoreDataDir } from './daemon-client';
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

const daemon = createDaemonClient({
  clientName: 'kulala-fmt',
  dataDir: defaultKulalaCoreDataDir,
  executable: () => {
    if (!cachedExecutable) {
      throw new Error('kulala-core executable not resolved');
    }
    return cachedExecutable;
  },
});

async function executablePath(override?: string): Promise<string> {
  if (override && override.trim()) {
    cachedExecutable = override.trim();
    return cachedExecutable;
  }
  if (!cachedExecutable) cachedExecutable = await downloader.ensureInstalled();
  return cachedExecutable;
}

async function invoke(payload: Record<string, unknown>): Promise<unknown> {
  if (!cachedExecutable) {
    throw new Error('kulala-core executable not resolved');
  }
  const result = await daemon.invoke(payload, { track: 'none' });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `kulala-core exited with code ${result.code}`);
  }
  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new Error('kulala-core returned empty output');
  }
  return JSON.parse(stdout);
}

export async function formatHttp(content: string, options: FormatOptions = {}): Promise<string> {
  await executablePath(options.kulalaCoreExecutablePath);
  const config = options.config ?? configparser.parse();

  const response = (await invoke({
    action: 'format',
    content,
    filepath: options.filepath,
    formatBody: options.formatBody ?? true,
    bodyFormat: config.body.format,
    defaults: config.defaults,
  })) as FormatResponse;

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

  const result = daemon.invokeSync(payload);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `kulala-core exited with code ${result.code}`);
  }
  const response = JSON.parse(result.stdout) as {
    success?: boolean;
    content?: string;
    error?: string;
  };
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

  return (await invoke({
    action: 'parse',
    content,
    filepath,
  })) as KulalaParsedDocument;
}

export const kulalaCore = {
  formatHttp,
  parseHttp,
  ensureKulalaCore,
  formatJson,
  formatJsonSync,
};
