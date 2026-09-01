import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('VictoryOverlay', () => {
  it('offers recovery, load, and menu actions instead of only a new run', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./VictoryOverlay.tsx', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('Keep operating')
    expect(source).toContain('Load last save')
    expect(source).toContain('Main menu')
    expect(source).toContain('New run')
    expect(source).toContain('Take emergency credit')
    expect(source).toContain('data-testid="victory-recovery"')
    expect(source).toContain('resumeInsolvency')
    expect(source).toContain('continueGame')
  })
})
