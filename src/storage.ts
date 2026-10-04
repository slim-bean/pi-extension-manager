import { mkdir, readFile, rename, writeFile, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { record, repoId, type Config, type Profile } from "./model.ts";

export const expand = (path: string, base = process.cwd()) =>
  resolve(
    base,
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
  );
export async function jsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${String(error)}`);
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export function managerDir(agentDir: string): string {
  return join(agentDir, "extension-manager");
}
export async function loadConfig(agentDir: string): Promise<Config> {
  const value = await jsonFile(join(managerDir(agentDir), "config.json"));
  if (value === undefined)
    return {
      schemaVersion: 1,
      owner: "slim-bean",
      prefix: "pi-",
      cacheHours: 24,
      localRoots: [join(homedir(), "projects")],
    };
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.owner !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value.owner)
  )
    throw new Error("Invalid extension-manager config (schemaVersion and owner required)");
  const prefix = value.prefix ?? "pi-",
    cacheHours = value.cacheHours ?? 24,
    roots = value.localRoots ?? [join(homedir(), "projects")];
  if (
    typeof prefix !== "string" ||
    !prefix.length ||
    typeof cacheHours !== "number" ||
    !Number.isFinite(cacheHours) ||
    cacheHours < 0 ||
    !Array.isArray(roots) ||
    !roots.every((r) => typeof r === "string")
  )
    throw new Error("Invalid prefix, cacheHours, or localRoots");
  return {
    schemaVersion: 1,
    owner: value.owner.toLowerCase(),
    prefix,
    cacheHours,
    localRoots: roots.map((r) => expand(r, agentDir)),
  };
}
export function profilePath(agentDir: string, name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
    throw new Error("Profile names must be 1–64 letters, digits, underscores or hyphens");
  return join(managerDir(agentDir), "profiles", `${name}.json`);
}
export function parseProfile(value: unknown): Profile {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.owner !== "string" ||
    !Array.isArray(value.packages)
  )
    throw new Error("Invalid profile");
  repoId("validation", value.owner);
  const packages = value.packages.map((p: unknown) => {
    if (
      !record(p) ||
      typeof p.repo !== "string" ||
      (p.ref !== undefined &&
        (typeof p.ref !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(p.ref) ||
          p.ref.includes("..")))
    )
      throw new Error("Invalid profile package/ref");
    return {
      repo: repoId(p.repo, value.owner as string),
      ...(p.ref ? { ref: String(p.ref) } : {}),
    };
  });
  if (new Set(packages.map((p) => p.repo)).size !== packages.length)
    throw new Error("Duplicate profile packages");
  return { schemaVersion: 1, owner: value.owner, packages };
}
export async function withManagerLock<T>(agentDir: string, action: () => Promise<T>): Promise<T> {
  const dir = managerDir(agentDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "apply.lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Another manager operation is running. If it crashed, verify no operation is active before removing ${path}.`,
      );
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await action();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
