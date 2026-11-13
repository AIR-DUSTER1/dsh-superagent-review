import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { backFrom, initialLocation, navigateTo, remember, routeLabel, selectTab, HOME, type Location, type Route, type Tab } from './route.ts'
import type { T } from './text.ts'

export interface NavigationContextValue {
  location: Location
  navigate: (route: Route, replace?: boolean) => void
  back: () => void
  openTab: (tab: Tab) => void
  backLabel: string
}

const NavigationContext = createContext<NavigationContextValue | undefined>(undefined)

export function useNavigation(): NavigationContextValue {
  const value = useContext(NavigationContext)
  if (!value) throw new Error('dsh-superagent page rendered outside its navigation provider')
  return value
}

/** Owns route history and persistence only; panel data state is provided separately. */
export function NavigationProvider({ t, children }: { t: T; children: ReactNode }) {
  const [location, setLocation] = useState(initialLocation)
  useEffect(() => { remember(location) }, [location])
  const navigate = useCallback((route: Route, replace = false) => setLocation(current => navigateTo(current, route, replace)), [])
  const back = useCallback(() => setLocation(backFrom), [])
  const openTab = useCallback((tab: Tab) => setLocation(current => selectTab(current, tab)), [])
  const backLabel = routeLabel(t, location.stack.at(-1) ?? HOME)
  const value = useMemo(() => ({ location, navigate, back, openTab, backLabel }), [location, navigate, back, openTab, backLabel])
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}
