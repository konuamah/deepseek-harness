---
description: "CInHEd 工具服务六个 prepare 工具的网页确认卡片：显示已准备的批次和姓名，允许员工修改原因，并在点击后写入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ai-confirm

[English](README.md) | 中文

## Summary

`dsh-client-ui-ai-confirm` 将 CInHEd 工具服务的 `prepare_approve`、`prepare_reject`、`prepare_request_documents`、`prepare_cancel`、`prepare_verify_document` 和 `prepare_reject_document` 工具的结果渲染为确认卡片。卡片使用员工本人的会话加载已准备的批次以及每份申请或材料所属申请人的姓名，允许员工修改原因；点击确认后，它会铸造一个短期写入令牌，使用掉该批次，并逐条写入记录。prepare 结果不含姓名；读取工具结果可以包含申请人的名和姓。写入令牌、浏览器加载的姓名和写入结果不会提供给模型。

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
| `serverName` | `cinhed` | 工具服务 MCP 条目的 `serverName`。卡片注册为 `mcp__<serverName>__prepare_approve`、`..._prepare_reject`、`..._prepare_request_documents`、`..._prepare_cancel`、`..._prepare_verify_document` 和 `..._prepare_reject_document`。两张只读卡片注册为 `mcp__<serverName>__list_applications` 和 `mcp__<serverName>__get_application`。 |
| `toolsPath` | `/tools/pending` | 反向代理转发到工具服务待处理批次路由的页面路径。 |
| `apiPath` | `/api/v1` | 反向代理转发到 Django API 的页面路径。 |
| `signInUrl` | `/login` | 使用账号、密码和双因素认证登录员工的页面。在新标签页中打开。 |

浏览器为每个客户端行创建时不带配置，因此 `cordis.yml` 中的 `config:` 块永远不会传给此插件。这些默认值在构建时固定。工具服务必须以名为 `cinhed` 的 MCP 服务器接入；如需更改设置，请修改 `src/client/index.ts` 中的默认值并重新构建包的 bundle。

加载时会检查这三个路径：每个都必须是页面自身源上的绝对路径，因此卡片绝不会调用或链接到其他站点。这适用于默认值以及传给 `Config` 的任何值。

### 员工看到的内容

申请卡片和确认卡片会直接显示在对话中，带有浅色标题栏，并将记录、文件和操作分区显示。在窄屏上，申请表格可横向滚动，而文件链接保持原位。卡片默认展开，并可在当前会话中折叠。折叠只隐藏卡片详情，不会移除任何行；此选择不会保留到其他会话。同一轮中，当后面已加载的卡片显示了先前查询卡片所显示的全部申请时，先前的查询卡片会隐藏，因此单个申请的流程最终只保留一张卡片。已准备的批次会显示每条记录的姓名、编号、项目，以及每条记录将获得的变更（例如"Under review → Approved"）。工具服务跳过的记录会列出其原因。拒绝、请求材料和拒收材料的操作会显示一个原因字段，初始内容为 AI 的草稿。请求材料或拒收材料时，原因为空则无法确认。

取消申请、核验材料和拒收材料会多显示一行警告：取消申请无法撤销，且不会通知申请人；核验或拒收材料会通过电子邮件通知申请人，拒收时原因会按原文发送，申请状态可能变为“需补交材料”。材料批次中的编号是材料编号，每行显示姓名、编号、材料类型和状态变更（例如“Pending review → Verified”），数据来自仅限员工的材料摘要调用。申请人上传文件和官方文件均提供“下载”链接；支持预览的文件还提供“查看”链接。姓名为空或看起来像电子邮件地址时，显示为破折号。

确认按以下顺序执行：检查登录状态并铸造写入令牌，使用掉该批次，然后一次写入一条记录。每条记录都有自己的结果（已变更，或 Django 拒绝的原因）。取消会使用掉该批次但不写入。已过期、已使用或无法加载的批次会安静地说明情况，并显示每位申请人的当前状态；只有当所有记录都达到所请求的状态时，才会说明这一状态。真正的失败（未登录、无权限或系统无响应）会显示一个小的警告标记，并以警示（alert）形式播报给辅助技术；已关闭或已取消的请求则保持安静，不播报。

