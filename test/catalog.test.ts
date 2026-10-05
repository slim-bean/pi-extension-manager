import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOsc8LinkAtColumn,
  getTerminalColorMode,
  foregroundAnsi,
  rgbColor,
  setCapabilityOverrides,
  stripTerminalSequences,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { catalogName, piPackages, shortDescription } from "../src/catalog.ts";
import { discover } from "../src/github.ts";
import { inventory } from "../src/inventory.ts";
import { atomicJson } from "../src/storage.ts";
import extensionManager from "../src/index.ts";
import { showScreen } from "../src/ui.ts";
import type { Repo } from "../src/model.ts";

const repo: Repo = {
  id: "owner/pi-a",
  name: "pi-a",
  description: "A useful extension",
  url: "https://github.com/owner/pi-a",
  source: "git:github.com/owner/pi-a",
  installable: true,
  archived: false,
};
test("catalog hides non-packages but preserves identified Pi packages with metadata errors", () => {
  const invalid = {
    ...repo,
    id: "owner/pi-invalid",
    name: "pi-invalid",
    isPiPackage: true,
    installable: false,
    warning: "Invalid metadata",
  };
  const docs = {
    ...repo,
    id: "owner/pi-docs",
    name: "pi-docs",
    isPiPackage: false,
    installable: false,
  };
  assert.deepEqual(
    piPackages([repo, docs, invalid]).map((r) => r.name),
    ["pi-a", "pi-invalid"],
  );
  assert.deepEqual(piPackages([{ ...docs, isPiPackage: undefined }]), []); // Legacy cache compatibility.
});
test("names use safe GitHub OSC 8 links that survive width truncation", () => {
  const name = catalogName({ ...repo, url: "https://evil.invalid/", name: "pi-a\x1b[31m" }, true);
  assert.equal(stripTerminalSequences(name), "pi-a");
  assert.ok(name.includes(foregroundAnsi(rgbColor(70, 145, 255), getTerminalColorMode())));
  assert.ok(name.includes("\x1b[4m"), "clickable names should be underlined");
  assert.equal(getOsc8LinkAtColumn(name, 1), "https://github.com/owner/pi-a");
  const row = truncateToWidth(`[x] ${name}`, 7, "");
  assert.ok(visibleWidth(row) <= 7);
  assert.equal(getOsc8LinkAtColumn(row, 5), "https://github.com/owner/pi-a");
  assert.equal(catalogName(repo, false), "pi-a");
});
test("rendered catalog names remain clickable inside SelectList", async () => {
  setCapabilityOverrides({ hyperlinks: true });
  try {
    const ctx = {
      ui: {
        custom(factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) {
          let result: unknown;
          const theme = {
            fg: (_color: string, text: string) => `\x1b[33m${text}\x1b[39m`,
            getFgAnsi: () => "\x1b[33m",
            bold: (text: string) => text,
          } as unknown as Theme;
          const panel = factory({ requestRender() {} } as never, theme, {} as never, (value) => {
            result = value;
          });
          assert.ok(!(panel instanceof Promise));
          const row = panel.render(80).find((line) => line.includes("pi-a"))!;
          assert.equal(getOsc8LinkAtColumn(row, 8), "https://github.com/owner/pi-a");
          assert.match(stripTerminalSequences(row), /A useful extension/);
          const blue = foregroundAnsi(rgbColor(70, 145, 255), getTerminalColorMode());
          assert.ok(
            row.includes(`${blue}\x1b[4mpi-a`),
            "selection must keep the name blue and underlined",
          );
          const description = row.slice(0, row.indexOf("A useful extension"));
          assert.ok(
            description.lastIndexOf("\x1b[33m") > description.lastIndexOf(blue),
            "selection color must resume after the link",
          );
          panel.handleInput?.("a");
          return Promise.resolve(result);
        },
      },
    } as unknown as ExtensionCommandContext;
    await showScreen(ctx, [repo], [], "user", new Map(), new Map(), "");
  } finally {
    setCapabilityOverrides({});
  }
});
test("descriptions are concise, single-line, and sanitized", () => {
  const description = shortDescription({
    ...repo,
    description: `\x1b[31mUseful\n\n  extension ${"details ".repeat(40)}`,
  });
  assert.match(description, /^Useful extension/);
  assert.ok(visibleWidth(description) <= 140);
  assert.equal(description.includes("\x1b"), false);
  assert.equal(shortDescription({ ...repo, description: " " }), "No description provided.");
});
test("discovery falls back to package descriptions and marks docs-only repos", async () => {
  const encoded = (v: unknown) => ({
    encoding: "base64",
    content: Buffer.from(JSON.stringify(v)).toString("base64"),
  });
  const repos = await discover(
    { schemaVersion: 1, owner: "owner", prefix: "pi-", cacheHours: 24, localRoots: [] },
    async (endpoint) => {
      if (endpoint.startsWith("users/"))
        return [{ name: "pi-a", description: "" }, { name: "pi-docs" }];
      if (endpoint === "repos/owner/pi-a/contents/package.json")
        return encoded({
          description: "Useful package description",
          pi: { extensions: ["src/index.ts"] },
        });
      if (endpoint.endsWith("/contents/")) return [{ type: "file", name: "README.md" }];
      throw new Error("HTTP 404");
    },
  );
  assert.equal(repos[0].description, "Useful package description");
  assert.equal(repos[0].isPiPackage, true);
  assert.equal(repos[1].isPiPackage, false);
  assert.equal(piPackages(repos).length, 1);
});
test("installed package descriptions enrich an older cached catalog without GitHub requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-description-"));
  try {
    const local = join(dir, "local");
    await atomicJson(join(local, "package.json"), {
      name: "pi-a",
      description: "Description from checkout",
    });
    const repos = [{ ...repo, description: "" }];
    await inventory(
      repos,
      [{ source: local, scope: "user", filtered: false, installedPath: local }],
      { user: {}, project: {} },
      dir,
      join(dir, "agent"),
    );
    assert.equal(repos[0].description, "Description from checkout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("/extensions list excludes docs-only repos and includes short descriptions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-catalog-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    await atomicJson(join(dir, "extension-manager/config.json"), {
      schemaVersion: 1,
      owner: "owner",
      localRoots: [],
    });
    await atomicJson(join(dir, "extension-manager/catalog.json"), {
      schemaVersion: 1,
      owner: "owner",
      prefix: "pi-",
      fetchedAt: new Date().toISOString(),
      repos: [
        repo,
        { ...repo, id: "owner/pi-docs", name: "pi-docs", isPiPackage: false, installable: false },
      ],
    });
    let command!: RegisteredCommand;
    extensionManager({
      registerCommand(_name: string, c: RegisteredCommand) {
        command = c;
      },
    } as ExtensionAPI);
    const messages: string[] = [];
    await command.handler("list", {
      cwd: dir,
      mode: "rpc",
      isProjectTrusted: () => false,
      ui: {
        setStatus() {},
        notify(message: string) {
          messages.push(message);
        },
      },
    } as unknown as ExtensionCommandContext);
    assert.match(messages.join("\n"), /A useful extension/);
    assert.match(messages.join("\n"), /pi-a/);
    assert.equal(messages.join("\n").includes("pi-docs"), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
