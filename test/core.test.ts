import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, loadCatalog, type Api } from "../src/github.ts";
import { buildPlan } from "../src/planner.ts";
import {
  parseManifest,
  githubIdentity,
  gitRef,
  cleanText,
  type Config,
  type Installation,
  type Repo,
} from "../src/model.ts";
import {
  atomicJson,
  jsonFile,
  loadConfig,
  parseProfile,
  profilePath,
  withManagerLock,
} from "../src/storage.ts";
import { checkRequirement } from "../src/checks.ts";
import { inventory, findCheckouts } from "../src/inventory.ts";

const repo = (name: string, deps: string[] = []): Repo => ({
  id: `owner/${name}`,
  name,
  description: "",
  url: `https://github.com/owner/${name}`,
  source: `git:github.com/owner/${name}`,
  archived: false,
  installable: true,
  packageName: name,
  version: "1.0.0",
  manifest: parseManifest({ schemaVersion: 1, requires: deps }, "owner"),
});
const installed = (name: string, overrides: Partial<Installation> = {}): Installation => ({
  id: `owner/${name}`,
  source: `git:github.com/owner/${name}`,
  scope: "user",
  kind: "package",
  version: "1.0.0",
  filtered: false,
  missing: false,
  ...overrides,
});
async function temp(action: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-extension-manager-test-"));
  try {
    await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("dependency installs are deduped and ordered", () => {
  const repos = [
    repo("pi-app", ["pi-search", "pi-tools"]),
    repo("pi-search", ["pi-tools"]),
    repo("pi-tools"),
  ];
  const plan = buildPlan({
    repos,
    installed: [],
    scope: "user",
    changes: new Map([["owner/pi-app", true]]),
  });
  assert.deepEqual(
    plan.installs.map((i) => i.id),
    ["owner/pi-tools", "owner/pi-search", "owner/pi-app"],
  );
  assert.deepEqual(plan.errors, []);
});
test("required removal is blocked, joint removal reverses dependency order", () => {
  const repos = [repo("pi-app", ["pi-tools"]), repo("pi-tools")];
  const instances = [installed("pi-tools"), installed("pi-app")];
  assert.match(
    buildPlan({
      repos,
      installed: instances,
      scope: "user",
      changes: new Map([["owner/pi-tools", false]]),
    }).errors.join(),
    /requires/,
  );
  const plan = buildPlan({
    repos,
    installed: instances,
    scope: "user",
    changes: new Map(instances.map((i) => [i.id, false])),
  });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.removals.map((i) => i.id),
    ["owner/pi-app", "owner/pi-tools"],
  );
});
test("an existing dependency in another scope prevents duplicate install", () => {
  const repos = [repo("pi-app", ["pi-tools"]), repo("pi-tools")];
  const plan = buildPlan({
    repos,
    installed: [installed("pi-tools")],
    scope: "project",
    changes: new Map([["owner/pi-app", true]]),
  });
  assert.deepEqual(
    plan.installs.map((i) => i.id),
    ["owner/pi-app"],
  );
  assert.deepEqual(plan.errors, []);
});
test("removing one scope retains dependencies in the other scope", () => {
  const repos = [repo("pi-app", ["pi-tools"]), repo("pi-tools")];
  const plan = buildPlan({
    repos,
    installed: [
      installed("pi-tools"),
      installed("pi-tools", { scope: "project" }),
      installed("pi-app"),
    ],
    scope: "project",
    changes: new Map([["owner/pi-tools", false]]),
  });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.removals.length, 1);
});
test("cycles, missing catalog deps and archived repos fail closed", () => {
  assert.match(
    buildPlan({
      repos: [repo("a", ["b"]), repo("b", ["a"])],
      installed: [],
      scope: "user",
      changes: new Map([["owner/a", true]]),
    }).errors.join(),
    /cycle/,
  );
  assert.match(
    buildPlan({
      repos: [repo("a", ["missing"])],
      installed: [],
      scope: "user",
      changes: new Map([["owner/a", true]]),
    }).errors.join(),
    /outside/,
  );
  assert.match(
    buildPlan({
      repos: [{ ...repo("a"), archived: true }],
      installed: [],
      scope: "user",
      changes: new Map([["owner/a", true]]),
    }).errors.join(),
    /archived/,
  );
});
test("optional dependencies do not install", () => {
  const r = repo("pi-app");
  r.manifest!.optional = [{ repo: "owner/pi-extra" }];
  const plan = buildPlan({
    repos: [r],
    installed: [],
    scope: "user",
    changes: new Map([[r.id, true]]),
  });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.installs.length, 1);
});
test("version ranges use installed/local versions, not latest catalog", () => {
  const app = repo("pi-app", ["pi-tools"]);
  app.manifest!.requires[0].version = ">=1.0.0";
  const input = {
    repos: [app, repo("pi-tools")],
    installed: [installed("pi-tools", { version: "0.1.0" })],
    scope: "user" as const,
    changes: new Map([[app.id, true]]),
  };
  assert.match(buildPlan(input).errors.join(), /0.1.0/);
  assert.match(
    buildPlan({
      ...input,
      installed: [],
      versions: new Map([["owner/pi-tools", "0.2.0"]]),
    }).errors.join(),
    /0.2.0/,
  );
  assert.deepEqual(buildPlan({ ...input, installed: [installed("pi-tools")] }).errors, []);
});
test("dependency version gates reject prereleases and invalid versions without rejecting build metadata", () => {
  const app = repo("pi-app", ["pi-tools"]);
  for (const [version, range, compatible] of [
    ["1.2.3+local.1", "^1.0.0", true],
    ["1.3.0-beta.1", "^1.0.0", false],
    ["2.0.0", "^1.0.0", false],
    ["not-a-version", "^1.0.0", false],
    ["1.2.3+local.1", ">= \t1.2.0 < \t2.0.0", true],
    ["2.0.0", ">= \t1.2.0 < \t2.0.0", false],
  ] as const) {
    app.manifest!.requires[0].version = range;
    const plan = buildPlan({
      repos: [app, repo("pi-tools")],
      installed: [installed("pi-tools", { version })],
      scope: "user",
      changes: new Map([[app.id, true]]),
    });
    assert.equal(plan.errors.length === 0, compatible, version);
    if (!compatible) assert.match(plan.errors.join(), /needs owner\/pi-tools/);
  }
});
test("missing/filtered providers and auto-discovered removals are blocked", () => {
  for (const override of [{ missing: true }, { filtered: true }]) {
    const plan = buildPlan({
      repos: [repo("pi-app", ["pi-tools"]), repo("pi-tools")],
      installed: [installed("pi-tools", override)],
      scope: "user",
      changes: new Map([["owner/pi-app", true]]),
    });
    assert.match(plan.errors.join(), /second copy/);
  }
  assert.match(
    buildPlan({
      repos: [repo("a")],
      installed: [installed("a", { kind: "discovered" })],
      scope: "user",
      changes: new Map([["owner/a", false]]),
    }).errors.join(),
    /auto-discovered/,
  );
});
test("project resource filters override an equivalent global dependency provider", () => {
  const repos = [repo("pi-app", ["pi-tools"]), repo("pi-tools")];
  const plan = buildPlan({
    repos,
    installed: [installed("pi-tools"), installed("pi-tools", { scope: "project", filtered: true })],
    scope: "user",
    changes: new Map([["owner/pi-app", true]]),
  });
  assert.match(plan.errors.join(), /second copy/);
  const repaired = buildPlan({
    repos,
    installed: [installed("pi-tools"), installed("pi-tools", { scope: "project", filtered: true })],
    scope: "project",
    changes: new Map([
      ["owner/pi-tools", false],
      ["owner/pi-app", true],
    ]),
  });
  assert.deepEqual(repaired.errors, []);
});
test("local source selection is preserved in plans", () => {
  const plan = buildPlan({
    repos: [repo("a")],
    installed: [],
    scope: "user",
    changes: new Map([["owner/a", true]]),
    sources: new Map([["owner/a", "/tmp/local-a"]]),
  });
  assert.equal(plan.installs[0].source, "/tmp/local-a");
});
test("schema validates versions, checks, and single-line commands", () => {
  assert.equal(
    parseManifest({ schemaVersion: 1, requires: ["pi-tools"] }, "owner").requires[0].repo,
    "owner/pi-tools",
  );
  for (const value of [
    { schemaVersion: 2 },
    { schemaVersion: 1, requires: [{ repo: "x", version: "nonsense" }] },
    { schemaVersion: 1, checks: [{ kind: "shell", names: ["oops"], label: "Oops" }] },
    { schemaVersion: 1, setupCommand: "/setup\n/send" },
  ])
    assert.throws(() => parseManifest(value, "owner"));
});
test("repository identities handle HTTPS, SSH, refs, and .git", () => {
  for (const source of [
    "git:github.com/Owner/pi-tools@v1",
    "https://github.com/Owner/pi-tools.git",
    "https://owner@github.com/Owner/pi-tools.git",
    "https://username:password@github.com/Owner/pi-tools.git",
    "git@github.com:Owner/pi-tools.git",
    "ssh://git@github.com/Owner/pi-tools.git",
  ])
    assert.equal(githubIdentity(source), "owner/pi-tools");
  assert.equal(gitRef("git:github.com/owner/pi-tools@release/v1"), "release/v1");
  assert.equal(githubIdentity("https://evil.example/owner/pi-tools"), undefined);
  assert.equal(cleanText("hello\x1b[31m\nworld"), "hello world");
  assert.equal(
    cleanText("https://user:secret@github.com/owner/pi-tools"),
    "https://[redacted]@github.com/owner/pi-tools",
  );
});
test("profiles reject path traversal, duplicate entries and bad refs", () => {
  assert.throws(() => profilePath("/tmp", "../oops"));
  assert.throws(() =>
    parseProfile({
      schemaVersion: 1,
      owner: "owner",
      packages: [{ repo: "pi-a" }, { repo: "pi-a" }],
    }),
  );
  assert.throws(() =>
    parseProfile({
      schemaVersion: 1,
      owner: "owner",
      packages: [{ repo: "pi-a", ref: "--exec=bad" }],
    }),
  );
  assert.deepEqual(
    parseProfile({ schemaVersion: 1, owner: "owner", packages: [{ repo: "pi-a", ref: "v1" }] })
      .packages,
    [{ repo: "owner/pi-a", ref: "v1" }],
  );
});
test("atomic storage, defaults and process lock", async () =>
  temp(async (dir) => {
    assert.equal((await loadConfig(dir)).owner, "slim-bean");
    const path = join(dir, "nested", "test.json");
    await atomicJson(path, { hello: "world" });
    assert.deepEqual(await jsonFile(path), { hello: "world" });
    await withManagerLock(dir, async () => {
      await assert.rejects(
        withManagerLock(dir, async () => {}),
        /Another manager operation/,
      );
    });
    await withManagerLock(dir, async () => {});
    await atomicJson(join(dir, "extension-manager/config.json"), {
      schemaVersion: 1,
      owner: "owner",
      cacheHours: -1,
    });
    await assert.rejects(loadConfig(dir), /Invalid/);
  }));
