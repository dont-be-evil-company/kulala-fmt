import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

export const DAEMON_PROTOCOL = 1;
const START_TIMEOUT_MS = 10_000;
const WORKER_SOURCE_VERSION = 3;

export type DaemonHttpStreamEvent = {
  type: "http-stream";
  event: "headers" | "chunk" | "error";
  status?: number;
  httpVersion?: string;
  headers?: Record<string, string>;
  url?: string;
  data?: string;
  error?: string;
  blockName?: string;
};

export type DaemonInvokeResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type DaemonWebSocketEvent = {
  type: string;
  data?: string;
  error?: string;
  remaining?: number;
  code?: number;
};

export type DaemonWebSocketHandle = {
  send(data: string): void;
  close(): void;
  kill(): void;
  readonly pid: number | undefined;
  readonly exited: Promise<number | null>;
};

export type DaemonInvokeOptions = {
  cwd?: string;
  onHttpStream?: (event: DaemonHttpStreamEvent) => void;
  /** Milliseconds. 0 waits without a client timeout. */
  timeoutMs?: number;
  /** `active` is cancelled by {@link DaemonClient.cancelActive}. `search` replaces the previous search. */
  track?: "active" | "search" | "none";
};

type Pending = {
  onEvent?: (message: Record<string, unknown>) => void;
  finish: (result: DaemonInvokeResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  track: "active" | "search" | "none";
};

export type DaemonClient = {
  invoke(
    payload: Record<string, unknown>,
    options?: DaemonInvokeOptions,
  ): Promise<DaemonInvokeResult>;
  invokeSync(
    payload: Record<string, unknown>,
    options?: DaemonInvokeOptions,
  ): DaemonInvokeResult;
  cancel(id: string): void;
  cancelActive(): boolean;
  cancelAll(): boolean;
  openWebSocket(
    connect: Record<string, unknown>,
    handlers: {
      onEvent: (event: DaemonWebSocketEvent) => void;
      onExit?: (code: number | null) => void;
    },
    cwd?: string,
  ): Promise<DaemonWebSocketHandle | undefined>;
};

export type DaemonClientOptions = {
  clientName: string;
  dataDir: () => string;
  executable: () => string | Promise<string>;
  log?: (message: string) => void;
  /** Defaults to `["--daemon"]`. Tests pass the bun entrypoint plus `--daemon`. */
  daemonArgs?: string[];
};

export function defaultKulalaCoreDataDir(): string {
  const explicit = process.env.KULALA_CORE_DATA_DIR?.trim();
  if (explicit) return explicit;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, "kulala-core");
    const appData = process.env.APPDATA;
    if (appData) return join(appData, "kulala-core");
    return join(homedir(), "kulala-core");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "kulala-core");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "kulala-core");
  return join(homedir(), ".local", "share", "kulala-core");
}

function sanitizeVersion(version: string): string {
  const cleaned = version.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

class DaemonUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailable";
  }
}

// The import keyword is split so electron-vite's ESM shim does not treat this
// worker text as the bundle's last static import and inject `__dirname` inside it.
const workerImport = (names: string, specifier: string): string =>
  `imp${""}ort { ${names} } fr${""}om ${JSON.stringify(specifier)};\n`;

