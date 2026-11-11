---
description: "Web confirm card and private forms for the CInHEd tool service: shows a prepared batch with names, writes after a click, and renders application create/upload and draft-offer forms."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ai-confirm

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-ai-confirm` renders the result of the CInHEd tool service's `prepare_approve`, `prepare_reject`, `prepare_request_documents`, `prepare_cancel`, `prepare_verify_document`, `prepare_reject_document`, `prepare_enroll`, and `prepare_send_offer` tools as a confirm card. The card loads the prepared batch and each application's or document's name with the staff member's own session, lets them edit the reason, and on Confirm mints a short-lived write token, uses the batch up, and writes each record. Prepare results contain no names; read-tool results may include first and last names. The write token, browser-loaded names, and write outcomes are not model-visible. It also renders the tool service's `open_application_form` and `open_offer_form` markers as private forms: staff enter applicant details, choose programs, intakes and documents, or edit a draft offer. Form values and files go directly to Django with the staff session; they never enter chat or the model.

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
| `serverName` | `cinhed` | `serverName` of the MCP entry for the tool service. The cards register as `mcp__<serverName>__prepare_approve`, `..._prepare_reject`, `..._prepare_request_documents`, `..._prepare_cancel`, `..._prepare_verify_document`, `..._prepare_reject_document`, `..._prepare_enroll`, and `..._prepare_send_offer`. Two read-only cards register as `mcp__<serverName>__list_applications` and `mcp__<serverName>__get_application`; two private-form markers register as `mcp__<serverName>__open_application_form` and `mcp__<serverName>__open_offer_form`. |
| `toolsPath` | `/tools/pending` | Page path a reverse proxy forwards to the tool service's pending-batch routes. |
| `apiPath` | `/api/v1` | Page path a reverse proxy forwards to Django's API. |
| `signInUrl` | `/login` | Page that signs staff in with login and 2FA. Opened in a new tab. |

The browser creates every client row with no config, so a `config:` block in `cordis.yml` never reaches this plugin. These defaults are fixed in the bundle. The tool service must be connected as the MCP server named `cinhed`; to change a setting, change its default in `src/client/index.ts` and rebuild the package bundle.

All three paths are checked at load: each must be an absolute path on the page's own origin, so the card never calls or links to another site. This applies to the defaults and any value passed to `Config`.

### What staff see

Application and confirm cards appear inline in the conversation with shaded headers and separated record, file, and action sections. On narrow screens, the application table scrolls horizontally without moving the file links. Cards open by default and can be collapsed for the current session. Collapsing hides the card details without removing any rows; the choice is not persisted across sessions. In one turn, an earlier lookup card hides once a later loaded card shows every application it shows, so a one-application flow ends on a single card. A prepared batch shows its records with name, reference, program, and the change each will get (for example, "Under review → Approved"). Records the tool service skipped are listed with its reason. Reject, request-documents, and reject-document show a reason field that starts from the AI's draft. A request for documents or a document rejection cannot be confirmed with an empty reason.

The three document and cancel actions add a warning line: cancelling an application cannot be undone and the applicant is not told; verifying or rejecting a document emails the applicant, and a rejection sends the reason as written and may move the application to documents required. Document batches list their ids as document ids, and each row shows name, reference, document type, and the status change (for example, "Pending review → Verified"), loaded from the staff-only document-summaries call. Uploaded and official files have Download links; previewable files also have a View link. A name that is empty or looks like an email address shows as a dash.

Confirm runs in this order: check the sign-in and mint the write token, use the batch up, then write one record at a time. Each record gets its own outcome (changed, or the reason Django refused). Cancel uses the batch up without writing. A closed batch (expired, used, or unable to load) shows a calm message and each application's current status; it names the requested status only when every record now has it. A real failure (signed out, refused, or the system did not answer) shows a small warning marker and is announced to assistive technology as an alert; a closed or cancelled request stays calm and unannounced.

Manual enrolment and offer sending accept one application at a time and require staff to retype its exact reference. Enrolment also requires a staff-only reason and warns that no payment is needed and that a student ID and semester invoice will be created. Sending an offer warns that the applicant receives an email; it does not show an application-status change to Sent. The typed reference stays in the browser's in-memory store and is sent only in the token request and Django write body, never in the conversation log.

### Applications cards

The results of `list_applications` and `get_application` show as a compact table with Name, Reference, Status, and Program. The AI tool result may include first and last names, and the browser independently loads names from the staff-only application-summaries call under `apiPath`, using the staff member's own session. Only a single-result `get_application` card also lists uploaded and official files from the staff-only application documents call; it labels uploaded status and unreleased official files. View opens a native preview in a new tab when supported, and Download is a separate link. File metadata remains in the browser-only store. The card reads only each record's id and name from the summaries reply, asks once per call (for at most 25 ids), and keeps names in the card's in-memory store only. A name that looks like an email address is not shown.

The card fails soft. While names load, the rows show without them. If names cannot be loaded (signed out, expired, unavailable), the table keeps its reference, status, and program and adds one line saying so, with a Try again button. A result that is not a well-formed list of applications, or an error, renders nothing.

### Private forms

`open_application_form` opens a create form when the marker's application id is null, and an upload form for an existing application. The form loads programs, intakes, scholarships and document types page by page from Django, never from the model. Create posts the applicant fields, the chosen program and intake, explicit terms acceptance, and any selected files as `document_<id>` fields. Upload shows the target reference and status, labels types already attached, and posts only the new files. A duplicate create is reported as an existing application: nothing was changed and the selected files were not attached.

`open_offer_form` opens the draft-offer form for one approved application. It loads the existing draft and the scholarship choices privately, shows the eight fee fields and the offer details, keeps money as decimal strings, and shows server-computed totals after a save. A missing draft is created only when staff click Save; blank new fields are omitted so Django applies its defaults. Saving creates or updates the draft only. It does not generate a PDF or send email. A saved draft can be previewed inline in a new tab; the preview action stays hidden while entries are unsaved or a save is unsettled, because it shows the saved draft.

Forms keep values in the declared Session store and files in the component. The first click sets a target lock before awaiting, so a second card for the same target cannot start another write. An unknown create, upload or save outcome keeps the entries and the lock, and nothing retries automatically; application reconciliation and a later offer load are inspection only. The browser unload warning covers a dirty form, and Cancel asks before discarding. A full reload loses values and files; it is not recovery.

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

The eight prepare tool results reach the model as ordinary tool output: a `pendingActionId`, the `eligible` and `skipped` record ids with their statuses, and an `expiresAt`; these results contain no names or applicant free text. Read-tool results may include applicants' first and last names. The confirm, the write token, browser-loaded names, and every write outcome stay in the browser and Django, so the model learns whether staff confirmed only if it calls a read tool afterwards.

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
- **Browser writes are mocked** — keyless Web replay covers card stacking and exact-reference confirmation for enrolment and offer sending, including request payloads and exclusion of typed references and tokens from the Session log. It does not verify real Django writes or email delivery.
- **Form drafts are browser-only** — values and files are not persisted. A full reload loses them, and reload is not recovery. No supported in-app navigation veto exists yet, so only the explicit Cancel prompt and the browser unload warning cover discard.
- **Form writes are one attempt** — an unknown create, upload or save outcome stays locked. The form shows a candidate or the current saved values for inspection but does not prove the original request failed and never retries.
- **Saving an offer is not sending it** — the draft form never generates a PDF or sends mail. Sending remains the separate exact-reference confirm flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The card exists for the CInHEd staff AI platform; the design and the reasons for the write path are recorded in that project's `dev-journal/decisions/ai-platform-design.md`. Nothing here is intended for upstream.

</details>
