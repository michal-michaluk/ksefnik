import { describe, it, expect } from 'vitest'
import { createProgram } from '../../main.js'

describe('upo command', () => {
  it('is registered on program', () => {
    const program = createProgram()
    const cmd = program.commands.find((c) => c.name() === 'upo')
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toBe(
      'Fetch UPO (Urzędowe Poświadczenie Odbioru) for an invoice',
    )
  })
})