const WORKER_SOURCE =
  workerImport("execFile, spawn", "node:child_process") +
  workerImport(
    "closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync",
    "node:fs",
  ) +
  workerImport("createConnection", "node:net") +
  workerImport("dirname, join", "node:path") +
  workerImport("parentPort", "node:worker_threads") +
  String.raw`
const PROTOCOL = 1;

function sanitize(version) {
  const cleaned = String(version ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === "EPERM"; }
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function metaFile(dataDir, version) { return join(dataDir, "daemon", sanitize(version) + ".json"); }

parentPort.on("message", (msg) => {
  const chain = parentPort.chain || Promise.resolve();
  parentPort.chain = chain.then(() => run(msg)).catch((error) => finish(msg, { stdout: "", stderr: String(error && error.message || error), code: 1 }));
});

function finish(msg, result) {
  writeFileSync(msg.resultPath, JSON.stringify(result));
  const flag = new Int32Array(msg.sab);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0, 1);
}

function readMeta(path) {
  if (!existsSync(path)) return null;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8"));
    if (meta && meta.token && meta.endpoint && meta.protocol === PROTOCOL && pidAlive(meta.pid)) return meta;
  } catch {}
  return null;
}

function lockFile(dataDir, version) {
  return join(dataDir, "daemon", sanitize(version) + ".lock");
}

function tryLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    throw error;
  }
}

async function waitMeta(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const meta = readMeta(path);
    if (meta) return meta;
    await delay(50);
  }
  return null;
}

function versionOf(executable, daemonArgs) {
  const args = (daemonArgs || ["--daemon"]).filter((arg) => arg !== "--daemon");
  args.push("--version");
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 20000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout).trim() || "dev");
    });
  });
}

async function ensure(dataDir, executable, daemonArgs) {
  const version = await versionOf(executable, daemonArgs);
  const meta = metaFile(dataDir, version);
  const lock = lockFile(dataDir, version);
  const existing = readMeta(meta);
  if (existing) return existing;
  let owned = tryLock(lock);
  if (!owned) {
    const waited = await waitMeta(meta, 10000);
    if (waited) return waited;
    try { unlinkSync(lock); } catch {}
    owned = tryLock(lock);
  }
  if (!owned) throw new Error("timed out waiting for kulala-core daemon");
  const child = spawn(executable, daemonArgs || ["--daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, KULALA_CORE_DATA_DIR: dataDir },
  });
  child.unref();
  const ready = await waitMeta(meta, 10000);
  if (!ready) {
    try { unlinkSync(lock); } catch {}
    throw new Error("kulala-core daemon did not become ready");
  }
  return ready;
}

function connect(meta, clientName) {
  const socket = createConnection(meta.endpoint);
  socket.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    const fail = (error) => {
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(JSON.stringify({ op: "hello", token: meta.token, protocol: PROTOCOL, client: clientName }) + "\n");
    });
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      socket.off("error", fail);
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.op !== "ready") fail(new Error(message.error || "daemon hello failed"));
        else resolve({ socket, rest: buffer.slice(newline + 1) });
      } catch (error) { fail(error); }
    };
    socket.on("data", onData);
  });
}

async function run(msg) {
  const meta = await ensure(msg.dataDir, msg.executable, msg.daemonArgs);
  const connected = await connect(meta, msg.clientName);
  const socket = connected.socket;
  let buffer = connected.rest;
  const result = await new Promise((resolve, reject) => {
    const timer = msg.timeoutMs > 0 ? setTimeout(() => {
      socket.write(JSON.stringify({ op: "cancel", id: msg.id }) + "\n");
      resolve({ stdout: "", stderr: "kulala-core subprocess timed out", code: 124 });
    }, msg.timeoutMs) : undefined;
    const take = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== msg.id || message.event) return;
      if (typeof message.ok !== "boolean") return;
      if (timer) clearTimeout(timer);
      if (message.ok) resolve({ stdout: JSON.stringify(message.result ?? null), stderr: "", code: 0 });
      else {
        const stderr = message.result != null ? JSON.stringify(message.result) : (message.error || "kulala-core request failed");
        resolve({ stdout: "", stderr, code: 1 });
      }
    };
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      take(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        take(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    socket.write(JSON.stringify(msg.payload) + "\n");
  });
  socket.end();
  finish(msg, result);
}
`;

