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

Mount the staff access plugin with `ownersFile`, the path of the owner JSON file, and `djangoBaseUrl`, the Django origin such as `https://django.example`. The plugin refuses to mount without a non-empty `ownersFile`, and refuses a `djangoBaseUrl` that is not an http or https origin (no path, query, or credentials). Optional settings: `cookieName` (default `sessionid`), `roles` (default `ADMISSIONS_MANAGER` and `ADMISSIONS_OFFICER`), `ttlMs` (default 60 000), `sweepIntervalMs` (default 30 000), `logDenied` (default `false`), `workspaceDir` (default `staff-workspace` under the Harness home), and `toolServerName` (default `cinhed`). An invalid setting throws when the plugin mounts. It provides the owner index as `staffSessions.owners`, registers the `staff` policy on the Remote access service, and provides `externalPeerAdmission`, the admission that gives each staff user a non-owner Peer keyed `staff:<userId>`. The web bundle lists the plugin as row `staff-access` with `disabled: true`, so it stays off until a profile overlay enables it:

```yaml
- id: staff-access
  disabled: false
  config:
    djangoBaseUrl: http://127.0.0.1:8000
    ownersFile: /absolute/path/to/staff-owners.json
```

Pass the overlay with `dsh web --patch <overlay.yml>`. The overlay restates the whole `config`, so list every key the row owns.

With `logDenied: true`, each Remote call or event that the staff policy refuses for a staff user is written to the stderr of the Host process, the terminal that started `dsh web`, as `<timestamp> staff-access: denied <method> for user <id>`, followed by ` on <kind>:<id>` when the refusal names a resource (`on global` for the global resource), once per method, user, and resource per process. The plugin's own exporter prints only this logger's lines, so other output is unchanged. Each line carries the endpoint, the numeric user id, and the refused resource's kind and id only. Arguments, cookies, and results are never printed, and the owner is never printed. The remembered pairs are capped at 2000; the oldest is forgotten first.

The plugin also admits staff Session creation through the `api-session/create-request` and `api-session/created` events of [session-controller](../session-controller/README.md). A staff `session.create` keeps `agentPreset`, which is replaced with `staff`, and `workspaceId`, which must equal the shared staff Workspace or be omitted; an omitted `workspaceId` is filled with the shared id. `sessionId` is kept only when the caller owns that Session, which lets the client reuse its own blank Session; `cwd` and every other field are refused, and a create before the shared Workspace is registered is refused. Reuse is narrowed to blank Sessions the same user owns. After the Session exists, the caller is recorded as its owner and `remoteAccess.invalidate` refreshes that user's bindings. A recording failure fails the create and disposes the new Session.

The plugin also provides the Cordis service `mcpHeaders`, which the mcp-client package reads. For the MCP server named by `toolServerName` (default `cinhed`; letters, digits, `_`, and `-` only) it returns `{ Authorization: 'Bearer <token>' }`, where the token is a Django AI read token minted for the user who owns the calling Session (`createAiTokenProvider`); for any other server it returns `{}` and mints nothing. The provider takes the owner from the owner index, so a child Session uses its parent's owner, and mints with that user's held session cookie only: `GET /api/v1/users/csrf-token/`, then `POST /api/v1/ai/token/` with `{"kind":"read"}`, the cookie, the CSRF token, and `Origin` and `Referer` set to the Django origin, with redirects refused and a 3 000 ms timeout. Tokens are cached per user id (at most 1000 users), reused while they stay valid for at least 60 s, and minted once at a time per user. If the Session has no owner, no cookie is held, or Django answers anything but a valid 200, the call fails with `staff-access: sign in again`; the message never carries a token, cookie, or CSRF value, nothing is cached, and the next call tries again. A revoke drops the user's cached token and discards a mint still in flight.

<a id="understand-the-implementation"></a>
## Understand the implementation

Results are cached in memory: `allow` for `ttlMs` (default 60 000 ms), and every deny except `no-cookie` for `failureTtlMs` (default 5 000 ms). A short deny lifetime lets a user who finishes two-factor authentication regain access without waiting a minute. The cache holds at most 1000 entries; when full, the oldest entry is evicted. Concurrent calls for the same cookie share one upstream fetch. `invalidateUser(userId)` drops that user's cached allow decisions.

Known limitation: `invalidateUser` does not cancel a fetch already in flight, so its result can still be cached after the call.

A staff caller is a `StaffPrincipal`, `{ kind: 'staff', userId, role }`, built by `staffPrincipal(identity)`. It carries no cookie, email, or name, and each field is copied one by one.

Admission holds, per user id, the session cookie value that last authenticated, and the role it had. The cookie is held in memory only, is never logged, and is dropped on revoke or dispose. At most 1000 users are held; admitting one more revokes the least recently admitted user. A revoke for a user cancels the running turns of the Sessions the user owns with the command's cancel arguments, disposes the `staff:<userId>` Peer, invalidates the user's access bindings, and drops the cookie. Every step runs even when an earlier one throws; the failures are reported as one error that names the user and omits the cookie, and a second revoke is safe.

A revoke runs when a request for a held cookie is denied, when the cookie now names another user or another role, and when a sweep re-check fails. Every `sweepIntervalMs`, the sweep drops each held user's cached allow decision and checks the cookie with Django again. A denial, a two-factor step still open, a role outside `roles`, or a Django failure such as a 500 or a timeout revokes the user, so Django failures fail closed. A user whose identity or role changed is revoked and admitted again with the new identity on their next request. The sweep timer is unreferenced and stops when the plugin is disposed.

