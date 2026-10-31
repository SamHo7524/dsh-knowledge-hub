// projects-registry —— DSH 多项目唯一注册表
// 职责：加载 / 校验 / 匹配 / 路径归一化。Prompt 层与 Guard 层共用本模块，
// 避免「配置漂移」与「路径语义漂移」两种分裂。
import {
  readFileSync, statSync, existsSync, realpathSync, writeFileSync, mkdirSync, unlinkSync,
  openSync, closeSync, fsyncSync, renameSync,
} from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname, basename, join } from "node:path";

export const REGISTRY_VERSION = 1;
export const VALID_STATUS = ["active", "readonly", "disabled"];

// ── 配置缓存：按 mtime+size 失效，避免每轮重复读盘，同时保证变更立即可见 ──
let cache = { key: "", projects: [], lastGood: [] };

const fileKey = (f) => {
  try { const st = statSync(f); return f + "|" + st.mtimeMs + "|" + st.size; } catch { return ""; }
};

// ── last-good 快照：持久化上一次成功加载的注册表 ──
//
// 为什么需要落盘：fail-closed 依赖 lastGood 判断「这个目标是否受保护」。
// 若只在内存里，进程重启后缓存为空，配置恰好损坏时 Guard 无从判断归属，
// 会静默放行——而这正是最危险的时机（配置刚被改坏、进程刚启动）。
const snapshotPath = (projectsFile) => projectsFile + ".lastgood";

const readSnapshot = (projectsFile) => {
  try {
    const raw = JSON.parse(readFileSync(snapshotPath(projectsFile), "utf8"));
    const v = validateProjects(raw);
    return v.ok ? v.projects : [];
  } catch { return []; }
};

/**
 * 原子写入快照：先写临时文件，fsync 后 rename 替换。
 *
 * 为什么必须原子：直接 writeFileSync 在进程中断/断电时可能留下半截文件，
 * 下次冷启动读到的就是损坏快照 → fail-closed 判断依据失效。
 * rename 在同一文件系统内是原子的，读侧要么看到旧内容、要么看到新内容。
 */
const writeSnapshot = (projectsFile, projects) => {
  const target = snapshotPath(projectsFile);
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
  try {
    mkdirSync(dirname(target), { recursive: true });
    const body = JSON.stringify({ version: REGISTRY_VERSION, projects });
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, body, "utf8");
      try { fsyncSync(fd); } catch { /* 部分文件系统不支持，忽略 */ }
    } finally { closeSync(fd); }
    renameSync(tmp, target);          // 原子替换
  } catch {
    // 快照写失败不影响主流程；清理可能残留的临时文件
    try { unlinkSync(tmp); } catch { /* 无残留则忽略 */ }
  }
};


/**
 * 剥离 Windows 扩展长度路径前缀。
 *
 * `\\?\H:\V\a\x.md` 与 `H:\V\a\x.md` 指向同一文件，但 Node 的 resolve()
 * 不会把前者规范化成后者。若原样比较，经扩展前缀写入受保护 vault 会被判为
 * 「非知识库路径」而放行——实测可真实落盘，是与 junction 同级的跨库绕过。
 *
 * 三种形式：
 *   \\?\H:\path        → H:\path
 *   \\?\UNC\server\share\path → \\server\share\path
 *   \\?\Volume{...}\   → 保持原样（无法映射到盘符，交由后续比较处理）
 */
const stripExtendedPrefix = (p) => {
  if (typeof p !== "string") return p;
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice(8);
  if (p.startsWith("\\\\?\\")) {
    const rest = p.slice(4);
    // 仅剥离「盘符:」或 UNC 形式；Volume GUID 等无法映射的保持原样
    if (/^[A-Za-z]:[\\/]/.test(rest) || rest.startsWith("\\\\")) return rest;
  }
  return p;
};

