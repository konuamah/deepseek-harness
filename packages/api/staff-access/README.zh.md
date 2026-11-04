---
description: "通过向 Django 询问会话 Cookie 的所有者来认证员工 Remote 连接，并将结果短暂缓存。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-staff-access

[English](README.md) | 中文

## 概要

通过向 Django 询问会话 Cookie 的所有者来认证员工 Remote 连接，并将结果短暂缓存。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

使用 `createDjangoStaffAuthenticator({ baseUrl, roles })` 创建认证器，然后用 Remote 连接的请求头调用 `authenticate(headers)`。它会解析为 `{ kind: 'allow', identity }` 或 `{ kind: 'deny', reason }`，且从不抛出异常。

Django 契约为 `GET {baseUrl}/api/v1/users/me/`。仅转发指定的会话 Cookie，并附带 `Accept: application/json`。响应体必须包含四个字段：`id`（整数）、`role`（字符串）、`two_factor_required` 和 `two_factor_satisfied`（布尔值）。

| 决定 | 含义 |
| --- | --- |
| `allow` | 会话有效，需要双因素时已满足，且角色在 `roles` 中。 |
| `no-cookie` | 会话 Cookie 缺失或为空。不调用 Django。 |
| `rejected` | Django 返回 401 或 403。缓存 `failureTtlMs`。 |
| `two-factor` | 需要双因素认证，但尚未完成。缓存 `failureTtlMs`。 |
| `wrong-role` | 角色不在 `roles` 中。缓存 `failureTtlMs`。 |
| `unavailable` | 其他所有情况：网络错误、超时、其他状态码、JSON 格式错误或响应体无效。 |

失败即关闭：只有返回 200 且响应体有效才会允许。其余情况一律拒绝。

Cookie 值从不记录日志。缓存键是 Cookie 值的 SHA-256 十六进制摘要。

使用 `ownersFile`（所有者 JSON 文件的路径）和 `djangoBaseUrl`（Django 源，例如 `https://django.example`）挂载员工访问插件。未提供非空的 `ownersFile` 时，插件拒绝挂载；`djangoBaseUrl` 不是 http 或 https 源（不得含路径、查询或凭据）时同样拒绝。可选设置：`cookieName`（默认 `sessionid`）、`roles`（默认 `ADMISSIONS_MANAGER` 与 `ADMISSIONS_OFFICER`）、`ttlMs`（默认 60 000）和 `sweepIntervalMs`（默认 30 000）。设置无效时，挂载即抛出异常。它将所有者索引作为 `staffSessions.owners` 提供，在 Remote 访问服务上注册 `staff` 策略，并提供 `externalPeerAdmission`，为每位员工用户授予键为 `staff:<userId>` 的非所有者 Peer。本包尚未在任何地方挂载该插件。

插件同时通过 [session-controller](../session-controller/README.zh.md) 的 `api-session/create-request` 与 `api-session/created` 事件处理员工的 `session.create`。员工请求只保留 `agentPreset`，并被替换为 `staff`，其余字段一律拒绝：`SessionCreateRequest` 只有 `sessionId`、`cwd`、`workspaceId` 与 `agentPreset`，没有消息、标题、模型、提供方或附件字段，因此允许列表只有 `agentPreset`。复用范围收窄为同一用户拥有的空白 Session。Session 创建后，调用者被记为所有者，并调用 `remoteAccess.invalidate` 刷新该用户的绑定。记录所有者失败时，创建失败，新建的 Session 被释放。

<a id="understand-the-implementation"></a>
## 理解实现

结果缓存在内存中：`allow` 保存 `ttlMs`（默认 60 000 毫秒），除 `no-cookie` 外的所有拒绝结果保存 `failureTtlMs`（默认 5 000 毫秒）。较短的拒绝缓存时间让完成双因素认证的用户无需等待一分钟即可恢复访问。缓存最多保存 1000 条，已满时淘汰最旧的一条。同一 Cookie 的并发调用共享一次上游请求。`invalidateUser(userId)` 会丢弃该用户已缓存的 allow 决定。

已知限制：`invalidateUser` 不会取消已在进行中的请求，因此该请求的结果仍可能在调用之后被缓存。

员工调用方是 `StaffPrincipal`，即 `{ kind: 'staff', userId, role }`，由 `staffPrincipal(identity)` 构建。它不包含 Cookie、邮箱或姓名，且每个字段逐一复制。

准入按用户 ID 保存最近一次通过认证的会话 Cookie 值及其角色。Cookie 仅保存在内存中，从不记录日志，撤销或释放时丢弃。最多保存 1000 名用户；再准入一名用户时，撤销最久未准入的用户。撤销某用户时，会使用命令的取消参数取消该用户所拥有 Session 的正在运行的轮次，释放键为 `staff:<userId>` 的 Peer，使该用户的访问绑定失效，并丢弃 Cookie。即使较早的步骤抛出异常，其余步骤仍会全部执行；失败汇总为一个错误，该错误指明用户且不含 Cookie，再次撤销是安全的。

