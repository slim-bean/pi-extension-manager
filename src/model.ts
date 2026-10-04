import { validRange } from "semver";

export type Scope = "user" | "project";
export interface Dependency {
  repo: string;
  version?: string;
}
export interface Requirement {
  kind: "env" | "file" | "executable";
  names: string[];
  label: string;
  optional?: boolean;
  help?: string;
}
export interface Manifest {
  schemaVersion: 1;
  requires: Dependency[];
  optional: Dependency[];
  checks: Requirement[];
  help?: string;
  setupCommand?: string;
}
export interface Repo {
  id: string;
  name: string;
  description: string;
  url: string;
  source: string;
  archived: boolean;
  installable: boolean;
  /** Identification is distinct from installability (e.g. invalid dependency metadata). */
  isPiPackage?: boolean;
  packageName?: string;
  version?: string;
  manifest?: Manifest;
  warning?: string;
}
export interface Installation {
  id: string;
  source: string;
  scope: Scope;
  kind: "package" | "explicit" | "discovered";
  path?: string;
  version?: string;
  filtered: boolean;
  missing: boolean;
}
export interface Config {
  schemaVersion: 1;
  owner: string;
  prefix: string;
  cacheHours: number;
  localRoots: string[];
}
export interface Catalog {
  schemaVersion: 1;
  owner: string;
  prefix: string;
  fetchedAt: string;
  repos: Repo[];
}
export interface Profile {
  schemaVersion: 1;
  owner: string;
  packages: { repo: string; ref?: string }[];
}

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function repoId(value: string, owner: string): string {
  const id = value.includes("/") ? value : `${owner}/${value}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(id))
    throw new Error(`Invalid repository: ${value}`);
  return id.toLowerCase();
}
export function parseManifest(value: unknown, owner: string): Manifest {
  if (!record(value) || value.schemaVersion !== 1)
    throw new Error("pi-manager.json must have schemaVersion: 1");
  const deps = (key: string): Dependency[] => {
    const array = value[key] ?? [];
    if (!Array.isArray(array)) throw new Error(`${key} must be an array`);
    return array.map((entry: unknown) => {
      const item = typeof entry === "string" ? { repo: entry } : entry;
      if (!record(item) || typeof item.repo !== "string")
        throw new Error(`Invalid ${key} dependency`);
      if (
        item.version !== undefined &&
        (typeof item.version !== "string" || !validRange(item.version))
      )
        throw new Error(`Invalid version range for ${item.repo}`);
      return {
        repo: repoId(item.repo, owner),
        ...(item.version ? { version: String(item.version) } : {}),
      };
    });
  };
  const checks = value.checks ?? [];
  if (!Array.isArray(checks)) throw new Error("checks must be an array");
  const parsedChecks: Requirement[] = checks.map((check: unknown) => {
    if (
      !record(check) ||
      !["env", "file", "executable"].includes(String(check.kind)) ||
      typeof check.label !== "string" ||
      !Array.isArray(check.names) ||
      !check.names.length ||
      !check.names.every((n) => typeof n === "string" && n.length > 0)
    )
      throw new Error("Invalid readiness check");
    if (check.optional !== undefined && typeof check.optional !== "boolean")
      throw new Error("check.optional must be boolean");
    if (check.help !== undefined && typeof check.help !== "string")
      throw new Error("check.help must be a string");
    return check as unknown as Requirement;
  });
  for (const key of ["help", "setupCommand"])
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`${key} must be a string`);
  if (
    typeof value.setupCommand === "string" &&
    !/^\/[a-zA-Z0-9_-]+(?: [^\r\n]*)?$/.test(value.setupCommand)
  )
    throw new Error("setupCommand must be a single slash command");
  return {
    schemaVersion: 1,
    requires: deps("requires"),
    optional: deps("optional"),
    checks: parsedChecks,
    help: value.help as string | undefined,
    setupCommand: value.setupCommand as string | undefined,
  };
}

// Transitional metadata for existing repos. A repository's pi-manager.json takes precedence.
export function builtinManifest(id: string): Manifest | undefined {
  if (id === "slim-bean/pi-assistant")
    return {
      schemaVersion: 1,
      requires: [
        { repo: "slim-bean/pi-devtools", version: ">=0.3.0" },
        { repo: "slim-bean/pi-search" },
        { repo: "slim-bean/pi-browser" },
      ],
      optional: [],
      checks: [],
      setupCommand: "/assistant status",
      help: "Local mode needs Chrome and an executable browser-fetch gateway (default ~/.local/bin/browser-fetch). External mode needs a gateway URL and credential. Configure .pi/assistant.json; /assistant status verifies the chosen mode. No Chrome or gateway is started by this manager.",
    };
  if (id === "slim-bean/pi-search")
    return {
      schemaVersion: 1,
      requires: [],
      optional: [{ repo: "slim-bean/pi-devtools" }],
      checks: [],
      setupCommand: "/search-provider",
      help: "Search requires a supported API key (subscription OAuth is not enough). Browser fetching is optional: configure PI_SEARCH_BROWSER_URL and a gateway credential. pi-devtools enables browser_read. /search-provider reports search readiness.",
    };
  return undefined;
}

export function githubIdentity(source: string): string | undefined {
  let normalized = source.replace(/^git:/, "").replace(/^git@github\.com:/, "https://github.com/");
  if (/^(https?:|ssh:)\/\//.test(normalized)) {
    try {
      const url = new URL(normalized);
      if (url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return undefined;
      // Remotes commonly contain a username. Identity must never depend on or expose userinfo.
      normalized = `github.com${url.pathname}`;
    } catch {
      return undefined;
    }
  }
  const match = normalized.match(/^github\.com\/([^/]+)\/([^/@#?]+)(?:@[^\s]+)?$/i);
  if (!match) return undefined;
  try {
    return repoId(`${match[1]}/${match[2].replace(/\.git$/, "")}`, match[1]);
  } catch {
    return undefined;
  }
}
export function gitRef(source: string): string | undefined {
  const match = source.match(/github\.com[/:][^/]+\/[^@]+@(.+)$/);
  return match?.[1];
}
export function cleanText(value: string): string {
  // Repository/config text is untrusted terminal content; remove escape/control sequences.
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/(https?:\/\/)[^\s/]+@/g, "$1[redacted]@");
}
export function cleanMultiline(value: string): string {
  return value.split(/\r?\n/).map(cleanText).join("\n");
}