/**
 * 是否为「无法映射到本地盘符」的 UNC 路径。
 *
 * 为什么需要单独识别：`\\localhost\K$\Temp\x` 与 `K:\Temp\x` 是同一位置，
 * 但纯字符串运算无法把「机器名 + 共享名」还原成盘符（共享名不一定是 `K$`，
 * 也可能是用户自建共享指向任意子目录）。实测该写法可真实写入受保护 vault，
 * 而 Guard 判为「非知识库路径」放行。
 *
 * 处置：fail-closed —— 无法确认归属的 UNC 一律拒绝写入知识库场景。
 * 代价：真实的网络共享写入会被拒绝。这是刻意的取舍：
 * 宁可误伤共享写入，也不能让跨库保护留一个可用的绕过口。
 */
const isUnmappableUnc = (p) => {
  if (typeof p !== "string") return false;
  const bare = stripExtendedPrefix(p);
  // \\server\share\... 形式（排除已剥离的 \\?\ 前缀）
  return bare.startsWith("\\\\") && !bare.startsWith("\\\\?\\");
};

export const UNC_UNMAPPABLE_CODE = "UNC_UNMAPPABLE";

/** 归一化路径用于比较（小写，解析 ..，统一分隔符）。不解析符号链接。 */
const norm = (p) => {
  try { return resolve(stripExtendedPrefix(String(p))).toLowerCase(); } catch { return ""; }
};

/**
 * 归一化「字面路径」：解析 .. / 大小写 / 分隔符，**不解析符号链接**。
 * 用于 cwd 这类必然已存在、且不应被链接语义改写的路径。
 */
export function normPath(p) {
  if (!p || typeof p !== "string") return null;
  return norm(p) || null;
}

/**
 * 归一化「写入目标」：在 normPath 基础上解析已存在祖先的符号链接。
 * 目标文件可能尚不存在，因此向上找最近已存在祖先再拼回剩余段。
 *
 * 为什么必须解析符号链接：否则「指向他库的 junction」会被判为非知识库路径，
 * 跨库保护被整体绕过。
 */