### 申请列表卡片

`list_applications` 和 `get_application` 的结果会显示为紧凑的表格，包含姓名、编号、状态和专业。AI 工具结果可以包含申请人的名和姓；浏览器也会独立使用员工本人的会话，从 `apiPath` 下仅限员工使用的申请摘要接口加载姓名。只有单条结果的 `get_application` 卡片还会从仅限员工使用的申请文件接口列出申请人上传文件和官方文件，并标记上传文件状态及尚未发布的官方文件。支持预览的文件会在新标签页中打开原生预览，下载使用单独的链接。文件元数据只保留在浏览器 store 中。卡片只读取摘要响应中每条记录的 id 和姓名，每次调用只请求一次（最多 25 个 id），姓名只保存在卡片的内存 store 中。看起来像电子邮件地址的姓名不会显示。

卡片会柔性降级。姓名加载期间，各行不带姓名显示。如果无法加载姓名（未登录、已过期、不可用），表格仍保留编号、状态和专业，并增加一行提示，附带"重试"按钮。结果不是格式正确的申请列表，或为错误时，不渲染任何内容。

### 代理要求

卡片在页面自身的源上调用工具服务和 Django，因此员工的会话 Cookie 随每次调用发送，且没有凭据经过 harness。反向代理必须将 `toolsPath` 转发到工具服务，将 `apiPath` 转发到 Django，并且与提供 harness 的主机相同。不支持跨源使用。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

`apply` 注册一对词典（`zh`、`en`）、一个用于显示申请卡片和确认卡片的 `conversation.chat.node` 渲染器，以及每个 prepare 工具和只读工具对应的空 `tool.call.toolview` 条目，以避免重复显示卡片。节点渲染器接收 API、服务器名称和登录路径；卡片定义按配置的服务器名称派生出的确切线缆名称匹配调用。卡片会直接显示在对话轮次中，并且只在当前会话内可折叠。节点渲染器和卡片共享一个已声明的 Session store。该包只导出 `apply`、`inject` 和 `Config`。

### Flow

`controller.ts` 以普通函数形式承载流程，这些函数作用于网络面和 store：`openCard`、`confirmCard`、`cancelCard`。先铸造令牌意味着未登录或双因素未完成的会话会在批次被使用前失败，因此登录后重试仍可成功。其次使用掉批次意味着已过期或已使用的批次永远不会写入。`api.ts` 将每个失败归类为 `sign-in`、`expired`、`refused` 或 `unavailable`；唯一传递的响应文本是 Django 对单条写入的拒绝原因。

### State

store 按工具服务的待处理操作 id 保存每个批次的阶段、正在编辑的原因、已加载的姓名以及每次写入的结果。卡片在确认过程中重新挂载时仍会显示进度，且确认会继续运行，因为流程由控制器持有，而非组件。结果不写入 Session 日志：重新加载后，卡片会从 Django 读回每位申请人的当前状态。申请列表卡片的姓名保存在同一个 store 中，以日志中的调用 id 为键。

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

六个 prepare 工具的结果由工具服务写入，并以普通工具输出的形式到达模型：`pendingActionId`、带状态的 `eligible` 和 `skipped` 记录编号，以及 `expiresAt`；这些结果不含姓名或申请人的自由文本。读取工具的结果可以包含申请人的名和姓。确认、写入令牌、浏览器加载的姓名以及每次写入的结果都保留在浏览器和 Django 中，因此模型只有在之后调用读取工具时，才能得知员工是否确认。

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
- **浏览器重放不执行写入**：无需密钥的 `staff-cards` 场景通过真实 Web 组合和模拟员工 API 覆盖内联读取及准备操作卡片，但不确认后端写入。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

本卡片服务于 CInHEd 员工 AI 平台；设计及写入路径的理由记录在该项目的 `dev-journal/decisions/ai-platform-design.md` 中。此处内容不打算上游化。

</details>
