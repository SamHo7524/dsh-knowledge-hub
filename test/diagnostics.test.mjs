// P1：统一诊断入口
//
// 目标：一条命令看清配置与运行是否正常，而不是翻散落的日志。
//
// 设计原则：
//   - 诊断逻辑写成纯函数（collectDiagnostics），可脱离 DSH 运行时测试
//   - 无法取得的信息一律标 "unknown"，绝不伪造成 success
//   - 不做副作用操作（不写文件、不改配置、不触发同步）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectDiagnostics, formatDiagnostics } from "../diagnostics.mjs";

function makeFixture({ withVaults = true, projects = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kh-diag-"));
  const wsA = join(root, "ws-a");
  const wsB = join(root, "ws-b");
  const vaultA = join(root, "vault-a");
  const vaultB = join(root, "vault-b");
  for (const d of [wsA, wsB]) mkdirSync(d, { recursive: true });
  if (withVaults) for (const d of [vaultA, vaultB]) mkdirSync(d, { recursive: true });

  const projectsFile = join(root, "projects.json");
  const body = projects !== null ? projects : {
    version: 1,
    projects: [
      { id: "proj-a", name: "Project A", status: "active", workspace: wsA, vault: vaultA },
      { id: "proj-b", name: "Project B", status: "active", workspace: wsB, vault: vaultB },
    ],
  };
  writeFileSync(projectsFile, JSON.stringify(body), "utf8");
  return { root, wsA, wsB, vaultA, vaultB, projectsFile };
}

// ══════════════════════════════════════════════════════════
// Registry 状态
// ══════════════════════════════════════════════════════════

test("诊断：注册表有效时报告 ok 与项目数", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA });
    assert.equal(d.registry.ok, true);
    assert.equal(d.registry.projectCount, 2);
    assert.equal(d.registry.error, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：注册表损坏时报告 error 且不伪造成功", () => {
  const f = makeFixture({ projects: { version: 999, projects: [] } });
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA });
    assert.equal(d.registry.ok, false);
    assert.equal(d.registry.projectCount, 0);
    assert.ok(typeof d.registry.error === "string" && d.registry.error.length > 0,
      "必须给出具体错误，不能只说失败");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：注册表文件不存在时报告 ok=false", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: join(f.root, "nope.json"), cwd: f.wsA });
    assert.equal(d.registry.ok, false);
    assert.ok(d.registry.error);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 当前 cwd 匹配
// ══════════════════════════════════════════════════════════

test("诊断：cwd 匹配到项目时报告项目 id", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA });
    assert.equal(d.cwd.projectId, "proj-a");
    assert.equal(d.cwd.projectName, "Project A");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：cwd 未匹配时明确报告 null，不猜测", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: join(f.root, "unregistered") });
    assert.equal(d.cwd.projectId, null);
    assert.ok(d.cwd.note.includes("未登记"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// Vault 存在性
// ══════════════════════════════════════════════════════════

test("诊断：逐个项目报告 Vault 是否存在", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA });
    assert.equal(d.vaults.length, 2);
    assert.equal(d.vaults[0].exists, true);
    assert.equal(d.vaults[1].exists, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：Vault 不存在时该项为 false", () => {
  const f = makeFixture({ withVaults: false });
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA });
    assert.equal(d.vaults[0].exists, false);
    assert.equal(d.vaults[0].id, "proj-a");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// Guard 注册状态与保护范围
// ══════════════════════════════════════════════════════════

test("诊断：报告 Guard 保护的工具范围，区分读取与写入", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({
      projectsFile: f.projectsFile,
      cwd: f.wsA,
      guardRegistered: true,
    });
    assert.equal(d.guard.registered, true);
    assert.ok(Array.isArray(d.guard.writeTools) && d.guard.writeTools.length > 0, "必须列出写入工具");
    assert.ok(Array.isArray(d.guard.readTools) && d.guard.readTools.length > 0, "必须列出读取工具");
    assert.ok(d.guard.writeTools.includes("write"));
    assert.ok(d.guard.readTools.includes("read"));
    // 读写不能混在同一列表里
    assert.ok(!d.guard.readTools.includes("write"), "写入工具不得出现在读取列表");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：Guard 未注册时 registered=false", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({
      projectsFile: f.projectsFile,
      cwd: f.wsA,
      guardRegistered: false,
    });
    assert.equal(d.guard.registered, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// Pipeline 状态：无法取得时必须 unknown，不得伪造
// ══════════════════════════════════════════════════════════

test("诊断：Pipeline 状态未知时必须是 unknown，不能伪造 success", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA });
    assert.equal(d.pipeline.lastSyncStatus, "unknown",
      "取不到同步状态就必须标 unknown");
    assert.notEqual(d.pipeline.lastSyncStatus, "success");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：能提供 pipeline 信息时如实反映", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({
      projectsFile: f.projectsFile,
      cwd: f.wsA,
      pipeline: { available: true, scriptPath: "C:/x/pipeline.mjs", lastSyncStatus: "success" },
    });
    assert.equal(d.pipeline.available, true);
    assert.equal(d.pipeline.lastSyncStatus, "success");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 上游 dsh-llm-wiki 共存检测
