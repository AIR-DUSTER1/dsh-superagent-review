import { describe, expect, it, vi } from 'vitest'
import { isTransientNetworkFailure, retryTransient } from '../src/infra/retry.ts'

describe('retryTransient', () => {
  it('retries a reset connection and returns the later result', async () => {
    const action = vi.fn()
      .mockRejectedValueOnce(new Error('read tcp: An existing connection was forcibly closed by the remote host'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('ok')
    await expect(retryTransient(action, undefined, 3, 0)).resolves.toBe('ok')
    expect(action).toHaveBeenCalledTimes(3)
  })

  it('does not retry a non-network failure', async () => {
    const action = vi.fn().mockRejectedValue(new Error('permission denied'))
    await expect(retryTransient(action, undefined, 3, 0)).rejects.toThrow('permission denied')
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('stops after the configured attempt limit', async () => {
    const action = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(retryTransient(action, undefined, 2, 0)).rejects.toThrow('ECONNRESET')
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('recognizes common transport diagnostics', () => {
    expect(isTransientNetworkFailure(new Error('transport: connection reset'))).toBe(true)
    expect(isTransientNetworkFailure('permission denied')).toBe(false)
  })
})