---
description: "CInHEd 工具服务三个 prepare 工具的网页确认卡片：显示已准备的批次和姓名，允许员工修改原因，并在点击后写入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ai-confirm

[English](README.md) | 中文

## Summary

`dsh-client-ui-ai-confirm` 将 CInHEd 工具服务的 `prepare_approve`、`prepare_reject` 和 `prepare_request_documents` 工具的结果渲染为确认卡片。卡片使用员工本人的会话加载已准备的批次以及每位申请人的姓名，允许员工修改原因；点击确认后，它会铸造一个短期写入令牌，使用掉该批次，并逐条写入记录。模型只看到工具结果，从不接触姓名、令牌或写入结果。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Web 包中该行默认随附 `disabled: true`。请在 profile 补丁（`$DSH_HOME/profiles/web/cordis.patch.yml`）中启用它，补丁只设置 `disabled: false`（不带配置）：

```yaml
- id: ui-ai-confirm
  disabled: false
```

| 设置 | 默认值 | 含义 |
|---|---|---|
| `serverName` | `cinhed` | 工具服务 MCP 条目的 `serverName`。卡片注册为 `mcp__<serverName>__prepare_approve`、`..._prepare_reject` 和 `..._prepare_request_documents`。 |
| `toolsPath` | `/tools/pending` | 反向代理转发到工具服务待处理批次路由的页面路径。 |
| `apiPath` | `/api/v1` | 反向代理转发到 Django API 的页面路径。 |
| `signInUrl` | `/login` | 使用账号、密码和双因素认证登录员工的页面。在新标签页中打开。 |

浏览器为每个客户端行创建时不带配置，因此 `cordis.yml` 中的 `config:` 块永远不会传给此插件。这些默认值在构建时固定。工具服务必须以名为 `cinhed` 的 MCP 服务器接入；如需更改设置，请修改 `src/client/index.ts` 中的默认值并重新构建包的 bundle。

加载时会检查这三个路径：每个都必须是页面自身源上的绝对路径，因此卡片绝不会调用或链接到其他站点。这适用于默认值以及传给 `Config` 的任何值。

### 员工看到的内容

已准备的批次会显示每条记录的姓名、编号、项目，以及每条记录将获得的变更（例如"Under review → Approved"）。工具服务跳过的记录会列出其原因。拒绝和请求材料的操作会显示一个原因字段，初始内容为 AI 的草稿。请求材料时，原因为空则无法确认。

确认按以下顺序执行：检查登录状态并铸造写入令牌，使用掉该批次，然后一次写入一条记录。每条记录都有自己的结果（已变更，或 Django 拒绝的原因）。取消会使用掉该批次但不写入。已过期、已使用或无法加载的批次会说明原因，并显示每位申请人的当前状态。

### 代理要求

卡片在页面自身的源上调用工具服务和 Django，因此员工的会话 Cookie 随每次调用发送，且没有凭据经过 harness。反向代理必须将 `toolsPath` 转发到工具服务，将 `apiPath` 转发到 Django，并且与提供 harness 的主机相同。不支持跨源使用。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

`apply` 注册一对词典（`zh`、`en`）以及每个 prepare 工具一个 `tool.call.toolview` 条目，所有条目共享一个已声明的 Session store。每个条目的 `inject` 面携带网络面、它所代表的操作以及登录路径。该包只导出 `apply`、`inject` 和 `Config`。

### Flow

`controller.ts` 以普通函数形式承载流程，这些函数作用于网络面和 store：`openCard`、`confirmCard`、`cancelCard`。先铸造令牌意味着未登录或双因素未完成的会话会在批次被使用前失败，因此登录后重试仍可成功。其次使用掉批次意味着已过期或已使用的批次永远不会写入。`api.ts` 将每个失败归类为 `sign-in`、`expired`、`refused` 或 `unavailable`；唯一传递的响应文本是 Django 对单条写入的拒绝原因。

### State

store 按工具服务的待处理操作 id 保存每个批次的阶段、正在编辑的原因、已加载的姓名以及每次写入的结果。卡片在确认过程中重新挂载时仍会显示进度，且确认会继续运行，因为流程由控制器持有，而非组件。结果不写入 Session 日志：重新加载后，卡片会从 Django 读回每位申请人的当前状态。

### Replay

卡片只根据已记录的调用和结果渲染。结果不是格式正确的批次，或为错误时，会渲染为一行普通的失败信息，并显示工具自身的文本。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-tool](../ui-tool/README.zh.md)：承载 `tool.call.toolview` 插槽的工具调用展示层。
- [ui-skill](../ui-skill/README.zh.md)：同一插槽中另一个由业务负责的注册。

-----

<a id="model-experience"></a>
## Model Experience

### Confirming a prepared batch

#### What the model sees

本包不向模型提供任何内容。`prepare_approve`、`prepare_reject` 和 `prepare_request_documents` 的结果由工具服务写入，并以普通工具输出的形式到达模型：`pendingActionId`、带状态的 `eligible` 和 `skipped` 记录编号，以及 `expiresAt`。其中不含姓名，也不含申请人的任何自由文本。确认、写入令牌、姓名以及每次写入的结果都保留在浏览器和 Django 中，因此模型只有在之后调用读取工具时，才能得知员工是否确认。

#### Token effect

无。本包不增加任何模型可见内容。

#### KV Cache effect

无。本包从不改写先前请求的 token。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **设置在构建时固定**：客户端行不接收 `cordis.yml` 中的配置，因此更改服务器名称或路径需要修改默认值并重新构建 bundle。
- **仅支持中文和英文**：语言注册表要求 `zh` 和 `en`；其他语言按键回退到英文。只有在有人能够担保译文时才添加新语言。
- **结果不在 Session 日志中**：重新加载后显示的是每位申请人的当前状态，而不是此卡片的哪些写入成功。
- **登录是一个链接**：卡片不承载登录表单。它在新标签页中打开 `signInUrl`，员工返回卡片后选择重试。
- **仅限同源**：卡片依赖员工的会话 Cookie 和反向代理；没有跨源模式。
- **工具服务在内存中保存批次 15 分钟**：工具服务重启后，卡片会报告批次已过期，模型必须重新准备。
- **未被浏览器冒烟测试或重放的端到端测试套件覆盖**：该包具有单元、组件和插件注册规范，覆盖率为 100%，但没有 `test:web` 场景。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

本卡片服务于 CInHEd 员工 AI 平台；设计及写入路径的理由记录在该项目的 `dev-journal/decisions/ai-platform-design.md` 中。此处内容不打算上游化。

</details>
