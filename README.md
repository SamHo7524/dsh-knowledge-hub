# dsh-knowledge-hub

**English** | [简体中文](README.zh-CN.md)

> **Derived from [`iwtown/dsh-llm-wiki`](https://github.com/iwtown/dsh-llm-wiki)**
> (commit `4602b75e4afc2546704ca8b5e642f870eb2f0f96`, v0.10.7, MIT,
> Copyright (c) 2026 iwtown).
> The Prompt-layer plugin `prompt.mjs` is a modified version of that project's
> `plugin/dsh-llm-wiki.mjs`. The original copyright and license notice is
> retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
> `guard.mjs` and `projects-registry.mjs` are original work of this project.

DSH (DeepSeek Harness) knowledge-base hub plugin: multi-project registry,
per-turn project-context prompt injection, and write-path guard.

**Version 0.1.0** · MIT License · Copyright (c) 2026 SamBanHo

## Compatibility

| Item | Value |
|---|---|
| DSH | `0.2.1-rc.5` (verified) |
| Declared range | `>=0.2.0-rc.2 <0.2.1-0 \|\| >=0.2.1-rc.1 <0.3.0-0` |
| Node.js | `>=22.5.0` |
| Runtime dependencies | **none** (only `node:` built-ins) |

The declared range uses `includePrerelease` semantics, so prerelease DSH builds
such as `0.2.1-rc.5` match normally. If your DSH version falls outside the
range, the plugin is skipped at load time — see **Verifying the installation**.

## Installation

### Option A: install from the tarball (recommended)

```powershell
# 1. Create or pick a profile
$profile = "myprofile"
$profileDir = "$env:USERPROFILE\.dsh\profiles\$profile"
New-Item -ItemType Directory -Path "$profileDir\node_modules" -Force | Out-Null

# 2. Install the plugin
npm install --prefix $profileDir "C:\path\to\dsh-knowledge-hub-0.1.0.tgz"

# 3. Add it to the profile bundle list (see "Profile configuration" below)
```

### Option B: install from a local directory

```powershell
npm install --prefix $profileDir "C:\path\to\dsh-knowledge-hub"
```

### Option C: install from npm or Git (if published)

```powershell
npm install --prefix $profileDir dsh-knowledge-hub
# or pin a commit:
npm install --prefix $profileDir "github:owner/dsh-knowledge-hub#<sha>"
```

> Git installs fetch source, not build output. Pin a commit rather than a branch.

## Profile configuration

Add `dsh-knowledge-hub` to your profile's bundle list in `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-knowledge-hub"
      ]
    }
  }
}
```

Then create `cordis.patch.yml` in the profile directory:

```yaml
- insert:
    - id: llm-wiki
      name: dsh-knowledge-hub
      config:
        projectsFile: "C:/Users/you/.dsh/llm-wiki/dsh-projects.json"

    - id: wiki-guard
      name: dsh-knowledge-hub/guard
      disabled: true          # guard ships disabled; enable explicitly
      config:
        projectsFile: "C:/Users/you/.dsh/llm-wiki/dsh-projects.json"
        logFile: "C:/Users/you/.dsh/llm-wiki/guard.log"
```

> **Use forward slashes** in YAML paths. Backslashes can form invalid escape
> sequences (for example `\g` in `\guard.log`) and the patch fails silently.

> **`projectsFile` is required for the guard to register.** If it is missing,
> `apply()` runs but returns early and the guard never enters the tool pipeline.

## Registry

Both layers read one registry file:

```json
{
  "version": 1,
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "status": "active",
      "workspace": "C:\\path\\to\\workspace",
      "vault": "C:\\path\\to\\vault"
    },
    {
      "id": "readonly-project",
      "name": "Read-only Project",
      "status": "readonly",
      "workspace": "C:\\path\\to\\ro-workspace",
      "vault": "C:\\path\\to\\ro-vault"
    }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | Unique. Must not repeat. |
| `status` | `active` \| `readonly` \| `disabled` |
| `workspace` | Session `cwd` under this path selects the project. Must be unique and non-nested. |
| `vault` | Knowledge base root. Must be unique and non-overlapping. |

`disabled` projects are excluded from workspace matching but their vault is
still recognized, so writes to them are denied rather than misclassified.

The registry is re-read on every turn (invalidated by mtime and size), so edits
take effect without restarting DSH.

### Keep vaults inside the session workspace

