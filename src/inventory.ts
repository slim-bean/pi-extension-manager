import { access, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { dirname, join, resolve } from "node:path";
import {
  githubIdentity,
  record,
  parseManifest,
  type Installation,
  type Repo,
  type Scope,
} from "./model.ts";
import { expand, jsonFile } from "./storage.ts";

const exec = promisify(execFile);
export interface PackageEntry {
  source: string;
  scope: Scope;
  filtered: boolean;
  installedPath?: string;
}
export interface InventorySettings {
  user: { extensions?: string[] };
  project: { extensions?: string[] };
}
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export interface PackageInfo {
  root: string;
  id?: string;
  version?: string;
  packageName?: string;
  description?: string;
  manifest?: unknown;
}
export async function inspectPath(path: string, repos: Repo[]): Promise<PackageInfo | undefined> {
  let dir: string;
  try {
    dir = (await stat(path)).isDirectory() ? path : dirname(path);
  } catch {
    return undefined;
  }
  // Find the owning package of an explicitly loaded src/index.ts without guessing names.
  for (let i = 0; i < 8; i++) {
    const pkg = await jsonFile(join(dir, "package.json"));
    if (record(pkg)) {
      let remote: string | undefined;
      try {
        remote = (
          await exec("git", ["-C", dir, "config", "--get", "remote.origin.url"], { timeout: 5_000 })
        ).stdout.trim();
      } catch {
        /* Non-git packages are valid. */
      }
      const repository =
        typeof pkg.repository === "string"
          ? pkg.repository
          : record(pkg.repository) && typeof pkg.repository.url === "string"
            ? pkg.repository.url
            : undefined;
      // A known foreign remote takes precedence: do not identify another owner's fork by name.
      let id = remote
        ? githubIdentity(remote)
        : repository
          ? githubIdentity(repository.replace(/^git\+/, ""))
          : undefined;
      if (!id && !remote && !repository && typeof pkg.name === "string") {
        const matches = repos.filter((r) => r.packageName === pkg.name || r.name === pkg.name);
        if (matches.length === 1) id = matches[0].id;
      }
      return {
        root: dir,
        id,
        version: typeof pkg.version === "string" ? pkg.version : undefined,
        packageName: typeof pkg.name === "string" ? pkg.name : undefined,
        description: typeof pkg.description === "string" ? pkg.description : undefined,
        manifest: await jsonFile(join(dir, "pi-manager.json")),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
async function autoEntries(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (/\.[cm]?[jt]s$/.test(entry.name)) result.push(path);
    else if ((await exists(join(path, "index.ts"))) || (await exists(join(path, "index.js"))))
      result.push(path);
  }
  return result;
}
export async function inventory(
  repos: Repo[],
  packages: PackageEntry[],
  settings: InventorySettings,
  cwd: string,
  agentDir: string,
): Promise<Installation[]> {
  const result: Installation[] = [];
  const add = async (
    source: string,
    scope: Scope,
    kind: Installation["kind"],
    path?: string,
    filtered = false,
  ) => {
    const info = path ? await inspectPath(path, repos) : undefined;
    const id = githubIdentity(source) ?? info?.id;
    if (!id) return;
    const base = scope === "user" ? agentDir : join(cwd, ".pi");
    const exclusions = (settings[scope].extensions ?? [])
      .filter((p) => /^[!-]/.test(p))
      .map((p) => expand(p.slice(1), base));
    const excluded =
      !!path &&
      exclusions.some(
        (pattern) =>
          minimatch(path, pattern, { dot: true }) ||
          (!/[*?{]/.test(pattern) &&
            (path.startsWith(`${pattern}/`) || (!!info && pattern.startsWith(`${info.root}/`)))),
      );
    result.push({
      id,
      source,
      scope,
      kind,
      path,
      version: info?.version,
      filtered: filtered || excluded,
      missing: !path || !(await exists(path)),
    });
    const catalogRepo = repos.find((r) => r.id === id);
    if (catalogRepo && !catalogRepo.description.trim() && info?.description)
      catalogRepo.description = info.description;
    // Installed checkout metadata reflects the code actually running, not the latest GitHub version.
    if (info?.manifest !== undefined) {
      const repo = repos.find((r) => r.id === id);
      if (repo) {
        try {
          repo.manifest = parseManifest(info.manifest, id.split("/")[0]);
        } catch (error) {
          repo.warning = `Installed pi-manager.json invalid: ${String(error)}`;
        }
      }
    }
  };
  for (const pkg of packages)
    await add(pkg.source, pkg.scope, "package", pkg.installedPath, pkg.filtered);
  for (const scope of ["user", "project"] as const) {
    const base = scope === "user" ? agentDir : join(cwd, ".pi");
    for (const source of settings[scope].extensions ?? []) {
      if (source.startsWith("builtin:") || /^[!-]/.test(source) || /[*?{]/.test(source)) continue;
      const path = source.startsWith("+") ? source.slice(1) : source;
      if (path.startsWith("builtin:")) continue;
      await add(source, scope, "explicit", expand(path, base));
    }
    for (const path of await autoEntries(join(base, "extensions")))
      await add(path, scope, "discovered", path);
  }
  return result;
}
export async function findCheckouts(roots: string[], repos: Repo[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = resolve(root, entry.name);
      if (!(await exists(join(path, "package.json")))) continue;
      const info = await inspectPath(path, repos);
      if (info?.id && repos.some((r) => r.id === info.id)) found.set(info.id, info.root);
    }
  }
  return found;
}
