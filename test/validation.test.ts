import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativePackages } from "../src/native.ts";
import { buildPlan } from "../src/planner.ts";
import { atomicJson } from "../src/storage.ts";
import { cleanMultiline, parseManifest, type Installation, type Repo } from "../src/model.ts";

const repo = (name: string): Repo => ({
  id: `owner/${name}`,
  name,
  packageName: name,
  source: `git:github.com/owner/${name}`,
  url: `https://github.com/owner/${name}`,
  description: "",
  installable: true,
  archived: false,
  version: "1.0.0",
});
test("installed-version revalidation stops a plan when a ref differs from catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-revalidate-"));
  try {
    const root = join(dir, "dependency"),
      appRoot = join(dir, "app"),
      agent = join(dir, "agent");
    await atomicJson(join(root, "package.json"), { name: "pi-dependency", version: "0.1.0" });
    await atomicJson(join(appRoot, "package.json"), { name: "pi-app", version: "1.0.0" });
    const app = repo("pi-app"),
      dependency = repo("pi-dependency");
    app.manifest = parseManifest(
      { schemaVersion: 1, requires: [{ repo: dependency.id, version: ">=1.0.0" }] },
      "owner",
    );
    const native = new NativePackages(dir, agent, false);
    const plan = buildPlan({
      repos: [app, dependency],
      installed: [],
      scope: "user",
      changes: new Map([[app.id, true]]),
      sources: new Map([
        [dependency.id, root],
        [app.id, appRoot],
      ]),
    });
    assert.deepEqual(plan.errors, []); // Catalog says dependency is 1.0.0.
    await assert.rejects(
      native.execute(plan, native.fingerprint(), () => {}, [app, dependency]),
      /found 0.1.0.*Already completed/s,
    );
    const actual = await native.inventory([app, dependency]);
    assert.equal(actual.length, 2); // Partial work is retained and accurately reported.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("update refuses local development sources and changed settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-update-"));
  try {
    const agent = join(dir, "agent");
    await atomicJson(join(agent, "settings.json"), { theme: "dark" });
    const native = new NativePackages(dir, agent, false);
    const i: Installation = {
      id: "owner/pi-a",
      source: "../local-package",
      scope: "user",
      kind: "package",
      filtered: false,
      missing: false,
    };
    await assert.rejects(
      native.update(i, native.fingerprint(), () => {}),
      /development work/,
    );
    const fingerprint = native.fingerprint();
    await atomicJson(join(agent, "settings.json"), { theme: "light" });
    let updated = false;
    native.manager.update = async () => {
      updated = true;
    };
    await assert.rejects(
      native.update({ ...i, source: "npm:pi-a" }, fingerprint, () => {}),
      /settings changed/,
    );
    assert.equal(updated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("multiline plans preserve line breaks while removing terminal control codes", () => {
  assert.equal(cleanMultiline("INSTALL\n\x1b[31mrepo\x1b[0m\r\nREMOVE"), "INSTALL\nrepo\nREMOVE");
});
