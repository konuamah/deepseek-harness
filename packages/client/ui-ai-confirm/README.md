---
description: "Web confirm card for the three prepare tools of the CInHEd tool service: shows a prepared batch with names, lets staff edit the reason, and writes after a click."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ai-confirm

## Summary

`dsh-client-ui-ai-confirm` renders the result of the CInHEd tool service's `prepare_approve`, `prepare_reject`, and `prepare_request_documents` tools as a confirm card. The card loads the prepared batch and each application's name with the staff member's own session, lets them edit the reason, and on Confirm mints a short-lived write token, uses the batch up, and writes each record. The model sees only the tool result and never a name, a token, or a write outcome.

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

The row ships `disabled: true` in the Web bundle. Turn it on in the profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`) and name the MCP server that connects the tool service:

```yaml
- id: ui-ai-confirm
  disabled: false
  config:
    serverName: cinhed
```

| Setting | Default | Meaning |
|---|---|---|
| `serverName` | required | `serverName` of the MCP entry for the tool service. The cards register as `mcp__<serverName>__prepare_approve`, `..._prepare_reject`, and `..._prepare_request_documents`. |
| `toolsPath` | `/tools/pending` | Page path a reverse proxy forwards to the tool service's pending-batch routes. |
| `apiPath` | `/api/v1` | Page path a reverse proxy forwards to Django's API. |
| `signInUrl` | `/login` | Page that signs staff in with login and 2FA. Opened in a new tab. |

All three paths are checked at load: each must be an absolute path on the page's own origin, so the card never calls or links to another site.

### What staff see

A prepared batch shows its records with name, reference, program, and the change each will get (for example, "Under review → Approved"). Records the tool service skipped are listed with its reason. Reject and request-documents show a reason field that starts from the AI's draft. A request for documents cannot be confirmed with an empty reason.

Confirm runs in this order: check the sign-in and mint the write token, use the batch up, then write one record at a time. Each record gets its own outcome (changed, or the reason Django refused). Cancel uses the batch up without writing. A batch that expired, was used, or cannot be loaded explains itself and shows each application's current status.

### Proxy requirements

The card calls the tool service and Django on the page's own origin, so the staff session cookie travels with every call and no credential passes through the harness. A reverse proxy must forward `toolsPath` to the tool service and `apiPath` to Django on the same host that serves the harness. Cross-origin use is not supported.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

`apply` registers one dictionary pair (`zh`, `en`) and one `tool.call.toolview` entry per prepare tool, all sharing one declared Session store. Each entry's `inject` face carries the network faces, the action it stands for, and the sign-in path. The package exports only `apply`, `inject`, and `Config`.

### Flow

`controller.ts` holds the flow as plain functions over the network faces and the store: `openCard`, `confirmCard`, `cancelCard`. Minting the token first means a signed-out or 2FA-incomplete session fails before the batch is used up, so a retry after sign-in works. Using the batch up second means an expired or already-used batch never writes. `api.ts` classifies every failure into `sign-in`, `expired`, `refused`, or `unavailable`; the only response text it passes on is Django's own refusal of a single write.

### State

The store keeps each batch's phase, the reason being edited, the loaded names, and each write's outcome, keyed by the tool service's pending action id. A card that remounts mid-confirm shows its progress, and the confirm keeps running because the flow is owned by the controller, not the component. Outcomes are not written to the Session log: after a reload the card reads each application's current status back from Django.

### Replay

The card derives only from the logged call and result. A result that is not a well-formed batch, or an error, renders a plain failure row with the tool's own text.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-tool](../ui-tool/README.md) — the tool-call presentation layer hosting the `tool.call.toolview` slot.
- [ui-skill](../ui-skill/README.md) — another business-owned registration in the same slot.

-----

<a id="model-experience"></a>
## Model Experience

### Confirming a prepared batch

#### What the model sees

Nothing from this package. The results of `prepare_approve`, `prepare_reject`, and `prepare_request_documents`, written by the tool service, reach the model as ordinary tool output: a `pendingActionId`, the `eligible` and `skipped` record ids with their statuses, and an `expiresAt`. They hold no names and no free text from applicants. The confirm, the write token, the names, and every write outcome stay in the browser and Django, so the model learns whether staff confirmed only if it calls a read tool afterwards.

#### Token effect

None. This package adds no model-visible content.

#### KV Cache effect

None. The package never edits earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Chinese and English only** — the locale registry requires `zh` and `en`; every other language falls back to English per key. Add a language only with a translation someone can vouch for.
- **Outcomes are not in the Session log** — a reload shows each application's current status, not which of this card's writes succeeded.
- **Sign-in is a link** — the card does not host a login form. It opens `signInUrl` in a new tab, and staff return to the card and choose Try again.
- **Same origin only** — the card relies on the staff session cookie and a reverse proxy; there is no cross-origin mode.
- **The tool service keeps batches in memory for 15 minutes** — a tool service restart makes the card report an expired batch, and the model must prepare it again.
- **Not covered by the browser smoke or replayed end-to-end suites** — the package has unit, component, and plugin-registration specs at 100% coverage, but no `test:web` scenario.
- **English-only documentation** — the bilingual README and Agent Note triplets the upstream documentation gates expect are not provided.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The card exists for the CInHEd staff AI platform; the design and the reasons for the write path are recorded in that project's `dev-journal/decisions/ai-platform-design.md`. Nothing here is intended for upstream.

</details>
