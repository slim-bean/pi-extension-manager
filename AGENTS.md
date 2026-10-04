# Development rules

- This is a Pi package. Use exported Pi package/settings APIs; never introduce a second installer or overwrite whole user settings files.
- Read README.md before changes and keep it accurate. Separate catalog/storage/inventory/planning from host integration and rendering.
- No network, processes, timers, or config writes in the extension factory. All work starts from the user command.
- Discovery and readiness checks are data-only. Do not execute repository setup hooks or expose credential values.
- Confirm mutation plans. Preserve existing source choices and local files; honor project trust. Never automatically prune dependencies or profiles.
- No operations on real user settings, browser profiles, or installed packages in tests. Use fixtures, fakes and temporary directories.
- Fail closed on invalid dependency metadata. Surface partial completion; do not promise transactional rollback.
- Respect reload lifecycle: finish cleanup before ctx.reload(); do not access the old context/runtime after it.
- Host Pi packages are optional peerDependencies, never runtime dependencies or bundled copies.
- Run npm run check before finishing. Exercise narrow TUI widths and command registration when changing UI/integration.
