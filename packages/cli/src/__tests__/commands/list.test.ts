import { describe, it, expect } from 'vitest'
import { createProgram } from '../../main.js'

describe('list command', () => {
  it('is registered on program', () => {
    const program = createProgram()
    const cmd = program.commands.find((c) => c.name() === 'list')
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toBe('Fetch invoices from KSeF (seller role)')
  })
})
