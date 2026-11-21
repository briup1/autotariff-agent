import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  lstat,
  writeFile,
  link,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runsRootFor } from "./paths.js";
import type { ArtifactRef } from "./models.js";
export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export class ArtifactStore {
  readonly root: string;
  /** Accepts a project root and resolves its isolated run-evidence root. */
  constructor(projectRoot: string) {
    this.root = runsRootFor(projectRoot);
  }
  path(runId: string, path: string): string {
    if (
      !/^[\w-]+$/.test(runId) ||
      isAbsolute(path) ||
      path.split(/[\\/]/).some((p) => p === "..")
    )
      throw new Error("Artifact path escapes the run directory");
    const base = resolve(this.root, runId),
      target = resolve(base, path);
    if (target === base || relative(base, target).startsWith(".."))
      throw new Error("Artifact path escapes the run directory");
    return target;
  }
  async guard(path: string): Promise<void> {
    const rel = relative(this.root, path);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Artifact escapes root");
    let current = this.root;
    for (const part of ["", ...rel.split(sep)]) {
      if (part) current = resolve(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Artifact symlink rejected");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  async put(
    runId: string,
    path: string,
    value: string | Uint8Array,
    kind: string,
  ): Promise<ArtifactRef> {
    const target = this.path(runId, path);
    await this.guard(target);
    await mkdir(dirname(target), { recursive: true });
    const bytes = Buffer.from(value),
      sha256 = digest(bytes),
      temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await link(temporary, target);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        digest(await readFile(target)) !== sha256
      )
        throw new Error(`Immutable artifact conflict: ${path}`);
    } finally {
      await unlink(temporary);
    }
    return {
      artifactId: `${runId}:${path}`,
      kind,
      relativePath: path,
      sha256,
      bytes: bytes.length,
    };
  }
  async snapshot(runId: string, path: string, value: unknown): Promise<void> {
    const target = this.path(runId, path);
    await this.guard(target);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomUUID()}`;
    await writeFile(temp, JSON.stringify(value, null, 2));
    await rename(temp, target);
  }
  async read(ref: ArtifactRef): Promise<Buffer> {
    const path = this.path(ref.artifactId.split(":")[0], ref.relativePath);
    await this.guard(path);
    const bytes = await readFile(path);
    if (digest(bytes) !== ref.sha256)
      throw new Error(`Artifact digest mismatch: ${ref.relativePath}`);
    return bytes;
  }
  async exists(ref: ArtifactRef): Promise<boolean> {
    try {
      await this.read(ref);
      return true;
    } catch {
      return false;
    }
  }
}

/** A contiguous text hunk preserves repeated-line changes without quadratic scans. */
export function textDiff(
  original: string,
  updated: string,
): { startLine: number; removed: string[]; added: string[] } {
  const before = original.split("\n"),
    after = updated.split("\n");
  let prefix = 0,
    suffix = 0;
  while (
    prefix < Math.min(before.length, after.length) &&
    before[prefix] === after[prefix]
  )
    prefix++;
  while (
    suffix < Math.min(before.length, after.length) - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  return {
    startLine: prefix + 1,
    removed: before.slice(prefix, before.length - suffix),
    added: after.slice(prefix, after.length - suffix),
  };
}