以下情况会触发撤销：对已保存 Cookie 的请求被拒绝；Cookie 改为指向另一用户或另一角色；以及巡检重新校验失败。每隔 `sweepIntervalMs`，巡检会丢弃每位已保存用户缓存的 allow 决定，并再次向 Django 校验 Cookie。拒绝、双因素步骤未完成、角色不在 `roles` 中，或 Django 失败（例如 500 或超时），都会撤销该用户，因此 Django 失败时采取失败即关闭策略。身份或角色已变化的用户会被撤销，并在其下一次请求时以新身份重新准入。巡检定时器不保持进程存活，插件释放时停止。

所有者索引将每个会话的员工所有者记录在一个 JSON 文件中，格式为 `{ "version": 1, "owners": { "<sessionId>": <userId> } }`。文件不存在时视为空索引。文件损坏、版本不符或所有者条目格式错误时，创建索引会抛出以 `staff-access: owner file` 开头的错误，因此索引绝不会从一份被静默清空的记录开始。每次写入先写入同一目录中的临时文件，执行 fsync，然后重命名覆盖原文件；内存中的副本只在重命名成功后才更新。一个会话只有一个所有者：记录不同的所有者会抛出错误，重复记录同一所有者则不执行任何操作。`ownerOf` 先检查会话本身，再向上检查最多 8 层父会话，因此子会话继承其最近的有所有者祖先的所有者；第九层祖先永远不计入。`sessionsOf` 只列出用户直接拥有的会话。

员工策略默认拒绝。每位员工持有一个全局角色，并且对其直接拥有的每个会话持有一个会话级角色。全局角色允许 `session/list`、`session/create`、`commands/list`、`workspace/follow` 和 `session/control`。会话级角色允许 `commands/list`、`goals/get`、`skills/list`、`session/list`、`session/prompt`、`session/cancel`、`session/follow`、`session/page`、`session/projections`、`session/observeProjections`、`session/observeEvent`、`session/observeState`、`session/state`、`session/events`、`session/wait`、`session/attachment`、`session/rename`、`session/updateQueue`、`toolResults/watch`，以及五个事件 `event:api-session/activity`、`event:api-session/added`、`event:api-session/error`、`event:api-session/removed` 和 `event:api-session/status`。会话级角色在每次决定时都重新检查所有权。除此之外不绑定任何内容。

有意拒绝、且任何地方都没有绑定的项：`fileUploads/upload`、`session/modelCatalog`、`llm/listProviders`、`llm/listConfigurableProviders`、`session/selectModel`、`session/search`、`session/fork`、`session/openWorkspacePath`、`session/canOpenWorkspacePath`，以及所有账户、凭据、设置、终端、工作区文件、目录选择器、插件管理器、计划任务和作业方法，还有任何未知方法。本包不保存被拒名称列表；拒绝即没有绑定。

Web 客户端的启动调用必须在集成步骤中对照此允许列表进行检查；任何不在允许列表中的调用都会被拒绝。按照已审阅的计划，`session/control` 是全局的。如果其 Remote 签名携带会话 ID，Gateway 会解析该资源，除非用户拥有该会话，否则调用被拒绝。

<a id="further-exploration"></a>
## 延伸阅读

[架构文档](../../../docs/architecture.zh.md)说明 Remote 连接如何到达各个认证器。

<a id="model-experience"></a>
## 模型体验

无。本包决定员工 Remote 连接的访问权限，不注册任何面向模型的内容。

#### KV 缓存影响

无直接影响。

## 已知限制与待办工作
<a id="known-limitations-and-deferred-work"></a>

- `invalidateUser` 不会丢弃已在进行中的请求。
- 撤销步骤抛出异常时只会报告，不会重试。Peer 或正在运行的轮次可能保持有效，直到 Host 重启。
- 每位用户只保存最近一次通过认证的 Cookie。同一用户的另一浏览器会话不会被单独跟踪，因此其后续被拒绝不会撤销该用户。
- Django 故障会撤销所有已保存用户。Django 恢复后，他们会在下一次请求时重新准入。
- 缓存只存在于单个进程中，不在多个 Host 实例之间共享。
- `session/create` 不会记录新会话的所有者；集成步骤必须调用 `staffSessions.owners.record`。
- 子代理子会话只有在提供 `parentOf` 时才由 `ownerOf` 覆盖，而插件目前尚未提供它。
- `workspace/follow` 不为员工列出任何工作区，因为不存在工作区绑定。
- 插件尚未在任何地方挂载。
- Web 客户端的启动调用尚未对照允许列表检查；不在列表中的调用都会被拒绝。
