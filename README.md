# pi-extension-manager

Discover your GitHub Pi packages and manage them with **`/extensions`**. Uses
Pi's native package manager, with dependency-aware plans and portable profiles.
Requires **Pi 1.0.0+** and Node **22.19+**. Defaults to `slim-bean` repos named `pi-*`.

## Install

For local development, install dependencies in the checkout:

```sh
cd ~/projects/pi-extensions/pi-extension-manager
npm install --ignore-scripts --legacy-peer-deps
```

Add the entry point to the **existing** `extensions` array in
`~/.pi/agent/settings.json` (preserve other entries):

```json
{
  "extensions": ["~/projects/pi-extensions/pi-extension-manager/src/index.ts"]
}
```

Run `/reload` after editing source. This loads directly from the checkout; no
install step is needed. Do not also declare the same extension under `packages`.
`pi install ~/projects/pi-extensions/pi-extension-manager` is an alternative
that also loads in-place, but records a package declaration instead of an
explicit source file.

Install from GitHub (or pin the initial release with `@v0.1.0`):

```sh
pi install git:github.com/slim-bean/pi-extension-manager
```

Run `/reload` in existing sessions, then `/extensions`. `gh` is recommended:
`gh auth login` enables discovery of your private repos. Without `gh`, the public
GitHub API is used (lower rate limits, no private repositories). Failed `gh`
authentication is reported, not silently downgraded to anonymous access.

## Interactive catalog

Only identified Pi packages appear in the catalog and `/extensions list`.
Names are blue, underlined GitHub links in terminals with hyperlink support. Rows show
short descriptions (GitHub description, then `package.json`); the selected row's
summary and installation status also appear below the list for narrow terminals.

A visible loading panel shows a spinner, GitHub discovery and repository-metadata
counts, then installed-package and local-checkout scanning. Cached catalogs skip
GitHub discovery; there is no artificial delay on fast loads.

- **↑/↓** navigate; **Space** stage install/remove; **a** review and apply.
- **Enter** inspect dependencies, readiness checks, and setup guidance.
- **l** choose GitHub or a detected local checkout for a _new_ installation.
- **Tab** switch global/project scope; **/** filter; **r** refresh; **Esc** discard.

Changes require confirmation. Dependencies install first; dependents remove first.
Required dependency removals, cycles, and incompatible versions are blocked.
Existing local installs are recognized and preserved, not replaced with GitHub copies.

```text
/extensions list
/extensions refresh
/extensions install pi-assistant
/extensions remove pi-looper --local
/extensions check pi-search
/extensions update pi-looper
/extensions profile save laptop
/extensions profile apply laptop --local
/extensions profile list
/extensions help
```

Default scope is global; `-l`/`--local` selects the current project and requires
Pi project trust. The full screen needs TUI mode; explicit commands also work
in RPC with confirmation dialogs. Use native `pi install/remove` for automation.

## Configuration and dependencies

No configuration is required. Optional config lives at
`<agent-dir>/extension-manager/config.json` (default `~/.pi/agent`):

```json
{
  "schemaVersion": 1,
  "owner": "slim-bean",
  "prefix": "pi-",
  "cacheHours": 24,
  "localRoots": ["~/projects"]
}
```

- [Configuration, portable profiles, and safeguards](docs/configuration.md)
- [Declaring dependencies and setup checks with `pi-manager.json`](docs/metadata.md)

Transitional metadata for `pi-assistant` and `pi-search` is included. Their own
setup/status commands still own conditional browser configuration. The manager
provides guidance and non-executing checks—not configuration-writing wizards yet.
**Installed does not necessarily mean configured or currently loaded.**

Profiles are additive selections you copy between computers; they never export
secrets/local paths or prune extra packages. No automatic cloud sync is implemented.
Local files are never deleted, dirty managed checkouts are protected, and partial
failures are reported without pretending to offer transactional rollback.

## Development

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run dev:link-host   # reuse installed Pi/pi-tui; do not bundle duplicate host copies
npm run check          # formatting, strict types, fixtures + isolated integration tests
```

Tests never mutate real Pi settings, credentials, browser profiles, or installations.
See [AGENTS.md](AGENTS.md) for implementation boundaries.
