import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAndLoadExtensions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import extensionManager from "../src/index.ts";
import { atomicJson, jsonFile } from "../src/storage.ts";

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
test("Pi's real extension loader registers /extensions in an isolated agent directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-loader-"));
  try {
    const loaded = await discoverAndLoadExtensions([extensionPath], dir, join(dir, "agent"));
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions.find((e) => e.resolvedPath === extensionPath);
    assert.ok(extension);
    assert.ok(extension.commands.has("extensions"));
    assert.equal(extension.handlers.size, 0);
    assert.equal(extension.tools.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("confirmed removal finishes all cleanup BEFORE reload invalidates context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-command-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    const agent = join(dir, "agent"),
      root = join(dir, "pi-a");
    process.env.PI_CODING_AGENT_DIR = agent;
    await mkdir(join(root, "src"), { recursive: true });
    await atomicJson(join(root, "package.json"), { name: "pi-a", version: "1.0.0" });
    const path = join(root, "src/index.ts");
    await writeFile(path, "export default () => {};");
    await atomicJson(join(agent, "settings.json"), { extensions: [path] });
    await atomicJson(join(agent, "extension-manager/config.json"), {
      schemaVersion: 1,
      owner: "owner",
      localRoots: [],
    });
    await atomicJson(join(agent, "extension-manager/catalog.json"), {
      schemaVersion: 1,
      owner: "owner",
      prefix: "pi-",
      fetchedAt: new Date().toISOString(),
      repos: [
        {
          id: "owner/pi-a",
          name: "pi-a",
          packageName: "pi-a",
          source: "git:github.com/owner/pi-a",
          description: "",
          url: "https://github.com/owner/pi-a",
          installable: true,
          archived: false,
        },
      ],
    });
    let command: RegisteredCommand | undefined;
    extensionManager({
      registerCommand(_name: string, c: RegisteredCommand) {
        command = c;
      },
    } as ExtensionAPI);
    const events: string[] = [];
    let reloaded = false;
    const record = (event: string) => {
      assert.equal(reloaded, false, `Old context accessed after reload: ${event}`);
      events.push(event);
    };
    const ctx = {
      cwd: dir,
      mode: "rpc",
      hasUI: true,
      isProjectTrusted: () => false,
      waitForIdle: async () => record("idle"),
      reload: async () => {
        record("reload");
        reloaded = true;
      },
      ui: {
        notify: () => record("notify"),
        setStatus: () => record("status"),
        confirm: async () => {
          record("confirm");
          return true;
        },
      },
    } as unknown as ExtensionCommandContext;
    await command!.handler("remove pi-a", ctx);
    assert.equal(reloaded, true);
    assert.equal(events.at(-1), "reload");
    assert.deepEqual(
      ((await jsonFile(join(agent, "settings.json"))) as { extensions: string[] }).extensions,
      [],
    );
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(dir, { recursive: true, force: true });
  }
});
