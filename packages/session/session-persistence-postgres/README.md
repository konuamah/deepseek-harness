---
description: "The Postgres session-persistence backend for shared multi-user chat storage with database-backed staff ownership, schema migrations, and leased writers."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-postgres

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-postgres` stores Session headers and contiguous event logs in one shared Postgres database with a dedicated login. It implements the same persistence handles as the JSONL backend, creates and migrates its own tables at startup, and latches unavailable after an infrastructure failure instead of falling back to files. A Session row can carry a Django owner id, making the database the only durable staff ownership authority. Choose it when several staff users share one Harness process and chats must live in a server database. Ordinary single-user profiles stay on `dsh-session-persistence-jsonl`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it instead of the JSONL backend. The connection string comes from the deployment environment; never commit it.

```yaml
- name: '@deepseek-ai/dsh-session-persistence-postgres'
  config:
    connectionString: !!js process.env.DSH_CHAT_DATABASE_URL
```

| Field | Default | Meaning |
|---|---|---|
| `connectionString` | required | Login for the dedicated chat database; never logged |
| `maxConnections` | `10` | Largest pooled connection count |
| `connectionTimeoutMs` | `5000` | Bound on opening one connection |
| `queryTimeoutMs` | `10000` | Bound on one query and each acquired client's statement timeout |
| `leaseMs` | `30000` | Writer lease lifetime measured by database time |
| `renewIntervalMs` | `10000` | Lease renewal interval; must be shorter than `leaseMs` |
| `healthIntervalMs` | `15000` | Independent `SELECT 1` monitoring interval |
| `migrationLockTimeoutMs` | `10000` | Bound on waiting for another instance's startup migration |
| `applicationName` | `'dsh-harness'` | `application_name` reported to Postgres |
| `retentionDays` | `90` | Delete chats whose last activity is older than this many days |
| `retentionIntervalMs` | `3600000` | Interval between retention sweeps |
| `retentionBatchSize` | `1000` | Largest number of chats one sweep deletes |

The [`staff-postgres` overlay](../../bundle/web-app/overlays/staff-postgres.patch.yml) composes this backend with database-backed staff ownership and disables the JSONL provider and the durable projection cache.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-postgres) is the exhaustive source for every accepted field.

### Deployment requirements

- Use the chat database's own login, not Django's database login. The login needs only `CONNECT` on its database and read/write on the `dsh_*` tables; it never needs database or role administration.
- Provide the connection string through the environment. The provider never writes it to a Session, log line, or diagnostic.
- Do not point this plugin at Django data. It owns only `dsh_sessions`, `dsh_session_events`, and `dsh_schema_migrations`.
- A startup failure prevents the plugin from loading. In the staff composition, `session-persistence-postgres` and `staff-access` are required boot entries, so a missing plugin stops startup instead of warning.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Tables and migrations

The provider creates a migration-version record and two data tables:

- `dsh_sessions` holds the Session id, optional owner id, serialized header text, inherited prefix length, event count, monotonic revision, materialization flag, and the current writer lease.
- `dsh_session_events` holds ordered `(session_id, seq)` rows with JSON payload text.

Migrations run in one transaction behind a transaction-scoped Postgres advisory lock, so concurrent starts serialize. A recorded schema newer than this build refuses startup. Payloads use `text`, not `jsonb`, because `jsonb` rejects escaped Unicode NUL while the logical Session format accepts it.

### Writers and durability

Creating a Session inserts its row and owner in one transaction; the row is visible only to the creating process until its first append or flush materializes it, matching the seam's lazy-visibility rule. A writer holds a row-fenced lease renewed from database time. Every append transaction verifies the lease token and expiry, appends contiguous event rows, advances the event count and revision, and refreshes the lease before commit. A stale handle cannot write after another instance takes over; it rejects with `SessionOwnershipLostError`. `flush` is the durability barrier, and service-wide `flush` drains every routed write handle.

### Availability

A connection, query, migration, commit, or renewal failure latches the provider `failed` for the rest of the process. Reads, writes, stats, listings, and staff admission refuse immediately, and a sanitized error explains that a restart is required and an in-flight write may have an unknown outcome. An independent health query detects loss even while warm Sessions bypass storage. Ordinary duplicate-id, contention, and validation refusals do not latch it.

### Retention

A sweep runs at startup and then on `retentionIntervalMs`. It deletes whole Sessions whose `updated_at` is older than `retentionDays`, cascading to their event rows and dropping their ownership view entries. Each sweep deletes at most `retentionBatchSize` Sessions, so a large backlog clears across ticks. A Session with a live writer lease is skipped even if its activity is older than the window. Attachments, output spills, exports, and any externally configured durable projection checkpoints are outside this database and are not deleted by the sweep; the staff overlay keeps the projection cache disabled and SQLite unopened.

### Staff ownership

`ctx.sessionOwnership` exposes the synchronous ownership read view staff policy uses, plus a create-time reservation. A staff create reserves the exact Session id before the storage insert; the provider consumes the reservation synchronously and writes the owner in the create transaction. A missing reservation creates an unowned row, which is how a loopback administrator's non-staff Session stays outside staff access. Ownership is published to the in-memory view only after commit; `verify` reads the committed row again before the create is announced.

<a id="model-experience"></a>
## Model Experience

### Stored conversation history

#### What the model sees

This backend contributes no live prompt or schema. On `resume` it restores the stored `SessionHeader` and contiguous `SessionEvent` log, so the model sees the same history it saw when the turn was written; the current loop composes its own envelope exactly as it does over JSONL.

#### Token effect

Zero live-request tokens from storage. A resumed agent pays for retained history and its current envelope, unchanged by the storage backend.

#### KV Cache effect

Storage location does not change request construction, so the package neither extends nor invalidates a reusable prompt prefix; reads and appends do not rewrite earlier logical events.

## Known Limitations and Deferred Work

- Attachments, output spills, exports, and other content-bearing sinks are not moved into Postgres by this plugin.
- No importer for existing JSONL logs and no deletion of old files; existing chats remain on disk and are never read by this composition.
- Retention covers chat logs and ownership rows only; attachments, spills, exports, and externally configured projection checkpoints are not deleted.
- Cross-user isolation is enforced by staff access policy over this provider's ownership view; the provider itself lists every stored Session.
- The plugin does not provision the database, login, or grants.
- A write open reads and validates the whole stored log; a very large Session pays that cost once per open.
- A crashed writer's unmaterialized row becomes reusable only after its lease expires; a live but wedged writer keeps its lease until the process exits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
