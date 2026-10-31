# Third-Party Notices

This project includes code derived from the following third-party project.

## iwtown/dsh-llm-wiki

- Source: https://github.com/iwtown/dsh-llm-wiki
- Pinned commit: 4602b75e4afc2546704ca8b5e642f870eb2f0f96 (v0.10.7)
- License: MIT
- Copyright: Copyright (c) 2026 iwtown
- Upstream file used: `plugin/dsh-llm-wiki.mjs`
  (SHA256 7070BF78AC13E8FD409C3501E28DD0A49E9F0EA16BB67ED8EA6A6FFAEDD09620, 8371 bytes)
- Derived file in this project: `prompt.mjs`

### Modifications to `prompt.mjs` (derived work)

Only changes actually made to this file are listed:

- Added registry-driven multi-project matching (`loadProjects` / `matchProject`).
- Added a per-turn project-context prompt section.
- Added file logging and an opt-in debug probe.
- Changed the local workspace-matching helper to delegate to the shared
  registry module.
- The original single-vault code path is **retained as a legacy compatibility
  branch** (active when no registry is configured); it was not removed.

Modified by this project on 2026-10-30.

### Files NOT derived from this upstream

The following files are original work of this project and are listed here only
to prevent misattribution:

- `projects-registry.mjs` — registry loading/validation/matching, two path
  normalization modes (`normPath` / `resolvePath`), Windows extended-prefix
  stripping, unmappable-UNC fail-closed, and the atomic last-good snapshot.
- `guard.mjs` — `ctx.tools.guard` registration, write-tool argument mapping,
  and deny-code decisions.

### Copyright attribution

| Scope | Copyright holder |
| --- | --- |
| Original portion of `prompt.mjs` (derived from upstream) | Copyright (c) 2026 iwtown |
| Modifications to `prompt.mjs` | Copyright (c) 2026 SamBanHo |
| `guard.mjs`, `projects-registry.mjs`, configuration and docs | Copyright (c) 2026 SamBanHo |

The entire prompt.mjs file is distributed under the MIT License. The scope
distinctions above describe copyright attribution only and do not divide or
restrict the applicable license terms.

### MIT License (full text as distributed by the upstream project)

MIT License

Copyright (c) 2026 iwtown

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

