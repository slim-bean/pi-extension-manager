import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { expand } from "./storage.ts";
import type { Requirement } from "./model.ts";

export interface CheckResult {
  label: string;
  ok: boolean;
  optional: boolean;
  help?: string;
}
export async function checkRequirement(
  check: Requirement,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckResult> {
  let ok = false;
  for (const name of check.names) {
    if (check.kind === "env") {
      ok ||= !!env[name];
      continue;
    }
    const paths =
      check.kind === "file" || isAbsolute(name) || name.includes("/") || name.startsWith("~")
        ? [expand(name, cwd)]
        : (env.PATH ?? "")
            .split(delimiter)
            .filter(Boolean)
            .map((dir) => join(dir, name));
    for (const path of paths) {
      try {
        await access(path, check.kind === "executable" ? constants.X_OK : constants.R_OK);
        if ((await stat(path)).isFile()) ok = true;
      } catch {
        /* Report only availability, never file contents or environment values. */
      }
    }
  }
  return { label: check.label, ok, optional: check.optional ?? false, help: check.help };
}
