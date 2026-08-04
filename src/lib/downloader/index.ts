import { execFile } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { chmodSync, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { KULALA_CORE_VERSION } from '../../versions/backend';
import {
  KULALA_CORE_DOWNLOAD_URL,
  LICENSE_TOKEN_HELP,
  readSavedLicenseToken,
  throwIfLicenseRejected,
  withLicenseToken,
} from './license-token';

const BINARY_NAME = 'kulala-core';
const DOWNLOAD_URL = KULALA_CORE_DOWNLOAD_URL;

function platform(): string {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch;
  let archName: string = arch;
  if (arch === 'x64') {
    archName = 'x86_64';
  } else if (arch === 'arm64') {
    archName = os === 'darwin' ? 'arm64' : 'aarch64';
  }
  return `${os}-${archName}`;
}

function getBinDir(): string {
  return path.join(__dirname, 'bin');
}

function getReleaseBinName(): string {
  const name = `${BINARY_NAME}-${platform()}`;
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function getBinName(): string {
  return process.platform === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
}

function getBinPath(): string {
  return path.join(getBinDir(), getBinName());
}

function getVersionPath(): string {
  return path.join(getBinDir(), 'version.txt');
}

function binaryExists(): boolean {
  return fs.existsSync(getBinPath());
}

function getInstalledVersion(): string | null {
  const versionPath = getVersionPath();
  if (!fs.existsSync(versionPath)) {
    return null;
  }
  return fs.readFileSync(versionPath, 'utf-8').trim();
}

function versionMatches(): boolean {
  const installed = getInstalledVersion();
  return installed === KULALA_CORE_VERSION;
}

function makeExecutable(filePath: string): void {
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o755);
  }
}

const VERSION_PROBE_TIMEOUT_MS = 15_000;

function firstOutputLine(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function runVersion(binPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binPath,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        if (!firstOutputLine(stdout)) {
          reject(new Error('kulala-core --version produced no output'));
          return;
        }
        resolve();
      },
    );
  });
}

function clearQuarantine(binPath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('xattr', ['-d', 'com.apple.quarantine', binPath], { timeout: 5_000 }, () => {
      resolve();
    });
  });
}

async function assertCoreStarts(binPath: string): Promise<void> {
  try {
    await runVersion(binPath);
    return;
  } catch (error) {
    if (process.platform === 'darwin') {
      await clearQuarantine(binPath);
      try {
        await runVersion(binPath);
        return;
      } catch {
        fs.rmSync(binPath, { force: true });
        throw new Error(
          'macOS refused to start kulala-core. The downloaded binary is signed incorrectly or blocked by Gatekeeper.',
        );
      }
    }
    fs.rmSync(binPath, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`kulala-core --version failed. The downloaded binary did not start. ${detail}`);
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

function isInteractiveTerminal(): boolean {
  return process.stderr.isTTY === true;
}

type DownloadProgress = {
  start(message: string): void;
  succeed(message: string): void;
  fail(): void;
};

function createDownloadProgress(): DownloadProgress {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let message = '';

  const clearLine = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (isInteractiveTerminal()) {
      process.stderr.write('\r\x1b[K');
    }
  };

  return {
    start(msg: string) {
      message = msg;
      if (!isInteractiveTerminal()) {
        console.error(message);
        return;
      }

      const render = (): void => {
        process.stderr.write(`\r${SPINNER_FRAMES[frame]} ${message}`);
        frame = (frame + 1) % SPINNER_FRAMES.length;
      };

      render();
      timer = setInterval(render, 80);
    },
    succeed(msg: string) {
      clearLine();
      console.error(msg);
    },
    fail() {
      clearLine();
    },
  };
}

async function downloadFile(url: string, outputPath: string, token: string): Promise<void> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  throwIfLicenseRejected(response.status);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download kulala-core from ${url}: ${response.status} ${response.statusText}`,
    );
  }
  await pipeline(response.body, createWriteStream(outputPath));
}

function removeStaleBinary(): void {
  if (!binaryExists()) {
    return;
  }

  fs.unlinkSync(getBinPath());
  const versionPath = getVersionPath();
  if (fs.existsSync(versionPath)) {
    fs.unlinkSync(versionPath);
  }
}

export async function installBackend(options?: { allowPrompt?: boolean }): Promise<void> {
  const binDir = getBinDir();
  fs.mkdirSync(binDir, { recursive: true });

  const releaseName = getReleaseBinName();
  const url = DOWNLOAD_URL.replace('%s', KULALA_CORE_VERSION).replace('%s', releaseName);
  const downloadPath = path.join(binDir, `${releaseName}.download`);
  const binPath = getBinPath();
  const progress = createDownloadProgress();

  progress.start(`Downloading kulala-core v${KULALA_CORE_VERSION}...`);
  try {
    await withLicenseToken({
      allowPrompt: options?.allowPrompt ?? true,
      download: async (token) => {
        await downloadFile(url, downloadPath, token);
      },
    });
    makeExecutable(downloadPath);
    fs.renameSync(downloadPath, binPath);
    await assertCoreStarts(binPath);
    fs.writeFileSync(getVersionPath(), KULALA_CORE_VERSION, 'utf-8');
    progress.succeed(`Installed kulala-core to ${binPath}`);
  } catch (error) {
    progress.fail();
    if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
    throw error;
  }
}

/**
 * Best-effort install for lifecycle scripts (postinstall/prepare).
 * Never throws; logs a warning when download fails so first-use fallback can run.
 */
export async function tryInstallBackend(): Promise<void> {
  const fromEnv = process.env.KULALA_CORE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return;
  }

  if (binaryExists() && versionMatches()) {
    return;
  }

  if (!process.env.KULALA_CORE_LICENSE_TOKEN?.trim() && !readSavedLicenseToken()) {
    console.error(`Warning: ${LICENSE_TOKEN_HELP}`);
    console.error('kulala-fmt will ask for a license token on first use.');
    return;
  }

  if (binaryExists()) {
    removeStaleBinary();
  }

  try {
    await installBackend({ allowPrompt: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to download kulala-core during install: ${message}`);
    console.error('kulala-fmt will attempt to download it on first use instead.');
  }
}

export async function ensureInstalled(): Promise<string> {
  const fromEnv = process.env.KULALA_CORE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`KULALA_CORE_PATH does not exist: ${fromEnv}`);
    }
    return fromEnv;
  }

  if (binaryExists() && versionMatches()) {
    return getBinPath();
  }

  if (binaryExists()) {
    removeStaleBinary();
  }

  await installBackend({ allowPrompt: true });
  return getBinPath();
}

export const downloader = {
  ensureInstalled,
  getBinPath,
  installBackend,
  tryInstallBackend,
};
