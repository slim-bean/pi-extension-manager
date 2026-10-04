import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { atomicJson, jsonFile, managerDir } from "./storage.ts";
import {
  builtinManifest,
  parseManifest,
  record,
  repoId,
  type Catalog,
  type Config,
  type Repo,
} from "./model.ts";

const exec = promisify(execFile);
export type Api = (endpoint: string) => Promise<unknown>;
export function githubApi(): Api {
  let transport: "gh" | "public" | undefined;
  let login: string | undefined;
  return async (endpoint) => {
    if (transport !== "public") {
      try {
        if (login === undefined) {
          const { stdout } = await exec("gh", ["api", "--hostname", "github.com", "user"], {
            timeout: 30_000,
          });
          const user: unknown = JSON.parse(stdout);
          if (!record(user) || typeof user.login !== "string")
            throw new Error("Unexpected authenticated GitHub user response");
          login = user.login.toLowerCase();
        }
        const listing = endpoint.match(/^users\/([^/]+)\/repos\?(.*)$/);
        // /users/:owner/repos is public-only. Use /user/repos for our own private repositories.
        const routed =
          listing && listing[1].toLowerCase() === login
            ? `user/repos?${listing[2].replace("type=owner", "affiliation=owner")}`
            : endpoint;
        const { stdout } = await exec("gh", ["api", "--hostname", "github.com", routed], {
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        transport = "gh";
        return JSON.parse(stdout);
      } catch (error) {
        // Never silently downgrade failed authenticated requests to anonymous ones.
        if (transport === "gh" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        transport = "public";
      }
    }
    const response = await fetch(`https://api.github.com/${endpoint}`, {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-extension-manager" },
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
    return response.json();
  };
}
async function contents(api: Api, id: string, path: string): Promise<unknown | undefined> {
  try {
    const value = await api(`repos/${id}/contents/${path}`);
    if (!record(value) || value.encoding !== "base64" || typeof value.content !== "string")
      throw new Error(`Unexpected contents response for ${id}/${path}`);
    return JSON.parse(Buffer.from(value.content, "base64").toString("utf8"));
  } catch (error) {
    if (/\b404\b/.test(String(error))) return undefined;
    throw error;
  }
}
export async function discover(config: Config, api: Api): Promise<Repo[]> {
  const candidates: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await api(
      `users/${config.owner}/repos?per_page=100&page=${page}&type=owner&sort=full_name`,
    );
    if (!Array.isArray(result)) throw new Error("Unexpected GitHub repositories response");
    for (const item of result)
      if (record(item) && typeof item.name === "string" && item.name.startsWith(config.prefix))
        candidates.push(item);
    if (result.length < 100) break;
    if (page === 100) throw new Error("GitHub repository pagination limit reached");
  }
  const repos: Repo[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        const name = String(candidate.name),
          id = repoId(name, config.owner);
        const repo: Repo = {
          id,
          name,
          description: typeof candidate.description === "string" ? candidate.description : "",
          url: `https://github.com/${id}`,
          source: `git:github.com/${id}`,
          archived: candidate.archived === true,
          installable: false,
        };
        try {
          const pkg = await contents(api, id, "package.json");
          if (record(pkg)) {
            repo.packageName = typeof pkg.name === "string" ? pkg.name : undefined;
            repo.version = typeof pkg.version === "string" ? pkg.version : undefined;
            repo.installable =
              record(pkg.pi) &&
              ["extensions", "skills", "prompts", "themes"].some(
                (key) =>
                  Array.isArray((pkg.pi as Record<string, unknown>)[key]) &&
                  ((pkg.pi as Record<string, unknown>)[key] as unknown[]).length > 0,
              );
          }
          if (!repo.installable) {
            const root = await api(`repos/${id}/contents/`);
            repo.installable =
              Array.isArray(root) &&
              root.some(
                (e) =>
                  record(e) &&
                  e.type === "dir" &&
                  ["extensions", "skills", "prompts", "themes"].includes(String(e.name)),
              );
          }
          const manifest = await contents(api, id, "pi-manager.json");
          repo.manifest =
            manifest === undefined ? builtinManifest(id) : parseManifest(manifest, config.owner);
        } catch (error) {
          repo.warning = `Metadata unavailable/invalid: ${String(error)}`;
          repo.installable = false; // Do not install when dependencies could not be inspected.
        }
        repos.push(repo);
      }
    }),
  );
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}
export interface CatalogResult {
  catalog: Catalog;
  notice?: string;
}
export async function loadCatalog(
  agentDir: string,
  config: Config,
  refresh = false,
  api: Api = githubApi(),
): Promise<CatalogResult> {
  const path = join(managerDir(agentDir), "catalog.json");
  let cached: Catalog | undefined;
  try {
    const value = await jsonFile(path);
    if (
      record(value) &&
      value.schemaVersion === 1 &&
      value.owner === config.owner &&
      value.prefix === config.prefix &&
      typeof value.fetchedAt === "string" &&
      Array.isArray(value.repos)
    ) {
      // Cache entries are data too; validate metadata again instead of trusting a cast.
      const entries = value.repos.map((r: unknown): Repo => {
        if (
          !record(r) ||
          typeof r.id !== "string" ||
          repoId(r.id, config.owner) !== r.id ||
          typeof r.name !== "string" ||
          typeof r.description !== "string" ||
          typeof r.installable !== "boolean" ||
          typeof r.archived !== "boolean"
        )
          throw new Error("Invalid catalog cache entry");
        return {
          ...r,
          url: `https://github.com/${r.id}`,
          source: `git:github.com/${r.id}`,
          manifest: r.manifest ? parseManifest(r.manifest, config.owner) : undefined,
        } as Repo;
      });
      cached = {
        schemaVersion: 1,
        owner: config.owner,
        prefix: config.prefix,
        fetchedAt: value.fetchedAt,
        repos: entries,
      };
    }
  } catch {
    /* A broken cache is recoverable through fresh discovery. */
  }
  if (
    !refresh &&
    cached &&
    Date.now() - Date.parse(cached.fetchedAt) < config.cacheHours * 3_600_000
  )
    return { catalog: cached };
  try {
    const repos = await discover(config, api);
    const catalog: Catalog = {
      schemaVersion: 1,
      owner: config.owner,
      prefix: config.prefix,
      fetchedAt: new Date().toISOString(),
      repos,
    };
    await atomicJson(path, catalog);
    return {
      catalog,
      notice: repos.some((r) => r.warning)
        ? "Some repository metadata could not be inspected; those installs are blocked. See details and refresh after fixing access/rate limits."
        : undefined,
    };
  } catch (error) {
    if (!cached) throw error;
    return {
      catalog: cached,
      notice: `Using cached catalog from ${cached.fetchedAt}; GitHub refresh failed: ${String(error)}`,
    };
  }
}