// ══════════════════════════════════════════════════════════

test("诊断：检测到上游 dsh-llm-wiki 共存时给出告警", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({
      projectsFile: f.projectsFile,
      cwd: f.wsA,
      upstreamPresent: true,
    });
    assert.equal(d.upstream.present, true);
    assert.ok(d.warnings.some((w) => w.includes("dsh-llm-wiki")),
      "共存必须产生明确告警，不能静默");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：无上游共存时不产生该告警", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({
      projectsFile: f.projectsFile,
      cwd: f.wsA,
      upstreamPresent: false,
    });
    assert.equal(d.upstream.present, false);
    assert.ok(!d.warnings.some((w) => w.includes("dsh-llm-wiki")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 输出格式
// ══════════════════════════════════════════════════════════

test("诊断：格式化输出包含关键章节且为中文", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA, guardRegistered: true });
    const text = formatDiagnostics(d);
    for (const section of ["注册表", "当前项目", "Vault", "Guard", "Pipeline", "上游"]) {
      assert.ok(text.includes(section), "输出必须包含「" + section + "」章节");
    }
    assert.ok(text.includes("unknown"), "未知状态必须原样显示 unknown");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("诊断：输出明确区分读取与写入保护范围", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA, guardRegistered: true });
    const text = formatDiagnostics(d);
    assert.ok(text.includes("写入") && text.includes("读取"), "必须分别列出读写");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 只读性：诊断不得产生副作用
// ══════════════════════════════════════════════════════════