export function resolvePath(p) {
  if (!p || typeof p !== "string") return null;
  let abs;
  // 必须先剥离 \\?\ 前缀：否则 resolve() 会保留它，realpath 与比较都失效
  try { abs = resolve(stripExtendedPrefix(p)); } catch { return null; }

  const tail = [];
  let cursor = abs;
  for (let i = 0; i < 64; i++) {
    if (existsSync(cursor)) {
      try { cursor = realpathSync(cursor); } catch { /* 解析失败则用原串 */ }
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(basename(cursor));
    cursor = parent;
  }

  const joined = tail.length ? join(cursor, ...tail) : cursor;
  return joined.toLowerCase();
}

/** a 是否位于 b 之内（含相等）。两侧须已归一化。 */
export function isInside(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const rel = relative(b, a);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/**
 * 校验注册表结构。返回 { ok, projects, errors }。
 * 校验项：版本、必填字段、status 合法性、id 唯一、workspace 唯一、vault 唯一/不重叠。
 */
export function validateProjects(raw) {
  const errors = [];

  if (!raw || typeof raw !== "object") {
    return { ok: false, projects: [], errors: ["配置不是对象"] };
  }
  if (raw.version !== REGISTRY_VERSION) {
    errors.push("version 必须为 " + REGISTRY_VERSION + "（实际：" + raw.version + "）");
  }
  if (!Array.isArray(raw.projects)) {
    errors.push("projects 必须是数组");
    return { ok: false, projects: [], errors };
  }

  const out = [];
  const seenId = new Set();
  const seenWs = new Map();
  const seenVault = new Map();

  for (let i = 0; i < raw.projects.length; i++) {
    const p = raw.projects[i] || {};
    const at = "projects[" + i + "]";

    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) { errors.push(at + ": 缺 id"); continue; }
    if (seenId.has(id)) { errors.push(at + ": id 重复 \"" + id + "\""); continue; }
    seenId.add(id);

    const status = p.status === undefined ? "active" : String(p.status);
    if (!VALID_STATUS.includes(status)) {
      errors.push(at + ": status 非法 \"" + status + "\"（允许：" + VALID_STATUS.join("/") + "）");
      continue;
    }

    if (typeof p.workspace !== "string" || !p.workspace.trim()) {
      errors.push(at + ": 缺 workspace");
      continue;
    }
    if (typeof p.vault !== "string" || !p.vault.trim()) {
      errors.push(at + ": 缺 vault");
      continue;
    }

    const ws = norm(p.workspace);
    const vt = norm(p.vault);

    // workspace 唯一
    if (seenWs.has(ws)) {
      errors.push(at + ": workspace 重复（与 \"" + seenWs.get(ws) + "\" 相同）");
      continue;
    }
    seenWs.set(ws, id);

    // vault 唯一 / 不重叠
    for (const [otherVt, otherId] of seenVault) {
      if (vt === otherVt) {
        errors.push(at + ": vault 与 \"" + otherId + "\" 相同");
      } else if (isInside(vt, otherVt) || isInside(otherVt, vt)) {
        errors.push(at + ": vault 与 \"" + otherId + "\" 重叠（嵌套目录）");
      }
    }
    seenVault.set(vt, id);

    out.push({
      id,
      name: p.name ? String(p.name) : id,
      status,
      workspace: String(p.workspace),
      vault: String(p.vault),
      state: p.state ? String(p.state) : "",
    });
  }

  return { ok: errors.length === 0, projects: errors.length === 0 ? out : [], errors };
}

/**
 * 动态加载注册表。按文件 mtime+size 失效缓存，保证配置变更立即可见。
 * 校验失败时返回 ok:false 并带上 lastGood（Guard 用它做 fail-closed 判断）。
 *
 * lastGood 优先取内存缓存；冷启动（进程刚起）时回退到落盘快照，
 * 否则重启后配置恰好损坏会导致 Guard 无从判断归属而静默放行。
 */
export function loadProjects({ projectsFile } = {}) {
  if (!projectsFile) {
    return { ok: false, projects: [], lastGood: cache.lastGood, error: "未配置 projectsFile" };
  }

  const key = fileKey(projectsFile);
  if (key && key === cache.key) {
    return { ok: true, projects: cache.projects, lastGood: cache.lastGood };
  }

  // 失败路径统一走这里：内存 lastGood → 落盘快照
  const lastGoodOf = () => {
    if (cache.lastGood.length > 0) return cache.lastGood;
    const snap = readSnapshot(projectsFile);
    if (snap.length > 0) cache = { ...cache, lastGood: snap };
    return snap;
  };

  let raw;
  try {
    raw = JSON.parse(readFileSync(projectsFile, "utf8"));
  } catch (e) {
    return { ok: false, projects: [], lastGood: lastGoodOf(), error: "读取/解析失败: " + e.message };
  }

  const v = validateProjects(raw);
  if (!v.ok) {
    return { ok: false, projects: [], lastGood: lastGoodOf(), error: v.errors.join("; ") };
  }

  cache = { key, projects: v.projects, lastGood: v.projects };
  writeSnapshot(projectsFile, v.projects);
  return { ok: true, projects: v.projects, lastGood: v.projects };
}

/** 仅测试用：清空内存缓存（落盘快照保留，用于模拟进程重启） */
export function __clearCache() { cache = { key: "", projects: [], lastGood: [] }; }

/** cwd 属于哪个项目（disabled 不参与匹配，嵌套取最具体） */
export function matchProject(cwd, projects) {
  if (!cwd || typeof cwd !== "string") return null;
  const current = norm(cwd);
  if (!current) return null;

  let best = null, bestLen = -1;
  for (const p of projects) {
    if (p.status === "disabled") continue;
    const ws = norm(p.workspace);
    if (!ws) continue;
    if (isInside(current, ws) && ws.length > bestLen) { best = p; bestLen = ws.length; }
  }
  return best;
}

/**
 * 路径属于哪个项目的 vault（含 disabled，用于 fail-closed 识别）。
 *
 * 目标侧与 vault 侧都用 resolvePath（解析符号链接），两侧归一化形态必须一致：
 *   - 目标侧不解析 → 「指向他库的 junction」被判为非知识库路径，跨库保护被绕过
 *   - vault 侧不解析 → vault 配成链接路径时，写自己库被判成「非知识库路径」放行
 * 两种情况都是「该保护时放行」，因此两侧统一解析。
 *
 * UNC 特例：无法映射到盘符的 UNC 路径，其真实归属无法判定，返回 sentinel
 * 让调用方 fail-closed（详见 guard 的 UNC_UNMAPPABLE 分支）。
 */
export function findVaultOwner(targetPath, projects) {
  if (!targetPath || typeof targetPath !== "string") return null;
  if (isUnmappableUnc(targetPath)) return null;   // 归属不可判定，由调用方 fail-closed

  const t = resolvePath(targetPath);
  if (!t) return null;

  let best = null, bestLen = -1;
  for (const p of projects) {
    const vt = resolvePath(p.vault);
    if (!vt) continue;
    if (isInside(t, vt) && vt.length > bestLen) { best = p; bestLen = vt.length; }
  }
  return best;
}

/** 导出给 guard 判断是否需要 fail-closed */
export { isUnmappableUnc };

/**
 * 探测 dsh-obsidian 实际使用的 Vault 根。
 *
 * 为什么 Guard 必须知道这个：`obsidian_*` 工具的 path 参数是「相对 Vault 根」
 * 的路径（见 dsh-obsidian 的 guardPath: path.resolve(vaultRoot, rel)），
 * 而 Guard 的 resolvePath 基于 process.cwd()。两者语义不同 →
 * 「obsidian_write({path:"x.md"})」会被判成 cwd 下的非知识库路径而放行，
 * 实际却写进了他库 Vault。实测确有此绕过。
 *
 * 解析顺序与 dsh-obsidian 的 resolveVaultRoot 保持一致：
 *   1. 显式配置的 vaultPath（最高优先，与插件一致）
 *   2. Obsidian 应用配置里「当前打开的 vault」→ 自动探测
 * 两者都拿不到时返回 null，由调用方 fail-closed。
 *
 * @param {object} opts
 * @param {string} [opts.configVaultPath] dsh-obsidian 的 vaultPath 配置
 * @returns {string|null} 归一化后的 vault 根（小写、已解析符号链接），或 null
 */
export function detectObsidianVaultRoot({ configVaultPath } = {}) {
  if (configVaultPath && typeof configVaultPath === "string" && configVaultPath.trim()) {
    return resolvePath(configVaultPath) || null;
  }

  // 与 dsh-obsidian 的 appConfigCandidates 保持同一候选顺序
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appData = process.env.APPDATA || "";
  const candidates = [];
  if (process.platform === "win32") {
    if (appData) candidates.push(join(appData, "obsidian", "obsidian.json"));
    if (home) {
      candidates.push(join(home, ".config", "obsidian", "obsidian.json"));
      candidates.push(join(home, "Library", "Application Support", "obsidian", "obsidian.json"));
    }
  } else if (process.platform === "darwin") {
    if (home) candidates.push(join(home, "Library", "Application Support", "obsidian", "obsidian.json"));
    if (appData) candidates.push(join(appData, "obsidian", "obsidian.json"));
    if (home) candidates.push(join(home, ".config", "obsidian", "obsidian.json"));
  } else {
    if (home) candidates.push(join(home, ".config", "obsidian", "obsidian.json"));
    if (appData) candidates.push(join(appData, "obsidian", "obsidian.json"));
    if (home) candidates.push(join(home, "Library", "Application Support", "obsidian", "obsidian.json"));
  }

  for (const file of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const entries = Object.values(cfg.vaults || {});
      // 与 dsh-obsidian 相同：优先「当前打开的」，否则取第一个
      const found = entries.find((v) => v && v.open) || entries[0];
      if (found && typeof found.path === "string" && found.path.trim()) {
        const resolved = resolvePath(found.path);
        if (resolved) return resolved;
      }
    } catch { /* 该候选不可用，继续下一个 */ }
  }
  return null;
}