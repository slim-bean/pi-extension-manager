// Development only: reuse the installed host, never install/bundle duplicate Pi copies.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const host = join(globalRoot, "@earendil-works", "pi-coding-agent");
if (!existsSync(host)) throw new Error(`Install Pi first; host not found at ${host}`);
const require = createRequire(join(host, "package.json"));
const tui = dirname(require.resolve("@earendil-works/pi-tui/package.json"));
mkdirSync("node_modules/@earendil-works", { recursive: true });
for (const [name, source] of [
  ["pi-coding-agent", host],
  ["pi-tui", tui],
]) {
  const target = join("node_modules", "@earendil-works", name);
  if (existsSync(target)) {
    if (realpathSync(target) !== realpathSync(source))
      throw new Error(
        `Refusing to replace ${target}; remove a duplicate development copy explicitly.`,
      );
  } else symlinkSync(source, target, "dir");
  console.log(`${target} -> ${source}`);
}