test("checks report availability only and never execute programs", async () =>
  temp(async (dir) => {
    const binary = join(dir, "danger");
    await writeFile(binary, "#!/bin/sh\ntouch SHOULD_NOT_EXIST\n", { mode: 0o700 });
    assert.equal(
      (await checkRequirement({ kind: "executable", names: [binary], label: "Program" }, dir)).ok,
      true,
    );
    await assert.rejects(access(join(dir, "SHOULD_NOT_EXIST")));
    assert.equal(
      (
        await checkRequirement({ kind: "env", names: ["KEY"], label: "Key" }, dir, {
          KEY: "secret",
        })
      ).ok,
      true,
    );
    assert.equal(
      (await checkRequirement({ kind: "file", names: ["missing"], label: "File" }, dir)).ok,
      false,
    );
  }));
test("discovery paginates, filters and reads data-only metadata", async () => {
  const config: Config = {
    schemaVersion: 1,
    owner: "owner",
    prefix: "pi-",
    cacheHours: 24,
    localRoots: [],
  };
  const calls: string[] = [];
  const encode = (value: unknown) => ({
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value)).toString("base64"),
  });
  const api: Api = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes("page=1&"))
      return [
        ...Array.from({ length: 99 }, (_, i) => ({ name: `other-${i}` })),
        { name: "pi-a", description: "A" },
      ];
    if (endpoint.includes("page=2&")) return [{ name: "pi-b", archived: true }];
    if (endpoint.endsWith("package.json"))
      return encode({
        name: endpoint.includes("pi-a") ? "pi-a" : "pi-b",
        version: "1.0.0",
        pi: { extensions: ["src/index.ts"] },
      });
    if (endpoint.includes("pi-a/contents/pi-manager.json"))
      return encode({ schemaVersion: 1, requires: ["pi-b"] });
    throw new Error("HTTP 404");
  };
  const repos = await discover(config, api);
  assert.deepEqual(
    repos.map((r) => r.name),
    ["pi-a", "pi-b"],
  );
  assert.equal(repos[1].archived, true);
  assert.equal(repos[0].manifest!.requires[0].repo, "owner/pi-b");
  assert.equal(calls.filter((c) => c.startsWith("users/")).length, 2);
});
test("malformed dependency metadata blocks repository installation", async () => {
  const encode = (v: unknown) => ({
    encoding: "base64",
    content: Buffer.from(JSON.stringify(v)).toString("base64"),
  });
  const repos = await discover(
    { schemaVersion: 1, owner: "owner", prefix: "pi-", cacheHours: 1, localRoots: [] },
    async (endpoint) =>
      endpoint.startsWith("users/")
        ? [{ name: "pi-a" }]
        : encode(
            endpoint.endsWith("package.json")
              ? { pi: { extensions: ["x.ts"] } }
              : { schemaVersion: 999 },
          ),
  );
  assert.equal(repos[0].installable, false);
  assert.match(repos[0].warning!, /schemaVersion/);
});
test("offline catalog fallback preserves validated metadata", async () =>
  temp(async (dir) => {
    const config: Config = {
      schemaVersion: 1,
      owner: "owner",
      prefix: "pi-",
      cacheHours: 24,
      localRoots: [],
    };
    await atomicJson(join(dir, "extension-manager/catalog.json"), {
      schemaVersion: 1,
      owner: "owner",
      prefix: "pi-",
      fetchedAt: new Date().toISOString(),
      repos: [repo("pi-a")],
    });
    const cached = await loadCatalog(dir, config, false, async () => {
      throw new Error("offline");
    });
    assert.equal(cached.catalog.repos.length, 1);
    assert.equal(cached.notice, undefined);
    const fallback = await loadCatalog(dir, config, true, async () => {
      throw new Error("offline");
    });
    assert.match(fallback.notice!, /cached catalog/);
  }));
