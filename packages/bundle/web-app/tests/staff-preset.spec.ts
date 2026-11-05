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
  it('declares the staff preset id', () => {
    expect(readFileSync(PRESET, 'utf8')).toContain('        id: staff\n')
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
