import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PRESET = fileURLToPath(new URL('../presets/staff.patch.yml', import.meta.url))

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
  'computer', 'mcp', 'plugin-manager', 'skill', 'extension', 'todo', 'plan', 'ptc',
].join('|'))

describe('staff agent preset', () => {
  it('declares the staff preset id', () => {
    expect(readFileSync(PRESET, 'utf8')).toContain('        id: staff\n')
  })

  it('composes no tool, terminal, or agent surface plugin', () => {
    const { names } = declaredPlugins()
    expect(names).toContain('@deepseek-ai/dsh-persona')
    expect(names.filter(name => DENIED.test(name))).toEqual([])
    expect(names.some(name => name.includes('tool-'))).toBe(false)
  })
})
