import { join } from "node:path";
import { readdir } from "node:fs/promises";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { loadCatalog } from "./github.ts";
import { findCheckouts, inspectPath } from "./inventory.ts";
import { checkRequirement } from "./checks.ts";
import { NativePackages } from "./native.ts";
import { buildPlan, describePlan, type Plan } from "./planner.ts";
import {
  atomicJson,
  jsonFile,
  loadConfig,
  managerDir,
  parseProfile,
  profilePath,
} from "./storage.ts";
import {
  cleanText,
  cleanMultiline,
  gitRef,
  parseManifest,
  repoId,
  type Config,
  type Installation,
  type Repo,
  type Scope,
} from "./model.ts";
import { showScreen, status } from "./ui.ts";
import { withProgress } from "./progress.ts";

const HELP = `Extensions manager\n/extensions                         interactive catalog\n/extensions list                    inventory + catalog\n/extensions refresh                 refresh GitHub catalog\n/extensions install <repo> [-l]      dependency-aware install plan\n/extensions remove <repo> [-l]       dependency-aware removal plan\n/extensions check <repo>             requirements and setup help\n/extensions update <repo>            update a managed git/npm package\n/extensions profile save <name>      save portable selection\n/extensions profile apply <name> [-l] additive, reviewed install plan\n/extensions profile list            list saved profiles\n/extensions help\n\n-l/--local selects project scope; default is global. No changes occur without confirmation.`;
class ReloadRequested extends Error {}
interface Snapshot {
  config: Config;
  repos: Repo[];
  catalogRepos: Repo[];
  installed: Installation[];
  native: NativePackages;
  fingerprint: string;
  fetchedAt: string;
  checkouts: Map<string, string>;
}
async function snapshot(
  ctx: ExtensionCommandContext,
  agentDir: string,
  refresh = false,
  includeCheckouts = false,
): Promise<Snapshot> {
  const result = await withProgress(ctx, "Loading extensions", async (report) => {
    report("Reading manager configuration…");
    const config = await loadConfig(agentDir);
    const { catalog, notice } = await loadCatalog(agentDir, config, refresh, undefined, report);
    const repos = structuredClone(catalog.repos);
    const native = new NativePackages(ctx.cwd, agentDir, ctx.isProjectTrusted());
    report("Inspecting installed packages and explicit extension files…");
    const installed = await native.inventory(repos);
    let checkouts = new Map<string, string>();
    if (includeCheckouts) {
      report("Looking for local development checkouts…");
      checkouts = await findCheckouts(config.localRoots, repos);
    }
    return {
      config,
      repos,
      catalogRepos: catalog.repos,
      installed,
      native,
      fingerprint: native.fingerprint(),
      fetchedAt: catalog.fetchedAt,
      checkouts,
      notice,
    };
  });
  if (result.notice) ctx.ui.notify(cleanText(result.notice), "warning");
  return result;
}
function resolveRepo(s: Snapshot, value: string): Repo {
  const id = repoId(value, s.config.owner);
  const repo = s.repos.find((r) => r.id === id);
  if (!repo) throw new Error(`Unknown repository ${id}. Try /extensions refresh.`);
  return repo;
}
async function apply(ctx: ExtensionCommandContext, s: Snapshot, plan: Plan): Promise<boolean> {
  if (plan.errors.length) {
    ctx.ui.notify(cleanMultiline(describePlan(plan)), "error");
    return false;
  }
  if (!plan.installs.length && !plan.removals.length) {
    ctx.ui.notify("No changes needed.", "info");
    return false;
  }
  if (!ctx.hasUI)
    throw new Error(
      "Apply requires interactive confirmation (TUI or RPC). Use pi install/remove for unattended operations.",
    );
  const message = `${describePlan(plan)}\n\nInstalling trusted repositories can execute package/extension code. Existing configuration files and local checkouts are not deleted. Other running sessions are not reloaded.`;
  if (!(await ctx.ui.confirm("Apply extension changes?", cleanMultiline(message)))) return false;
  await ctx.waitForIdle();
  const completed = await s.native.execute(
    plan,
    s.fingerprint,
    (message) => ctx.ui.setStatus("extension-manager", cleanText(message)),
    s.repos,
  );
  ctx.ui.setStatus("extension-manager", undefined);
  ctx.ui.notify(completed.join("\n"), "info");
  if (
    await ctx.ui.confirm(
      "Reload this session?",
      "Load the new package selection now? Other sessions need their own /reload. This replaces the extension runtime.",
    )
  ) {
    throw new ReloadRequested(); // The command cleans up first, then reloads as its final operation.
  }
  ctx.ui.notify("Changes saved. Run /reload to apply them to this session.", "info");
  return true;
}
async function details(
  ctx: ExtensionCommandContext,
  s: Snapshot,
  repo: Repo,
  pi: ExtensionAPI,
): Promise<void> {
  const lines = [
    repo.name,
    repo.description,
    repo.url,
    `Catalog version: ${repo.version ?? "unknown"}`,
    `Installable: ${repo.installable && !repo.archived}`,
    `Metadata fetched: ${s.fetchedAt}`,
  ];
  for (const i of s.installed.filter((i) => i.id === repo.id))
    lines.push(
      `${i.scope} / ${i.kind}: ${i.source}\n  ${i.path ?? "not on disk"} · version ${i.version ?? "unknown"}${i.filtered ? " · resource-filtered (review pi config)" : ""}${i.missing ? " · missing" : ""}`,
    );
  if (repo.warning) lines.push(`Warning: ${repo.warning}`);
  if (repo.manifest) {
    const m = repo.manifest;
    lines.push(
      `Requires: ${m.requires.map((d) => `${d.repo}${d.version ? ` ${d.version}` : ""}`).join(", ") || "none declared"}`,
    );
    lines.push(`Optional: ${m.optional.map((d) => d.repo).join(", ") || "none declared"}`);
    for (const check of m.checks) {
      const result = await checkRequirement(check, ctx.cwd);
      lines.push(
        `${result.ok ? "OK" : result.optional ? "OPTIONAL" : "MISSING"}: ${result.label}${result.help ? ` — ${result.help}` : ""}`,
      );
    }
    if (m.help) lines.push(m.help);
  } else
    lines.push(
      "No manager metadata: extension dependencies and configuration requirements are unknown. See the repository README.",
    );
  if (!repo.manifest?.checks.length)
    lines.push(
      "No general readiness checks declared; installed does not necessarily mean configured or running.",
    );
  ctx.ui.notify(lines.map(cleanMultiline).join("\n"), "info");
  const command = repo.manifest?.setupCommand;
  if (
    command &&
    ctx.hasUI &&
    pi.getCommands().some((c) => c.name === command.slice(1).split(" ")[0])
  ) {
    if (
      await ctx.ui.confirm(
        "Open extension setup/status?",
        `Place ${cleanText(command)} in the editor? Press Enter yourself to run it.`,
      )
    )
      ctx.ui.setEditorText(command);
  }
}
async function chooseSource(
  ctx: ExtensionCommandContext,
  s: Snapshot,
  id: string,
  checkouts: Map<string, string>,
  sources: Map<string, string>,
  versions: Map<string, string | undefined>,
): Promise<void> {
  const repo = s.repos.find((r) => r.id === id)!;
  if (s.installed.some((i) => i.id === id)) {
    ctx.ui.notify(
      "Existing install source is preserved. Remove its declaration first if you want to switch sources.",
      "info",
    );
    return;
  }
  const local = checkouts.get(id);
  const options = ["GitHub (managed checkout)", ...(local ? [`Local checkout: ${local}`] : [])];
  const choice = await ctx.ui.select(`Source for ${repo.name}`, options);
  if (!choice) return;
  if (choice === options[0]) {
    sources.delete(id);
    versions.delete(id);
    repo.manifest = structuredClone(s.catalogRepos.find((r) => r.id === id)?.manifest);
  } else if (local) {
    const info = await inspectPath(local, s.repos);
    sources.set(id, local);
    versions.set(id, info?.version);
    if (info?.manifest !== undefined) repo.manifest = parseManifest(info.manifest, s.config.owner);
    ctx.ui.notify(
      "Local packages are loaded in-place; Pi does not install their npm dependencies. Run npm install in that checkout if needed.",
      "info",
    );
  }
}
async function interactive(
  ctx: ExtensionCommandContext,
  s: Snapshot,
  agentDir: string,
  scope: Scope,
  pi: ExtensionAPI,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "The interactive catalog needs TUI mode. Use /extensions list/install/remove/check in RPC.",
      "warning",
    );
    return;
  }
  const changes = new Map<string, boolean>(),
    sources = new Map<string, string>(),
    versions = new Map<string, string | undefined>();
  let filter = "";
  let checkouts = s.checkouts;
  for (;;) {
    const action = await showScreen(ctx, s.repos, s.installed, scope, changes, sources, filter);
    if (action.kind === "cancel") return;
    if (action.kind === "apply") {
      if (await apply(ctx, s, buildPlan({ ...s, scope, changes, sources, versions }))) return;
    } else if (action.kind === "details")
      await details(
        ctx,
        s,
        s.repos.find((r) => r.id === action.id)!,
        pi,
      );
    else if (action.kind === "source")
      await chooseSource(ctx, s, action.id, checkouts, sources, versions);
    else if (action.kind === "filter")
      filter = (await ctx.ui.input("Filter extensions", filter)) ?? filter;
    else {
      if (
        changes.size &&
        !(await ctx.ui.confirm(
          "Discard pending changes?",
          "Changing scope or refreshing resets this uncommitted selection.",
        ))
      )
        continue;
      changes.clear();
      sources.clear();
      versions.clear();
      if (action.kind === "scope") {
        if (scope === "user" && !ctx.isProjectTrusted()) {
          ctx.ui.notify("Project is not trusted. Project installs are disabled.", "warning");
          continue;
        }
        scope = scope === "user" ? "project" : "user";
      }
      s = await snapshot(ctx, agentDir, action.kind === "refresh", true);
      checkouts = s.checkouts;
    }
  }
}
async function profiles(
  ctx: ExtensionCommandContext,
  s: Snapshot,
  agentDir: string,
  args: string[],
  scope: Scope,
): Promise<void> {
  const [action, name] = args;
  if (action === "list") {
    let files: string[] = [];
    try {
      files = await readdir(join(managerDir(agentDir), "profiles"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    ctx.ui.notify(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort()
        .join("\n") || "No profiles saved.",
      "info",
    );
    return;
  }
  if (!name) throw new Error("Usage: /extensions profile save|apply <name> [-l]");
  const path = profilePath(agentDir, name);
  if (action === "save") {
    if (!ctx.hasUI) throw new Error("Saving a profile requires confirmation");
    const ids = [
      ...new Set(
        s.installed
          .filter(
            (i) =>
              !i.missing &&
              !i.filtered &&
              s.repos.some((r) => r.id === i.id) &&
              !i.id.endsWith("/pi-extension-manager"),
          )
          .map((i) => i.id),
      ),
    ];
    const packages = ids.map((id) => {
      const refs = [
        ...new Set(
          s.installed
            .filter((i) => i.id === id)
            .map((i) => gitRef(i.source))
            .filter(Boolean),
        ),
      ];
      if (refs.length > 1)
        throw new Error(
          `Multiple pinned refs for ${id}; resolve the duplicate declarations before saving`,
        );
      return { repo: id, ...(refs[0] ? { ref: refs[0] } : {}) };
    });
    if (
      !(await ctx.ui.confirm(
        "Save portable profile?",
        `${packages.map((p) => p.repo).join("\n") || "(empty selection)"}\n\nWrite ${path}? Existing file will be replaced. Local paths, secrets, config files, filters and scopes are not exported.`,
      ))
    )
      return;
    await atomicJson(path, parseProfile({ schemaVersion: 1, owner: s.config.owner, packages }));
    ctx.ui.notify(
      `Saved ${path}. Copy this JSON to another computer's extension-manager/profiles directory to use it there.`,
      "info",
    );
  } else if (action === "apply") {
    const profile = parseProfile(await jsonFile(path));
    if (profile.owner.toLowerCase() !== s.config.owner)
      throw new Error("Profile owner does not match the configured catalog owner");
    const changes = new Map(profile.packages.map((p) => [p.repo, true]));
    const sources = new Map(
      profile.packages
        .filter((p) => p.ref)
        .map((p) => [p.repo, `git:github.com/${p.repo}@${p.ref}`]),
    );
    const plan = buildPlan({ ...s, scope, changes, sources });
    for (const p of profile.packages)
      if (p.ref && s.installed.some((i) => i.id === p.repo && gitRef(i.source) !== p.ref))
        plan.errors.push(
          `${p.repo} is already installed from a different source/ref. Its source will not be changed automatically.`,
        );
    plan.notes.push(
      "Profile application is additive: existing extra packages and machine-local configuration are preserved.",
    );
    await apply(ctx, s, plan);
  } else throw new Error("Unknown profile action; use save, apply, or list");
}
export default function extensionManager(pi: ExtensionAPI): void {
  let busy = false;
  pi.registerCommand("extensions", {
    description: "Discover, install, remove, check, and profile your GitHub Pi packages",
    handler: async (args, ctx) => {
      if (busy) {
        ctx.ui.notify("An extension-manager operation is already running.", "warning");
        return;
      }
      busy = true;
      let reload = false;
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const scope: Scope = words.includes("-l") || words.includes("--local") ? "project" : "user";
        const tokens = words.filter((w) => !["-l", "--local"].includes(w));
        const command = tokens[0];
        if (command === "help") {
          ctx.ui.notify(HELP, "info");
          return;
        }
        if (scope === "project" && !ctx.isProjectTrusted())
          throw new Error("Project scope requires project trust. No settings were changed.");
        const agentDir = getAgentDir();
        const s = await snapshot(
          ctx,
          agentDir,
          command === "refresh",
          !command && ctx.mode === "tui",
        );
        if (!command) {
          await interactive(ctx, s, agentDir, scope, pi);
          return;
        }
        if (command === "list" || command === "refresh") {
          ctx.ui.notify(
            s.repos
              .map((r) =>
                cleanText(
                  `${r.name}: ${status(r.id, s.installed, scope)}${r.warning ? " · metadata error" : !r.installable ? " · not a Pi package" : ""}${r.archived ? " · archived" : ""}`,
                ),
              )
              .join("\n") || "No matching repositories.",
            "info",
          );
          return;
        }
        if (command === "profile") {
          await profiles(ctx, s, agentDir, tokens.slice(1), scope);
          return;
        }
        if (!tokens[1]) throw new Error(HELP);
        const repo = resolveRepo(s, tokens[1]);
        if (command === "check") {
          await details(ctx, s, repo, pi);
          return;
        }
        if (command === "install" || command === "remove") {
          await apply(
            ctx,
            s,
            buildPlan({ ...s, scope, changes: new Map([[repo.id, command === "install"]]) }),
          );
          return;
        }
        if (command === "update") {
          const installations = s.installed.filter((i) => i.id === repo.id && i.kind === "package");
          if (installations.length !== 1)
            throw new Error(
              "Update needs exactly one managed package declaration. Local/explicit files are updated in their own checkout.",
            );
          const i = installations[0];
          if (
            !ctx.hasUI ||
            !(await ctx.ui.confirm(
              "Update package?",
              cleanMultiline(
                `${i.source}\nPinned refs stay pinned. Local development checkouts are never pulled.`,
              ),
            ))
          )
            return;
          await ctx.waitForIdle();
          await s.native.update(i, s.fingerprint, (message) =>
            ctx.ui.setStatus("extension-manager", cleanText(message)),
          );
          ctx.ui.notify("Package updated. Run /reload to load it in this session.", "info");
          return;
        }
        throw new Error(HELP);
      } catch (error) {
        if (error instanceof ReloadRequested) reload = true;
        else ctx.ui.notify(cleanMultiline(String(error)), "error");
      } finally {
        busy = false;
        ctx.ui.setStatus("extension-manager", undefined);
      }
      if (reload) await ctx.reload();
    },
  });
}