function workerFile(): string {
  const file = join(
    tmpdir(),
    `kulala-daemon-worker-${WORKER_SOURCE_VERSION}.mjs`,
  );
  if (!existsSync(file)) writeFileSync(file, WORKER_SOURCE);
  return file;
}

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
  const log =
    options.log ??
    ((message: string): void => {
      console.error(message);
    });
  let socket: Socket | null = null;
  let buffer = "";
  let opening: Promise<void> | null = null;
  let daemonPid: number | undefined;
  let seq = 0;
  let activeId: string | undefined;
  let searchId: string | undefined;
  let cachedVersion: string | undefined;
  let worker: Worker | undefined;
  const pending = new Map<string, Pending>();
  const oneShot = new Map<string, ChildProcessWithoutNullStreams>();

  const daemonArgs = options.daemonArgs ?? ["--daemon"];

  function versionArgv(): string[] {
    return [...daemonArgs.filter((arg) => arg !== "--daemon"), "--version"];
  }

  async function executable(): Promise<string> {
    return options.executable();
  }

  async function coreVersion(exe: string): Promise<string> {
    if (cachedVersion) return cachedVersion;
    const version = await new Promise<string>((resolve, reject) => {
      execFile(exe, versionArgv(), { timeout: 20_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout).trim() || "dev");
      });
    });
    cachedVersion = version;
    return version;
  }

  function metaFile(dataDir: string, version: string): string {
    return join(dataDir, "daemon", `${sanitizeVersion(version)}.json`);
  }

  function lockFile(dataDir: string, version: string): string {
    return join(dataDir, "daemon", `${sanitizeVersion(version)}.lock`);
  }

  function readMeta(
    path: string,
  ): { pid: number; token: string; endpoint: string; protocol: number } | null {
    if (!existsSync(path)) return null;
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: number;
        token?: string;
        endpoint?: string;
        protocol?: number;
      };
      if (
        !meta.token ||
        !meta.endpoint ||
        !meta.pid ||
        meta.protocol !== DAEMON_PROTOCOL
      )
        return null;
      if (!isPidAlive(meta.pid)) return null;
      return {
        pid: meta.pid,
        token: meta.token,
        endpoint: meta.endpoint,
        protocol: meta.protocol,
      };
    } catch {
      return null;
    }
  }

  function lockIsStale(path: string, meta: string): boolean {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: number;
        startedAt?: number;
      };
      if (!isPidAlive(raw.pid ?? 0)) return true;
      const age = Date.now() - (raw.startedAt ?? 0);
      return age > 15_000 && !existsSync(meta);
    } catch {
      return true;
    }
  }

  function tryLock(path: string): boolean {
    mkdirSync(dirname(path), { recursive: true });
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async function waitForMeta(
    path: string,
  ): Promise<ReturnType<typeof readMeta>> {
    const started = Date.now();
    while (Date.now() - started < START_TIMEOUT_MS) {
      const meta = readMeta(path);
      if (meta) return meta;
      await delay(50);
    }
    return null;
  }

  async function ensureDaemon(): Promise<{
    pid: number;
    token: string;
    endpoint: string;
  }> {
    const exe = await executable();
    const dataDir = options.dataDir();
    const version = await coreVersion(exe);
    const metaPath = metaFile(dataDir, version);
    const lockPath = lockFile(dataDir, version);
    const existing = readMeta(metaPath);
    if (existing) return existing;

    let owned = tryLock(lockPath);
    if (!owned && lockIsStale(lockPath, metaPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // another starter removed it
      }
      owned = tryLock(lockPath);
    }
    if (!owned) {
      const waited = await waitForMeta(metaPath);
      if (waited) return waited;
      throw new DaemonUnavailable("timed out waiting for kulala-core daemon");
    }

    const child = spawn(exe, daemonArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, KULALA_CORE_DATA_DIR: dataDir },
    });
    child.unref();
    const meta = await waitForMeta(metaPath);
    if (!meta) {
      try {
        unlinkSync(lockPath);
      } catch {
        // already removed
      }
      throw new DaemonUnavailable("kulala-core daemon did not become ready");
    }
    return meta;
  }

  function failPending(error: Error): void {
    for (const [id, request] of pending) {
      if (request.timer) clearTimeout(request.timer);
      request.finish({ stdout: "", stderr: error.message, code: 1 });
      pending.delete(id);
    }
    socket = null;
    opening = null;
    buffer = "";
  }

  let helloResolve: (() => void) | undefined;
  let helloReject: ((error: Error) => void) | undefined;

  function dispatch(message: Record<string, unknown>): void {
    if (message.op === "ready") {
      if (typeof message.pid === "number") daemonPid = message.pid;
      helloResolve?.();
      helloResolve = undefined;
      helloReject = undefined;
      return;
    }
    if (message.op === "error" && typeof message.id !== "string") {
      helloReject?.(
        new DaemonUnavailable(
          typeof message.error === "string"
            ? message.error
            : "daemon hello failed",
        ),
      );
      helloResolve = undefined;
      helloReject = undefined;
      return;
    }
    if (typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    if (typeof message.event === "string") {
      request.onEvent?.(message);
      return;
    }
    if (typeof message.ok !== "boolean") return;
    if (request.timer) clearTimeout(request.timer);
    pending.delete(message.id);
    if (activeId === message.id) activeId = undefined;
    if (searchId === message.id) searchId = undefined;
    if (message.ok) {
      request.finish({
        stdout: JSON.stringify(message.result ?? null),
        stderr: "",
        code: 0,
      });
      return;
    }
    const stderr =
      message.result != null
        ? JSON.stringify(message.result)
        : typeof message.error === "string"
          ? message.error
          : "kulala-core request failed";
    request.finish({ stdout: "", stderr, code: 1 });
  }

  function consume(chunk: string): void {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        dispatch(message);
      } catch {
        log("kulala-core daemon sent invalid JSON");
      }
    }
  }

  async function openSocket(): Promise<void> {
    if (socket && !socket.destroyed) return;
    const meta = await ensureDaemon();
    daemonPid = meta.pid;
    const next = createConnection(meta.endpoint);
    next.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        next.off("connect", onConnect);
        reject(new DaemonUnavailable(error.message));
      };
      const onConnect = (): void => {
        next.off("error", onError);
        resolve();
      };
      next.once("error", onError);
      next.once("connect", onConnect);
    });
    socket = next;
    buffer = "";
    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DaemonUnavailable("daemon hello timed out")),
        5_000,
      );
      helloResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      helloReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    next.on("data", (chunk: string) => consume(chunk));
    next.on("error", (error) => {
      if (helloReject) helloReject(new DaemonUnavailable(error.message));
      else failPending(error);
    });
    next.on("close", () => {
      if (helloReject)
        helloReject(new DaemonUnavailable("daemon connection closed"));
      else failPending(new DaemonUnavailable("daemon connection closed"));
    });
    next.write(
      `${JSON.stringify({
        op: "hello",
        token: meta.token,
        protocol: DAEMON_PROTOCOL,
        client: options.clientName,
      })}\n`,
    );
    try {
      await hello;
    } catch (error) {
      next.destroy();
      socket = null;
      throw error;
    }
  }

  function connection(): Promise<void> {
    if (socket && !socket.destroyed && opening == null)
      return Promise.resolve();
    if (!opening) {
      opening = openSocket()
        .catch((error) => {
          socket?.destroy();
          socket = null;
          throw error;
        })
        .finally(() => {
          opening = null;
        });
    }
    return opening;
  }

  function send(value: unknown): void {
    if (!socket || socket.destroyed)
      throw new DaemonUnavailable("daemon socket is closed");
    socket.write(`${JSON.stringify(value)}\n`);
  }

  function cancel(id: string): void {
    const child = oneShot.get(id);
    if (child) {
      oneShot.delete(id);
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      return;
    }
    try {
      send({ op: "cancel", id });
    } catch {
      // The socket is already gone.
    }
  }

  function oneShotInvoke(
    exe: string,
    payload: Record<string, unknown>,
    invokeOptions: DaemonInvokeOptions,
    id: string,
  ): Promise<DaemonInvokeResult> {
    return new Promise((resolve) => {
      const child = spawn(exe, [], {
        cwd: invokeOptions.cwd,
        env: { ...process.env, KULALA_CORE_DATA_DIR: options.dataDir() },
        stdio: ["pipe", "pipe", "pipe"],
      });
      oneShot.set(id, child);
      let stdout = "";
      let stderr = "";
      let pendingLine = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const take = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          stdout += `${line}\n`;
          return;
        }
        try {
          const value = JSON.parse(trimmed) as DaemonHttpStreamEvent;
          if (value.type === "http-stream" && typeof value.event === "string") {
            invokeOptions.onHttpStream?.(value);
            return;
          }
        } catch {
          // not a stream event
        }
        stdout += `${line}\n`;
      };
      child.stdout.on("data", (chunk: string) => {
        pendingLine += chunk;
        const lines = pendingLine.split("\n");
        pendingLine = lines.pop() ?? "";
        for (const line of lines) take(line);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timer =
        invokeOptions.timeoutMs && invokeOptions.timeoutMs > 0
          ? setTimeout(() => {
              try {
                child.kill("SIGTERM");
              } catch {
                // already exited
              }
            }, invokeOptions.timeoutMs)
          : undefined;
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        oneShot.delete(id);
        if (pendingLine) take(pendingLine);
        const timedOut =
          code === null &&
          invokeOptions.timeoutMs &&
          invokeOptions.timeoutMs > 0;
        resolve({
          stdout,
          stderr: timedOut
            ? stderr || "kulala-core subprocess timed out"
            : stderr,
          code: timedOut ? 124 : (code ?? 1),
        });
      });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        oneShot.delete(id);
        resolve({ stdout: "", stderr: error.message, code: 1 });
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      child.stdin.end();
    });
  }

  async function invoke(
    payload: Record<string, unknown>,
    invokeOptions: DaemonInvokeOptions = {},
  ): Promise<DaemonInvokeResult> {
    const track = invokeOptions.track ?? "active";
    const id = `c${++seq}`;
    if (track === "search" && searchId) cancel(searchId);
    if (track === "active") activeId = id;
    if (track === "search") searchId = id;

    try {
      await connection();
      return await new Promise<DaemonInvokeResult>((resolve, reject) => {
        const request: Pending = {
          track,
          finish: resolve,
          onEvent: (message) => {
            if (message.event !== "http-stream") return;
            const data = message.data as DaemonHttpStreamEvent | undefined;
            if (data && data.type === "http-stream")
              invokeOptions.onHttpStream?.(data);
          },
        };
        if (invokeOptions.timeoutMs && invokeOptions.timeoutMs > 0) {
          request.timer = setTimeout(() => {
            cancel(id);
            if (!pending.has(id)) return;
            pending.delete(id);
            if (activeId === id) activeId = undefined;
            resolve({
              stdout: "",
              stderr: "kulala-core subprocess timed out",
              code: 124,
            });
          }, invokeOptions.timeoutMs);
        }
        pending.set(id, request);
        try {
          const { processEnv: _ignored, ...body } = payload;
          send({
            ...body,
            id,
            ...(invokeOptions.cwd ? { cwd: invokeOptions.cwd } : {}),
            processEnv: stringEnv(process.env),
          });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!(error instanceof DaemonUnavailable) && socket) {
        return { stdout: "", stderr: error.message, code: 1 };
      }
      log(
        `kulala-core daemon unavailable (${error.message}); using a one-shot process`,
      );
      const exe = await executable();
      const { processEnv: _ignored, ...body } = payload;
      return oneShotInvoke(exe, body, invokeOptions, id);
    }
  }

  function invokeSync(
    payload: Record<string, unknown>,
    invokeOptions: DaemonInvokeOptions = {},
  ): DaemonInvokeResult {
    const exe = cachedExecutableSync();
    if (!exe) {
      throw new Error("kulala-core executable not resolved");
    }
    const id = `s${++seq}`;
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    const resultPath = join(
      tmpdir(),
      `kulala-daemon-result-${randomBytes(8).toString("hex")}.json`,
    );
    const timeoutMs =
      invokeOptions.timeoutMs && invokeOptions.timeoutMs > 0
        ? invokeOptions.timeoutMs
        : 60_000;
    try {
      const thread = syncWorker();
      thread.postMessage({
        id,
        payload: {
          ...payload,
          id,
          ...(invokeOptions.cwd ? { cwd: invokeOptions.cwd } : {}),
          processEnv: stringEnv(process.env),
        },
        dataDir: options.dataDir(),
        executable: exe,
        daemonArgs,
        clientName: options.clientName,
        timeoutMs,
        sab,
        resultPath,
      });
      const status = Atomics.wait(flag, 0, 0, timeoutMs + 5_000);
      if (Atomics.load(flag, 0) !== 1 || status === "timed-out") {
        throw new DaemonUnavailable("daemon sync call timed out");
      }
      return JSON.parse(readFileSync(resultPath, "utf8")) as DaemonInvokeResult;
    } catch (error) {
      log(
        `kulala-core daemon sync call failed (${error instanceof Error ? error.message : error}); using a one-shot process`,
      );
      const result = spawnSync(exe, [], {
        input: `${JSON.stringify(payload)}\n`,
        encoding: "utf8",
        cwd: invokeOptions.cwd,
        env: { ...process.env, KULALA_CORE_DATA_DIR: options.dataDir() },
        maxBuffer: 50 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? (result.error ? result.error.message : ""),
        code: result.status ?? 1,
      };
    } finally {
      try {
        unlinkSync(resultPath);
      } catch {
        // the worker may not have created it
      }
    }
  }

  let syncExe: string | undefined;
  function cachedExecutableSync(): string | undefined {
    if (syncExe) return syncExe;
    try {
      const value = options.executable();
      if (typeof value === "string" && value.length > 0) {
        syncExe = value;
        return value;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function syncWorker(): Worker {
    if (!worker) {
      worker = new Worker(workerFile());
      worker.unref();
      worker.on("error", (error) =>
        log(
          `kulala-core daemon worker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    return worker;
  }

  async function openWebSocket(
    connect: Record<string, unknown>,
    handlers: {
      onEvent: (event: DaemonWebSocketEvent) => void;
      onExit?: (code: number | null) => void;
    },
    cwd?: string,
  ): Promise<DaemonWebSocketHandle | undefined> {
    const id = `ws${++seq}`;
    let exitResolve: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      exitResolve = resolve;
    });
    let closed = false;
    const finish = (code: number | null): void => {
      if (closed) return;
      closed = true;
      pending.delete(id);
      handlers.onExit?.(code);
      exitResolve(code);
    };
    try {
      await connection();
      pending.set(id, {
        track: "none",
        finish: (result) => finish(result.code === 0 ? 0 : 1),
        onEvent: (message) => {
          if (message.event !== "websocket") return;
          const data = message.data as DaemonWebSocketEvent | undefined;
          if (data && typeof data.type === "string") handlers.onEvent(data);
        },
      });
      send({
        id,
        action: "websocket",
        connect,
        ...(cwd ? { cwd } : {}),
        processEnv: stringEnv(process.env),
      });
      return {
        pid: daemonPid,
        exited,
        send(data: string) {
          try {
            send({ op: "ws-send", id, data });
          } catch {
            // socket closed
          }
        },
        close() {
          try {
            send({ op: "ws-close", id });
          } catch {
            finish(1);
          }
        },
        kill() {
          try {
            send({ op: "ws-close", id });
          } catch {
            finish(1);
          }
        },
      };
    } catch (error) {
      log(
        `kulala-core daemon websocket failed (${error instanceof Error ? error.message : error}); using a one-shot process`,
      );
      const exe = await executable();
      const tmp = join(
        tmpdir(),
        `kulala-ws-${Date.now()}-${randomBytes(4).toString("hex")}.json`,
      );
      writeFileSync(tmp, JSON.stringify(connect));
      const child = spawn(exe, ["--websocket", "-i", tmp], {
        cwd,
        env: { ...process.env, KULALA_CORE_DATA_DIR: options.dataDir() },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBuf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        let newline = stdoutBuf.indexOf("\n");
        while (newline >= 0) {
          const line = stdoutBuf.slice(0, newline).trim();
          stdoutBuf = stdoutBuf.slice(newline + 1);
          newline = stdoutBuf.indexOf("\n");
          if (!line) continue;
          try {
            handlers.onEvent(JSON.parse(line) as DaemonWebSocketEvent);
          } catch {
            // ignore malformed lines
          }
        }
      });
      child.on("close", (code) => {
        try {
          unlinkSync(tmp);
        } catch {
          // already removed
        }
        finish(code);
      });
      return {
        pid: child.pid,
        exited,
        send(data: string) {
          if (!child.stdin.writable) return;
          child.stdin.write(`${JSON.stringify({ op: "send", data })}\n`);
        },
        close() {
          if (!child.stdin.writable) return;
          child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
        },
        kill() {
          try {
            child.kill("SIGTERM");
          } catch {
            // already exited
          }
        },
      };
    }
  }

  return {
    invoke: async (payload, invokeOptions) => {
      syncExe = await executable();
      return invoke(payload, invokeOptions);
    },
    invokeSync: (payload, invokeOptions) => invokeSync(payload, invokeOptions),
    cancel,
    cancelActive() {
      if (!activeId) return false;
      cancel(activeId);
      return true;
    },
    cancelAll() {
      const ids = [...pending.keys(), ...oneShot.keys()];
      if (ids.length === 0) return false;
      for (const id of ids) cancel(id);
      return true;
    },
    openWebSocket,
  };
}
