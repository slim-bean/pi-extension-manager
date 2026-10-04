# Configuration, profiles, and safety

## Manager configuration

Config: `<agent-dir>/extension-manager/config.json`; the default agent directory
is `~/.pi/agent`. No file is required. Default settings:

```json
{
  "schemaVersion": 1,
  "owner": "slim-bean",
  "prefix": "pi-",
  "cacheHours": 24,
  "localRoots": ["~/projects"]
}
```

Local roots are scanned one directory level deep only when the catalog screen
opens. Installed package paths and direct explicit extension files are inspected
without loading their code. Git remotes and package metadata identify checkouts,
including renamed directories. Existing sources are preserved. Resource-filtered
packages are conservatively unsuitable dependency providers; enable their resources
using `pi config` instead of installing another copy.

Catalog metadata is cached for 24 hours. Failed refreshes can use an existing
cache with a warning. Invalid/unavailable metadata blocks new installs. Discovery
reads metadata only; no repository setup code runs. Repositories with a Pi resource
manifest or conventional resource directories are eligible; archived repositories
are listed but cannot be newly installed.

Authenticated discovery uses `/user/repos` for your own account, including private
repositories. Discovery of a different configured owner uses its public repository
listing. No token is read or stored by this extension; `gh` owns authentication.

## Portable profiles

```text
/extensions profile save laptop
/extensions profile apply laptop --local
/extensions profile list
```

Profiles live at `<agent-dir>/extension-manager/profiles/<name>.json`. Copy the
JSON to another computer's profiles directory and apply it there:

```json
{
  "schemaVersion": 1,
  "owner": "slim-bean",
  "packages": [
    { "repo": "slim-bean/pi-search" },
    { "repo": "slim-bean/pi-devtools", "ref": "v0.4.0" }
  ]
}
```

Profiles export known, unfiltered, on-disk catalog packages from both scopes,
with Git refs where present—not absolute paths, npm versions, secrets, config,
resource filters, or scope assignments. Applying is **additive** and never prunes
extra packages. An existing install's source/ref is not changed to match a profile.
Automatic cross-computer sync and remote machine inventory are not implemented.

## Mutation safeguards and limits

- Installing packages can execute dependency lifecycle scripts and extension code.
  Only install sources you trust. Catalog discovery does not execute source code.
- Native install/remove operations persist through Pi's settings manager. Explicit
  extension removal detaches its settings entry; local source files are never deleted.
- Auto-discovered files are read-only inventory: move them yourself or use `pi config`.
- Managed Git removal/update refuses dirty checkouts. Files shared with another
  scope's package declaration are retained. Local checkout updates are manual.
- Plans reject settings changes made while the plan is open. Manager mutations use
  a cross-process lock. A stale lock is not automatically stolen: verify no operation
  is active before deleting `<agent-dir>/extension-manager/apply.lock`.
- Failures stop the plan and report completed actions. There is no automatic rollback;
  reopen the catalog to inspect real state before retrying.
- Reload only affects this session. Other sessions must reload independently.
- Direct explicit paths are recognized; arbitrary glob-loaded extensions, packages
  without identifiable metadata, and undeclared third-party dependencies cannot all
  be mapped to GitHub repositories. Resource activation remains `pi config`'s job.
- Catalog metadata is not a supply-chain lockfile. See [metadata](metadata.md) for
  pinned-ref compatibility and setup-check limitations.
