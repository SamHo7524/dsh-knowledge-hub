// diagnostics —— 知识库运行状态统一诊断
//
// 设计原则：
//   1. 只读：不做任何副作用操作（不写文件、不改配置、不触发同步）
//   2. 诚实：取不到的信息一律标 "unknown"，绝不伪造成 success
//   3. 纯函数：collectDiagnostics 不依赖 DSH 运行时，可独立测试
//
// 为什么需要它：配置是否生效、Guard 是否真的在保护、Pipeline 是否可用，
// 过去要靠翻 plugin.log / guard.log / 试写文件才能判断，分散且容易误判。
import { existsSync, statSync } from "node:fs";
import { matchProject, loadProjects } from "./projects-registry.mjs";
import { describeProtectedTools } from "./guard.mjs";
import { detectUpstreamConflict, formatCoexistence } from "./coexistence.mjs";

const UNKNOWN = "unknown";

/**
 * 收集诊断信息。全部为只读操作。
 *
 * @param {object} opts
 * @param {string} opts.projectsFile 注册表路径
 * @param {string} [opts.cwd] 当前工作目录（默认 process.cwd()）
 * @param {boolean} [opts.guardRegistered] Guard 是否已注册（由 apply() 传入）
 * @param {object} [opts.pipeline] Pipeline 状态
 * @param {boolean} [opts.upstreamPresent] 是否检测到上游 dsh-llm-wiki
 * @param {string} [opts.obsidianVaultPath] dsh-obsidian 配置的 vaultPath
 * @returns {object} 结构化诊断结果
 */
export function collectDiagnostics(opts = {}) {
  const {
    projectsFile = "",
    cwd = process.cwd(),
    guardRegistered = false,
    pipeline = null,
    upstreamPresent = false,
    obsidianVaultPath = "",
  } = opts;

  const warnings = [];

  // ── 注册表 ──
  const reg = loadProjects({ projectsFile });
  const registry = {
    path: projectsFile || "(未配置)",
    ok: reg.ok === true,
    projectCount: reg.ok ? reg.projects.length : 0,
    error: reg.ok ? null : (reg.error || "未知错误"),
    lastGoodCount: (reg.lastGood || []).length,
  };
  if (!registry.ok) {
    warnings.push("注册表无效：" + registry.error + "。此时任何已登记 Vault 的访问都会被拒绝（fail-closed）。");
  }

  // ── 当前项目 ──
  const projects = reg.ok ? reg.projects : [];
  const current = matchProject(cwd, projects);
  const cwdInfo = {
    path: cwd,
    projectId: current ? current.id : null,
    projectName: current ? current.name : null,
    status: current ? current.status : null,
    note: current
      ? "已匹配项目「" + current.name + "」（" + current.status + "）"
      : "当前工作区未登记任何项目 —— 知识库访问将被拒绝",
  };
  if (!current && registry.ok) {
    warnings.push("当前 cwd 未匹配任何已登记项目，知识库读写都会被拒绝。");
  }

  // ── 各 Vault 状态 ──
  const vaults = projects.map((p) => {
    let exists = false;
    let isDir = false;
    try {
      exists = existsSync(p.vault);
      isDir = exists ? statSync(p.vault).isDirectory() : false;
    } catch { /* 视为不可访问 */ }
    const isCurrent = current ? current.id === p.id : false;
    return {
      id: p.id,
      name: p.name,
      path: p.vault,
      status: p.status,
      exists,
      isDirectory: isDir,
      isCurrent,
    };
  });
  for (const v of vaults) {
    if (!v.exists) warnings.push("项目「" + v.name + "」的 Vault 路径不存在：" + v.path);
    else if (!v.isDirectory) warnings.push("项目「" + v.name + "」的 Vault 路径不是目录：" + v.path);
  }

  // ── Guard ──
  const protectedTools = describeProtectedTools();
  const guard = {
    registered: guardRegistered === true,
    writeTools: protectedTools.write,
    readTools: protectedTools.read,
    readOnlyProjects: projects.filter((p) => p.status === "readonly").map((p) => p.id),
  };
  if (!guard.registered) {
    warnings.push("Guard 未注册 —— 跨项目读写隔离当前不生效。检查 wiki-guard entry 是否被 disabled。");
  }

  // ── Pipeline ──
  let pipelineInfo;
  if (pipeline && typeof pipeline === "object") {
    pipelineInfo = {
      available: pipeline.available === true,
      scriptPath: pipeline.scriptPath || UNKNOWN,
      lastSyncStatus: pipeline.lastSyncStatus || UNKNOWN,
      lastSyncAt: pipeline.lastSyncAt || UNKNOWN,
      note: pipeline.note || "",
    };
  } else {
    pipelineInfo = {
      available: UNKNOWN,
      scriptPath: UNKNOWN,
      lastSyncStatus: UNKNOWN,
      lastSyncAt: UNKNOWN,
      note: "未提供 Pipeline 状态 —— 无法判断同步是否正常（不伪造成功状态）",
    };
  }
  if (pipelineInfo.lastSyncStatus === UNKNOWN) {
    warnings.push("Pipeline 最近一次同步状态未知 —— 不要假定知识库已同步。");
  }

  // ── 上游共存 ──
  const coexistence = detectUpstreamConflict({ upstreamPresent, hubEnabled: true });
  const upstream = {
    present: upstreamPresent === true,
    note: upstreamPresent
      ? "检测到上游 dsh-llm-wiki 与本插件共存"
      : "未检测到上游 dsh-llm-wiki",
  };
  if (upstreamPresent) {
    warnings.push(
      "检测到上游 dsh-llm-wiki 共存 —— Prompt 注入与管线同步都可能重复执行。" +
      coexistence.recommendation
    );
  }

  // ── dsh-obsidian 关联 ──
  const obsidian = {
    vaultPath: obsidianVaultPath || "(未显式配置，使用自动探测)",
  };

  return {
    generatedAt: new Date().toISOString(),
    registry,
    cwd: cwdInfo,
    vaults,
    guard,
    pipeline: pipelineInfo,
    upstream,
    coexistence,
    obsidian,
    warnings,
  };
}

