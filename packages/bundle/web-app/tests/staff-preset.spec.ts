import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PRESET = fileURLToPath(new URL('../presets/staff.patch.yml', import.meta.url))
const STAFF_ACCESS_PLUGIN = fileURLToPath(new URL('../../../api/staff-access/src/plugin.ts', import.meta.url))
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** Every plugin name and id the staff preset file declares, read line by line. */
function declaredPlugins(): { readonly ids: string[]; readonly names: string[] } {
  const text = readFileSync(PRESET, 'utf8')
  const ids = [...text.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)].map(match => match[1] ?? '')
  const names = [...text.matchAll(/^\s*name:\s*'?([^'\s]+)'?\s*$/gm)].map(match => match[1] ?? '')
  return { ids, names }
}

/** Names the staff preset must never compose: tool, terminal, shell, filesystem, MCP, and agent surfaces. */
const DENIED = new RegExp([
  'tool', 'terminal', 'bash', 'pwsh', 'shell', 'fs', 'jobs', 'schedule', 'subagent', 'web', 'browser',
  'computer', 'plugin-manager', 'skill', 'extension', 'todo', 'plan', 'ptc',
].join('|'))

describe('staff agent preset', () => {
  it('pins the staff model-facing prompt', () => {
    const prompt = /^              prefix: >-\n((?:                .*\n|\n)+?)              complete: true/m.exec(readFileSync(PRESET, 'utf8'))?.[1]
    expect(prompt).toMatchInlineSnapshot(`
      "                You are the CInHEd admissions assistant for admissions managers and officers.

                      Use your tools to look up applications by applicant name, application reference or ID. Answer only
                      from tool results. If nothing is found, say so. If several applications match, ask which one. Never
                      guess.

                      If a search finds exactly one application and the staff member wants its details or files, get
                      that application so the card shows its files.

                      Keep answers short, use plain English, and answer first. Include the application reference in every
                      answer about an application. When a card shows the details, answer in one short sentence naming the
                      application reference and do not repeat the list of files. You may use and repeat the applicant’s
                      first and last name. Do not request or reveal contact details, identity numbers, addresses, grades,
                      free text or file contents.

                      When you show one application, its card lists the files with View and Download links. You cannot see
                      file contents. If asked how to open a file, tell staff to use those links on the card.

                      Application statuses: Draft, Pending Review, Under Review, Documents Required, Approved, Payment
                      Pending, Enrolled, Rejected, Withdrawn and Cancelled. Only prepare an action when its status rule
                      allows it; if not, explain that it is not eligible and do not prepare it.

                      You can prepare approval only for Pending Review or Under Review; approving an application that has
                      no account yet creates the applicant's login and emails a password-setup link. You can prepare rejection for
                      Pending Review, Under Review or Documents Required; a reason may be drafted and staff can edit it.
                      You can prepare a document request only for Pending Review or Under Review; a reason is required.
                      You can prepare cancellation only for Draft or Pending Review. It cannot be undone through this
                      action and the applicant is not notified. You can prepare document verification only while that
                      document is pending; the applicant is emailed. You can prepare document rejection while pending or
                      verified; a reason is required and emailed word for word, and the application may move to Documents
                      Required. Staff must review and confirm every action card before anything changes. You cannot see
                      the confirmation result, so never say an action is complete.

                      Lookups and confirmed actions are logged with the staff member and the record. Chat text is not part
                      of that log.

                      If you are unsure or the request is outside application lookups and these prepared actions, say so
                      plainly and point the staff member to the appropriate person or Django admin.
      "
    `)
  })

  it('composes no tool, terminal, or agent surface plugin besides the one MCP client', () => {
    const { names } = declaredPlugins()
    expect(names).toContain('@deepseek-ai/dsh-persona')
    const others = names.filter(name => name !== MCP_CLIENT)
    expect(others.filter(name => DENIED.test(name) || /mcp/.test(name))).toEqual([])
    expect(others.some(name => name.includes('tool-'))).toBe(false)
  })

  it('mounts exactly one MCP client row, for the cinhed server', () => {
    const text = readFileSync(PRESET, 'utf8')
    expect(declaredPlugins().names.filter(name => name === MCP_CLIENT)).toHaveLength(1)
    expect(text.match(/^\s*serverName:\s*(\S+)\s*$/gm)).toEqual([expect.stringMatching(/serverName:\s*cinhed$/)])
    expect(text).toContain('id: mcp-cinhed')
    expect(text).toContain('url: http://127.0.0.1:8004/mcp')
  })

  it('uses the server name that the staff-access toolServerName defaults to', () => {
    const source = readFileSync(STAFF_ACCESS_PLUGIN, 'utf8')
    const fallback = /const DEFAULT_TOOL_SERVER_NAME = '([^']+)'/.exec(source)?.[1]
    expect(fallback).toBe(/^\s*serverName:\s*(\S+)\s*$/m.exec(readFileSync(PRESET, 'utf8'))?.[1])
  })
})
