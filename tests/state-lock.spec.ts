import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { acquireStateDirectoryLock, retryStateLock } from '../src/app/runtime.ts'

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

it('acquires the state directory after an interrupted owner lock becomes stale', async () => {
  const root = mkdtempSync(join(tmpdir(), 'state-lock-'))
  const state = join(root, 'state')
  const lock = `${state}.lock`
  mkdirSync(state)
  mkdirSync(lock)
  const recent = new Date(Date.now() - 1_900)
  utimesSync(lock, recent, recent)
  let release: (() => void) | undefined
  try {
    const acquired = await acquireStateDirectoryLock(state, { staleMs: 2_000, retryDelayMs: 100, timeoutMs: 3_000 })
    release = acquired.release
    expect(statSync(lock).isDirectory()).toBe(true)
    release()
    release = undefined
    expect(existsSync(lock)).toBe(false)
  } finally {
    release?.()
    rmSync(root, { recursive: true, force: true })
  }
})
