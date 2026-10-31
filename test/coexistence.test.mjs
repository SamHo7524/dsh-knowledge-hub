// P2：上游 dsh-llm-wiki 共存
//
// 背景：dsh-knowledge-hub 的 prompt.mjs 派生自上游 iwtown/dsh-llm-wiki。
// 若两者同时加载，会出现：
//   1. 重复 Prompt 注入（两套 systemPrompt.section 都往同一会话写）
//   2. 重复 Pipeline 同步（两个 entry 都在 session/disposed 时 spawn 管线）
//   3. 两套插件操作同一项目上下文
//   4. 加载顺序变化导致行为不一致
//
// 处理原则（用户明确要求）：
//   - Hub 保留自己的 Registry / Resolver / Context Provider / Guard
//   - 不因上游共存而禁用 Hub
//   - 明确 Prompt 注入的唯一责任方
//   - 明确 Pipeline 同步的唯一责任方
//   - 无法自动解决时给出明确诊断告警
//   - 不重写现有上下文协调机制

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectDiagnostics, formatDiagnostics } from "../diagnostics.mjs";
import { detectUpstreamConflict, PROMPT_OWNER } from "../coexistence.mjs";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "kh-coex-"));
  const ws = join(root, "ws");
  const vault = join(root, "vault");
  mkdirSync(ws, { recursive: true });
  mkdirSync(vault, { recursive: true });
  const projectsFile = join(root, "projects.json");
  writeFileSync(projectsFile, JSON.stringify({
    version: 1,
    projects: [{ id: "p", name: "P", status: "active", workspace: ws, vault }],
  }), "utf8");
  return { root, ws, vault, projectsFile };
}

// ══════════════════════════════════════════════════════════
// 责任方声明
// ══════════════════════════════════════════════════════════

test("共存：必须明确 Prompt 注入的唯一责任方", () => {
  assert.equal(typeof PROMPT_OWNER, "string");
  assert.ok(PROMPT_OWNER.length > 0, "必须声明 Prompt 责任方");
  assert.ok(PROMPT_OWNER.includes("dsh-knowledge-hub"),
    "责任方应为 dsh-knowledge-hub（Hub 不因上游共存而退让）");
});

// ══════════════════════════════════════════════════════════
// 冲突检测
// ══════════════════════════════════════════════════════════

test("共存：检测到上游时报告冲突，且指出重复注入风险", () => {
  const c = detectUpstreamConflict({ upstreamPresent: true, hubEnabled: true });
  assert.equal(c.detected, true);
  assert.equal(c.severity, "warning");
  assert.ok(c.issues.some((i) => i.includes("Prompt")), "必须指出 Prompt 重复注入");
  assert.ok(c.issues.some((i) => i.includes("同步") || i.includes("Pipeline")),
    "必须指出 Pipeline 重复同步");
});

test("共存：Hub 不因上游共存而被禁用", () => {
  const c = detectUpstreamConflict({ upstreamPresent: true, hubEnabled: true });
  assert.equal(c.hubShouldRun, true, "Hub 必须继续运行，不因共存而禁用");
});

test("共存：无上游时不报冲突", () => {
  const c = detectUpstreamConflict({ upstreamPresent: false, hubEnabled: true });
  assert.equal(c.detected, false);
  assert.equal(c.severity, "none");
  assert.equal(c.issues.length, 0);
});

test("共存：给出可执行的处置建议（而非只说有问题）", () => {
  const c = detectUpstreamConflict({ upstreamPresent: true, hubEnabled: true });
  assert.ok(typeof c.recommendation === "string" && c.recommendation.length > 0,
    "必须给出建议");
  assert.ok(c.recommendation.includes("disabled"),
    "建议应指出禁用其中一方的 entry");
});

// ══════════════════════════════════════════════════════════
// 与诊断输出集成
// ══════════════════════════════════════════════════════════

test("共存：诊断输出必须明确写出 Prompt 与同步责任方", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({
      projectsFile: f.projectsFile,
      cwd: f.ws,
      guardRegistered: true,
      upstreamPresent: true,
    });
    const text = formatDiagnostics(d);

    assert.ok(text.includes("dsh-knowledge-hub"), "输出必须写明责任方");
    assert.ok(/Prompt|注入/.test(text), "输出必须提到 Prompt");
    assert.ok(/同步|Pipeline/.test(text), "输出必须提到同步");
    assert.ok(text.includes("disabled"), "输出必须给出处置办法");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("共存：诊断结果的 coexistence 字段结构完整", () => {
  const f = makeFixture();
  try {
    const d = collectDiagnostics({
      projectsFile: f.projectsFile,
      cwd: f.ws,
      guardRegistered: true,
      upstreamPresent: true,
    });
    assert.ok(d.coexistence, "必须有 coexistence 字段");
    assert.equal(d.coexistence.detected, true);
    assert.equal(d.coexistence.hubShouldRun, true);
    assert.ok(d.coexistence.promptOwner);
    assert.ok(d.coexistence.pipelineOwner);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════
// 不重写上下文协调机制
// ══════════════════════════════════════════════════════════

test("共存：Hub 的 Registry / Resolver / Guard 责任不因共存改变", () => {
  const c = detectUpstreamConflict({ upstreamPresent: true, hubEnabled: true });
  assert.equal(c.hubKeepsRegistry, true);
  assert.equal(c.hubKeepsResolver, true);
  assert.equal(c.hubKeepsGuard, true);
});
