import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventory } from "../src/inventory.ts";

test("over-complex exclusion patterns fail inventory closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-glob-limit-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pi-safe",
        version: "1.0.0",
        repository: "https://github.com/owner/pi-safe",
      }),
    );
    const entry = join(dir, "index.ts");
    await writeFile(entry, "export {};\n");
    await assert.rejects(
      inventory(
        [],
        [],
        {
          user: { extensions: [entry, `!${join(dir, "?(a)".repeat(257))}`] },
          project: {},
        },
        dir,
        join(dir, "agent"),
      ),
      /pattern has too many extglobs/,
    );
    // A bad exclusion must not poison a subsequent valid discovery.
    const result = await inventory(
      [],
      [],
      { user: { extensions: [entry, `!${entry}`] }, project: {} },
      dir,
      join(dir, "agent"),
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].filtered, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Exercise the actual inventory filter rather than minimatch in isolation:
// hidden checkout directories must not disable the user's exclusion rules.
test("resource exclusion globs retain dot-directory, brace, and extglob semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-manager-globs-"));
  try {
    const entries: string[] = [];
    for (const name of ["pi-a", "pi-b", "pi-c"]) {
      const root = join(dir, ".checkouts", name);
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name, version: "1.0.0", repository: `https://github.com/owner/${name}` }),
      );
      const entry = join(root, "src", "index.ts");
      await writeFile(entry, "export {};\n");
      entries.push(entry);
    }
    for (const pattern of ["{pi-a,pi-b}", "@(pi-a|pi-b)", "!(pi-c)", "pi-[ab]"]) {
      const result = await inventory(
        [],
        [],
        {
          user: { extensions: [...entries, `!${join(dir, "**", pattern, "src", "*.ts")}`] },
          project: {},
        },
        dir,
        join(dir, "agent"),
      );
      assert.deepEqual(
        result.map(({ id, filtered, missing }) => ({ id, filtered, missing })),
        [
          { id: "owner/pi-a", filtered: true, missing: false },
          { id: "owner/pi-b", filtered: true, missing: false },
          { id: "owner/pi-c", filtered: false, missing: false },
        ],
        pattern,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
