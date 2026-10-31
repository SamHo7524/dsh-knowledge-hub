# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-10-31

Initial release.

### Added

- **Multi-project registry** (`projects-registry.mjs`) — a single JSON registry
  drives both the prompt layer and the guard layer. Validation rejects duplicate
  ids, duplicate workspaces, and overlapping vaults. The registry is re-read on
  every turn (invalidated by mtime and size), so edits take effect without a
  restart.
- **Project-context prompt injection** (`prompt.mjs`) — injects the current
  project's knowledge-base context into the system prompt each turn, derived from
  the session `cwd`.
- **Write-path guard** (`guard.mjs`) — registers a tool guard that rejects
  cross-vault writes, unregistered workspaces, and writes to read-only projects.
  **Disabled by default.**
- **Atomic last-good snapshot** — the last successfully loaded registry is
  persisted next to it, so a corrupted registry fails closed on cold start
  instead of silently allowing writes.
- **Path normalization** — two modes: `normPath` (literal, for `cwd`) and
  `resolvePath` (resolves symlinks and strips the Windows `\\?\` prefix, for
  write targets). Unmappable UNC paths fail closed.

### Security notes

- The guard prevents accidental writes and ordinary boundary crossings. It is
  **not** a defense against deliberate bypass.
- The registry and its last-good snapshot are **not** protected by the guard and
  can be modified by a session.
- Shell redirection and direct `ctx.fs` access are **not** covered.

### Known limitations

- Registry tamper resistance is not implemented.
- Device namespace (`\\.\`), 8.3 short names, UNC paths, and case-sensitive
  directories are unverified.
- Guard registration must be verified from its log; configuration presence and
  entry loading are not sufficient evidence.

### Compatibility

- DSH `0.2.1-rc.5` (verified); declared range
  `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`
- Node.js `>=22.5.0`
- No runtime dependencies
