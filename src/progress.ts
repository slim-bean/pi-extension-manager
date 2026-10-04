import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Loader, Text } from "@earendil-works/pi-tui";
import { cleanText } from "./model.ts";

export type Progress = (message: string) => void;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Keep slow command work visible in the interaction area, not just the footer. */
export async function withProgress<T>(
  ctx: ExtensionCommandContext,
  title: string,
  task: (report: Progress) => Promise<T>,
): Promise<T> {
  if (ctx.mode !== "tui") {
    try {
      ctx.ui.setStatus("extension-manager", cleanText(title));
      return await task((message) => ctx.ui.setStatus("extension-manager", cleanText(message)));
    } finally {
      ctx.ui.setStatus("extension-manager", undefined);
    }
  }

  const outcome = await ctx.ui.custom<Outcome<T>>((tui, theme, _kb, done) => {
    const panel = new Container();
    panel.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    panel.addChild(new Text(theme.fg("accent", theme.bold(cleanText(title))), 1, 0));
    const loader = new Loader(
      tui,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("muted", text),
      "Starting…",
    );
    panel.addChild(loader);
    panel.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    let active = true;
    const report: Progress = (message) => {
      if (active) loader.setMessage(cleanText(message));
    };
    const finish = (result: Outcome<T>) => {
      active = false;
      loader.stop();
      done(result);
    };
    // Return the component before work begins; never hold UI creation behind network I/O.
    void Promise.resolve()
      .then(() => task(report))
      .then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error }),
      );
    return {
      render: (width) => panel.render(width),
      invalidate: () => panel.invalidate(),
      dispose: () => {
        active = false;
        loader.stop();
      },
    };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