test("explicit exclusions mark providers filtered instead of claiming they load", async () =>
  temp(async (dir) => {
    const root = join(dir, "package");
    await mkdir(join(root, "src"), { recursive: true });
    await atomicJson(join(root, "package.json"), { name: "pi-a", version: "1.0.0" });
    const path = join(root, "src/index.ts");
    await writeFile(path, "throw new Error('must not execute');");
    const items = await inventory(
      [repo("pi-a")],
      [],
      { user: { extensions: [`+${path}`, `-${path}`] }, project: {} },
      dir,
      join(dir, "agent"),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].filtered, true);
    assert.equal(items[0].source, `+${path}`);
  }));
test("inventory recognizes local packages and explicit files without duplication", async () =>
  temp(async (dir) => {
    const root = join(dir, "renamed-checkout");
    await mkdir(join(root, "src"), { recursive: true });
    await atomicJson(join(root, "package.json"), { name: "pi-a", version: "0.4.0" });
    await writeFile(join(root, "src/index.ts"), "throw new Error('must not execute');");
    const repos = [repo("pi-a")];
    const items = await inventory(
      repos,
      [{ source: root, scope: "user", filtered: false, installedPath: root }],
      { user: {}, project: { extensions: [join(root, "src/index.ts")] } },
      dir,
      join(dir, "agent"),
    );
    assert.equal(items.length, 2);
    assert.equal(items[0].version, "0.4.0");
    assert.equal(items[1].kind, "explicit");
    assert.equal(items[1].id, "owner/pi-a");
    const found = await findCheckouts([dir], repos);
    assert.equal(found.get("owner/pi-a"), root);
  }));
