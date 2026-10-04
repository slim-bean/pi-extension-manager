# Dependency and setup metadata

Publish `pi-manager.json` at a repository root. This is the manager's schema,
**not a native Pi dependency declaration**:

```json
{
  "schemaVersion": 1,
  "requires": [{ "repo": "slim-bean/pi-devtools", "version": ">=0.3.0" }],
  "optional": ["slim-bean/pi-browser"],
  "checks": [
    {
      "kind": "env",
      "names": ["TAVILY_API_KEY", "BRAVE_API_KEY"],
      "label": "Search API key",
      "optional": true,
      "help": "Set one of these variables, or configure a supported Pi API-key provider."
    },
    {
      "kind": "executable",
      "names": ["~/.local/bin/browser-fetch"],
      "label": "Local browser gateway",
      "optional": true
    }
  ],
  "help": "Configure your gateway before using browser retrieval.",
  "setupCommand": "/search-provider"
}
```

`requires` and `optional` accept repository strings or `{repo, version}` objects.
Unqualified repo names resolve against the catalog owner. Required packages must
be in the current catalog. Cycles and incompatible/unknown required versions block
apply. Optional integrations are informational and are not installed automatically.

Checks support `env`, `file`, and `executable`. At least one of `names` must be
available. Paths resolve from the session working directory, with `~` expansion;
bare executable names search PATH. Checks never execute programs, read secrets,
or start services. `setupCommand` must be a single slash-command line and is only
**placed in the editor after confirmation**, never executed automatically.

The manager ships transitional dependency/setup guidance for `pi-assistant` and
`pi-search`; repository metadata overrides it. Their conditional local/external
browser requirements remain owned by those extensions' status/config interfaces.
The manager does not yet provide configuration-writing wizards, feature selection,
or runtime health probes. **Installed is not the same as configured or loaded.**
No metadata means dependency requirements are unknown, not necessarily absent.

The default-branch catalog is used for preflight. Actual installed versions and
metadata are checked again before removals; a differing pinned ref may require a
revised plan after some installs complete. This is not a lockfile resolver.
