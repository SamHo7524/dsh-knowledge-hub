// coexistence —— 上游 dsh-llm-wiki 共存处理
//
// 背景：dsh-knowledge-hub 的 prompt.mjs 派生自上游 iwtown/dsh-llm-wiki。
// 若两者同时加载，会同时注册 systemPrompt.section、同时监听 session/disposed
// 触发管线同步，造成重复注入与重复同步。
//
// 设计取舍（按用户明确要求）：
//   - Hub 保留自己的 Registry / Resolver / Context Provider / Guard
//   - **不因上游共存而禁用 Hub**
//   - 明确 Prompt 注入与 Pipeline 同步的唯一责任方
//   - 无法自动解决时给出明确诊断告警，而不是静默降级
//   - 不重写现有上下文协调机制（只做检测与告警，不改 Prompt 层逻辑）
//
// 为什么只做检测不做自动禁用：两个插件都能正常工作，自动禁用哪一方都会
// 让用户失去预期能力。正确做法是把选择权交给用户，并明确告知后果。

/** Prompt 注入的唯一责任方 */
export const PROMPT_OWNER = "dsh-knowledge-hub";

/** Pipeline 同步的唯一责任方 */
export const PIPELINE_OWNER = "dsh-knowledge-hub";

/**
 * 检测上游共存冲突。
 *
 * @param {object} opts
 * @param {boolean} opts.upstreamPresent 是否检测到上游 dsh-llm-wiki
 * @param {boolean} [opts.hubEnabled] Hub 是否启用（默认 true）
 * @returns {object} 冲突描述
 */
export function detectUpstreamConflict(opts = {}) {
  const { upstreamPresent = false, hubEnabled = true } = opts;

  if (!upstreamPresent) {
    return {
      detected: false,
      severity: "none",
      issues: [],
      recommendation: "",
      hubShouldRun: hubEnabled === true,
      promptOwner: PROMPT_OWNER,
      pipelineOwner: PIPELINE_OWNER,
      hubKeepsRegistry: true,
      hubKeepsResolver: true,
      hubKeepsGuard: true,
    };
  }

  return {
    detected: true,
    severity: "warning",
    issues: [
      "Prompt 重复注入：两个插件都会注册 systemPrompt.section，同一会话会收到两份知识库上下文，可能互相矛盾并浪费 token。",
      "Pipeline 重复同步：两个插件都会在会话结束时触发管线同步，同一 Vault 会被并发同步，可能产生写冲突或重复索引。",
      "项目上下文重叠：两套插件各自解析项目归属，若注册表或匹配规则不一致，可能出现「提示词说 A、守卫判 B」。",
      "加载顺序敏感：谁后加载谁覆盖，行为随 bundle 顺序变化而不稳定。",
    ],
    recommendation:
      "只保留一个责任方：在 profile 的 cordis.patch.yml 中把上游 llm-wiki entry 设为 " +
      "disabled: true，保留 dsh-knowledge-hub 的 entry（它已包含 Prompt 注入、项目注册表与 Guard）。" +
      "如果确实需要上游的额外能力，则反过来禁用 dsh-knowledge-hub 的 prompt entry、" +
      "只保留其 guard entry，但此时项目注册表需自行维护。",
    hubShouldRun: hubEnabled === true,
    promptOwner: PROMPT_OWNER,
    pipelineOwner: PIPELINE_OWNER,
    hubKeepsRegistry: true,
    hubKeepsResolver: true,
    hubKeepsGuard: true,
  };
}

/**
 * 把共存结论渲染成诊断输出的一段文字。
 * @param {object} c detectUpstreamConflict 的返回值
 * @returns {string[]} 文本行
 */
export function formatCoexistence(c) {
  const L = [];
  if (!c.detected) {
    L.push("  未检测到上游 dsh-llm-wiki，无共存冲突。");
    L.push("  Prompt 注入责任方: " + c.promptOwner);
    L.push("  管线同步责任方: " + c.pipelineOwner);
    return L;
  }

  L.push("  ⚠️ 检测到上游 dsh-llm-wiki 共存（severity: " + c.severity + "）");
  L.push("  本插件继续运行: " + (c.hubShouldRun ? "是（不因共存而禁用）" : "否"));
  L.push("  Prompt 注入责任方: " + c.promptOwner);
  L.push("  管线同步责任方: " + c.pipelineOwner);
  L.push("  保留能力: Registry=" + (c.hubKeepsRegistry ? "是" : "否") +
    " Resolver=" + (c.hubKeepsResolver ? "是" : "否") +
    " Guard=" + (c.hubKeepsGuard ? "是" : "否"));
  L.push("  冲突点:");
  c.issues.forEach((i, n) => L.push("    " + (n + 1) + ". " + i));
  L.push("  处置建议: " + c.recommendation);
  return L;
}
