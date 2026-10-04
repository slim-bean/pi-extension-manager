import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { githubIdentity, type Installation, type Repo } from "./model.ts";
import { inventory } from "./inventory.ts";
import { buildPlan, type Plan } from "./planner.ts";
import { expand, withManagerLock } from "./storage.ts";

const exec = promisify(execFile);
const isGit = (source: string) => /^(git:|https?:|ssh:)/.test(source) || !!githubIdentity(source);
const isManaged = (source: string) => source.startsWith("npm:") || isGit(source);
export class NativePackages {
  readonly settings: SettingsManager;
  readonly manager: DefaultPackageManager;
  constructor(
    readonly cwd: string,
    readonly agentDir: string,
    trusted: boolean,
  ) {
    this.settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
    this.manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: this.settings });
  }
  assertHealthy(): void {
    const errors = this.settings.drainErrors();
    if (errors.length)
      throw new Error(errors.map((e) => `${e.path ?? e.scope}: ${e.error.message}`).join("\n"));
  }
  fingerprint(): string {
    return JSON.stringify([this.settings.getGlobalSettings(), this.settings.getProjectSettings()]);
  }
  async inventory(repos: Repo[]): Promise<Installation[]> {
    this.assertHealthy();
    return inventory(
      repos,
      this.manager.listConfiguredPackages(),
      { user: this.settings.getGlobalSettings(), project: this.settings.getProjectSettings() },
      this.cwd,
      this.agentDir,
    );
  }
  async execute(
    plan: Plan,
    fingerprint: string,
    onProgress: (message: string) => void,
    repos?: Repo[],
  ): Promise<string[]> {
    if (plan.errors.length) throw new Error("Cannot apply a blocked plan");
    return withManagerLock(this.agentDir, async () => {
      await this.settings.reload();
      this.assertHealthy();
      if (this.fingerprint() !== fingerprint)
        throw new Error(
          "Pi settings changed while this plan was open. Reopen /extensions and review a fresh plan.",
        );
      const completed: string[] = [];
      this.manager.setProgressCallback((e) => onProgress(e.message ?? `${e.action}: ${e.source}`));
      try {
        // Preflight removals BEFORE installing anything or removing declarations.
        for (const action of plan.removals) {
          const i = action.installation;
          if (i.kind === "package" && isGit(i.source) && i.path && !i.missing) {
            const { stdout } = await exec("git", ["-C", i.path, "status", "--porcelain"], {
              timeout: 10_000,
            });
            if (stdout.trim())
              throw new Error(
                `Refusing to remove dirty managed checkout ${i.path}. Commit/save changes or remove its declaration manually.`,
              );
          }
        }
        for (const action of plan.installs) {
          onProgress(`Installing ${action.id}…`);
          await this.manager.installAndPersist(action.source, {
            local: action.scope === "project",
          });
          await this.settings.flush();
          this.assertHealthy();
          completed.push(`Installed ${action.id}`);
        }
        if (plan.installs.length && repos) {
          // A pinned ref/local checkout may differ from the default-branch catalog.
          // Verify actual installed versions/metadata before doing any destructive removal.
          const actualRepos = structuredClone(repos);
          const actual = await this.inventory(actualRepos);
          const scope = plan.installs[0].scope;
          const verified = buildPlan({
            repos: actualRepos,
            installed: actual,
            scope,
            changes: new Map(plan.removals.map((a) => [a.id, false])),
          });
          if (verified.errors.length || verified.installs.length)
            throw new Error(
              `Installed packages need a revised dependency plan: ${verified.errors.join("; ") || verified.installs.map((a) => a.id).join(", ")}`,
            );
        }
        for (const action of plan.removals) {
          const i = action.installation;
          onProgress(`Removing ${i.id}…`);
          if (i.kind === "explicit") {
            const settings =
              i.scope === "user"
                ? this.settings.getGlobalSettings()
                : this.settings.getProjectSettings();
            const paths = (settings.extensions ?? []).filter((path) => path !== i.source);
            if (i.scope === "user") this.settings.setExtensionPaths(paths);
            else this.settings.setProjectExtensionPaths(paths);
          } else {
            // npm roots may be shared between scopes. Keep physical files if another declaration uses them.
            const sharedPackage = this.manager
              .listConfiguredPackages()
              .some((p) => p.scope !== i.scope && p.installedPath && p.installedPath === i.path);
            const explicitReference =
              !!i.path &&
              (["user", "project"] as const).some((scope) => {
                const settings =
                  scope === "user"
                    ? this.settings.getGlobalSettings()
                    : this.settings.getProjectSettings();
                const base = scope === "user" ? this.agentDir : join(this.cwd, ".pi");
                return (settings.extensions ?? []).some((source) => {
                  if (/^[!-]/.test(source) || source.includes("builtin:")) return false;
                  const path = expand(source.replace(/^\+/, ""), base);
                  return path === i.path || path.startsWith(`${i.path}/`);
                });
              });
            const shared = sharedPackage || explicitReference;
            // listConfiguredPackages returns settings-relative local sources; mutation APIs take cwd-relative inputs.
            const source = isManaged(i.source)
              ? i.source
              : expand(i.source, i.scope === "user" ? this.agentDir : join(this.cwd, ".pi"));
            if (shared || i.missing)
              this.manager.removeSourceFromSettings(source, { local: i.scope === "project" });
            else await this.manager.removeAndPersist(source, { local: i.scope === "project" });
          }
          await this.settings.flush();
          this.assertHealthy();
          completed.push(`Removed ${i.id} (${i.scope})`);
        }
        return completed;
      } catch (error) {
        throw new Error(
          `${String(error)}\n${completed.length ? `Already completed:\n${completed.join("\n")}\n` : ""}No automatic rollback. Reopen /extensions to inspect actual state before retrying.`,
        );
      } finally {
        this.manager.setProgressCallback(undefined);
      }
    });
  }
  async update(
    installation: Installation,
    fingerprint: string,
    onProgress: (message: string) => void,
  ): Promise<void> {
    if (installation.kind !== "package" || !isManaged(installation.source))
      throw new Error(
        "Local/explicit extensions are updated in their own checkout; this manager will not git pull your development work.",
      );
    await withManagerLock(this.agentDir, async () => {
      await this.settings.reload();
      this.assertHealthy();
      if (this.fingerprint() !== fingerprint)
        throw new Error("Pi settings changed while the update was open. Review it again.");
      if (installation.path && isGit(installation.source)) {
        const { stdout } = await exec("git", ["-C", installation.path, "status", "--porcelain"], {
          timeout: 10_000,
        });
        if (stdout.trim()) throw new Error("Refusing to update a dirty managed checkout");
      }
      this.manager.setProgressCallback((e) => onProgress(e.message ?? `${e.action}: ${e.source}`));
      try {
        await this.manager.update(installation.source);
        await this.settings.flush();
        this.assertHealthy();
      } finally {
        this.manager.setProgressCallback(undefined);
      }
    });
  }
}
