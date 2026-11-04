---
description: "Authenticates staff Remote connections by asking Django who owns the session cookie, and caches the answer for a short time."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-staff-access

English | [中文](README.zh.md)

## Summary

Authenticates staff Remote connections by asking Django who owns the session cookie, and caches the answer for a short time.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Create an authenticator with `createDjangoStaffAuthenticator({ baseUrl, roles })`, then call `authenticate(headers)` with the Remote connection headers. It resolves to `{ kind: 'allow', identity }` or `{ kind: 'deny', reason }`; it never throws.

The Django contract is `GET {baseUrl}/api/v1/users/me/`. Only the named session cookie is forwarded, with `Accept: application/json`. The response body must carry four fields: `id` (integer), `role` (string), `two_factor_required` and `two_factor_satisfied` (booleans).

| Decision | Meaning |
| --- | --- |
| `allow` | Session is valid, two-factor (if required) is satisfied, and the role is in `roles`. |
| `no-cookie` | The session cookie is missing or empty. Django is not called. |
| `rejected` | Django answered 401 or 403. Cached for `failureTtlMs`. |
| `two-factor` | Two-factor is required but not yet satisfied. Cached for `failureTtlMs`. |
| `wrong-role` | The role is not in `roles`. Cached for `failureTtlMs`. |
| `unavailable` | Anything else: a network error, timeout, other status, malformed JSON or an invalid body. |

Fail closed: only a 200 with a valid body can allow. Everything else denies.

The cookie value is never logged. The cache key is the SHA-256 hex digest of the cookie value.

Mount the staff access plugin with `ownersFile`, the path of the owner JSON file. The plugin refuses to mount without a non-empty `ownersFile`. It provides the owner index as `staffSessions.owners` and registers the `staff` policy on the Remote access service. The package does not mount the plugin anywhere yet.

<a id="understand-the-implementation"></a>
## Understand the implementation

Results are cached in memory: `allow` for `ttlMs` (default 60 000 ms), and every deny except `no-cookie` for `failureTtlMs` (default 5 000 ms). A short deny lifetime lets a user who finishes two-factor authentication regain access without waiting a minute. The cache holds at most 1000 entries; when full, the oldest entry is evicted. Concurrent calls for the same cookie share one upstream fetch. `invalidateUser(userId)` drops that user's cached allow decisions.

Known limitation: `invalidateUser` does not cancel a fetch already in flight, so its result can still be cached after the call.

A staff caller is a `StaffPrincipal`, `{ kind: 'staff', userId, role }`, built by `staffPrincipal(identity)`. It carries no cookie, email, or name, and each field is copied one by one.

The owner index records which staff user owns each Session in one JSON file, `{ "version": 1, "owners": { "<sessionId>": <userId> } }`. A missing file is an empty index. A corrupt file, an unexpected version, or a malformed owner entry makes creation throw an error that starts with `staff-access: owner file`, so the index never starts from a silently empty record. Each write goes to a temp file in the same directory, is fsynced, and is renamed over the file; the in-memory copy changes only after the rename succeeds. A Session has one owner: recording a different owner throws, and recording the same owner again does nothing. `ownerOf` checks the Session and then up to 8 parent Sessions, so a child Session inherits the owner of its nearest owned ancestor, and a ninth ancestor never counts. `sessionsOf` lists only the Sessions a user owns directly.

The staff policy denies by default. Every staff user holds one global role and, for each Session the user owns directly, one per-Session role. The global role allows `session/list`, `session/create`, `commands/list`, `workspace/follow`, and `session/control`. The per-Session role allows `commands/list`, `goals/get`, `skills/list`, `session/list`, `session/prompt`, `session/cancel`, `session/follow`, `session/page`, `session/projections`, `session/observeProjections`, `session/observeEvent`, `session/observeState`, `session/state`, `session/events`, `session/wait`, `session/attachment`, `session/rename`, `session/updateQueue`, `toolResults/watch`, and the five events `event:api-session/activity`, `event:api-session/added`, `event:api-session/error`, `event:api-session/removed`, and `event:api-session/status`. The per-Session role re-checks ownership on every decision. Nothing else is bound.

Denied on purpose, with no binding anywhere: `fileUploads/upload`, `session/modelCatalog`, `llm/listProviders`, `llm/listConfigurableProviders`, `session/selectModel`, `session/search`, `session/fork`, `session/openWorkspacePath`, `session/canOpenWorkspacePath`, and every account, credentials, settings, terminal, workspace file, directory picker, plugin manager, schedule, and jobs method, plus any unknown method. The package keeps no list of denied names; denial is the absence of a binding.

The web client's startup calls must be checked against this allow-list during the integration step; any call not on the allow-list is refused. `session/control` is global per the reviewed plan. If its Remote signature carries a session id, the Gateway resolves that resource, and the call is denied unless the user owns that Session.

<a id="further-exploration"></a>
## Further Exploration

The [architecture](../../../docs/architecture.md) explains how Remote connections reach their authenticators.

<a id="model-experience"></a>
## Model Experience

None, as this package decides staff access for Remote connections and registers nothing model-facing.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- `invalidateUser` does not drop a fetch already in flight.
- The cache is per process and is not shared between Host instances.
- `session/create` does not record the new Session's owner; the integration step must call `staffSessions.owners.record`.
- Subagent child Sessions are covered by `ownerOf` only when `parentOf` is supplied, and the plugin does not supply it yet.
- `workspace/follow` lists no workspaces for staff, because no workspace binding exists.
- The plugin is not mounted anywhere yet.
- The web client's startup calls are not yet checked against the allow-list; any call not on it is refused.
