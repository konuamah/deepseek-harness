---
kind: upgrade-guide
description: "Staff access gains an `ownership` mode; Postgres deployments must mount the new persistence provider and remove `ownersFile`."
---

# Staff ownership moves into Postgres for the database composition

English | [中文](guide.zh.md)

## Change

`staff-access` now accepts `ownership: 'file' | 'postgres'`, defaulting to `file`. File mode keeps `ownersFile` required and behaves as before, so an existing profile that only sets `ownersFile` needs no change. Postgres mode makes `ownersFile` forbidden and requires the new `@deepseek-ai/dsh-session-persistence-postgres` provider: the Session row's owner column becomes the only durable authority, the sidecar is never opened, and existing sidecar entries are not imported. A staff create in this mode reserves the exact Session id before storage creation and fails unless the committed row names the caller.

The new provider is also available on its own as a replacement for the JSONL backend. A deployment that enables it must not keep `session-persistence-jsonl` mounted.

## Migration

1. Decide the ownership mode. Keep the default file mode by leaving `ownership` unset.
2. For Postgres mode, replace `session-persistence-jsonl` with the new provider in the profile or `--patch` overlay:

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

   Remove `ownersFile` from the `staff-access` config; leaving it set refuses startup. The overlay shipped in `packages/bundle/web-app/overlays/staff-postgres.patch.yml` is a complete example.
3. Give the Postgres login only its own database's `CONNECT` and the `dsh_*` table privileges. Do not point it at Django's database.
4. Confirm startup lists `session-persistence-postgres` and `staff-access` as active entries, then create a staff chat and check that a second staff user cannot open it. A missing provider, a persistence name mismatch, or an unreachable database now fails startup instead of warning.
