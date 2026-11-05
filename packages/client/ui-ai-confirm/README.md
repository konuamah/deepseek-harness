---
description: "Web confirm card for the six prepare tools of the CInHEd tool service: shows a prepared batch with names, lets staff edit the reason, and writes after a click."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ai-confirm

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-ai-confirm` renders the result of the CInHEd tool service's `prepare_approve`, `prepare_reject`, `prepare_request_documents`, `prepare_cancel`, `prepare_verify_document`, and `prepare_reject_document` tools as a confirm card. The card loads the prepared batch and each application's or document's name with the staff member's own session, lets them edit the reason, and on Confirm mints a short-lived write token, uses the batch up, and writes each record. Prepare results contain no names; read-tool results may include first and last names. The write token, browser-loaded names, and write outcomes are not model-visible.

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

The row ships `disabled: true` in the Web bundle. Turn it on in the profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`) with a patch that sets ONLY `disabled: false` (no config):

```yaml
- id: ui-ai-confirm
  disabled: false
```

| Setting | Default | Meaning |
|---|---|---|
| `serverName` | `cinhed` | `serverName` of the MCP entry for the tool service. The cards register as `mcp__<serverName>__prepare_approve`, `..._prepare_reject`, `..._prepare_request_documents`, `..._prepare_cancel`, `..._prepare_verify_document`, and `..._prepare_reject_document`. Two read-only cards register as `mcp__<serverName>__list_applications` and `mcp__<serverName>__get_application`. |
| `toolsPath` | `/tools/pending` | Page path a reverse proxy forwards to the tool service's pending-batch routes. |
| `apiPath` | `/api/v1` | Page path a reverse proxy forwards to Django's API. |
| `signInUrl` | `/login` | Page that signs staff in with login and 2FA. Opened in a new tab. |

The browser creates every client row with no config, so a `config:` block in `cordis.yml` never reaches this plugin. These defaults are fixed in the bundle. The tool service must be connected as the MCP server named `cinhed`; to change a setting, change its default in `src/client/index.ts` and rebuild the package bundle.

All three paths are checked at load: each must be an absolute path on the page's own origin, so the card never calls or links to another site. This applies to the defaults and any value passed to `Config`.

### What staff see

Application and confirm cards appear inline in the conversation with shaded headers and separated record, file, and action sections. On narrow screens, the application table scrolls horizontally without moving the file links. Cards open by default and can be collapsed for the current session. Collapsing hides the card details without removing any rows; the choice is not persisted across sessions. In one turn, an earlier lookup card hides once a later loaded card shows every application it shows, so a one-application flow ends on a single card. A prepared batch shows its records with name, reference, program, and the change each will get (for example, "Under review → Approved"). Records the tool service skipped are listed with its reason. Reject, request-documents, and reject-document show a reason field that starts from the AI's draft. A request for documents or a document rejection cannot be confirmed with an empty reason.

The three document and cancel actions add a warning line: cancelling an application cannot be undone and the applicant is not told; verifying or rejecting a document emails the applicant, and a rejection sends the reason as written and may move the application to documents required. Document batches list their ids as document ids, and each row shows name, reference, document type, and the status change (for example, "Pending review → Verified"), loaded from the staff-only document-summaries call. Uploaded and official files have Download links; previewable files also have a View link. A name that is empty or looks like an email address shows as a dash.

Confirm runs in this order: check the sign-in and mint the write token, use the batch up, then write one record at a time. Each record gets its own outcome (changed, or the reason Django refused). Cancel uses the batch up without writing. A closed batch (expired, used, or unable to load) shows a calm message and each application's current status; it names the requested status only when every record now has it. A real failure (signed out, refused, or the system did not answer) shows a small warning marker and is announced to assistive technology as an alert; a closed or cancelled request stays calm and unannounced.

### Applications cards

