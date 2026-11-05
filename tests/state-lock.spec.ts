import { expect, it, vi } from 'vitest'
import { retryStateLock } from '../src/app/runtime.ts'

it('retries the plugin entry while an interrupted process lock is still recent', async () => {
  let attempts = 0
  const value = await retryStateLock(() => {
    attempts++
    if (attempts < 3) throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' })
    return 'open'
  }, { retryDelayMs: 1, timeoutMs: 100 })
  expect(value).toBe('open')
  expect(attempts).toBe(3)
})

it('does not retry unrelated Runtime initialization failures', async () => {
  const attempts = vi.fn(() => { throw new Error('Unsupported orchestrator database version 99') })
  await expect(retryStateLock(attempts, { retryDelayMs: 1, timeoutMs: 100 }))
    .rejects.toThrow('Unsupported orchestrator database version 99')
  expect(attempts).toHaveBeenCalledOnce()
})
