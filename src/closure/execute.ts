import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { AsyncLocalStorage } from "node:async_hooks";
export const executionDeadline = new AsyncLocalStorage<number>();
export type IsolationDescriptor = {
  provider: "macos_sandbox";
  network: "disabled";
  readRoots: string[];
  writeRoots: string[];
  timeoutSeconds: number;
  memoryBytes?: number;
  cpuSeconds?: number;
};
const quote = (s: string): string => JSON.stringify(s);
export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
    memoryBytes?: number;
  } = {},
): Promise<string> {
  const remaining = (executionDeadline.getStore() ?? Infinity) - Date.now();
  if (remaining <= 0)
    throw new Error("BLOCKED: worker wall deadline exhausted");
  return new Promise((yes, no) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: options.env ?? {
        PATH: "/usr/bin:/bin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        TMPDIR: process.env.TMPDIR,
        PI_RUN_ROOT: process.env.PI_RUN_ROOT,
        PI_RUN_ORIGIN: process.env.PI_RUN_ORIGIN,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      problem: Error | undefined;
    const kill = (): void => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    let checking = false;
    const monitor = setInterval(() => {
      if (!options.memoryBytes || !child.pid || checking) return;
      checking = true;
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { env: { PATH: "/usr/bin:/bin" }, timeout: 1000 },
        (error, out) => {
          checking = false;
          if (!error && Number(out.trim()) * 1024 > options.memoryBytes!) {
            problem = new Error("BLOCKED: worker memory limit");
            kill();
          }
        },
      );
    }, 25);
    const timer = setTimeout(
      () => {
        problem = new Error("BLOCKED: worker timeout");
        kill();
      },
      Math.min(options.timeoutMs ?? 120000, remaining),
    );
    const collect = (chunk: Buffer, err: boolean): void => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 64 * 1024 * 1024)) {
        problem = new Error("BLOCKED: worker output limit");
        kill();
      } else if (err) stderr += chunk.toString();
      else stdout += chunk.toString();
    };
    child.stdout.on("data", (c: Buffer) => collect(c, false));
    child.stderr.on("data", (c: Buffer) => collect(c, true));
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(monitor);
      no(new Error(`BLOCKED: dependency unavailable: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(monitor);
      kill();
      if (problem) no(problem);
      else if (code !== 0)
        no(
          new Error(
            `Worker exited ${code ?? signal}: ${stderr.slice(0, 8000)}`,
          ),
        );
      else yes(stdout);
    });
  });
}
export async function executeParser(
  pythonBin: string,
  parserPath: string,
  sourcePath: string,
  outputPath: string,
  isolation: IsolationDescriptor,
): Promise<Record<string, unknown>[]> {
  if (
    process.platform !== "darwin" ||
    isolation.provider !== "macos_sandbox" ||
    isolation.network !== "disabled"
  )
    throw new Error("BLOCKED: verified OS sandbox unavailable");
  const source = await realpath(sourcePath),
    parser = await realpath(parserPath),
    targetParent = await realpath(dirname(outputPath)),
    target = resolve(targetParent, outputPath.slice(dirname(outputPath).length + 1));
  const canonicalRoots = async (roots: string[]): Promise<string[]> =>
    Promise.all(roots.map(async (root) => {
      try { return await realpath(root); }
      catch { return resolve(root); }
    }));
  const inside = (p: string, roots: string[]): boolean =>
    roots.some((r) => p === resolve(r) || p.startsWith(resolve(r) + "/"));
  const readRoots = await canonicalRoots(isolation.readRoots);
  const writeRoots = await canonicalRoots(isolation.writeRoots);
  if (!inside(source, readRoots) || !inside(parser, readRoots) || !inside(target, writeRoots))
    throw new Error("BLOCKED: path outside isolation roots");
  const root = resolve(PROJECT_ROOT, ".tmp/runtime");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(join(root, "parser-"));
  try {
    const py = await realpath(pythonBin),
      prefix = dirname(dirname(py)),
      launcher = resolve(PROJECT_ROOT, "src/workers/limited_exec.py");
    const reads = [
      prefix,
      dirname(dirname(resolve(pythonBin))),
      resolve(PROJECT_ROOT, ".venv"),
      "/usr/lib",
      "/System",
      "/Library/Apple",
      "/private/var/db/dyld",
      "/private/var/db/timezone",
      scratch,
    ];
    const literals = [
      "/",
      source,
      parser,
      launcher,
      "/dev/null",
      "/dev/urandom",
      "/dev/random",
    ];
    const policy = `(version 1)(deny default)(allow process-exec)(allow signal (target self))(allow file-read-metadata)(allow file-read* ${reads.map((r) => `(subpath ${quote(r)})`).join(" ")} ${literals.map((r) => `(literal ${quote(r)})`).join(" ")})(allow file-write* (subpath ${quote(scratch)}))`;
    const out = join(scratch, "result.json");
    await runProcess(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        policy,
        pythonBin,
        launcher,
        String(isolation.cpuSeconds ?? 30),
        String(isolation.memoryBytes ?? 1024 ** 3),
        String(32 * 1024 ** 2),
        parser,
        source,
        out,
      ],
      {
        cwd: scratch,
        memoryBytes: isolation.memoryBytes ?? 1024 ** 3,
        timeoutMs: isolation.timeoutSeconds * 1000,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: scratch,
          TMPDIR: scratch,
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    if ((await stat(out)).size > 32 * 1024 ** 2)
      throw new Error("Parser result too large");
    const records: unknown = JSON.parse(await readFile(out, "utf8"));
    if (
      !Array.isArray(records) ||
      records.some((r) => !r || typeof r !== "object" || Array.isArray(r))
    )
      throw new Error("Parser output must be an array of records");
    // The host commits records; candidate code cannot write any durable evidence.
    return records as Record<string, unknown>[];
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
