---
kind: upgrade-guide
description: "员工访问新增 `ownership` 模式；Postgres 部署必须挂载新的持久化提供者并移除 `ownersFile`。"
---

# 数据库组合将员工归属移入 Postgres

[English](guide.md) | 中文

## 变更

`staff-access` 现在接受 `ownership: 'file' | 'postgres'`，默认 `file`。file 模式仍要求 `ownersFile`，行为不变，因此只设置 `ownersFile` 的现有 profile 无需修改。postgres 模式禁止 `ownersFile`，并要求新的 `@deepseek-ai/dsh-session-persistence-postgres` 提供者：Session 行的所有者列成为唯一的持久权威，侧文件永不打开，现有侧文件条目也不会被导入。此模式下，员工创建在存储创建之前预留确切的 Session id，并且除非已提交行命名了调用者，否则创建失败。

新提供者也可单独用于替换 JSONL 后端。启用它的部署不得同时挂载 `session-persistence-jsonl`。

## 迁移

1. 选择归属模式。若保持默认 file 模式，不要设置 `ownership`。
2. 使用 Postgres 模式时，在 profile 或 `--patch` overlay 中用新提供者替换 `session-persistence-jsonl`：

   ```yaml
   - id: session-persistence-jsonl
     disabled: true
   - id: staff-access
     disabled: false
     config:
       ownership: postgres
       djangoBaseUrl: https://django.example
   - insert:
       - id: session-persistence-postgres
         name: '@deepseek-ai/dsh-session-persistence-postgres'
         config:
           connectionString: !!js process.env.DSH_CHAT_DATABASE_URL
   ```

   从 `staff-access` 配置中移除 `ownersFile`；保留它会拒绝启动。`packages/bundle/web-app/overlays/staff-postgres.patch.yml` 中的 overlay 是完整示例。
3. 只给 Postgres 登录授予其自身数据库的 `CONNECT` 权限和 `dsh_*` 表权限，不要指向 Django 的数据库。
4. 确认启动时 `session-persistence-postgres` 与 `staff-access` 均为活动条目，然后创建一个员工聊天，并检查第二位员工无法打开它。缺少提供者、持久化名称不匹配或数据库不可达现在会阻止启动，而不是发出警告。
