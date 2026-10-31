/**
 * dsh-llm-wiki.mjs —— LLM-Wiki 生命周期插件（多项目版 v2：cwd 直接匹配）
 *
 * profile 本地文件插件，但实际由包内 dsh-llm-wiki 的 bundle 加载
 * （package.json 的 dsh.profile.bundles 含 dsh-llm-wiki，bundle 层先 insert
 *   id: llm-wiki / name: dsh-llm-wiki；cordis.patch.yml 里同 id 只能覆盖 config，
 *   不能改 name。因此本文件必须覆盖到包内 plugin/dsh-llm-wiki.mjs 才生效）。
 * 零外部依赖（不 import dsh-tools；只用 node 内置 + ctx）。
 *
 * 两种模式：
 *  A. 单库模式（config 里没有 vaults）：行为与原版完全一致。
 *  B. 多项目模式（config.vaults 非空）：每个工作区对应自己的知识库。
 *     1) 提示词：用当前会话的 cwd（context.agent.session.header.cwd）匹配 vaults 里的
 *        workspace，**只注入匹配到的那一个库**的 schema.md + wiki/index.md。
 *        不再向模型展示全部项目的知识库清单，避免跨项目污染与 token 浪费。
 *        未匹配到任何库时不注入任何项目知识（只给一句"未登记"提示）。
 *        另外每轮都注入一段「项目上下文确认」：当前项目、允许写入的库路径、
 *        禁止跨库写入、读取不等于写入权限、需换项目请换工作区。
 *        这段提示每个 turn 每步都会重新生成（DSH 的 section.text 回调无缓存），
 *        因此天然做到"每次新指令重新确认项目，不沿用上一轮推断"。
 *        注意：这是上下文提示，不是硬安全隔离；硬校验需另做 wiki-guard 层。
 *     2) 会话结束：cwd 有值时**只**按 cwd 匹配 workspace——
 *        匹配失败即视为未登记工作区、直接跳过同步，**不回退**到旧 match 方式
 *        （否则未登记工作区可能因历史会话目录匹配而写进别的项目知识库）。
 *        仅在 cwd 完全拿不到时，才兼容旧方式（session id → findProj → match）。
 *        只对匹配到的那个库跑 --sync，并使用该库专属的状态文件。
 *     3) 未登记的工作区：不同步、不写库。
 *     4) 防重入和冷却按库分开；多项目模式下不显示"上个会话较大"的压缩提示
 *        （它是全局单文件，会串项目）。
 *
 * 配置（cordis.patch.yml config）:
 *  vault:        单库模式的 vault 路径
 *  vaults:       多项目模式，数组，每项：
 *                  workspace: 工作目录的真实路径，**正式必填**（cwd 匹配用）
 *                  vault:     该项目知识库路径，必填
 *                  name:      项目名（显示用）
 *                  match:     ~/.dsh/sessions 下的工作区目录名（旧方式兼容，可选）
 *                  state:     该库专属的管线状态文件路径（.json 文件，不是目录），不填则用管线默认值
 *                  sync:      是否在会话结束时同步该库，默认 true；老库想先只登记不同步就设 false
 *                  （workspace 与 match 至少填一个，两个都填则 cwd 优先、match 兜底）
 *  previewOrder: 提示词 section 顺序（默认 138）
 *  rulesOrder:   守则 section 顺序（默认 139，仅单库模式）
 *  mainAgentOnly: 只给主 Agent 注入（默认 true）
 *  debugContext: true 时在日志里打印一次 context / session header 的字段名（调研用）
 *
 * 注意：本插件只会触发管线的 --sync，不会触发 --okf / --all / --dsh-export。
 */
import { readFileSync, statSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
// A 阶段：workspace 匹配统一由注册表模块提供，本文件不再保留独立实现。
// 两层（Prompt / Guard）共用同一份路径语义，避免「提示词说 A、守卫判 B」。
import { loadProjects, matchProject } from "./projects-registry.mjs";
// 诊断入口：只读收集运行状态，供 knowledge_hub_status 工具使用。
import { collectDiagnostics, formatDiagnostics } from "./diagnostics.mjs";
// defineTool 由 DSH 运行时提供。所有能正常注册工具的插件（dsh-obsidian、
// dsh-github）都是静态 import，且注册发生在 apply() 同步执行期间。
// 曾改为惰性异步 import + .then() 内注册，结果工具从未出现在会话工具表中，
// 因此这里改回静态 import + 同步注册，不保留降级路径。
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-llm-wiki";
export const inject = ["systemPrompt"];

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), ".dsh");
const DEFAULT_VAULT = process.platform === "win32"
  ? "D:\\DB\\Obsidian\\LLM-Wiki"
  : "/mnt/d/DB/Obsidian/LLM-Wiki";