The results of `list_applications` and `get_application` show as a compact table with Name, Reference, Status, and Program. The AI tool result may include first and last names, and the browser independently loads names from the staff-only application-summaries call under `apiPath`, using the staff member's own session. Only a single-result `get_application` card also lists uploaded and official files from the staff-only application documents call; it labels uploaded status and unreleased official files. View opens a native preview in a new tab when supported, and Download is a separate link. File metadata remains in the browser-only store. The card reads only each record's id and name from the summaries reply, asks once per call (for at most 25 ids), and keeps names in the card's in-memory store only. A name that looks like an email address is not shown.

The card fails soft. While names load, the rows show without them. If names cannot be loaded (signed out, expired, unavailable), the table keeps its reference, status, and program and adds one line saying so, with a Try again button. A result that is not a well-formed list of applications, or an error, renders nothing.

### Proxy requirements

The card calls the tool service and Django on the page's own origin, so the staff session cookie travels with every call and no credential passes through the harness. A reverse proxy must forward `toolsPath` to the tool service and `apiPath` to Django on the same host that serves the harness. Cross-origin use is not supported.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

`apply` registers one dictionary pair (`zh`, `en`), a `conversation.chat.node` renderer for application and confirm cards, and empty `tool.call.toolview` entries for each prepare and read tool to prevent duplicate cards. The node renderer receives the API, server name, and sign-in path; the card definition matches calls using the exact wire names derived from the configured server name. Cards render inline with the turn and are collapsible for the current session only. The node renderer and cards share one declared Session store. The package exports only `apply`, `inject`, and `Config`.

### Flow

`controller.ts` holds the flow as plain functions over the network faces and the store: `openCard`, `confirmCard`, `cancelCard`. Minting the token first means a signed-out or 2FA-incomplete session fails before the batch is used up, so a retry after sign-in works. Using the batch up second means an expired or already-used batch never writes. `api.ts` classifies every failure into `sign-in`, `expired`, `refused`, or `unavailable`; the only response text it passes on is Django's own refusal of a single write.

### State

The store keeps each batch's phase, the reason being edited, the loaded names, and each write's outcome, keyed by the tool service's pending action id. The applications cards keep their names in the same store, keyed by the logged call id. A card that remounts mid-confirm shows its progress, and the confirm keeps running because the flow is owned by the controller, not the component. Outcomes are not written to the Session log: after a reload the card reads each application's current status back from Django.

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

The six prepare tool results reach the model as ordinary tool output: a `pendingActionId`, the `eligible` and `skipped` record ids with their statuses, and an `expiresAt`; these results contain no names or applicant free text. Read-tool results may include applicants' first and last names. The confirm, the write token, browser-loaded names, and every write outcome stay in the browser and Django, so the model learns whether staff confirmed only if it calls a read tool afterwards.

#### Token effect

None. This package adds no model-visible content.

#### KV Cache effect

None. The package never edits earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Settings are fixed at build time** — client rows receive no config from `cordis.yml`, so changing the server name or a path means editing a default and rebuilding the bundle.
- **Chinese and English only** — the locale registry requires `zh` and `en`; every other language falls back to English per key. Add a language only with a translation someone can vouch for.
- **Outcomes are not in the Session log** — a reload shows each application's current status, not which of this card's writes succeeded.
- **Sign-in is a link** — the card does not host a login form. It opens `signInUrl` in a new tab, and staff return to the card and choose Try again.
- **Same origin only** — the card relies on the staff session cookie and a reverse proxy; there is no cross-origin mode.
- **The tool service keeps batches in memory for 15 minutes** — a tool service restart makes the card report an expired batch, and the model must prepare it again.
- **Browser replay does not exercise writes** — the keyless `staff-cards` scenario covers inline read and preparation cards through the real Web composition with mocked staff APIs; it does not confirm a backend write.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The card exists for the CInHEd staff AI platform; the design and the reasons for the write path are recorded in that project's `dev-journal/decisions/ai-platform-design.md`. Nothing here is intended for upstream.

</details>
