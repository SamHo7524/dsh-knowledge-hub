# Changelog

All notable changes to this project are documented here.

## [0.1.2] - 2026-10-31

### Fixed

- **Cross-vault write bypass via `obsidian_*` relative paths.** The `obsidian_*`
  tools from `dsh-obsidian` resolve their `path` argument against the **vault
  root** (`path.resolve(vaultRoot, rel)`), while the guard resolved relative
  paths against `process.cwd()`. The two disagree, so
  `obsidian_write({ path: "note.md" })` was classified as "not inside any
  knowledge base" and **allowed**, even though it actually wrote into another
  project's vault. Verified end to end: writing into a different project's vault
  from a session belonging to another project succeeded and left no `DENY` line
  in `guard.log`.

  The guard now resolves relative paths for `obsidian_*` tools against the
  Obsidian vault root, using the same resolution order as `dsh-obsidian`:
  explicit `vaultPath` config first, then auto-detection from the Obsidian app
  config (`obsidian.json`, preferring the currently open vault).

  Three new deny codes:

  | Code | Meaning |
  | --- | --- |
  | `VAULT_ROOT_UNKNOWN` | Relative path used, but the vault root cannot be determined → fail-closed |
  | `VAULT_ESCAPE` | Relative path climbs out of the vault root (`../`) → fail-closed |
  | `CROSS_VAULT_WRITE` | (existing) Resolved target belongs to another project |

- **`apply()` now forwards `obsidianVaultPath`** from plugin config to the
  decision layer. Without it the guard would have to rely on auto-detection
  alone.

### Added

- **`detectObsidianVaultRoot()`** in `projects-registry.mjs`, mirroring
  `dsh-obsidian`'s `appConfigCandidates` / `detectVaultRootFromAppConfig`
  behavior so both layers agree on the vault root.

- **Test suite** (`test/obsidian-relpath.test.mjs`, 12 cases) covering
  relative-path cross-vault denial for all five `obsidian_*` write tools,
  fail-closed when the vault root is unknown, `../` escape rejection, and
  non-regression of absolute-path and non-vault behavior.

### Note

This closes a real protection gap, not a cosmetic one. It does not change the
standing caveat: the guard is meant to prevent mistakes and ordinary
overreach — it is not a security boundary against deliberate bypass.

## [0.1.1] - 2026-10-31

### Changed

- **Guard is now enabled by default.** Previously the entry shipped with
  `disabled: true` and required an explicit opt-in. Installing the plugin now
  activates write-path protection without extra configuration. To turn it off,
  override the row in the profile patch:

  ```yaml
  - id: wiki-guard
    disabled: true
  ```

- **Log prefix changed** from `[dsh-llm-wiki]` to `[dsh-knowledge-hub]`. The old
  prefix was carried over from the upstream project and made it ambiguous which
  plugin a log line came from. Grep for the new prefix when reading
  `plugin.log`.

### Added

- **Design intent section** in both READMEs, stating the plugin is built for
  Obsidian vaults following the LLM-Wiki pattern with multi-vault management,
  while remaining usable with any "directory + Markdown" knowledge base.

### Migration

If you are upgrading from 0.1.0 and had explicitly set `disabled: false`, that
setting still works — it is now simply the default. If you relied on the guard
being off, add `disabled: true` to keep the previous behavior.

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
