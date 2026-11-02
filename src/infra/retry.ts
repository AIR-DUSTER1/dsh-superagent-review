/** Bounded retries for transient failures in external CLI network calls. */
import { setTimeout as delay } from 'node:timers/promises'

const TRANSIENT = /network|transport|forcibly closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|temporary failure/i

/** Whether an error's message identifies a transient CLI network failure. */
export function isTransientNetworkFailure(error: unknown): boolean {
  return TRANSIENT.test(error instanceof Error ? error.message : String(error))
}

/**
 * Run an operation up to `attempts` times, retrying only transient network failures.
 * @param action - operation to run.
 * @param signal - cancellation for retry delays.
 * @param attempts - maximum total attempts.
 * @param initialDelayMs - first retry delay; later delays double.
 * @returns the operation's value.
 */
export async function retryTransient<T>(action: () => Promise<T>, signal?: AbortSignal, attempts = 3, initialDelayMs = 500): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await action() }
    catch (error) {
      last = error
      if (attempt + 1 >= attempts || !isTransientNetworkFailure(error)) throw error
      await delay(initialDelayMs * 2 ** attempt, undefined, { signal })
    }
  }
  throw last
}