DSH's file sandbox (`workspace-write`) blocks writes outside the session
workspace **before** the guard is consulted. If your vault lives outside the
workspace, writes fail with a sandbox error and the guard never runs.

Put the vault inside the workspace, or widen the sandbox deliberately:

```
<workspace>/vault/          <- vault inside workspace: guard is the effective layer
```

## Enabling the guard

The guard entry ships with `disabled: true`. Override it in the profile patch:

```yaml
- id: wiki-guard
  disabled: false
```

> **Security scope.** The guard is intended to prevent accidental writes and
> ordinary boundary crossings. It is **not** a defense against deliberate
> bypass, and it is not a substitute for OS-level permission isolation,
> separate process identity, or full filesystem access control.
>
> The registry and its last-good snapshot are **not protected by the guard** and
> can be modified by a session. The guard's rejection of a cross-vault write
> does not imply the registry is tamper-proof.

## Verifying the installation

> **An installation is not verified by files being present, nor by the entry
> appearing in the config. Three independent checks are required, and they are
> not interchangeable.**

### Check 1 — bundle level (stderr)

```powershell
dsh --profile <profile> --dump-config 2>&1 | Select-String "skipping profile bundle"
```

**Expected:** no output.

If present, the bundle was skipped entirely (unresolvable package, missing
`dsh.bundle`, version incompatibility, or an unreadable patch file). The message
is written to **stderr only** — checking stdout alone will miss it.

### Check 2 — entry level (stderr, real startup)

```powershell
dsh --profile <profile> "reply with OK" 2>&1 | Select-String "entries did not activate|failed to import"
```

**Expected:** no output.

If present, one or more entries failed to import (for example a syntax error in
a shared module). A shared-module failure appears here as
`entries did not activate` plus `failed to import` — **not** as
`skipping profile bundle`. These are different layers.

### Check 3 — guard registration (log)

```powershell
Select-String -Path "<logFile>" -Pattern "guard 已注册"
```

**Expected:**
- Guard enabled → the current startup must log `guard 已注册`
- Guard `disabled: true` → **no** registration line must appear

The only valid evidence that the guard entered the tool pipeline is this
registration line. Configuration presence, entry loading, and `apply()`
execution are all insufficient:

| Observation | Proves |
|---|---|
| Config row exists | nothing about runtime |
| Entry loaded | module was resolved |
| `apply()` executed | plugin code ran |
| **`guard 已注册` in log** | **guard entered the tool pipeline** |

A guard that is configured but not registered provides **no protection**. Never
claim the protection chain is active without this line.

## What it does

- **Prompt layer** (`dsh-knowledge-hub`) — injects the current project's
  knowledge-base context into the system prompt on every turn, driven by a
  single JSON project registry.
- **Guard layer** (`dsh-knowledge-hub/guard`) — registers a tool guard that
  rejects cross-vault writes. **Disabled by default.**

## Acknowledgements and References

- The "LLM Wiki" knowledge-base pattern: Andrej Karpathy,
  https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
  (concept reference only; no license found on the gist, no text or code reused)

- This project is derived from **iwtown/dsh-llm-wiki** @ 4602b75e4afc2546704ca8b5e642f870eb2f0f96
  (v0.10.7), MIT License, Copyright (c) 2026 iwtown,
  https://github.com/iwtown/dsh-llm-wiki
  The Prompt-layer plugin (`prompt.mjs`) is a modified version of that project's
  `plugin/dsh-llm-wiki.mjs`. Modifications: added registry-driven multi-project
  matching (`loadProjects` / `matchProject`), added a per-turn project-context
  prompt section, added file logging and a debug probe, and changed the local
  workspace-matching helper to delegate to the shared registry module. The
  original single-vault code path is **retained as a legacy compatibility branch**
  (active when no registry is configured), not removed.
  The original copyright and license notice is retained in THIRD_PARTY_NOTICES.md.

- The Guard layer (`guard.mjs`) and the shared registry module
  (`projects-registry.mjs`) are original work of this project and are not
  derived from any third-party code.

iwtown is the upstream author of dsh-llm-wiki and is not a maintainer,
contributor to, or official representative of dsh-knowledge-hub.

This project is independently developed. References do not imply affiliation,
endorsement, or official association with the upstream projects.

## License

MIT — Copyright (c) 2026 SamBanHo (this project's original work).
The derived portion of `prompt.mjs` remains Copyright (c) 2026 iwtown under MIT;
see THIRD_PARTY_NOTICES.md for the full upstream notice.
