// dsh-wiki-guard —— 知识库写入权限守卫
//
// A 阶段：路径归一化与 workspace 匹配统一由 projects-registry.mjs 提供，
// 本文件不再保留独立实现，只做「工具参数 → 待检查路径」的提取与决策。
// 保留 normalizePath / isInside / matchWorkspace 三个导出名仅为向后兼容，
// 它们现在是共享实现的别名，不是第二份逻辑。
import { dirname, join, isAbsolute, resolve as pathResolve } from "node:path";
import {
  normPath,
  resolvePath,
  isInside,
  matchProject,
  findVaultOwner,
  loadProjects,
  isUnmappableUnc,
  detectObsidianVaultRoot,
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
 * 读取类工具 → 需检查的路径参数名。
 *
 * 空数组表示「没有路径参数，作用于整个 Vault」——`obsidian_search` 与
 * `obsidian_tags` 属于此类：它们不接受路径，但会把整个 Vault 的内容
 * 或标签全量返回。若该 Vault 属于其他项目，整次调用都必须拒绝。
 *
 * 为什么读取也要管：写入保护只防「改坏」，不防「看光」。会话属于 A 项目时
 * 直接 read 出 B 项目整个知识库，是同一类跨库越界。
 */
const READ_TOOLS = {
  read: ["file_path"],
  grep: ["path"],
  glob: ["path"],
  obsidian_read: ["path"],
  obsidian_list: ["dir"],
  obsidian_backlinks: ["path"],
  obsidian_frontmatter: ["path"],
  obsidian_search: [],      // 无路径参数：搜索范围 = 整个 Vault
  obsidian_tags: [],        // 无路径参数：枚举整个 Vault 的标签
};

/**
 * 路径语义以 Vault 根为基准的工具（全部 Obsidian 工具）。
 *
 * 为什么必须区分：这些工具的 path 参数由 dsh-obsidian 的 guardPath 解析，
 * 即 path.resolve(vaultRoot, rel)，基准是 Vault 根而非 process.cwd()。
 * 若 Guard 仍按 cwd 解析，跨库写入/读取会被判成「非知识库路径」而放行（实测可复现）。
 */
const VAULT_SCOPED_TOOLS = new Set([
  ...Object.keys(WRITE_TOOLS).filter((k) => k.startsWith("obsidian_")),
  ...Object.keys(READ_TOOLS).filter((k) => k.startsWith("obsidian_")),
]);

/** 相对路径是否试图穿越出基准目录 */
const escapesBase = (rel) => {
  if (typeof rel !== "string") return false;
  const norm = rel.replace(/\\/g, "/");
  return norm === ".." || norm.startsWith("../") || norm.includes("/../") || norm.endsWith("/..");
};

/**
 * 报告 Guard 实际保护的工具范围，读写分开。
 * 供诊断入口使用，避免诊断与实现各写一份清单而漂移。
 */
export function describeProtectedTools() {
  return {
    write: Object.keys(WRITE_TOOLS),
    read: Object.keys(READ_TOOLS),
  };
}

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

  // dsh-obsidian 的 vaultPath：用于把 obsidian_* 的相对路径解析到正确基准。
  // 未配置时留空，由 decideWithRegistry 内部自动探测（与 dsh-obsidian 同逻辑）。
  const obsidianVaultPath = config.obsidianVaultPath ? String(config.obsidianVaultPath) : "";

  ctx.tools.guard((exec) => {
    let verdict;
    try {
      verdict = useRegistry
        ? decideWithRegistry(exec, projectsFile, { obsidianVaultPath })
        : decide(exec, vaultList);
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

/** 判断是否为绝对路径（含 Windows 盘符与 UNC / \\?\ 前缀） */
const isAbsoluteTarget = (p) => {
  if (typeof p !== "string" || p.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;      // UNC 或 \\?\ 扩展前缀
  return isAbsolute(p);
};

/**
 * 用项目注册表做读写决策（每次调用重新加载，保证配置变更立即可见）。
 * 配置损坏时 fail-closed：拒绝访问任何已登记 vault。
 *
 * @param {object} exec 工具执行上下文
 * @param {string} projectsFile 注册表路径
 * @param {object} [opts]
 * @param {string} [opts.obsidianVaultPath] dsh-obsidian 配置的 vaultPath
 * @param {string} [opts.obsidianVaultRoot] 直接指定 vault 根（测试注入用）
 */
export function decideWithRegistry(exec, projectsFile, opts = {}) {
  const tool = exec && exec.name;

  const writeArgs = WRITE_TOOLS[tool];
  const readArgs = READ_TOOLS[tool];
  const isWrite = Array.isArray(writeArgs);
  const isRead = !isWrite && Array.isArray(readArgs);
  if (!isWrite && !isRead) return { action: "allow" };   // 与路径无关的工具

  const argNames = isWrite ? writeArgs : readArgs;
  const verb = isWrite ? "写入" : "读取";
  const crossCode = isWrite ? "CROSS_VAULT_WRITE" : "READ_CROSS_VAULT";

  const args = (exec && exec.arguments) || {};
  const rawTargets = argNames.map((k) => args[k]).filter((v) => typeof v === "string" && v.length > 0);

  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd : "";

  // ── Obsidian 工具的路径基准是 Vault 根，不是 process.cwd() ──
  //
  // 必须显式解析：obsidian 的 guardPath 用 path.resolve(vaultRoot, rel)，
  // 若此处仍按 cwd 解析，跨库访问会被判成「非知识库路径」而放行（实测可复现）。
  const vaultScoped = VAULT_SCOPED_TOOLS.has(tool);
  const hasRelative = rawTargets.some((t) => !isAbsoluteTarget(t));
  let obsidianRoot = null;
  if (vaultScoped && (hasRelative || rawTargets.length === 0)) {
    obsidianRoot = opts.obsidianVaultRoot
      ? resolvePath(opts.obsidianVaultRoot)
      : detectObsidianVaultRoot({ configVaultPath: opts.obsidianVaultPath });
  }

  // 预解析每个待检查目标为「绝对路径」；相对路径无法定基准时 fail-closed
  const targets = [];
  for (const rawTarget of rawTargets) {
    if (vaultScoped && !isAbsoluteTarget(rawTarget)) {
      // 相对路径试图穿越出 vault 根：真实落点不可信，直接拒绝
      if (escapesBase(rawTarget)) {
        return {
          action: "deny",
          code: "VAULT_ESCAPE",
          reason: "知识库" + verb + "被拒绝：路径「" + rawTarget + "」穿越出 Vault 根，" +
            "实际落点无法确认。请改用 Vault 内的相对路径。",
          detail: { tool, target: rawTarget, cwd: cwd || "(empty)" },
        };
      }
      if (!obsidianRoot) {
        return {
          action: "deny",
          code: "VAULT_ROOT_UNKNOWN",
          reason: "知识库" + verb + "被拒绝：无法确定 dsh-obsidian 的 Vault 根，" +
            "因此无法确认相对路径「" + rawTarget + "」的真实归属。" +
            "请在 dsh-obsidian 配置中显式设置 vaultPath，或改用绝对路径。",
          detail: { tool, target: rawTarget, cwd: cwd || "(empty)" },
        };
      }
      targets.push({ raw: rawTarget, check: pathResolve(obsidianRoot, rawTarget) });
      continue;
    }
    targets.push({ raw: rawTarget, check: rawTarget });
  }

  // 无路径参数但作用于整个 Vault 的工具（obsidian_search / obsidian_tags）：
  // 检查目标就是这个 Vault 根本身。
  if (vaultScoped && targets.length === 0) {
    if (!obsidianRoot) {
      return {
        action: "deny",
        code: "VAULT_ROOT_UNKNOWN",
        reason: "知识库" + verb + "被拒绝：无法确定 dsh-obsidian 的 Vault 根，" +
          "因此无法确认「" + tool + "」的作用范围。请显式设置 vaultPath。",
        detail: { tool, target: "(whole vault)", cwd: cwd || "(empty)" },
      };
    }
    targets.push({ raw: "(whole vault)", check: obsidianRoot });
  }

  const reg = loadProjects({ projectsFile });

  // 配置无效：fail-closed —— 只对「已登记 vault 的访问」拒绝，其他路径不受影响
  if (!reg.ok) {
    const known = reg.lastGood || [];
    for (const { raw, check } of targets) {
      const owner = findVaultOwner(check, known);
      if (owner) {
        return {
          action: "deny",
          code: "REGISTRY_INVALID",
          reason: "知识库" + verb + "被拒绝：项目注册表无效（" + (reg.error || "未知错误") +
            "），无法确认「" + raw + "」的归属。请修复 " + projectsFile,
          detail: { tool, target: raw, owner: owner.id, error: reg.error },
        };
      }
    }
    return { action: "allow" };   // 不涉及已登记 vault，保持原行为
  }

  const projects = reg.projects;
  const current = matchProject(cwd, projects);

  for (const { raw: rawTarget, check } of targets) {
    // UNC fail-closed：无法映射到盘符的 UNC 路径，其真实归属不可判定。
    // 实测 `\\localhost\K$\...` 可真实写入受保护 vault，因此宁可拒绝。
    if (isUnmappableUnc(check)) {
      return {
        action: "deny",
        code: "UNC_UNMAPPABLE",
        reason: "知识库" + verb + "被拒绝：UNC 路径「" + rawTarget + "」无法映射到本地盘符，" +
          "无法确认其归属。请改用盘符路径（如 K:\\...）重试。",
        detail: { tool, target: rawTarget, cwd: cwd || "(empty)" },
      };
    }

    const owner = findVaultOwner(check, projects);
    if (!owner) continue;        // 不属于任何知识库，保持原有行为

    if (!current) {
      return {
        action: "deny",
        code: "UNREGISTERED_WORKSPACE",
        reason: "知识库" + verb + "被拒绝：当前工作区未登记任何项目（目标：" + rawTarget + "）",
        detail: { tool, target: rawTarget, owner: owner.id, cwd: cwd || "(empty)" },
      };
    }

    if (owner.id !== current.id) {
      return {
        action: "deny",
        code: crossCode,
        reason: "跨库" + verb + "被拒绝：目标属于项目「" + owner.name + "」，当前会话属于「" +
          current.name + "」。如需操作其他项目，请切换工作区开新会话。",
        detail: { tool, target: rawTarget, owner: owner.id, current: current.id, cwd: cwd || "(empty)" },
      };
    }

    // 只读项目：禁止写入，但允许读取（readonly 的语义是「不许改」）
    if (isWrite && current.status === "readonly") {
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
