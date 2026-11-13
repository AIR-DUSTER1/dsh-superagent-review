import { useRef, useState } from 'react'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'

/** Wrap an async action with re-entrancy protection, busy state, optional reload, and error toast reporting. */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>,
  { reload }: { reload?: () => Promise<unknown> } = {}) {
  const { notify } = usePanel()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = async (...args: A): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    try { await action(...args); await reload?.(); return true }
    catch (failure) { notify(errorText(failure)); return false }
    finally { running.current = false; setBusy(false) }
  }
  return { run, busy }
}
