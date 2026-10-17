import { describe, expect, it } from '@jest/globals'
import { VERSION } from '../src/index.js'

describe('package scaffold', () => {
  it('exports the package version', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
