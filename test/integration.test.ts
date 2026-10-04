import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativePackages } from "../src/native.ts";
import { buildPlan } from "../src/planner.ts";
import { atomicJson, jsonFile } from "../src/storage.ts";
import extensionManager from "../src/index.ts";
import { showScreen } from "../src/ui.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Repo, Installation } from "../src/model.ts";

const exec = promisify(execFile);
const r: Repo = {
  id: "owner/pi-a",
  name: "pi-a",
  packageName: "pi-a",
  source: "git:github.com/owner/pi-a",
  version: "1.0.0",
  description: "Extension A",
  url: "https://github.com/owner/pi-a",
  installable: true,
  archived: false,
};
async function fixture(action: (dir: string, root: string, agent: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-extension-manager-integration-"));
  const root = join(dir, "local-package"),
    agent = join(dir, "agent");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(agent);
    await atomicJson(join(root, "package.json"), {
      name: "pi-a",
      version: "1.0.0",
      pi: { extensions: ["src/index.ts"] },
    });
    await writeFile(join(root, "src/index.ts"), "export default () => {};");
    await action(dir, root, agent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("native local install/remove preserves source files and unrelated settings", async () =>
  fixture(async (dir, root, agent) => {
    await atomicJson(join(agent, "settings.json"), { theme: "dark", packages: [] });
    const native = new NativePackages(dir, agent, false);
    const plan = buildPlan({
      repos: [r],
      installed: [],
      scope: "user",
      changes: new Map([[r.id, true]]),
      sources: new Map([[r.id, root]]),
    });
    const progress: string[] = [];
    assert.deepEqual(await native.execute(plan, native.fingerprint(), (m) => progress.push(m)), [
      "Installed owner/pi-a",
    ]);
    const saved = (await jsonFile(join(agent, "settings.json"))) as {
      theme: string;
      packages: unknown[];
    };
    assert.equal(saved.theme, "dark");
    assert.equal(saved.packages.length, 1);
    const installed = await native.inventory([r]);
    assert.equal(installed.length, 1);
    const remove = buildPlan({
      repos: [r],
      installed,
      scope: "user",
      changes: new Map([[r.id, false]]),
    });
    await native.execute(remove, native.fingerprint(), () => {});
    assert.match(await readFile(join(root, "src/index.ts"), "utf8"), /export default/);
    assert.equal(
      ((await jsonFile(join(agent, "settings.json"))) as { packages: unknown[] }).packages.length,
      0,
    );
  }));
test("explicit file removal detaches only its exact declaration", async () =>
  fixture(async (dir, root, agent) => {
    const path = join(root, "src/index.ts");
    await atomicJson(join(agent, "settings.json"), {
      extensions: [path, "builtin:mcp"],
      defaultTools: ["+codemode"],
    });
    const native = new NativePackages(dir, agent, false);
    const items = await native.inventory([r]);
    assert.equal(items.length, 1);
    const plan = buildPlan({
      repos: [r],
      installed: items,
      scope: "user",
      changes: new Map([[r.id, false]]),
    });
    await native.execute(plan, native.fingerprint(), () => {});
    const settings = (await jsonFile(join(agent, "settings.json"))) as {
      extensions: string[];
      defaultTools: string[];
    };
    assert.deepEqual(settings.extensions, ["builtin:mcp"]);
    assert.deepEqual(settings.defaultTools, ["+codemode"]);
    assert.match(await readFile(path, "utf8"), /export default/);
  }));
test("settings race and untrusted project changes are rejected", async () =>
  fixture(async (dir, root, agent) => {
    await atomicJson(join(agent, "settings.json"), { theme: "dark" });
    const native = new NativePackages(dir, agent, false);
    const fingerprint = native.fingerprint();
    await atomicJson(join(agent, "settings.json"), { theme: "light" });
    const plan = buildPlan({
      repos: [r],
      installed: [],
      scope: "user",
      changes: new Map([[r.id, true]]),
      sources: new Map([[r.id, root]]),
    });
    await assert.rejects(
      native.execute(plan, fingerprint, () => {}),
      /settings changed/,
    );
    const localPlan = buildPlan({
      repos: [r],
      installed: [],
      scope: "project",
      changes: new Map([[r.id, true]]),
      sources: new Map([[r.id, root]]),
    });
    await assert.rejects(
      native.execute(localPlan, native.fingerprint(), () => {}),
      /trust/i,
    );
  }));
test("partial install failures report completed work and stop before removals", async () =>
  fixture(async (dir, _root, agent) => {
    const native = new NativePackages(dir, agent, false);
    let installs = 0,
      removals = 0;
    native.manager.installAndPersist = async () => {
      if (++installs === 2) throw new Error("simulated failure");
    };
    native.manager.removeAndPersist = async () => {
      removals++;
      return true;
    };
    await assert.rejects(
      native.execute(
        {
          installs: ["first", "second"].map((id) => ({
            kind: "install",
            id,
            source: "npm:test",
            scope: "user",
            reason: "test",
          })),
          removals: [
            {
              kind: "remove",
              id: r.id,
              installation: {
                id: r.id,
                source: "npm:old",
                scope: "user",
                kind: "package",
                filtered: false,
                missing: true,
              },
            },
          ],
          errors: [],
          notes: [],
        },
        native.fingerprint(),
        () => {},
      ),
      /Already completed:\nInstalled first/,
    );
    assert.equal(removals, 0);
  }));
test("dirty managed checkout blocks removals before any install", async () =>
  fixture(async (dir, root, agent) => {
    await exec("git", ["-C", root, "init"]);
    const native = new NativePackages(dir, agent, false);
    let installs = 0;
    native.manager.installAndPersist = async () => {
      installs++;
    };
    const i: Installation = {
      id: r.id,
      source: r.source,
      scope: "user",
      kind: "package",
      path: root,
      filtered: false,
      missing: false,
    };
    await assert.rejects(
      native.execute(
        {
          installs: [
            { kind: "install", id: "other", source: "npm:other", scope: "user", reason: "test" },
          ],
          removals: [{ kind: "remove", id: r.id, installation: i }],
          errors: [],
          notes: [],
        },
        native.fingerprint(),
        () => {},
      ),
      /dirty managed checkout/,
    );
    assert.equal(installs, 0);
  }));
test("shared package files are retained when removing one scope", async () =>
  fixture(async (dir, root, agent) => {
    await atomicJson(join(agent, "settings.json"), { packages: [root] });
    await atomicJson(join(dir, ".pi/settings.json"), { packages: [root] });
    const native = new NativePackages(dir, agent, true);
    let deleted = false;
    native.manager.removeAndPersist = async () => {
      deleted = true;
      return true;
    };
    const installed = await native.inventory([r]);
    assert.equal(installed.length, 2);
    await native.execute(
      buildPlan({ repos: [r], installed, scope: "project", changes: new Map([[r.id, false]]) }),
      native.fingerprint(),
      () => {},
    );
    assert.equal(deleted, false);
    assert.equal(
      ((await jsonFile(join(agent, "settings.json"))) as { packages: string[] }).packages.length,
      1,
    );
    assert.equal(
      ((await jsonFile(join(dir, ".pi/settings.json"))) as { packages: string[] }).packages.length,
      0,
    );
  }));
test("factory only registers the command; help needs no external services", async () => {
  let registered: RegisteredCommand | undefined;
  const pi = {
    registerCommand(name: string, command: RegisteredCommand) {
      assert.equal(name, "extensions");
      registered = command;
    },
  } as ExtensionAPI;
  extensionManager(pi);
  assert.ok(registered);
  const messages: string[] = [];
  await registered.handler("help", {
    ui: {
      notify(m: string) {
        messages.push(m);
      },
      setStatus() {},
    },
  } as unknown as ExtensionCommandContext);
  assert.match(messages[0], /profile save/);
});
test("toggle screen stages changes and stays within narrow terminal widths", async () => {
  const changes = new Map<string, boolean>();
  const ctx = {
    ui: {
      notify() {},
      custom(factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) {
        let result: unknown;
        const theme = {
          fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`,
          bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
        } as unknown as Theme;
        const component = factory({ requestRender() {} } as never, theme, {} as never, (r) => {
          result = r;
        });
        assert.ok(!(component instanceof Promise));
        const screen = component.render(80).join("\n");
        assert.match(screen, /Extension A/);
        assert.equal(screen.includes("pi-docs"), false);
        assert.match(component.render(20).join("\n"), /Extension A/);
        for (const width of [20, 40, 80])
          for (const line of component.render(width))
            assert.ok(visibleWidth(line) <= width, `Line exceeds ${width}: ${line}`);
        component.handleInput?.(" ");
        assert.equal(changes.get(r.id), true);
        component.handleInput?.(" ");
        assert.equal(changes.size, 0);
        component.handleInput?.("a");
        return Promise.resolve(result);
      },
    },
  } as unknown as ExtensionCommandContext;
  assert.deepEqual(
    await showScreen(
      ctx,
      [r, { ...r, id: "owner/pi-docs", name: "pi-docs", installable: false }],
      [],
      "user",
      changes,
      new Map(),
      "",
    ),
    {
      kind: "apply",
    },
  );
});
