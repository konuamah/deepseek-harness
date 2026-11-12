---
description: "面向共享多用户聊天存储的 Postgres Session 持久化后端，提供数据库端员工归属、模式迁移与租约写入者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-postgres

[English](README.md) | 中文

## 概述

`dsh-session-persistence-postgres` 使用一个独立的数据库登录，将 Session 头部与连续事件日志存储在一个共享 Postgres 数据库中。它实现与 JSONL 后端相同的持久化句柄，在启动时创建并迁移自己的表，并在基础设施故障后锁定为不可用，而不是回退到文件。Session 行可带有 Django 所有者 id，使数据库成为唯一的持久员工归属权威。当多个员工共享同一个 Harness 进程、聊天必须存放在服务器数据库时选择它；普通单用户配置继续使用 `dsh-session-persistence-jsonl`。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

用它代替 JSONL 后端挂载。连接字符串来自部署环境，绝不要提交到仓库。

```yaml
- name: '@deepseek-ai/dsh-session-persistence-postgres'
  config:
    connectionString: !!js process.env.DSH_CHAT_DATABASE_URL
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `connectionString` | 必填 | 专用聊天数据库的登录信息，永不写入日志 |
| `maxConnections` | `10` | 连接池最大连接数 |
| `connectionTimeoutMs` | `5000` | 建立单个连接的超时上限 |
| `queryTimeoutMs` | `10000` | 单次查询及每个已获取客户端的语句超时上限 |
| `leaseMs` | `30000` | 以数据库时间计量的写入者租约时长 |
| `renewIntervalMs` | `10000` | 租约续期间隔，必须短于 `leaseMs` |
| `healthIntervalMs` | `15000` | 独立 `SELECT 1` 监控间隔 |
| `migrationLockTimeoutMs` | `10000` | 等待其他实例启动迁移的超时上限 |
| `applicationName` | `'dsh-harness'` | 报告给 Postgres 的 `application_name` |
| `retentionDays` | `90` | 删除最后活动早于该天数的聊天 |
| `retentionIntervalMs` | `3600000` | 保留清理的间隔 |
| `retentionBatchSize` | `1000` | 单次清理最多删除的聊天数 |

[`staff-postgres` 覆盖层](../../bundle/web-app/overlays/staff-postgres.patch.yml)将此后端与数据库端员工归属组合，并禁用 JSONL 提供者和持久投影缓存。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-postgres)是每个可接受字段的完整来源。

### 部署要求

- 使用聊天数据库自己的登录，而不是 Django 的数据库登录。该登录只需其数据库的 `CONNECT` 权限以及 `dsh_*` 表的读写权限，永远不需要数据库或角色管理权限。
- 通过环境变量提供连接字符串。提供者不会把它写入 Session、日志行或诊断信息。
- 不要把这个插件指向 Django 数据。它只拥有 `dsh_sessions`、`dsh_session_events` 和 `dsh_schema_migrations`。
- 启动失败会阻止插件加载。在员工组合中，`session-persistence-postgres` 和 `staff-access` 是必需的启动项，因此缺少插件会阻止启动而不是发出警告。

<a id="understand-the-implementation"></a>
## 理解实现

### 表与迁移

提供者创建一个迁移版本记录和两个数据表：

- `dsh_sessions` 保存 Session id、可选所有者 id、序列化头部文本、继承前缀长度、事件计数、单调修订号、物化标志以及当前写入者租约。
- `dsh_session_events` 保存有序的 `(session_id, seq)` 行，载荷为 JSON 文本。

迁移在一个事务中、于事务级 Postgres 咨询锁之后运行，因此并发启动会串行化。记录的数据库模式版本高于本构建时拒绝启动。载荷使用 `text` 而非 `jsonb`，因为 `jsonb` 会拒绝转义 Unicode NUL，而逻辑 Session 格式允许它。

### 写入者与持久性

创建 Session 时在一个事务中插入其行和所有者；该行在首次 append 或 flush 物化之前只对创建进程可见，符合存储接口的惰性可见性规则。写入者持有以数据库时间续期的行级隔离租约。每个 append 事务验证租约令牌和过期时间，追加连续事件行，推进事件计数和修订号，并在提交前刷新租约。另一个实例接管后，过期句柄无法写入，并以 `SessionOwnershipLostError` 拒绝。`flush` 是持久性屏障，服务级 `flush` 会排空每个已路由的写入句柄。

### 可用性

连接、查询、迁移、提交或续期失败会把提供者在本进程余下时间内锁定为 `failed`。读取、写入、stat、list 和员工准入立即拒绝，并给出经过清理的错误，说明需要重启且进行中的写入结果可能未知。独立健康查询即使热 Session 绕过存储也能发现丢失。普通的重复 id、争用和校验拒绝不会触发锁定。

### 保留清理

启动时以及随后每个 `retentionIntervalMs` 运行一次清理。它删除 `updated_at` 早于 `retentionDays` 的整个 Session，级联删除事件行，并从归属视图中移除条目。每次清理最多删除 `retentionBatchSize` 个 Session，因此大量积压会跨多个周期清除。即使活动时间早于窗口，持有活动写入者租约的 Session 也会被跳过。附件、输出溢出、导出以及任何外部配置的持久投影检查点不在该数据库中，清理不会删除它们；员工覆盖层保持投影缓存禁用且不打开 SQLite。

### 员工归属

`ctx.sessionOwnership` 暴露员工策略使用的同步归属读取视图，以及创建时预留。员工创建在存储插入之前预留确切的 Session id；提供者在创建事务中同步消费预留并写入所有者。缺少预留会创建无所有者行，回环管理员的非员工 Session 因此不会进入员工访问。归属只在提交后发布到内存视图；`verify` 在宣布创建之前再次读取已提交行。

<a id="model-experience"></a>
## 模型体验

### 已存储的对话历史

#### 模型看到什么

此后端不贡献实时提示或模式。`resume` 时它还原已存 `SessionHeader` 与连续 `SessionEvent` 日志，因此模型看到的历史与写入该轮次时相同；当前循环与使用 JSONL 时一样组合自己的请求信封。

#### Token 影响

存储贡献零实时请求 token。恢复的 agent 仍需为保留的历史和当前信封付费，与存储后端无关。

#### KV Cache 影响

存储位置不改变请求构造，因此本包既不延长也不使可复用提示前缀失效；读取和追加不会重写更早的逻辑事件。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- 本插件不会把附件、输出溢出、导出或其他承载内容的存储移入 Postgres。
- 没有现有 JSONL 日志的导入器，也不会删除旧文件；现有聊天保留在磁盘上，此组合永不读取它们。
- 保留清理只覆盖聊天日志与归属行；附件、溢出、导出和外部配置的投影检查点不会被删除。
- 跨用户隔离由员工访问策略基于本提供者的归属视图执行；提供者本身会列出所有已存 Session。
- 插件不负责创建数据库、登录或授权。
- write open 会读取并校验整个已存日志；超大 Session 每次打开都要付出一次该成本。
- 崩溃写入者未物化的行只会在租约到期后重新可用；仍存活但卡住的写入者会保留租约直到进程退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
