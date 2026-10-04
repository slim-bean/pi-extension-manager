import { satisfies, valid } from "semver";
import { githubIdentity, type Installation, type Repo, type Scope } from "./model.ts";

function sameNativePackage(a: Installation, b: Installation): boolean {
  if (a.kind !== "package" || b.kind !== "package") return false;
  const gitA = githubIdentity(a.source),
    gitB = githubIdentity(b.source);
  if (gitA || gitB) return !!gitA && gitA === gitB;
  if (a.source.startsWith("npm:") && b.source.startsWith("npm:")) {
    const name = (source: string) => source.replace(/@[^/@]+$/, "");
    return name(a.source) === name(b.source);
  }
  return !!a.path && a.path === b.path;
}

export interface InstallAction {
  kind: "install";
  id: string;
  source: string;
  scope: Scope;
  reason: string;
}
export interface RemoveAction {
  kind: "remove";
  id: string;
  installation: Installation;
}
export interface Plan {
  installs: InstallAction[];
  removals: RemoveAction[];
  errors: string[];
  notes: string[];
}
export interface PlanInput {
  repos: Repo[];
  installed: Installation[];
  scope: Scope;
  changes: Map<string, boolean>;
  sources?: Map<string, string>;
  versions?: Map<string, string | undefined>;
}
export function buildPlan(input: PlanInput): Plan {
  const { repos, installed, scope, changes } = input;
  const byId = new Map(repos.map((r) => [r.id, r]));
  const plan: Plan = { installs: [], removals: [], errors: [], notes: [] };
  const retained = installed.filter((i) => !(changes.get(i.id) === false && i.scope === scope));
  // A project package overrides the equivalent global declaration in Pi. Do not let a
  // disabled/older project package pretend its global counterpart is still a provider.
  const effective = retained.filter(
    (i) =>
      i.scope !== "user" || !retained.some((p) => p.scope === "project" && sameNativePackage(i, p)),
  );
  const active = effective.filter((i) => !i.missing && !i.filtered);
  const removing = installed.filter((i) => changes.get(i.id) === false && i.scope === scope);
  for (const item of removing) {
    if (item.kind === "discovered")
      plan.errors.push(
        `${item.id} is auto-discovered at ${item.path}; move it outside the extensions directory or use pi config. The manager will not delete your files.`,
      );
    else if (item.id.endsWith("/pi-extension-manager"))
      plan.errors.push("Remove this manager with pi remove outside the running session.");
    else plan.removals.push({ kind: "remove", id: item.id, installation: item });
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const ensure = (id: string, reason: string, range?: string) => {
    const repo = byId.get(id);
    const instances = active.filter((i) => i.id === id);
    const useExisting = instances.length > 0;
    if (changes.get(id) === false && !useExisting) {
      plan.errors.push(`${reason} requires ${id}, but you selected it for removal.`);
      return;
    }
    if (retained.some((i) => i.id === id) && !useExisting) {
      plan.errors.push(
        `${id} is configured but missing or resource-filtered. Repair it or enable its resources with pi config; refusing to install a second copy.`,
      );
      return;
    }
    if (range) {
      const versions = useExisting
        ? instances.map((i) => i.version)
        : [input.versions?.has(id) ? input.versions.get(id) : repo?.version];
      if (!versions.every((v) => v && valid(v) && satisfies(v, range)))
        plan.errors.push(
          `${reason} needs ${id} ${range}; found ${versions.join(", ") || "unknown version"}. Update/select a compatible checkout first.`,
        );
    }
    if (visiting.has(id)) {
      plan.errors.push(`Dependency cycle involving ${id}`);
      return;
    }
    if (visited.has(id)) return;
    if (!repo) {
      plan.errors.push(
        `Dependency ${id} is outside this catalog. Install it separately or add it to the catalog owner's repositories.`,
      );
      return;
    }
    if (!useExisting && (!repo.installable || repo.archived || repo.warning)) {
      plan.errors.push(
        `Cannot install ${id}: ${repo.warning ?? (repo.archived ? "repository is archived" : "not a Pi package")}`,
      );
      return;
    }
    if (repo.warning && useExisting)
      plan.errors.push(`Cannot verify dependencies for ${id}: ${repo.warning}`);
    if (useExisting && instances.length > 1)
      plan.notes.push(
        `${id} is present via multiple declarations; review details for duplicate loading.`,
      );
    visiting.add(id);
    for (const dep of repo.manifest?.requires ?? []) ensure(dep.repo, id, dep.version);
    visiting.delete(id);
    visited.add(id);
    if (!useExisting) {
      plan.installs.push({
        kind: "install",
        id,
        source: input.sources?.get(id) ?? repo.source,
        scope,
        reason,
      });
      for (const check of repo.manifest?.checks ?? [])
        plan.notes.push(
          `${id}: ${check.label}${check.optional ? " (optional)" : " (check after install)"}`,
        );
    }
  };
  // Only retained catalog packages participate; unrelated third-party packages are never managed.
  const roots = new Set([
    ...active.map((i) => i.id).filter((id) => byId.has(id)),
    ...[...changes].filter(([, on]) => on).map(([id]) => id),
  ]);
  for (const id of roots)
    ensure(id, changes.get(id) === true ? "selected explicitly" : "remaining installed extension");
  // Remove dependents before their dependencies (the reverse of install order).
  const removalIds = new Set(plan.removals.map((r) => r.id));
  const ordered: string[] = [],
    seen = new Set<string>();
  const order = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.manifest?.requires ?? [])
      if (removalIds.has(dep.repo)) order(dep.repo);
    ordered.push(id);
  };
  for (const id of removalIds) order(id);
  plan.removals.sort((a, b) => ordered.indexOf(b.id) - ordered.indexOf(a.id));
  plan.errors = [...new Set(plan.errors)];
  plan.notes = [...new Set(plan.notes)];
  return plan;
}
export function describePlan(plan: Plan): string {
  return (
    [
      ...plan.errors.map((e) => `BLOCKED: ${e}`),
      ...plan.installs.map((a) => `INSTALL [${a.scope}] ${a.id}\n  ${a.source} (${a.reason})`),
      ...plan.removals.map(
        (a) => `REMOVE [${a.installation.scope}] ${a.id}\n  ${a.installation.source}`,
      ),
      ...plan.notes.map((n) => `NOTE: ${n}`),
    ].join("\n") || "No changes needed."
  );
}