/**
 * 把诊断结果渲染成便于人阅读的中文文本。
 * @param {object} d collectDiagnostics 的返回值
 * @returns {string}
 */
export function formatDiagnostics(d) {
  const L = [];
  const mark = (ok) => (ok ? "✅" : "❌");
  const unknownMark = (v) => (v === UNKNOWN ? "❓" : mark(true));

  L.push("=== dsh-knowledge-hub 诊断 ===");
  L.push("生成时间: " + d.generatedAt);
  L.push("");

  // 注册表
  L.push("[注册表]");
  L.push("  " + mark(d.registry.ok) + " 状态: " + (d.registry.ok ? "有效" : "无效"));
  L.push("  路径: " + d.registry.path);
  L.push("  项目数: " + d.registry.projectCount);
  if (!d.registry.ok) {
    L.push("  错误: " + d.registry.error);
    L.push("  上次可用项目数: " + d.registry.lastGoodCount);
  }
  L.push("");

  // 当前项目
  L.push("[当前项目]");
  L.push("  cwd: " + d.cwd.path);
  if (d.cwd.projectId) {
    L.push("  " + mark(true) + " 匹配: " + d.cwd.projectName + " (" + d.cwd.projectId + ", " + d.cwd.status + ")");
  } else {
    L.push("  " + mark(false) + " " + d.cwd.note);
  }
  L.push("");

  // Vault
  L.push("[Vault]");
  if (d.vaults.length === 0) {
    L.push("  (无可列出的项目)");
  } else {
    for (const v of d.vaults) {
      const tag = v.isCurrent ? " ← 当前" : "";
      L.push("  " + mark(v.exists && v.isDirectory) + " " + v.name + " (" + v.id + ", " + v.status + ")" + tag);
      L.push("      " + v.path);
    }
  }
  L.push("");

  // Guard
  L.push("[Guard]");
  L.push("  " + mark(d.guard.registered) + " 注册状态: " + (d.guard.registered ? "已注册" : "未注册"));
  L.push("  写入保护: " + (d.guard.writeTools.length ? d.guard.writeTools.join(", ") : "(无)"));
  L.push("  读取保护: " + (d.guard.readTools.length ? d.guard.readTools.join(", ") : "(无)"));
  if (d.guard.readOnlyProjects.length) {
    L.push("  只读项目: " + d.guard.readOnlyProjects.join(", "));
  }
  L.push("");

  // Pipeline
  L.push("[Pipeline]");
  L.push("  " + unknownMark(d.pipeline.available) + " 可用性: " + d.pipeline.available);
  L.push("  脚本: " + d.pipeline.scriptPath);
  L.push("  " + unknownMark(d.pipeline.lastSyncStatus) + " 最近同步: " + d.pipeline.lastSyncStatus +
    (d.pipeline.lastSyncAt !== UNKNOWN ? " (" + d.pipeline.lastSyncAt + ")" : ""));
  if (d.pipeline.note) L.push("  说明: " + d.pipeline.note);
  L.push("");

  // 上游
  L.push("[上游共存]");
  if (d.coexistence) {
    for (const line of formatCoexistence(d.coexistence)) L.push(line);
  } else {
    L.push("  " + (d.upstream.present ? "⚠️ " : mark(true) + " ") + d.upstream.note);
  }
  L.push("");

  // dsh-obsidian
  L.push("[dsh-obsidian]");
  L.push("  Vault 配置: " + d.obsidian.vaultPath);
  L.push("");

  // 告警
  if (d.warnings.length === 0) {
    L.push("✅ 未发现告警。");
  } else {
    L.push("⚠️ 告警 (" + d.warnings.length + "):");
    d.warnings.forEach((w, i) => L.push("  " + (i + 1) + ". " + w));
  }

  return L.join("\n");
}
