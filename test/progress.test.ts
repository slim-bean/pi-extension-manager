import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { withProgress } from "../src/progress.ts";
import { loadCatalog, type Api } from "../src/github.ts";
import type { Config } from "../src/model.ts";

function fakePanel() {
  let component: (Component & { dispose?(): void }) | undefined;
  let renders = 0,
    disposed = false;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const ctx = {
    mode: "tui",
    ui: {
      custom<T>(factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]): Promise<T> {
        return new Promise((resolve) => {
          const created = factory(
            {
              requestRender() {
                renders++;
              },
            } as never,
            theme,
            {} as never,
            (result) => {
              component?.dispose?.();
              disposed = true;
              resolve(result as T);
            },
          );
          assert.ok(!(created instanceof Promise));
          component = created;
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    lines: (width: number) => component!.render(width),
    renders: () => renders,
    disposed: () => disposed,
  };
}

test("loading panel appears before work, updates progress, and fits narrow widths", async () => {
  const panel = fakePanel();
  let complete!: (value: number) => void;
  let started = false;
  const work = withProgress(panel.ctx, "Loading extensions", async (report) => {
    started = true;
    report("Inspecting repository metadata · 6/14 · pi-search");
    return new Promise<number>((resolve) => {
      complete = resolve;
    });
  });
  assert.equal(started, false);
  assert.match(panel.lines(80).join("\n"), /Loading extensions/);
  await nextTurn();
  assert.match(panel.lines(80).join("\n"), /6\/14/);
  for (const width of [20, 40, 80])
    for (const line of panel.lines(width)) assert.ok(visibleWidth(line) <= width);
  complete(42);
  assert.equal(await work, 42);
  assert.equal(panel.disposed(), true);
  const renders = panel.renders();
  await sleep(100);
  assert.equal(panel.renders(), renders, "spinner must stop after completion");
});
test("loading errors reach the caller and also stop the spinner", async () => {
  const panel = fakePanel();
  await assert.rejects(
    withProgress(panel.ctx, "Loading extensions", async (report) => {
      report("Contacting GitHub…");
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(panel.disposed(), true);
  const renders = panel.renders();
  await sleep(100);
  assert.equal(panel.renders(), renders);
});
test("RPC progress uses status updates and cleans up on failure without custom UI", async () => {
  const statuses: (string | undefined)[] = [];
  const ctx = {
    mode: "rpc",
    ui: {
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
    },
  } as unknown as ExtensionCommandContext;
  await assert.rejects(
    withProgress(ctx, "Loading extensions", async (report) => {
      report("Inspecting packages…");
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.deepEqual(statuses, ["Loading extensions", "Inspecting packages…", undefined]);
});
test("cold catalog reports repository counts, cached catalog skips network progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-progress-"));
  try {
    const config: Config = {
      schemaVersion: 1,
      owner: "owner",
      prefix: "pi-",
      cacheHours: 24,
      localRoots: [],
    };
    const encode = (value: unknown) => ({
      encoding: "base64",
      content: Buffer.from(JSON.stringify(value)).toString("base64"),
    });
    const api: Api = async (endpoint) => {
      if (endpoint.startsWith("users/")) return [{ name: "pi-a" }, { name: "pi-b" }];
      if (endpoint.endsWith("package.json"))
        return encode({ pi: { extensions: ["src/index.ts"] } });
      throw new Error("HTTP 404");
    };
    const cold: string[] = [];
    await loadCatalog(dir, config, false, api, (message) => cold.push(message));
    assert.match(cold.join("\n"), /Listing owner's GitHub repositories/);
    assert.deepEqual(
      cold
        .filter((s) => s.startsWith("Inspecting repository"))
        .map((s) => s.match(/\d+\/\d+/)?.[0]),
      ["0/2", "1/2", "2/2"],
    );
    const cached: string[] = [];
    await loadCatalog(
      dir,
      config,
      false,
      async () => {
        throw new Error("must not call GitHub");
      },
      (message) => cached.push(message),
    );
    assert.deepEqual(cached, [
      "Checking the local catalog cache…",
      "Using cached catalog · 2 repositories",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
