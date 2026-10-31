# dsh-knowledge-hub

[English](README.md) | **简体中文**

> **本项目派生自 [`iwtown/dsh-llm-wiki`](https://github.com/iwtown/dsh-llm-wiki)**
> （commit `4602b75e4afc2546704ca8b5e642f870eb2f0f96`，v0.10.7，MIT 许可，
> Copyright (c) 2026 iwtown）。
>
> Prompt 层插件 `prompt.mjs` 是该项目的 `plugin/dsh-llm-wiki.mjs` 的修改版本。
> 原始版权与许可声明完整保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
>
> `guard.mjs` 与 `projects-registry.mjs` 为本项目原创。

DSH（DeepSeek Harness）知识库中枢插件：多项目注册表、每轮项目上下文注入、写入路径守卫。

### 设计定位

**面向 Obsidian vault 设计，同时也适用于任意「目录 + Markdown」结构的知识库。**

本插件的设计初衷是三件事的结合：

| 组成 | 作用 |
|---|---|
| **Obsidian** | 知识库以 Obsidian vault 的形态存在——纯 Markdown 文件 + 目录结构，可直接用 Obsidian 打开浏览与编辑 |
| **LLM-Wiki** | 知识按 Karpathy 的 LLM-Wiki 模式组织：`schema.md` 守则 + `wiki/` 分类目录 + `index.md` 导航，由 AI 维护、由管线同步 |
| **多库管理** | 一个 DSH 实例同时服务多个项目，每个项目有独立 vault，按会话 `cwd` 自动识别、按注册表隔离写入 |

三者叠加才有意义：**没有 Obsidian**，知识库缺少人可读可编辑的界面；**没有 LLM-Wiki**，AI 写入的是一堆无结构文件；**没有多库隔离**，多个项目会互相污染。

> 实现上并不绑定 Obsidian：核心逻辑只读写普通 Markdown 文件（`schema.md`、`wiki/index.md`）。
> `obsidian_*` 系列工具是**可选的额外保护对象**——装了 `dsh-obsidian` 时守卫会一并保护这些写入路径，
> 没装时自动跳过。因此不用 Obsidian 也能运行，只是少了那部分便利。

**版本 0.1.0** · MIT 许可 · Copyright (c) 2026 SamBanHo

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [兼容性](#兼容性)
- [安装](#安装)
- [Profile 配置](#profile-配置)
- [项目注册表](#项目注册表)
- [启用守卫](#启用守卫)
- [验证安装](#验证安装)
- [安全边界（必读）](#安全边界必读)
- [常见问题](#常见问题)
- [致谢与参考](#致谢与参考)
- [许可证](#许可证)

---

## 它解决什么问题

一个 DSH 实例同时服务多个项目时，会碰到三个具体问题：

| 问题 | 表现 | 本插件的做法 |
|---|---|---|
| **知识库串台** | 在 A 项目会话里写进了 B 项目的知识库 | 按会话 `cwd` 匹配唯一项目，写入路径受守卫校验 |
| **AI 不知道自己在哪个项目** | 需要人工反复提醒「这是 X 项目」 | 每轮自动注入「项目上下文确认」段，含库路径与写入范围 |
| **配置散落各处** | 每个项目各配一份，改一处忘一处 | 单一 JSON 注册表，Prompt 层与守卫层共用 |

### 两个 entry，一份配置

本插件包含两个 Cordis entry，共享同一个 `projects-registry.mjs`：

| entry | 名称 | 作用 | 默认状态 |
|---|---|---|---|
| Prompt 层 | `dsh-knowledge-hub` | 每轮注入当前项目的知识库上下文 | 启用 |
| 守卫层 | `dsh-knowledge-hub/guard` | 拦截跨库写入、未登记工作区、只读项目 | **禁用** |

---

## 兼容性

| 项目 | 值 |
|---|---|
| DSH | `0.2.1-rc.5`（已实测验证） |
| 声明范围 | `>=0.2.0-rc.2 <0.2.1-0 \|\| >=0.2.1-rc.1 <0.3.0-0` |
| Node.js | `>=22.5.0` |
| 运行时依赖 | **零**（仅用 `node:` 内置模块） |

声明范围使用 `includePrerelease` 语义，因此 `0.2.1-rc.5` 这类预发布版本能正常匹配，不会被静默跳过。

如果 DSH 版本超出声明范围，插件会在加载阶段被跳过——请按[验证安装](#验证安装)的三项检查确认。

---

## 安装

### 方式 A：从 tarball 安装（推荐）

```powershell
# 1. 创建或选择一个 profile
$profile = "myprofile"
$profileDir = "$env:USERPROFILE\.dsh\profiles\$profile"
New-Item -ItemType Directory -Path "$profileDir\node_modules" -Force | Out-Null

# 2. 安装插件
npm install --prefix $profileDir "C:\path\to\dsh-knowledge-hub-0.1.0.tgz"
```

### 方式 B：从本地目录安装

```powershell
npm install --prefix $profileDir "C:\path\to\dsh-knowledge-hub"
```

### 方式 C：从 GitHub 安装

```powershell
# 固定到某个 commit，不要用分支
npm install --prefix $profileDir "github:SamHo7524/dsh-knowledge-hub#<commit-sha>"
```

> GitHub 安装拿到的是源码，不是构建产物。请固定 commit 而非分支。

---

## Profile 配置

### 第一步：把插件加入 bundle 列表

编辑 profile 目录下的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-knowledge-hub"
      ]
    }
  }
}
```

### 第二步：创建 `cordis.patch.yml`

在 profile 目录下新建该文件：

```yaml
- insert:
    - id: llm-wiki
      name: dsh-knowledge-hub
      config:
        projectsFile: "C:/Users/you/.dsh/llm-wiki/dsh-projects.json"

    - id: wiki-guard
      name: dsh-knowledge-hub/guard
      config:
        projectsFile: "C:/Users/you/.dsh/llm-wiki/dsh-projects.json"
        logFile: "C:/Users/you/.dsh/llm-wiki/guard.log"
```

### ⚠️ 两个必须注意的点

| 注意点 | 说明 |
|---|---|
| **路径用正斜杠** | YAML 中反斜杠可能构成非法转义（如 `\guard.log` 里的 `\g`），会导致 patch 静默失效 |
| **`projectsFile` 必须配** | 不配则 `apply()` 会执行但提前 return，**守卫不会注册** |

> 守卫**默认启用**——装上插件即生效，无需额外操作。详见[启用守卫](#启用守卫)。

---

## 项目注册表

Prompt 层与守卫层读取同一个注册表文件：

```json
{
  "version": 1,
  "projects": [
    {
      "id": "my-project",
      "name": "我的项目",
      "status": "active",
      "workspace": "C:\\path\\to\\workspace",
      "vault": "C:\\path\\to\\vault"
    },
    {
      "id": "readonly-project",
      "name": "只读项目",
      "status": "readonly",
      "workspace": "C:\\path\\to\\ro-workspace",
      "vault": "C:\\path\\to\\ro-vault"
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，不可重复 |
| `name` | 显示名称 |
| `status` | `active`（可读写）\| `readonly`（只读）\| `disabled`（停用） |
| `workspace` | 会话 `cwd` 落在此路径下即选中该项目。**不可重复，不可嵌套** |
| `vault` | 知识库根目录。**不可重复，不可重叠** |

### status 三种取值的差异

| 取值 | 参与 cwd 匹配 | 写入行为 |
|---|---|---|
| `active` | ✅ | 允许 |
| `readonly` | ✅ | **拒绝**（`READONLY_PROJECT`） |
| `disabled` | ❌ | **拒绝**（库仍被识别，判为未登记工作区，不会误判成「非知识库路径」） |

### 动态生效

注册表每轮重新读取，按 mtime + size 失效缓存。**改完配置不需要重启 DSH。**

### ⚠️ 知识库必须放在工作区内

DSH 文件沙箱（`workspace-write`）会**先于守卫**拦截工作区外的写入。如果知识库在工作区外，写入会以沙箱错误失败，**守卫根本轮不到执行**。

```
<workspace>/vault/          ← 知识库在工作区内，守卫才是实际生效的那一层
```

如果你确实要让知识库在工作区外，需要主动放宽沙箱，但那样守卫的作用范围也会改变。

---

## 启用守卫

守卫 entry **默认启用**——装上插件即生效，无需额外操作。

如果只想先验证 Prompt 层、暂时关闭守卫，在 profile patch 中覆盖：

```yaml
- id: wiki-guard
  disabled: true
```

关闭后日志中不会出现注册记录——参见[验证安装](#验证安装)的检查 3。

### 守卫拦截什么

| 拦截码 | 触发条件 |
|---|---|
| `CROSS_VAULT_WRITE` | 目标属于其他项目 |
| `UNREGISTERED_WORKSPACE` | 当前 cwd 不属于任何已登记项目 |
| `READONLY_PROJECT` | 当前项目状态为 `readonly` |
| `REGISTRY_INVALID` | 注册表损坏或读取失败（fail-closed） |
| `UNC_UNMAPPABLE` | UNC 路径无法映射到本地盘符 |

### 守卫保护哪些工具

`write`、`edit`、`obsidian_write`、`obsidian_append`、`obsidian_move`、`obsidian_delete`、`obsidian_set_property`。

**只读工具（`read` / `grep` / `glob` 等）不受影响。**

---

## 验证安装

> **文件存在不代表安装成功，entry 出现在配置里也不代表守卫生效。**
> **以下三项检查必须分别执行，不可互相替代。**

### 检查 1：bundle 级（stderr）

```powershell
dsh --profile <profile> --dump-config 2>&1 | Select-String "skipping profile bundle"
```

**预期：无输出。**

如果出现，说明 bundle 被整体跳过——包无法解析、缺 `dsh.bundle`、版本不兼容、或包内 patch 加载失败。

⚠️ **该信息只写 stderr**，只看 stdout 会漏掉。

### 检查 2：entry 级（stderr，真实启动）

```powershell
dsh --profile <profile> "reply with OK" 2>&1 | Select-String "entries did not activate|failed to import"
```

**预期：无输出。**

如果出现，说明 entry 导入失败（例如共享模块有语法错误）。

⚠️ 共享模块损坏表现为 `entries did not activate` + `failed to import`，
**不是** `skipping profile bundle`——两者属于不同层级。

### 检查 3：守卫实际注册（日志）

```powershell
Select-String -Path "<logFile>" -Pattern "guard 已注册"
```

**预期：**
- 守卫**启用** → 当前启动周期**必须**出现 `guard 已注册`
- 守卫 `disabled: true` → **不得**出现注册记录

### 为什么三项不能互相替代

| 观察到的现象 | 能证明什么 |
|---|---|
| 配置文件里有这一行 | **什么都不能证明** |
| entry 已加载 | 模块被解析了 |
| `apply()` 执行了 | 插件代码跑了 |
| **日志里有 `guard 已注册`** | **守卫真正进入了工具保护链** |

实测确认存在「`apply()` 执行了但因缺 `projectsFile` 提前 return」的情况。

**配置了但没注册的守卫，不提供任何保护。**

---

## 安全边界（必读）

> **守卫当前仅用于防误操作和普通越界，不防有意绕过。**

即使守卫部署成功，也**不能**将其视为操作系统权限隔离、独立身份运行或完整文件系统访问控制的替代品。

### 明确不覆盖的范围

| 项 | 状态 |
|---|---|
| **注册表与 last-good 快照可被会话改写** | ⛔ **未解决**（已知缺陷） |
| Shell 重定向 | **不在保护范围** |
| 插件直接调用 `ctx.fs` | **不在保护范围** |
| `\\.\` 设备命名空间 | 未验证 |
| 8.3 短文件名 | 未验证 |
| UNC 路径（无法映射时 fail-closed） | 部分覆盖 |
| 大小写敏感目录 | 未验证 |
| 用户手工编辑 | 不在保护范围 |

### 关于注册表篡改

守卫保护的是**知识库 vault 路径**。注册表位于 `~/.dsh/llm-wiki/`，**不在任何 vault 内**，因此：

- 会话可以直接改写注册表
- 会话可以直接改写 last-good 快照
- 改了之后，守卫的保护边界会随之改变

**守卫成功拒绝跨库写入 ≠ 注册表不可篡改 ≠ 跨库隔离已达安全保证。**

这是一个已知的、明确记录的限制，不在 0.1.0 的解决范围内。

---

## 常见问题

### Q：守卫没生效，日志里没有「guard 已注册」

按顺序排查：

1. **`projectsFile` 配了吗？** 没配则 `apply()` 提前 return，不注册。
2. **`disabled` 还是 `true` 吗？** 默认就是 `true`，要显式改 `false`。
3. **entry 导入成功了吗？** 查 stderr 有无 `failed to import`。
4. **bundle 加载了吗？** 查 stderr 有无 `skipping profile bundle`。

### Q：写入失败，但日志里没有 DENY

说明拦截来自**沙箱或操作系统**，不是守卫：

| 错误信息 | 来源 |
|---|---|
| `[sandbox: file access denied under workspace-write mode]` | DSH 沙箱 |
| `EACCES` / `EPERM` | Windows ACL |
| `DENY [CROSS_VAULT_WRITE]` 等 | **守卫** |

**判据：守卫日志里有没有对应的 `DENY` 记录。**

常见原因：知识库在工作区外，沙箱先拦住了。

### Q：改了注册表要重启吗

不需要。注册表按 mtime + size 失效缓存，每轮重新读取。

### Q：多个项目能共用一个知识库吗

不能。`vault` 字段要求唯一且不可重叠，启动时校验会拒绝。

### Q：`disabled` 和 `readonly` 有什么区别

- `disabled`：项目**完全不参与** cwd 匹配，等于「这个项目暂时不用了」。写它的库会被判为未登记工作区。
- `readonly`：项目**正常参与** cwd 匹配，但写入被拒绝。适合「还在读、暂时不写」的场景。

---

## 致谢与参考

- **LLM Wiki 知识库模式**：Andrej Karpathy，
  <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
  （仅理念参考；该 Gist 未声明许可证，未复用其文字或代码）

- **本项目派生自 [`iwtown/dsh-llm-wiki`](https://github.com/iwtown/dsh-llm-wiki)**
  @ `4602b75e4afc2546704ca8b5e642f870eb2f0f96`（v0.10.7），MIT 许可，
  Copyright (c) 2026 iwtown。

  Prompt 层插件 `prompt.mjs` 是该项目的 `plugin/dsh-llm-wiki.mjs` 的修改版本。
  修改内容：增加注册表驱动的多项目匹配（`loadProjects` / `matchProject`）、
  增加每轮项目上下文提示段、增加文件日志与调试探针、将本地工作区匹配函数改为
  委托给共享注册表模块。原有的单库代码路径**保留为 legacy 兼容分支**
  （未配置注册表时生效），未删除。

  原始版权与许可声明保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

- **守卫层（`guard.mjs`）与共享注册表模块（`projects-registry.mjs`）**
  为本项目原创，不派生自任何第三方代码。

iwtown 是 dsh-llm-wiki 的上游作者，**不是** dsh-knowledge-hub 的维护者、
贡献者或官方代表。

本项目独立开发。上述引用不表示与上游项目存在隶属、背书或官方关联关系。

---

## 许可证

MIT — Copyright (c) 2026 SamBanHo（本项目原创部分）。

`prompt.mjs` 中的派生部分仍为 Copyright (c) 2026 iwtown，同样以 MIT 许可分发。
完整的上游声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
