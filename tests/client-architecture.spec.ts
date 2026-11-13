import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
}

it('keeps API transport, polling state, panel state and navigation in separate modules', () => {
  const api = source('api.ts')
  const poll = source('poll.ts')
  const provider = source('provider.tsx')
  const navigation = source('navigation.tsx')
  const app = source('app.tsx')
  const routeView = source('route-view.tsx')
  expect(api).not.toMatch(/from 'react'|useState|useEffect/)
  expect(poll).toContain('export function usePoll')
  expect(provider).not.toContain("from './route.ts'")
  expect(provider).not.toContain('navigate:')
  expect(navigation).toContain('export function NavigationProvider')
  expect(app).not.toMatch(/initialLocation|lastSettingsGroup|remember\(|switch \(route\.page\)/)
  expect(routeView).toContain('switch (route.page)')
})
it('keeps the management HTTP transport separate from the route table', () => {
  const http = readFileSync(new URL('../src/app/http.ts', import.meta.url), 'utf8')
  const routes = readFileSync(new URL('../src/app/http-routes.ts', import.meta.url), 'utf8')
  const views = readFileSync(new URL('../src/app/http-views.ts', import.meta.url), 'utf8')
  expect(http).toContain('export function registerHttp')
  expect(http).not.toContain('function routes(')
  expect(routes).toContain('export function routes')
  expect(routes).not.toContain('function machineView')
  expect(views).toContain('export function stateView')
})
