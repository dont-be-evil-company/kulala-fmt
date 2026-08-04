import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const KULALA_CORE_DOWNLOAD_URL =
  "https://core.kulala.app/releases/%s/%s";

export const LICENSE_TOKEN_HELP =
  "Set KULALA_CORE_LICENSE_TOKEN to download kulala-core.";

export class LicenseRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `Kulala Core license token was rejected (${status}). ${LICENSE_TOKEN_HELP}`,
    );
    this.name = "LicenseRejectedError";
    this.status = status;
  }
}

export type LicenseTokenSource = "env" | "file" | "prompt";

/** Matches kulala-core `getKulalaCoreDataDir`. Survives client installs and updates. */
function kulalaCoreDataDir(): string {
  const explicit = process.env.KULALA_CORE_DATA_DIR?.trim();
  if (explicit) return explicit;

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return path.join(local, "kulala-core");
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, "kulala-core");
    return path.join(os.homedir(), "kulala-core");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "kulala-core",
    );
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(xdg, "kulala-core");
  return path.join(os.homedir(), ".local", "share", "kulala-core");
}

export function licenseTokenFile(): string {
  return path.join(kulalaCoreDataDir(), "license-token");
}

/** Previous config-directory location, so a token entered before this move is reused. */
function legacyLicenseTokenFile(): string {
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "kulala", "license-token");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "kulala",
      "license-token",
    );
  }
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "kulala", "license-token");
}

function readTokenFile(tokenFile: string): string | null {
  try {
    const value = fs.readFileSync(tokenFile, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function isDefaultTokenFile(tokenFile: string): boolean {
  return path.resolve(tokenFile) === path.resolve(licenseTokenFile());
}

export function readSavedLicenseToken(
  tokenFile = licenseTokenFile(),
): string | null {
  const saved = readTokenFile(tokenFile);
  if (saved) return saved;
  if (!isDefaultTokenFile(tokenFile)) return null;

  const legacy = readTokenFile(legacyLicenseTokenFile());
  if (!legacy) return null;
  try {
    saveLicenseToken(legacy, tokenFile);
  } catch {
    // Keep using the legacy copy for this download.
  }
  return legacy;
}

export function saveLicenseToken(
  token: string,
  tokenFile = licenseTokenFile(),
): void {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(tokenFile, 0o600);
  }
}

function unlinkToken(tokenFile: string): void {
  try {
    fs.unlinkSync(tokenFile);
  } catch {
    // The saved token is already gone.
  }
}

/** Remove a saved token. Call only after the download server rejects it. */
export function deleteSavedLicenseToken(tokenFile = licenseTokenFile()): void {
  unlinkToken(tokenFile);
  if (isDefaultTokenFile(tokenFile)) unlinkToken(legacyLicenseTokenFile());
}

export function promptHiddenLicenseToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error(`KULALA_CORE_LICENSE_TOKEN is not set. ${LICENSE_TOKEN_HELP}`),
    );
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    process.stderr.write("Kulala license token: ");
    const mutable = rl as readline.Interface & {
      _writeToOutput: (text: string) => void;
    };
    mutable._writeToOutput = (text: string) => {
      if (text.includes("\n") || text.includes("\r")) {
        process.stderr.write("\n");
      }
    };
    rl.once("line", (line) => {
      rl.close();
      const token = line.trim();
      if (!token) {
        reject(new Error(`No license token entered. ${LICENSE_TOKEN_HELP}`));
        return;
      }
      resolve(token);
    });
  });
}

export async function resolveLicenseToken(options: {
  allowPrompt: boolean;
  prompt?: () => Promise<string>;
  tokenFile?: string;
}): Promise<{ token: string; source: LicenseTokenSource } | null> {
  const fromEnv = process.env.KULALA_CORE_LICENSE_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, source: "env" };
  }

  const tokenFile = options.tokenFile ?? licenseTokenFile();
  const saved = readSavedLicenseToken(tokenFile);
  if (saved) {
    return { token: saved, source: "file" };
  }
  if (!options.allowPrompt) {
    return null;
  }

  const prompt = options.prompt ?? promptHiddenLicenseToken;
  const prompted = (await prompt()).trim();
  if (!prompted) {
    throw new Error(`No license token entered. ${LICENSE_TOKEN_HELP}`);
  }
  saveLicenseToken(prompted, tokenFile);
  return { token: prompted, source: "prompt" };
}

export function throwIfLicenseRejected(status: number): void {
  if (status === 401 || status === 403) {
    throw new LicenseRejectedError(status);
  }
}

/**
 * Downloads with a license token. A saved token is kept across updates and
 * removed only when the server rejects it. The user is then asked once more
 * when prompting is allowed.
 */
export async function withLicenseToken(options: {
  allowPrompt: boolean;
  prompt?: () => Promise<string>;
  tokenFile?: string;
  download: (token: string) => Promise<void>;
}): Promise<void> {
  const resolved = await resolveLicenseToken(options);
  if (!resolved) {
    throw new Error(
      `KULALA_CORE_LICENSE_TOKEN is not set. ${LICENSE_TOKEN_HELP}`,
    );
  }

  try {
    await options.download(resolved.token);
  } catch (error) {
    if (!(error instanceof LicenseRejectedError)) {
      throw error;
    }
    if (resolved.source !== "env") {
      deleteSavedLicenseToken(options.tokenFile);
    }
    if (!options.allowPrompt) {
      throw error;
    }
    const prompt = options.prompt ?? promptHiddenLicenseToken;
    const prompted = (await prompt()).trim();
    if (!prompted) {
      throw new Error(`No license token entered. ${LICENSE_TOKEN_HELP}`);
    }
    saveLicenseToken(prompted, options.tokenFile);
    await options.download(prompted);
  }
}
