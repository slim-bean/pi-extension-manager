import {
  getCapabilities,
  hyperlink,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { cleanText, repoId, type Repo } from "./model.ts";

/** Keep discovery/dependency data intact, but only display identified Pi packages. */
export function piPackages(repos: Repo[]): Repo[] {
  return repos.filter((repo) => repo.isPiPackage ?? repo.installable);
}
export function shortDescription(repo: Repo): string {
  const description = cleanText(repo.description).replace(/\s+/g, " ").trim();
  return stripTerminalSequences(truncateToWidth(description || "No description provided.", 140));
}
export function catalogName(repo: Repo, links = getCapabilities().hyperlinks): string {
  const name = cleanText(repo.name);
  // Never put an untrusted cached URL or terminal sequence inside OSC 8.
  const url = `https://github.com/${repoId(repo.id, repo.id.split("/")[0])}`;
  return links ? hyperlink(name, url) : name;
}
