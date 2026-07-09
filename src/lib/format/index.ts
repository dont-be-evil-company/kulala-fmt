import path from 'node:path';
import { configparser } from '../configparser';
import { formatHttp } from '../kulala-core';

export type FormatHttpTextOptions = {
  filepath?: string;
  formatBody?: boolean;
  /**
   * If provided, `kulala-fmt` will use this executable instead of downloading / resolving its own.
   * This is how Kulala Desktop can reuse its bundled `kulala-core` version.
   */
  kulalaCoreExecutablePath?: string;
};

export async function formatHttpText(
  content: string,
  options: FormatHttpTextOptions = {},
): Promise<string> {
  const startDir = options.filepath ? path.dirname(options.filepath) : undefined;
  const config = configparser.parse({ startDir });
  return await formatHttp(content, {
    filepath: options.filepath,
    formatBody: options.formatBody ?? true,
    kulalaCoreExecutablePath: options.kulalaCoreExecutablePath,
    config,
  });
}