test("诊断：collectDiagnostics 不修改注册表文件", () => {
  const f = makeFixture();
  try {
    const before = readFileSync(f.projectsFile, "utf8");
    collectDiagnostics({ projectsFile: f.projectsFile, cwd: f.wsA });
    const after = readFileSync(f.projectsFile, "utf8");
    assert.equal(before, after, "诊断必须是只读的");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 工具接入：prompt.mjs 必须注册诊断工具
// ══════════════════════════════════════════════════════════

test("inject 必须声明 tools 服务，否则 ctx.tools 在 apply() 时不可用", async () => {
  const mod = await import("../prompt.mjs");
  const inject = mod.inject || [];
  assert.ok(inject.includes("tools"),
    "inject 必须含 \"tools\"（dsh-obsidian/dsh-github 均如此），实际: [" + inject.join(", ") + "]");
});

test("inject 必须保留 systemPrompt 服务（提示词注入依赖）", async () => {
  const mod = await import("../prompt.mjs");
  const inject = mod.inject || [];
  assert.ok(inject.includes("systemPrompt"),
    "inject 必须保留 \"systemPrompt\"，实际: [" + inject.join(", ") + "]");
});

test("prompt.apply() 必须注册 knowledge_hub_status 工具", async () => {
  const f = makeFixture();
  try {
    const registered = [];
    const ctx = {
      tools: { register: (def) => { registered.push(def); return () => {}; } },
      systemPrompt: { section: () => () => {} },
      effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
      logger: { info: () => {}, warn: () => {} },
      on: () => () => {},
    };
    const { apply } = await import("../prompt.mjs");
    apply(ctx, { projectsFile: f.projectsFile });

    const names = registered.map((r) => r.name);
    assert.ok(names.includes("knowledge_hub_status"),
      "必须注册诊断工具，实际注册: " + (names.join(", ") || "(空)"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("工具注册必须是同步的（与 dsh-obsidian 一致），不能依赖异步解析", async () => {
  const f = makeFixture();
  try {
    const registered = [];
    const ctx = {
      tools: { register: (def) => { registered.push(def); return () => {}; } },
      systemPrompt: { section: () => () => {} },
      effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
      logger: { info: () => {}, warn: () => {} },
      on: () => () => {},
      agent: { session: { header: { cwd: f.wsA } } },
    };
    const { apply } = await import("../prompt.mjs");
    apply(ctx, { projectsFile: f.projectsFile });

    // 同步断言：apply() 返回后工具就必须已在，不等微任务
    const names = registered.map((r) => r.name);
    assert.ok(names.includes("knowledge_hub_status"),
      "apply() 返回后应已同步注册，实际: " + (names.join(", ") || "(空)"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("工具注册必须用单参数形态（与 dsh-obsidian 一致）", async () => {
  const f = makeFixture();
  try {
    const calls = [];
    const ctx = {
      tools: { register: (...a) => { calls.push(a); return () => {}; } },
      systemPrompt: { section: () => () => {} },
      effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
      logger: { info: () => {}, warn: () => {} },
      on: () => () => {},
      agent: { session: { header: { cwd: f.wsA } } },
    };
    const { apply } = await import("../prompt.mjs");
    apply(ctx, { projectsFile: f.projectsFile });

    const call = calls.find((a) => a[0] && a[0].name === "knowledge_hub_status");
    assert.ok(call, "必须注册该工具");
    assert.equal(call.length, 1,
      "register 应只传 1 个参数（实际 " + call.length + " 个），与 dsh-obsidian 一致");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("knowledge_hub_status 工具的 execute 返回诊断文本", async () => {
  const f = makeFixture();
  try {
    const registered = [];
    const ctx = {
      tools: { register: (def) => { registered.push(def); return () => {}; } },
      systemPrompt: { section: () => () => {} },
      effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
      logger: { info: () => {}, warn: () => {} },
      on: () => () => {},
    };
    const { apply } = await import("../prompt.mjs");
    apply(ctx, { projectsFile: f.projectsFile });

    const tool = registered.find((r) => r.name === "knowledge_hub_status");
    assert.ok(tool, "工具必须存在");
    // execute 的第二个参数是 exec，会话上下文从这里取（同 dsh-github 的 exec.signal 用法）
    const text = await tool.execute({}, { agent: { session: { header: { cwd: f.wsA } } } });
    assert.equal(typeof text, "string");
    assert.ok(text.includes("注册表"), "输出必须含注册表章节");
    assert.ok(text.includes("Guard"), "输出必须含 Guard 章节");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("execute 必须能从 exec.agent.session.header.cwd 取到 cwd（不能读 ctx.agent）", async () => {
  const f = makeFixture();
  try {
    const registered = [];
    const ctx = {
      tools: { register: (def) => { registered.push(def); return () => {}; } },
      systemPrompt: { section: () => () => {} },
      effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
      logger: { info: () => {}, warn: () => {} },
      on: () => () => {},
      // 故意不提供 ctx.agent：生产环境里访问未 inject 的服务会抛
      // "cannot get property agent without inject"
    };
    const { apply } = await import("../prompt.mjs");
    apply(ctx, { projectsFile: f.projectsFile });

    const tool = registered.find((r) => r.name === "knowledge_hub_status");
    assert.ok(tool, "工具必须存在");
    const text = await tool.execute({}, { agent: { session: { header: { cwd: f.wsA } } } });

    // 必须匹配到 fixture 里 wsA 对应的项目（Project A / proj-a），说明 cwd 确实来自 exec
    assert.ok(text.includes("匹配"), "必须报告 cwd 匹配结果");
    assert.ok(text.includes("Project A") && text.includes("proj-a"),
      "必须匹配到 fixture 的 Project A，实际输出片段:\n" + text.slice(0, 600));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("execute 在拿不到 exec 上下文时不得抛错，应降级并如实报告", async () => {
  const f = makeFixture();
  try {
    const registered = [];
    const ctx = {
      tools: { register: (def) => { registered.push(def); return () => {}; } },
      systemPrompt: { section: () => () => {} },
      effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
      logger: { info: () => {}, warn: () => {} },
      on: () => () => {},
    };
    const { apply } = await import("../prompt.mjs");
    apply(ctx, { projectsFile: f.projectsFile });

    const tool = registered.find((r) => r.name === "knowledge_hub_status");
    const text = await tool.execute({}, undefined);
    assert.equal(typeof text, "string", "无 exec 时应降级返回文本而非抛错");
    assert.ok(text.includes("注册表"), "仍应输出注册表章节");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

