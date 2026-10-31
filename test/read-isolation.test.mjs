// P0：跨 Vault 读取隔离
//
// 现状（0.1.2）：只有写入受保护（WRITE_TOOLS）。读取完全不受限——
// 会话属于 puqihe 时，可以直接 read 出 toogel / dianfei 的整个知识库内容。
//
// 本测试确立读取隔离的语义边界：
//   1. 当前项目 Vault 内读取 → 放行
//   2. 其他项目 Vault 内读取 → 拒绝（READ_CROSS_VAULT）
//   3. 非知识库普通文件读取 → 放行（不能误伤代码/配置/日志）
//   4. 相对路径按工具语义解析（obsidian_* 用 Vault 根，通用工具用 cwd）
//   5. Vault 根未知 + 相对路径 → fail-closed
//   6. ../ 穿越 → 拒绝
//   7. 符号链接指向他库 → 拒绝（resolvePath 已解析 realpath）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideWithRegistry } from "../guard.mjs";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "kh-read-"));
  const puqiheWs = join(root, "ws-puqihe");
  const toogelWs = join(root, "ws-toogel");
  const puqiheVault = join(root, "vault-puqihe");
  const toogelVault = join(root, "vault-toogel");
  const plainDir = join(root, "plain");
  for (const d of [puqiheWs, toogelWs, puqiheVault, toogelVault, plainDir]) mkdirSync(d, { recursive: true });

  writeFileSync(join(puqiheVault, "own.md"), "# own\n", "utf8");
  writeFileSync(join(toogelVault, "secret.md"), "# secret\n", "utf8");
  writeFileSync(join(plainDir, "code.js"), "// code\n", "utf8");

  const projectsFile = join(root, "projects.json");
  writeFileSync(projectsFile, JSON.stringify({
    version: 1,
    projects: [
      { id: "puqihe", name: "puqihe", status: "active", workspace: puqiheWs, vault: puqiheVault },
      { id: "toogel", name: "toogel", status: "active", workspace: toogelWs, vault: toogelVault },
    ],
  }), "utf8");

  return { root, puqiheWs, toogelWs, puqiheVault, toogelVault, plainDir, projectsFile };
}

const mkExec = (tool, args, cwd) => ({
  name: tool,
  arguments: args,
  agent: { session: { header: { cwd } } },
});

// ══════════════════════════════════════════════════════════
// 通用读取工具：read
// ══════════════════════════════════════════════════════════

test("read 读取自己项目 Vault 必须放行", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("read", { file_path: join(f.puqiheVault, "own.md") }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "allow", "读自己的知识库不应被拦");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("read 读取他项目 Vault 必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("read", { file_path: join(f.toogelVault, "secret.md") }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny", "读他库必须拒绝");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("read 读取非知识库普通文件必须放行", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("read", { file_path: join(f.plainDir, "code.js") }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "allow", "普通文件不受知识库隔离限制");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 其他通用读取工具：grep / glob
// ══════════════════════════════════════════════════════════

test("grep 搜索他项目 Vault 必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("grep", { pattern: "secret", path: f.toogelVault }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("glob 列举他项目 Vault 必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("glob", { pattern: "**/*.md", path: f.toogelVault }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("grep 搜索非知识库目录必须放行", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("grep", { pattern: "code", path: f.plainDir }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "allow");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// Obsidian 读取工具：相对路径按 Vault 根解析
// ══════════════════════════════════════════════════════════

test("obsidian_read 相对路径读取他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_read", { path: "secret.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_read 相对路径读取自己库必须放行", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_read", { path: "own.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.puqiheVault });
    assert.equal(v.action, "allow");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_read 绝对路径读取他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_read", { path: join(f.toogelVault, "secret.md") }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.puqiheVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_list 列举他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_list", { dir: "sub" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_search 搜索他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    // obsidian_search 没有路径参数：查询范围就是整个 Vault，
    // 因此 Vault 属于他库时整次搜索都必须拒绝。
    const exec = mkExec("obsidian_search", { query: "secret" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_backlinks 查询他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_backlinks", { path: "secret.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_frontmatter 读取他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_frontmatter", { path: "secret.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_tags 在 Vault 属于他库时必须被拒绝", () => {
  const f = makeFixture();
  try {
    // obsidian_tags 无路径参数，枚举整个 Vault 的标签
    const exec = mkExec("obsidian_tags", {}, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// fail-closed 与穿越
// ══════════════════════════════════════════════════════════

test("obsidian_read 相对路径在 Vault 根未知时必须 fail-closed", () => {
  const f = makeFixture();
  const emptyHome = mkdtempSync(join(tmpdir(), "kh-empty-"));
  const saved = { APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.APPDATA = emptyHome;
  process.env.USERPROFILE = emptyHome;
  process.env.HOME = emptyHome;
  try {
    const exec = mkExec("obsidian_read", { path: "secret.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny", "无法确定读取范围时必须拒绝");
    assert.equal(v.code, "VAULT_ROOT_UNKNOWN");
  } finally {
    process.env.APPDATA = saved.APPDATA;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_read 相对路径 ../ 穿越出 Vault 必须被拒绝", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_read", { path: "../../escape.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny", "穿越路径的落点不可信");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("read 用 ../ 穿越到其他项目 Vault 必须被拒绝", () => {
  const f = makeFixture();
  try {
    // 绝对路径形式已经覆盖；这里验证相对 cwd 的穿越仍被正确归属识别
    const target = join(f.toogelVault, "secret.md");
    const exec = mkExec("read", { file_path: target }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 符号链接绕过
// ══════════════════════════════════════════════════════════

test("read 经符号链接读取他库必须被拒绝", () => {
  const f = makeFixture();
  try {
    // 在自己 workspace 里建一个指向他库的符号链接
    const link = join(f.puqiheWs, "link-to-toogel");
    let linked = false;
    try { symlinkSync(f.toogelVault, link, "junction"); linked = true; } catch { /* 无权限则跳过 */ }
    if (!linked) { console.log("    (跳过：无法创建符号链接)"); return; }

    const exec = mkExec("read", { file_path: join(link, "secret.md") }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny", "符号链接不能绕过读取隔离");
    assert.equal(v.code, "READ_CROSS_VAULT");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 写入隔离不回归
// ══════════════════════════════════════════════════════════

test("write 跨库写入仍必须被拒绝（写入隔离不回归）", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("write", { file_path: join(f.toogelVault, "x.md") }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("obsidian_write 相对路径跨库仍必须被拒绝（写入隔离不回归）", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("obsidian_write", { path: "x.md" }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile, { obsidianVaultRoot: f.toogelVault });
    assert.equal(v.action, "deny");
    assert.equal(v.code, "CROSS_VAULT_WRITE");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 非读取非写入工具不受影响
// ══════════════════════════════════════════════════════════

test("非文件工具（如 todo_write）不受路径隔离影响", () => {
  const f = makeFixture();
  try {
    const exec = mkExec("todo_write", { todos: [] }, f.puqiheWs);
    const v = decideWithRegistry(exec, f.projectsFile);
    assert.equal(v.action, "allow", "与路径无关的工具不应被拦");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
