/** The node half: a plugin entry with no host-side behavior, present so the plugin loads. */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('node entry', () => {
  it('does nothing', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
