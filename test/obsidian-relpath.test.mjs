// 回归测试：obsidian_* 相对路径必须按 Vault 根解析，不能按 process.cwd() 解析
//
// 缺陷（0.1.1 实测）：obsidian_write 的 path 是「相对 Vault 根」的路径，
// 而 Guard 的 resolvePath() 用 resolve() 基于 process.cwd()。两者语义不一致，
// 导致写其他项目 Vault 的路径被判为「非知识库路径」→ 放行 → 跨库写入绕过。
//
// 修复要求：Guard 判断 obsidian_* 工具时，相对路径必须基于该工具实际使用的
// Vault 根解析。Vault 根来源优先级（与 dsh-obsidian 一致）：
//   1. config.vaultPath（显式配置）
//   2. 自动探测（Obsidian 应用当前打开的 vault）→ Guard 无法可靠得知
// 因此：当 vaultPath 未配置、Guard 无法确定相对路径基准时，必须 fail-closed。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideWithRegistry, apply } from "../guard.mjs";

// ── 测试夹具：两个互不重叠的 vault，分别属于不同项目 ──
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "kh-relpath-"));
  const puqiheWs = join(root, "ws-puqihe");
  const toogelWs = join(root, "ws-toogel");
  const puqiheVault = join(root, "vault-puqihe");
  const toogelVault = join(root, "vault-toogel");
  for (const d of [puqiheWs, toogelWs, puqiheVault, toogelVault]) mkdirSync(d, { recursive: true });

  const projectsFile = join(root, "projects.json");
  writeFileSync(projectsFile, JSON.stringify({
    version: 1,
    projects: [
      { id: "puqihe", name: "puqihe", status: "active", workspace: puqiheWs, vault: puqiheVault },
      { id: "toogel", name: "toogel", status: "active", workspace: toogelWs, vault: toogelVault },
    ],
  }), "utf8");

  return { root, puqiheWs, toogelWs, puqiheVault, toogelVault, projectsFile };
}

const mkExec = (tool, args, cwd) => ({
  name: tool,
  arguments: args,
  agent: { session: { header: { cwd } } },
});

// ══════════════════════════════════════════════════════════
// 核心回归：相对路径写他库必须被拒
// ══════════════════════════════════════════════════════════

test("obsidian_write 相对路径写入他库 Vault 必须被拒绝", () => {
  const f = makeFixture();
  try {
    // 会话属于 puqihe，但 obsidian 的 vaultRoot 指向 toogel（真实场景）
    const exec = mkExec("obsidian_write", { path: "note.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });

    assert.equal(v.action, "deny",
      "相对路径 note.md 在 toogel vault 内解析，会话属于 puqihe，必须拒绝");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_write 相对路径写入自己库 Vault 必须放行", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_write", { path: "note.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.puqiheVault });
    assert.equal(v.action, "allow", "写自己库应放行");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_append 相对路径写入他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_append", { path: "sub/note.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_delete 相对路径删除他库页面必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_delete", { path: "note.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_move 相对路径移动他库页面必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_move", { from: "a.md", to: "b.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_set_property 相对路径改他库属性必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_set_property", { path: "note.md", key: "x", value: 1 }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// fail-closed：vaultRoot 未知时不能放行
// ══════════════════════════════════════════════════════════

test("obsidian_* 相对路径在 vaultRoot 未知时必须 fail-closed", () => {
  const f = makeFixture();
  // 隔离本机真实 Obsidian 配置：把 APPDATA / USERPROFILE 指向空目录，
  // 使自动探测必然失败，从而验证 fail-closed 分支。
  const emptyHome = mkdtempSync(join(tmpdir(), "kh-empty-home-"));
  const savedAppData = process.env.APPDATA;
  const savedUserProfile = process.env.USERPROFILE;
  const savedHome = process.env.HOME;
  process.env.APPDATA = emptyHome;
  process.env.USERPROFILE = emptyHome;
  process.env.HOME = emptyHome;
  try {
    // 未提供 obsidianVaultRoot，且探测必然失败：无法判定 note.md 的真实归属
    const exec = mkExec("obsidian_write", { path: "note.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);

    assert.equal(v.action, "deny",
      "相对路径归属不可判定时必须拒绝，不能默认按 cwd 解析后放行");
    assert.equal(v.code, "VAULT_ROOT_UNKNOWN");
  } finally {
    process.env.APPDATA = savedAppData;
    process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 绝对路径行为不能被破坏
// ══════════════════════════════════════════════════════════

test("obsidian_write 绝对路径写入他库仍必须被拒绝", () => {
  const f = makeFixture();
  try {
    const target = join(f.toogelVault, "note.md");
    const exec = mkExec("obsidian_write", { path: target }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("通用 write 绝对路径跨库仍必须被拒绝（既有行为不回归）", () => {
  const f = makeFixture();
  try {
    const target = join(f.toogelVault, "note.md");
    const exec = mkExec("write", { file_path: target }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("通用 write 写非知识库路径仍必须放行（既有行为不回归）", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("write", { file_path: join(f.root, "outside.txt") }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "allow");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 相对路径穿越（../）不能被用作绕过
// ══════════════════════════════════════════════════════════

test("obsidian_write 相对路径含 .. 穿越到 vault 外必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_write", { path: "../../escape.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });

    assert.equal(v.action, "deny",
      "相对路径穿越出 vault 根，实际落点不可信，必须拒绝");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// apply() 接线：配置的 obsidianVaultPath 必须传给决策层
// ══════════════════════════════════════════════════════════

test("apply() 必须把配置的 obsidianVaultPath 传给守卫决策", () => {
  const f = makeFixture();
  try {
    // 用 apply() 注册守卫，配置 obsidianVaultPath 指向 toogel
    let registered = null;
    const ctx = { tools: { guard: (fn) => { registered = fn; } } };

    apply(ctx, {
      projectsFile: f.projectsFile,
      logFile: join(f.root, "guard.log"),
      obsidianVaultPath: f.toogelVault,
    });

    assert.equal(typeof registered, "function", "apply() 必须注册守卫函数");

    // 会话属于 puqihe，obsidian 的相对路径应解析到 toogel → 必须拒绝
    const exec = mkExec("obsidian_write", { path: "note.md" }, f.puqiheWs);
    const msg = registered(exec);

    assert.equal(typeof msg, "string",
      "配置了 obsidianVaultPath 时，相对路径跨库写入必须被拒绝并返回拒绝原因");
    assert.match(msg, /跨库写入被拒绝/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