The owner index records which staff user owns each Session in one JSON file, `{ "version": 1, "owners": { "<sessionId>": <userId> } }`. A missing file is an empty index. A corrupt file, an unexpected version, or a malformed owner entry makes creation throw an error that starts with `staff-access: owner file`, so the index never starts from a silently empty record. Each write goes to a temp file in the same directory, is fsynced, and is renamed over the file; the in-memory copy changes only after the rename succeeds. A Session has one owner: recording a different owner throws, and recording the same owner again does nothing. `ownerOf` checks the Session and then up to 8 parent Sessions, so a child Session inherits the owner of its nearest owned ancestor, and a ninth ancestor never counts. `sessionsOf` lists only the Sessions a user owns directly.

The staff policy denies by default. Every staff user holds one global role and, for each Session the user owns directly, one per-Session role. The global role allows `session/list`, `session/create`, `commands/list`, `workspace/follow`, `session/control`, and the three read-only metadata calls `agentPresets/list`, `permissionPresets/catalog`, and `session/modelCatalog`. The per-Session role allows `commands/list`, `goals/get`, `skills/list`, `session/list`, `workspace/follow`, `session/create`, `session/prompt`, `session/cancel`, `session/follow`, `session/page`, `session/projections`, `session/observeProjections`, `session/observeEvent`, `session/observeState`, `session/state`, `session/events`, `session/wait`, `session/attachment`, `session/rename`, `session/updateQueue`, `toolResults/watch`, and the five events `event:api-session/activity`, `event:api-session/added`, `event:api-session/error`, `event:api-session/removed`, and `event:api-session/status`. The per-Session role re-checks ownership on every decision. `session/list` and `workspace/follow` are in it because those methods filter each item through `allows()` against the current action, so a Session appears in the Session list or in the shared Workspace view only when the role lists that action. `session/create` is in it because a create that names an own blank Session to reuse resolves that Session as a resource; admission still refuses a `sessionId` the caller does not own. Nothing else is bound.

Denied on purpose, with no binding anywhere: `fileUploads/upload`, `llm/listProviders`, `llm/listConfigurableProviders`, `session/selectModel`, `session/search`, `session/fork`, `session/openWorkspacePath`, `session/canOpenWorkspacePath`, `workspace/initializeDefault`, `settings/*`, `credentials/*`, `dynamicCordisRunner/*`, and every account, credentials, settings, terminal, workspace file, directory picker, plugin manager, schedule, and jobs method, plus any unknown method.

The shared staff Workspace is the one Workspace staff callers see. At mount the plugin creates the empty directory `staff-workspace` under the Harness home, or the directory named by `workspaceDir` (an absolute path; an existing directory is accepted only when it is empty or was prepared by this plugin, marked by a `.dsh-staff-workspace` file), and registers it through the Workspace registry. The policy binds that Workspace, and only that Workspace, for `workspace/follow` and `session/create`, so a staff `workspace/follow` lists the shared Workspace and no other, and a create naming another Workspace is refused. Until the registration completes, no Workspace is bound and every staff create is refused. The package keeps no list of denied names; denial is the absence of a binding.

The web client's startup calls must be checked against this allow-list during the integration step; any call not on the allow-list is refused. `session/control` is global per the reviewed plan. `session/follow` and `commands/list` are not global calls: each names one Session (through the request address or the Agent context), so the Gateway checks that Session's resource, and only the per-Session role binds it. A global binding would never apply to them, so they are not in the global role. Their handlers return the one Session the caller names, which the per-Session ownership check already limits to the caller's Sessions. If its Remote signature carries a session id, the Gateway resolves that resource, and the call is denied unless the user owns that Session.

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
- A revoke step that throws is reported, not retried. The Peer or a running turn may stay live until the Host restarts.
- Each user holds only the cookie that last authenticated. A second browser session of the same user is not tracked, so its later denial does not revoke the user.
- A Django outage revokes every held user. They are admitted again on their next request once Django answers.
- The cache is per process and is not shared between Host instances.
- Subagent child Sessions inherit their parent's owner through `ownerOf` only when `parentOf` is supplied. The plugin does not supply `parentOf`, so a subagent child Session has no owner of its own.
- The shared Workspace view that `workspace/follow` sends to staff carries its canonical `path`, under the Harness home. The workspace-controller builds that view and this plugin does not change it, so the path is visible to staff.
- The shared Workspace is a normal registered Workspace, so the owner sees it in the list. Its existence also blocks the owner's automatic first-use default Workspace, because `workspace/initializeDefault` creates one only while no Workspace exists.
- `agentPresets/list`, `permissionPresets/catalog`, and `session/modelCatalog` are allowed without filtering, because the handlers do not call `allows()` on their items and staff-access has no hook to filter their replies. Staff can read: the id, default flag, display name, description, and activation-failure text of every agent preset, including the tool presets; the option names, descriptions, sandbox and approval mode names, and default preset of the permission catalog; and the provider ids and names, model ids, names, descriptions, reasoning efforts, and default selection of the model catalog, plus each provider's listing failure message. These replies carry no keys, server paths, or tool lists, but a failure message or activation-failure text may contain provider or configuration text that was not written for staff.
- The web client's startup calls are not yet checked against the allow-list; any call not on it is refused.
- `logDenied` does not print items that `allows()` filters out of a list, because no call is refused.
- A minted AI token stays valid for up to 15 minutes after a revoke, because Django tokens are stateless; the revoke only stops new tokens and drops the cached one.
