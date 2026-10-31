// dsh-wiki-guard —— 知识库写入权限守卫
//
// A 阶段：路径归一化与 workspace 匹配统一由 projects-registry.mjs 提供，
// 本文件不再保留独立实现，只做「工具参数 → 待检查路径」的提取与决策。
// 保留 normalizePath / isInside / matchWorkspace 三个导出名仅为向后兼容，
// 它们现在是共享实现的别名，不是第二份逻辑。
import { dirname, join } from "node:path";
import {
  normPath,
  resolvePath,
  isInside,
  matchProject,
  findVaultOwner,
  loadProjects,
  isUnmappableUnc,
} from "./projects-registry.mjs";

/** 写入类工具 → 需检查的路径参数名 */
const WRITE_TOOLS = {
  write: ["file_path"],
  edit: ["file_path"],
  obsidian_write: ["path"],
  obsidian_append: ["path"],
  obsidian_move: ["from", "to"],
  obsidian_delete: ["path"],
  obsidian_set_property: ["path"],
};

/**
 * 规范化「写入目标」：解析符号链接（共享实现）。
 * 保留原名导出，供既有测试与调用方使用。
 */
export const normalizePath = resolvePath;

/** target 是否位于 root 内（含相等，共享实现） */
export { isInside };

/** cwd 属于哪个工作区（嵌套取最具体，共享实现） */
export const matchWorkspace = matchProject;

/** 写入权限决策 */
export function decide(exec, vaultList) {
  const tool = exec && exec.name;
  const argNames = WRITE_TOOLS[tool];
  if (!argNames) return { action: "allow" };

  const args = (exec && exec.arguments) || {};
  const targets = argNames
    .map((k) => args[k])
    .filter((v) => typeof v === "string" && v.length > 0);
  if (targets.length === 0) return { action: "allow" };

  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : "";
  const allowed = matchWorkspace(cwd, vaultList);

  for (const rawTarget of targets) {
    const target = normalizePath(rawTarget);
    if (!target) continue;

    let owner = null, ownerLen = -1;
    for (const v of vaultList) {
      const root = normalizePath(v.vault);
      if (!root) continue;
      if (isInside(target, root) && root.length > ownerLen) { owner = v; ownerLen = root.length; }
    }

    if (!owner) continue;   // 不属于任何知识库，保持原有行为

    if (!allowed) {
      return {
        action: "deny",
        code: "UNREGISTERED_WORKSPACE",
        reason: "知识库写入被拒绝：当前工作区未登记任何知识库（目标：" + rawTarget + "）",
        detail: { tool, target: rawTarget, owner: owner.name },
      };
    }

    if (owner.vault !== allowed.vault) {
      return {
        action: "deny",
        code: "CROSS_VAULT_WRITE",
        reason: "跨库写入被拒绝：目标属于「" + (owner.name || owner.vault) +
          "」，当前会话属于「" + (allowed.name || allowed.vault) + "」",
        detail: { tool, target: rawTarget, owner: owner.name, current: allowed.name },
      };
    }
  }

  return { action: "allow" };
}
// ── 插件入口：注册到 DSH 的工具守卫 ──
// 需要日志与配置读取
import { existsSync, appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), ".dsh");
const DEFAULT_LOG = join(DSH_HOME, "llm-wiki", "guard.log");

export const name = "dsh-wiki-guard";

// 声明本插件依赖的 DSH 服务。Cordis 会在依赖就绪后才调用 apply()，
// 因此 ctx.tools 在这里保证可用（对照 dsh-obsidian 的 inject = ["tools","agents"]）。
export const inject = ["tools"];

