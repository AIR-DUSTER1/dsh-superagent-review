import { useCallback, useEffect, useRef, useState } from 'react'

const HIDDEN_FACTOR = 6
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * Poll an endpoint while mounted, backing off when the document is hidden.
 * This module owns React polling state; API transport remains in `api.ts`.
 */
export function usePoll<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = 5000) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({})
  const loader = useRef(load)
  loader.current = load
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // Serialize requests so a manual reload after a mutation runs after the current poll finishes.
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        if (active) setState(previous => same(previous.data, value) ? previous.error ? { data: previous.data as T } : previous : { data: value })
      } catch (failure) {
        if (active) setState(previous => ({ ...previous, error: failure instanceof Error ? failure : new Error(String(failure)) }))
      } finally {
        if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => { if (!document.hidden) void run() }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs])
  const reload = useCallback(() => refresh.current(), [])
  return { data: state.data, error: state.error, reload }
}
