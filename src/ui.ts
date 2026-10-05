import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, Key, matchesKey } from "@earendil-works/pi-tui";
import { cleanText, type Installation, type Repo, type Scope } from "./model.ts";
import { catalogName, piPackages, shortDescription } from "./catalog.ts";

export type ScreenAction =
  | { kind: "apply" | "cancel" | "refresh" | "scope" | "filter" }
  | { kind: "details" | "source"; id: string };
export function status(id: string, installed: Installation[], scope: Scope): string {
  const all = installed.filter((i) => i.id === id);
  if (!all.length) return "not installed";
  return (
    all
      .map(
        (i) =>
          `${i.kind === "package" ? "package" : i.kind} / ${i.scope}${i.missing ? " (missing)" : i.filtered ? " (filtered)" : ""}`,
      )
      .join(", ") + (all.some((i) => i.scope === scope) ? "" : " (other scope)")
  );
}
export async function showScreen(
  ctx: ExtensionCommandContext,
  repos: Repo[],
  installed: Installation[],
  scope: Scope,
  changes: Map<string, boolean>,
  sources: Map<string, string>,
  filter: string,
): Promise<ScreenAction> {
  return ctx.ui.custom<ScreenAction>((tui, theme, _kb, done) => {
    const container = new Container();
    const items = () =>
      piPackages(repos)
        .filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(filter.toLowerCase()))
        .map((repo) => {
          const existing = installed.some((i) => i.id === repo.id && i.scope === scope);
          const checked = changes.get(repo.id) ?? existing;
          const changed = changes.has(repo.id) && checked !== existing;
          return {
            value: repo.id,
            label: `${checked ? "[x]" : "[ ]"}${changed ? "*" : " "} ${catalogName(repo)}`,
            description: shortDescription(repo),
          };
        });
    const listTheme = {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      // Link/truncation resets must not remove the surrounding selected-row color.
      selectedText: (s: string) =>
        theme.fg(
          "accent",
          s.replace(/(\x1b\[(?:0|39)m)/g, (reset) => reset + (theme.getFgAnsi?.("accent") ?? "")),
        ),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: (s: string) => theme.fg("warning", s),
    };
    let list = new SelectList(items(), 12, listTheme);
    const wire = () => {
      list.onSelect = (item) => done({ kind: "details", id: item.value });
      list.onCancel = () => done({ kind: "cancel" });
    };
    wire();
    container.addChild(
      new Text(
        theme.fg(
          "accent",
          theme.bold(`Extensions · ${scope === "user" ? "global" : "project"} scope`),
        ),
        0,
        0,
      ),
    );
    if (filter) container.addChild(new Text(cleanText(`Filter: ${filter}`), 0, 0));
    container.addChild({
      render: (width) =>
        list.getSelectedItem()
          ? list.render(width)
          : new Text(theme.fg("muted", "No matching Pi packages."), 0, 0).render(width),
      invalidate: () => list.invalidate(),
    });
    const selectedInfo = new Text("", 0, 0);
    container.addChild({
      render(width) {
        const repo = repos.find((r) => r.id === list.getSelectedItem()?.value);
        if (!repo) return [];
        const state = cleanText(
          `${repo.archived ? "archived · " : ""}${repo.warning ? "metadata error · " : ""}${status(repo.id, installed, scope)}${sources.has(repo.id) ? ` · ${sources.get(repo.id)}` : ""}`,
        );
        selectedInfo.setText(
          `${theme.fg("muted", shortDescription(repo))}\n${theme.fg("dim", `Status: ${state}`)}`,
        );
        return selectedInfo.render(width);
      },
      invalidate: () => selectedInfo.invalidate(),
    });
    container.addChild(
      new Text(theme.fg("dim", "↑↓ navigate · space toggle · enter details · l source"), 0, 0),
    );
    container.addChild(
      new Text(theme.fg("dim", "a apply · r refresh · tab scope · / filter · esc cancel"), 0, 0),
    );
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data) {
        const selected = list.getSelectedItem();
        if (data === " " && selected) {
          const repo = repos.find((r) => r.id === selected.value)!;
          const existing = installed.some((i) => i.id === repo.id && i.scope === scope);
          const elsewhere = installed.some((i) => i.id === repo.id && i.scope !== scope);
          const next = !(changes.get(repo.id) ?? existing);
          if (next && !existing && elsewhere) {
            ctx.ui.notify(
              "Already installed in the other scope; switch scope to manage it. Refusing a duplicate declaration.",
              "warning",
            );
            return;
          }
          if (next && !existing && (!repo.installable || repo.archived || repo.warning)) {
            ctx.ui.notify(
              cleanText(
                repo.warning ?? "This repository is archived or not an installable Pi package",
              ),
              "warning",
            );
            return;
          }
          if (next === existing) changes.delete(repo.id);
          else changes.set(repo.id, next);
          const updated = items();
          const index = updated.findIndex((i) => i.value === selected.value);
          list = new SelectList(updated, 12, listTheme);
          list.setSelectedIndex(index);
          wire();
        } else if (data === "a") done({ kind: "apply" });
        else if (data === "r") done({ kind: "refresh" });
        else if (data === "/") done({ kind: "filter" });
        else if (matchesKey(data, Key.tab)) done({ kind: "scope" });
        else if (data === "l" && selected) done({ kind: "source", id: selected.value });
        else list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