export function apply(ctx, config = {}) {
  // 优先用统一注册表；保留 vaults 数组仅为向后兼容
  const projectsFile = config.projectsFile ? String(config.projectsFile) : "";
  const legacyVaults = Array.isArray(config.vaults)
    ? config.vaults.filter((v) => v && v.vault && v.workspace)
        .map((v) => ({ vault: String(v.vault), workspace: String(v.workspace), name: v.name ? String(v.name) : "" }))
    : [];
  const useRegistry = projectsFile.length > 0;
  const vaultList = legacyVaults;

  const dryRun = config.dryRun === true;
  const LOG = config.logFile ? String(config.logFile) : DEFAULT_LOG;

  const log = (msg) => {
    const line = "[wiki-guard] " + new Date().toISOString() + " pid=" + process.pid + " " + msg;
    try { console.log(line); } catch {}
    try {
      mkdirSync(dirname(LOG), { recursive: true });
      try { if (statSync(LOG).size > 512 * 1024) writeFileSync(LOG, "", "utf8"); } catch {}
      appendFileSync(LOG, line + "\n", "utf8");
    } catch {}
  };

  if (useRegistry) {
    const reg = loadProjects({ projectsFile });
    log("apply() registry=" + projectsFile + " ok=" + reg.ok +
      " projects=" + (reg.ok ? reg.projects.map((p) => p.id + "(" + p.status + ")").join(",") : "(无效: " + reg.error + ")") +
      " dryRun=" + dryRun);
  } else {
    log("apply() legacy vaults=" + vaultList.map((v) => v.name || v.vault).join(",") +
      " dryRun=" + dryRun + " tools=" + Object.keys(WRITE_TOOLS).join("/"));
  }

  if (!useRegistry && vaultList.length === 0) {
    log("未配置 projectsFile 也未配置 vaults，guard 不生效");
    return;
  }

  if (!useRegistry) {
    for (const v of vaultList) {
      if (!existsSync(v.vault)) log("WARN vault 不存在: " + v.vault);
      if (!existsSync(v.workspace)) log("WARN workspace 不存在: " + v.workspace);
    }
  }

  ctx.tools.guard((exec) => {
    let verdict;
    try {
      verdict = useRegistry ? decideWithRegistry(exec, projectsFile) : decide(exec, vaultList);
    } catch (e) {
      // fail-closed：守卫自身异常时按拒绝处理，绝不放行
      log("ERROR 守卫异常，按拒绝处理: " + e.message);
      return "知识库写入被拒绝：守卫内部错误（" + e.message + "）";
    }

    if (verdict.action === "allow") return;

    const d = verdict.detail || {};
    log("DENY [" + verdict.code + "] tool=" + d.tool + " target=" + d.target +
      " owner=" + d.owner + " current=" + (d.current || "-") +
      (dryRun ? "  (dryRun: 仅记录)" : ""));

    if (dryRun) return;
    return verdict.reason;
  });

  log("guard 已注册");
}

// ── 注册表驱动：动态加载 + 权限决策 ──

/**
 * 用项目注册表做写入决策（每次调用重新加载，保证配置变更立即可见）。
 * 配置损坏时 fail-closed：拒绝写入任何已登记 vault。
 */
export function decideWithRegistry(exec, projectsFile) {
  const tool = exec && exec.name;
  const argNames = WRITE_TOOLS[tool];
  if (!argNames) return { action: "allow" };          // 非写入工具

  const args = (exec && exec.arguments) || {};
  const targets = argNames.map((k) => args[k]).filter((v) => typeof v === "string" && v.length > 0);
  if (targets.length === 0) return { action: "allow" };

  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd : "";

  const reg = loadProjects({ projectsFile });

  // 配置无效：fail-closed —— 只对「已登记 vault 的写入」拒绝，其他路径不受影响
  if (!reg.ok) {
    const known = reg.lastGood || [];
    for (const rawTarget of targets) {
      const t = normalizePath(rawTarget);
      if (!t) continue;
      const owner = findVaultOwner(rawTarget, known);
      if (owner) {
        return {
          action: "deny",
          code: "REGISTRY_INVALID",
          reason: "知识库写入被拒绝：项目注册表无效（" + (reg.error || "未知错误") +
            "），无法确认「" + rawTarget + "」的归属。请修复 " + projectsFile,
          detail: { tool, target: rawTarget, owner: owner.id, error: reg.error },
        };
      }
    }
    return { action: "allow" };   // 不涉及已登记 vault，保持原行为
  }

  const projects = reg.projects;
  const current = matchProject(cwd, projects);

  for (const rawTarget of targets) {
    // UNC fail-closed：无法映射到盘符的 UNC 路径，其真实归属不可判定。
    // 实测 `\\localhost\K$\...` 可真实写入受保护 vault，因此宁可拒绝。
    if (isUnmappableUnc(rawTarget)) {
      return {
        action: "deny",
        code: "UNC_UNMAPPABLE",
        reason: "知识库写入被拒绝：UNC 路径「" + rawTarget + "」无法映射到本地盘符，" +
          "无法确认其归属。请改用盘符路径（如 K:\\...）重试。",
        detail: { tool, target: rawTarget, cwd: cwd || "(empty)" },
      };
    }

    const owner = findVaultOwner(rawTarget, projects);
    if (!owner) continue;        // 不属于任何知识库，保持原有行为

    if (!current) {
      return {
        action: "deny",
        code: "UNREGISTERED_WORKSPACE",
        reason: "知识库写入被拒绝：当前工作区未登记任何项目（目标：" + rawTarget + "）",
        detail: { tool, target: rawTarget, owner: owner.id, cwd: cwd || "(empty)" },
      };
    }

    if (owner.id !== current.id) {
      return {
        action: "deny",
        code: "CROSS_VAULT_WRITE",
        reason: "跨库写入被拒绝：目标属于项目「" + owner.name + "」，当前会话属于「" +
          current.name + "」。如需操作其他项目，请切换工作区开新会话。",
        detail: { tool, target: rawTarget, owner: owner.id, current: current.id, cwd: cwd || "(empty)" },
      };
    }

    if (current.status === "readonly") {
      return {
        action: "deny",
        code: "READONLY_PROJECT",
        reason: "项目「" + current.name + "」为只读状态，禁止写入（目标：" + rawTarget + "）",
        detail: { tool, target: rawTarget, owner: owner.id, status: current.status },
      };
    }
  }

  return { action: "allow" };
}