const PIPELINE = join(DSH_HOME, "bin", "llm-wiki-pipeline.mjs");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const HINT_DIR = join(DSH_HOME, "llm-wiki");
const HINT_FILE = join(HINT_DIR, "compile-hint.json");
const HINT_STATE = join(HINT_DIR, "hint-state.json");
const CACHE_TTL = 60_000;         // 读文件缓存 60s
const MAX_PROMPT_CHARS = 12000;   // 单库提示词上限，超出截断（防止某库 index 过大）

function cached(file, ttl = CACHE_TTL) {
  let last = 0, data = "";
  return () => {
    try {
      const st = statSync(file);
      if (Date.now() - last < ttl && data) return data;
      data = readFileSync(file, "utf8");
      last = Date.now();
      return data;
    } catch { return data || ""; }
  };
}

// 日志同时写 stdout 和文件（桌面版 DSH 的 stdout 不落盘，所以必须写文件才能验证）。
// 文件：~/.dsh/llm-wiki/plugin.log，超过 512KB 自动清空重来。
const LOG_FILE = join(HINT_DIR, "plugin.log");
let logReady = false;
const log = (msg) => {
  const line = "[dsh-knowledge-hub] " + new Date().toISOString() + " pid=" + process.pid + " " + msg;
  try { console.log(line); } catch {}
  try {
    if (!logReady) { mkdirSync(HINT_DIR, { recursive: true }); logReady = true; }
    try { if (statSync(LOG_FILE).size > 512 * 1024) writeFileSync(LOG_FILE, "", "utf8"); } catch {}
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {}
};

/**
 * 判断 cwd 是否落在某个 workspace 内，返回最具体的那个（最长前缀）。
 *
 * A 阶段：算法本身已迁入 projects-registry.mjs 的 matchProject()，此处仅做适配：
 * 注册表项目带 status 字段，disabled 不参与匹配；legacy vaults 无 status
 * （undefined !== "disabled"）自然放行，行为与合并前一致。
 */
function matchWorkspace(cwd, vaultList) {
  return matchProject(cwd, vaultList);
}

export function apply(ctx, config = {}) {
  const vault = config.vault && String(config.vault).length > 0 ? config.vault : DEFAULT_VAULT;
  const previewOrder = Number.isInteger(config.previewOrder) ? config.previewOrder : 138;
  const rulesOrder = Number.isInteger(config.rulesOrder) ? config.rulesOrder : 139;

  // ── 多项目配置 ──
  // 优先使用统一项目注册表（dsh-projects.json），与 dsh-wiki-guard 共用同一数据源。
  // config.vaults 保留仅为向后兼容。
  const projectsFile = config.projectsFile ? String(config.projectsFile) : "";
  const useRegistry = projectsFile.length > 0;

  const legacyVaults = Array.isArray(config.vaults)
    ? config.vaults
        .filter((v) => v && typeof v === "object" && v.vault && (v.workspace || v.match))
        .map((v) => ({
          vault: String(v.vault),
          name: v.name ? String(v.name) : "",
          workspace: v.workspace ? String(v.workspace) : "",
          match: v.match ? String(v.match) : "",
          state: v.state ? String(v.state) : "",
          sync: v.sync !== false,
          status: "active",
        }))
    : [];

  // 每轮重新读注册表（按 mtime 失效缓存），保证配置变更立即可见
  const loadVaults = () => {
    if (!useRegistry) return legacyVaults;
    const reg = loadProjects({ projectsFile });
    if (!reg.ok) {
      log("WARN 注册表无效，使用 lastGood: " + reg.error);
      return (reg.lastGood || []).map((p) => ({
        vault: p.vault, name: p.name, workspace: p.workspace,
        match: "", state: p.state, sync: p.status !== "disabled", status: p.status,
      }));
    }
    return reg.projects
      .filter((p) => p.status !== "disabled")
      .map((p) => ({
        vault: p.vault, name: p.name, workspace: p.workspace,
        match: "", state: p.state, sync: p.status !== "disabled", status: p.status,
      }));
  };

  let vaultList = loadVaults();
  const multi = useRegistry || legacyVaults.length > 0;

  // 单库模式的读取器（多项目模式下不使用，保留以维持单库行为）
  const rulesFile = join(vault, "schema.md");
  const previewFile = join(vault, "wiki", "index.md");
  const readRules = cached(rulesFile);
  const readPreview = cached(previewFile);

  // 多项目模式：按库懒建缓存读取器，避免每次构建提示词都读盘
  const vaultReaders = new Map();
  const readersFor = (v) => {
    let r = vaultReaders.get(v.vault);
    if (!r) {
      r = {
        rules: cached(join(v.vault, "schema.md")),
        preview: cached(join(v.vault, "wiki", "index.md")),
      };
      vaultReaders.set(v.vault, r);
    }
    return r;
  };

  const mainAgentOnly = config.mainAgentOnly !== false;
  const isMainAgent = (context) => {
    if (!mainAgentOnly) return true;
    const agent = context && context.agent;
    if (!agent) return true;
    try {
      const agents = ctx.get("agents");
      if (!agents || typeof agents.roots !== "function") return true;
      const roots = agents.roots();
      if (roots.length === 0) return true;
      return roots.some((item) => item.id === agent.id);
    } catch { return true; }
  };

  if (multi) {
    log("apply() multi-project mode, vaults=" +
      vaultList.map((v) => (v.name || v.workspace || v.match || v.vault)).join(",") +
      " pipeline=" + existsSync(PIPELINE));
    for (const v of vaultList) {
      if (!existsSync(v.vault)) log("WARN vault 不存在（该项目会被跳过同步）: " + v.vault);
      if (!v.workspace) log("WARN 未配置 workspace，该项目只能用 match 旧方式匹配: " + (v.name || v.vault));
    }
  } else {
    log("apply() vault=" + vault + " rules=" + existsSync(rulesFile) + " preview=" + existsSync(previewFile) +
      " pipeline=" + existsSync(PIPELINE));
  }

  // 调试用：只打印字段名和类型；字符串值只打印"名字像路径/目录/工作区/id"的字段，
  // 名字含 key/token/secret/password/auth/cred/cookie 的字段一律不打印值，避免泄露凭据。
  const SAFE_VAL = /cwd|workspace|workdir|work_dir|root|project|dir|path|folder|id$/i;
  const SECRET = /key|token|secret|passw|auth|cred|cookie|bearer/i;
  const probe = (obj, label, depth = 0) => {
    try {
      if (!obj || typeof obj !== "object") { log("probe " + label + " = " + (obj === null ? "null" : typeof obj)); return; }
      const parts = [];
      for (const k of Object.keys(obj).slice(0, 60)) {
        let v;
        try { v = obj[k]; } catch { parts.push(k + ":<getter-error>"); continue; }
        if (typeof v === "string" && SAFE_VAL.test(k) && !SECRET.test(k)) {
          parts.push(k + "=" + JSON.stringify(v.slice(0, 200)));
        } else if (v && typeof v === "object" && !Array.isArray(v) && !SECRET.test(k)) {
          if (depth < 1) probe(v, label + "." + k, depth + 1);
          parts.push(k + ":{" + Object.keys(v).slice(0, 30).join(",") + "}");
        } else {
          parts.push(k + ":" + (Array.isArray(v) ? "array(" + v.length + ")" : typeof v));
        }
      }
      log("probe " + label + " → " + parts.join(" | "));
    } catch (e) { log("probe " + label + " error: " + e.message); }
  };

  let debuggedContext = false;
  const debugContext = (context) => {
    if (!config.debugContext || debuggedContext) return;
    debuggedContext = true;
    try {
      log("debug context keys=" + JSON.stringify(Object.keys(context || {})) +
        " agent keys=" + JSON.stringify(Object.keys((context && context.agent) || {})));
      const agent = (context && context.agent) || {};
      probe(agent.session, "agent.session");
      probe(agent.options, "agent.options");
      probe(agent.runtimeContext, "agent.runtimeContext");
      probe(agent.scope, "agent.scope");
      probe(context && context.scope, "context.scope");
    } catch {}
  };

  // ── 1) systemPrompt 注入 ──
  const takeCompileHint = () => {
    try {
      if (!existsSync(HINT_FILE)) return "";
      const h = JSON.parse(readFileSync(HINT_FILE, "utf8") || "{}");
      if (!h || !h.at || Date.now() - h.at > 48 * 3600 * 1000) { try { unlinkSync(HINT_FILE); } catch {} return ""; }
      let st = {};
      try { st = JSON.parse(readFileSync(HINT_STATE, "utf8") || "{}"); } catch {}
      if (st.lastShown && st.lastShown >= h.at) return "";
      mkdirSync(HINT_DIR, { recursive: true });
      writeFileSync(HINT_STATE, JSON.stringify({ lastShown: h.at }), "utf8");
      try { unlinkSync(HINT_FILE); } catch {}
      return "\n> 上个会话较大（约 " + h.sizeKB + "KB），可能有可编译内容：运行 session-compile-candidates.mjs 生成候选，再用 wiki-write 落页（只写决策/排错/可复用结论）。";
    } catch { return ""; }
  };

  // ── 项目上下文确认（每次组装提示词都会重新生成，因为 text 回调每个 turn 每步都执行）──
  //
  // 目的：在 AI 处理任务前明确告知「当前在哪个项目、只允许写哪个库」，
  // 并由插件自动生成，不依赖 AI 自己记得检查。
  // 注意：这是**上下文提示**，不是硬安全隔离——硬校验在后续的 wiki-guard 层。
  const buildContextHeader = (target, cwd) => {
    const label = target.name || target.vault;
    const others = vaultList
      .filter((v) => v.vault !== target.vault)
      .map((v) => v.name || v.vault);

    let s = "\n---\n";
    s += "# 项目上下文确认（插件自动生成，每轮刷新）\n\n";
    s += "| 项 | 值 |\n|---|---|\n";
    s += "| 当前项目 | **" + label + "** |\n";
    s += "| 当前工作区 | `" + (cwd || "(未知)") + "` |\n";
    s += "| 本项目知识库 | `" + target.vault + "` |\n";
    s += "\n## ⚠️ 写入范围（强制）\n\n";
    s += "- ✅ **只允许**写入 `" + target.vault + "` 下的文件。\n";
    s += "- ❌ **禁止**写入任何其他项目的知识库";
    if (others.length) s += "（包括：" + others.join("、") + "）";
    s += "。\n";
    s += "- ❌ **不要使用**对话历史中出现过的其他项目路径——" +
      "本会话只认上面这一个库。\n";
    s += "- ⚠️ **读取其他项目资料 ≠ 获得写入权限**；看过不等于能写。\n";
    s += "- 🔄 如需操作其他项目知识库，请**切换到对应项目的工作区开启新会话**，" +
      "不要在本会话跨库操作。\n";
    s += "- 📌 每次收到新指令都会重新确认；**不要沿用上一轮对话的项目推断**。\n";
    return s;
  };

  // 只针对匹配到的那一个库拼提示词（不再注入全部项目清单）
  //
  // 截断策略：schema.md 是写入规则，优先级最高，**永远完整保留**；
  // wiki/index.md 只是导航，超限时优先截断它。schema 自身超限时明确告警，
  // 不静默截断（静默截断会悄悄丢掉知识库写入规则，是最危险的一种"看起来正常"）。
  const buildProjectPrompt = (target, cwd) => {
    const r = readersFor(target);
    const rules = (r.rules() || "").trim();
    const index = (r.preview() || "").trim();

    const head = buildContextHeader(target, cwd);

    let rulesBlock = rules ? "\n## 本库运行规则（schema.md）\n\n" + rules + "\n" : "";
    let indexBlock = index ? "\n## 本库索引（wiki/index.md）\n\n" + index + "\n" : "";

    if (!rules && !index) {
      rulesBlock = "\n> 本库尚未建立 schema.md 与 wiki/index.md。写入前先确认目录结构，" +
        "不要假设存在 wiki/ 分类目录。\n";
    }

    const TAIL = "\n---\n";

    // ① schema 自身就超限：完整保留 schema，完全舍弃 index，并明确告警
    if (head.length + rulesBlock.length + TAIL.length > MAX_PROMPT_CHARS) {
      log("WARN 库 [" + (target.name || target.vault) + "] 的 schema.md 超过提示词上限 " +
        MAX_PROMPT_CHARS + " 字符（当前 " + (head.length + rulesBlock.length) +
        "），已完整保留 schema 并舍弃 wiki/index.md");
      return head + rulesBlock +
        "\n> 本库 schema.md 已超出提示词预算，wiki/index.md 未注入；" +
        "需要导航时请直接读 `" + target.vault + "\\wiki\\index.md`。\n" + TAIL;
    }

    // ② 拼上 index 后超限：schema 全保留，只截断 index
    if (head.length + rulesBlock.length + indexBlock.length + TAIL.length > MAX_PROMPT_CHARS) {
      const budget = MAX_PROMPT_CHARS - head.length - rulesBlock.length - TAIL.length - 200;
      if (budget > 0 && indexBlock.length > budget) {
        indexBlock = indexBlock.slice(0, budget) +
          "\n\n> （本库 wiki/index.md 已截断，完整内容请读 `" +
          target.vault + "\\wiki\\index.md`）\n";
      } else {
        indexBlock = "\n> 本库 wiki/index.md 因提示词预算不足未注入，请直接读 `" +
          target.vault + "\\wiki\\index.md`。\n";
      }
    }

    return head + rulesBlock + indexBlock + TAIL;
  };

  // 未匹配到库时：明确「未识别当前项目」，暂停知识库写入，不暴露任何库路径
  const buildUnmatchedPrompt = (cwd) => {
    let s = "\n---\n";
    s += "# 项目上下文确认（插件自动生成，每轮刷新）\n\n";
    s += "## ⚠️ 未能识别当前项目\n\n";
    s += "- 当前工作区：`" + (cwd || "(未知)") + "`\n";
    s += "- 该工作区**未登记任何知识库**，无法确定允许写入的位置。\n";
    s += "\n## 强制约束\n\n";
    s += "- ❌ **暂停所有 LLM-Wiki 知识库写入**。\n";
    s += "- ✅ 如需记录知识，先询问用户应存到哪个项目。\n";
    s += "- ✅ 如确认应新增项目，请用户补充该工作区的 `workspace` 配置后重启 DSH。\n";
    s += "- 📌 每次收到新指令都会重新确认；**不要沿用上一轮对话的项目推断**。\n";
    s += "---\n";
    return s;
  };

  // 每个会话只记一次提示词匹配结果，避免刷屏
  const lastPromptKey = new Map();

  // 诊断用：Guard 是否应当处于注册状态。
  // Guard 在独立 entry（dsh-knowledge-hub/guard）里注册，本 entry 无法查询其状态，
  // 因此由 profile 配置显式声明（guardEnabled），默认视为启用（0.1.1 起默认开启）。
  const guardExpected = config.guardEnabled !== false;

  // 诊断用：检测上游 dsh-llm-wiki 是否与本插件共存。
  // 判据：profile 的 node_modules 里存在 dsh-llm-wiki 包。
  const detectUpstream = () => {
    try {
      const profileDir = dirname(dirname(DSH_HOME));
      const candidates = [
        join(DSH_HOME, "profiles"),
      ];
      for (const base of candidates) {
        if (!existsSync(base)) continue;
        for (const prof of readdirSync(base)) {
          if (existsSync(join(base, prof, "node_modules", "dsh-llm-wiki", "package.json"))) return true;
        }
      }
      return existsSync(join(profileDir, "node_modules", "dsh-llm-wiki", "package.json"));
    } catch { return false; }
  };

  if (multi) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: "llm-wiki:preview",
      order: previewOrder,
      text: (context) => {
        debugContext(context);
        if (!isMainAgent(context)) return "";

        const session = context && context.agent && context.agent.session;
        const header = (session && session.header) || {};
        const cwd = header.cwd;
        const sid = header.id || (context && context.agent && context.agent.id) || "?";

        // 每轮重新读注册表，保证配置变更立即可见（不只是启动时读一次）
        vaultList = loadVaults();
        const target = matchWorkspace(cwd, vaultList);

        const key = sid + "|" + (target ? target.vault : "-");
        if (lastPromptKey.get(sid) !== key) {
          lastPromptKey.set(sid, key);
          log("prompt: " + (target
            ? "已匹配 [" + (target.name || target.vault) + "]"
            : "未匹配工作区") + " cwd=" + (cwd || "(empty)") + " sid=" + sid);
        }

        return target ? buildProjectPrompt(target, cwd) : buildUnmatchedPrompt(cwd);
      },
    }), "dsh-llm-wiki.prompt.preview");
  } else {
    // 知识预览（先于守则，order 更低先出现）
    ctx.effect(() => ctx.systemPrompt.section({
      name: "llm-wiki:preview",
      order: previewOrder,
      text: (context) => {
        debugContext(context);
        if (!isMainAgent(context)) return "";
        const idx = readPreview();
        if (!idx) return "";
        return "\n---\n# LLM-Wiki 知识库（管线自动维护）\n\n" + idx + takeCompileHint() +
          "\n\n**检索入口**：先跑 wiki-router.mjs 分流 → wiki 走 wiki-retrieval 融合检索 / session 走会话语义 / live 直接实测 / docs 走 Documents / hot 看热记忆。\n---\n";
      },
    }), "dsh-llm-wiki.prompt.preview");

    // schema 守则
    ctx.effect(() => ctx.systemPrompt.section({
      name: "llm-wiki:rules",
      order: rulesOrder,
      text: (context) => {
        if (!isMainAgent(context)) return "";
        const schema = readRules();
        if (!schema) return "";
        return "\n---\n# LLM-Wiki 知识库运行规则\n\n" + schema + "\n---\n";
      },
    }), "dsh-llm-wiki.prompt.rules");
  }

  // ── 2) session/disposed → 触发管线 ──
  const COOLDOWN_MS = 60_000;
  const runningSet = new Set();       // 按库防重入
  const lastRunAt = new Map();        // 按库冷却

  const markCompileHint = (session) => {
    try {
      if (process.env.LLM_WIKI_COMPILE_HINT === "off") return;
      const h = (session && (session.header || session.meta || session)) || {};
      const id = h.id || h.sessionId || (session && session.id);
      if (!id) return;
      let logSize = 0;
      for (const rootDir of [SESSIONS_ROOT]) {
        if (!existsSync(rootDir)) continue;
        for (const proj of readdirSync(rootDir)) {
          const dir = join(rootDir, proj, "session-" + id);
          const f = join(dir, "session.v4.jsonl.zstd");
          try { if (existsSync(f)) { logSize = statSync(f).size; break; } } catch {}
        }
      }
      if (logSize < 300 * 1024) return; // 小于 ~300KB 视为短会话，不提示
      mkdirSync(HINT_DIR, { recursive: true });
      writeFileSync(HINT_FILE, JSON.stringify({ sessionId: id, sizeKB: Math.round(logSize / 1024), at: Date.now() }), "utf8");
    } catch {}
  };

  // 旧方式：用会话 id 反查所在工作区目录名（~/.dsh/sessions/<proj>/session-<id>）
  // 仅作 cwd 拿不到时的兜底，保留到新旧两条路径都验证完再清理。
  const findProj = (id) => {
    if (!id || !existsSync(SESSIONS_ROOT)) return null;
    try {
      for (const proj of readdirSync(SESSIONS_ROOT)) {
        if (existsSync(join(SESSIONS_ROOT, proj, "session-" + id))) return proj;
      }
    } catch {}
    return null;
  };

  const runPipeline = (target) => {
    const key = target.vault;
    if (runningSet.has(key)) return;
    if (!existsSync(PIPELINE)) { log("pipeline not found, skipped: " + PIPELINE); return; }
    if (!existsSync(target.vault)) { log("vault 不存在，跳过同步: " + target.vault); return; }
    const now = Date.now();
    if (now - (lastRunAt.get(key) || 0) < COOLDOWN_MS) return;
    runningSet.add(key);
    lastRunAt.set(key, now);
    // 管线自身的默认 vault 是 WSL 路径，必须显式传入；状态文件按库分开
    const env = { ...process.env, LLM_WIKI_VAULT: target.vault };
    if (target.state) {
      try { mkdirSync(dirname(target.state), { recursive: true }); } catch {}
      env.LLM_WIKI_STATE = target.state;
    }
    // 会话结束只做增量同步；全量巡检交给计划任务
    const child = spawn(process.execPath, [PIPELINE, "--sync"], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env,
    });
    child.on("exit", (code) => {
      runningSet.delete(key);
      log("pipeline exit code=" + code + " vault=" + target.vault);
    });
    child.on("error", (e) => {
      runningSet.delete(key);
      log("pipeline spawn error: " + e.message);
    });
    child.unref();
  };

  // 子代理（记忆写入/审查等）结束不需要跑整条管线。
  const isSubSession = (session) => {
    if (!session || typeof session !== "object") return false;
    const header = session.header || session.meta || session;
    return header.origin === "subagent" || header.parentSession !== undefined;
  };

  let debuggedSession = false;
  ctx.on("session/disposed", (session) => {
    if (isSubSession(session)) return;
    try {
      const h = (session && (session.header || session.meta || session)) || {};
      if (config.debugContext && !debuggedSession) {
        debuggedSession = true;
        log("debug session header keys=" + JSON.stringify(Object.keys(h)));
        probe(h, "session header");
      }
      if (!multi) {
        markCompileHint(session);
        runPipeline({ vault, state: "" });
        return;
      }

      // 优先：disposed payload 里的 cwd（字段位置未实测，逐个候选取）
      const cwd = h.cwd || (h.context && h.context.cwd) || (session && session.cwd) || "";
      let target = null;
      let how = "cwd";

      if (cwd) {
        // cwd 有值：必须以 cwd 为准。匹配失败 = 未登记工作区，直接跳过。
        // 绝不回退到 match 兜底，否则未登记工作区可能因历史会话目录匹配
        // 而同步到其他项目的知识库（跨项目污染）。
        target = matchWorkspace(cwd, vaultList);
        if (!target) {
          log("工作区未登记，跳过同步: cwd=" + cwd);
          return;
        }
      } else {
        // 仅在完全拿不到 cwd 时，才兼容旧版本用 match 兜底
        const id = h.id || h.sessionId || (session && session.id);
        const proj = findProj(id);
        target = vaultList.find((v) => v.match && v.match === proj) || null;
        how = "match";
        if (!target) {
          log("工作区未登记，跳过同步: cwd=(empty) proj=" +
            (proj || "(未找到会话目录)"));
          return;
        }
      }

      const label = target.name || target.workspace || target.match || target.vault;
      if (!target.sync) { log("工作区已匹配 [" + label + "] via " + how + "，但 sync=false，未同步"); return; }
      log("工作区已匹配 [" + label + "] via " + how + "，开始同步 → " + target.vault);
      runPipeline(target);
    } catch (e) { log("hook error: " + e.message); }
  });

  // ── 诊断工具：一条命令看清运行状态 ──
  //
  // 只读、无副作用。Guard 是否注册由 config 注入（Guard 在独立 entry 里，
  // 本 entry 无法直接查询其注册状态，因此由 profile 配置显式声明）。
  if (ctx.tools && typeof ctx.tools.register === "function") {
    const buildStatusText = () => {
      const d = collectDiagnostics({
        projectsFile,
        cwd: (ctx.agent && ctx.agent.session && ctx.agent.session.header
          && ctx.agent.session.header.cwd) || process.cwd(),
        guardRegistered: guardExpected === true,
        upstreamPresent: detectUpstream(),
        obsidianVaultPath: config.obsidianVaultPath ? String(config.obsidianVaultPath) : "",
        pipeline: {
          available: existsSync(PIPELINE),
          scriptPath: PIPELINE,
          lastSyncStatus: "unknown",
          note: "会话结束时由本插件触发增量同步；此处不读取历史同步记录",
        },
      });
      return formatDiagnostics(d);
    };

    // 同步注册，单参数，与 dsh-obsidian 的 registerTools 形态一致。
    // 注释说明了历史教训：异步注册会导致工具不出现在会话工具表中。
    ctx.tools.register(defineTool({
      name: "knowledge_hub_status",
      description:
        "诊断 dsh-knowledge-hub 的运行状态：注册表是否有效、当前 cwd 匹配哪个项目、" +
        "各 Vault 是否存在、Guard 是否注册及其读写保护范围、Pipeline 是否可用、" +
        "是否检测到上游 dsh-llm-wiki 共存。只读操作，不修改任何文件。",
      parameters: {
        verbose: {
          type: "boolean",
          description: "是否输出完整项目列表与告警详情（默认 false）。",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      execute: () => buildStatusText(),
    }));
  }
}
