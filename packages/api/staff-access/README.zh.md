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

使用 `ownersFile`（所有者 JSON 文件的路径）挂载员工访问插件。未提供非空的 `ownersFile` 时，插件拒绝挂载。它将所有者索引作为 `staffSessions.owners` 提供，并在 Remote 访问服务上注册 `staff` 策略。本包尚未在任何地方挂载该插件。

<a id="understand-the-implementation"></a>
## 理解实现

结果缓存在内存中：`allow` 保存 `ttlMs`（默认 60 000 毫秒），除 `no-cookie` 外的所有拒绝结果保存 `failureTtlMs`（默认 5 000 毫秒）。较短的拒绝缓存时间让完成双因素认证的用户无需等待一分钟即可恢复访问。缓存最多保存 1000 条，已满时淘汰最旧的一条。同一 Cookie 的并发调用共享一次上游请求。`invalidateUser(userId)` 会丢弃该用户已缓存的 allow 决定。

已知限制：`invalidateUser` 不会取消已在进行中的请求，因此该请求的结果仍可能在调用之后被缓存。

员工调用方是 `StaffPrincipal`，即 `{ kind: 'staff', userId, role }`，由 `staffPrincipal(identity)` 构建。它不包含 Cookie、邮箱或姓名，且每个字段逐一复制。

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
- 缓存只存在于单个进程中，不在多个 Host 实例之间共享。
- `session/create` 不会记录新会话的所有者；集成步骤必须调用 `staffSessions.owners.record`。
- 子代理子会话只有在提供 `parentOf` 时才由 `ownerOf` 覆盖，而插件目前尚未提供它。
- `workspace/follow` 不为员工列出任何工作区，因为不存在工作区绑定。
- 插件尚未在任何地方挂载。
- Web 客户端的启动调用尚未对照允许列表检查；不在列表中的调用都会被拒绝。
