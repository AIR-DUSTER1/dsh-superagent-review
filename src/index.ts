/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { retryStateLock, Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // A DSH update can terminate the previous host just before this one starts. Keep the plugin recoverable while
  // proper-lockfile's recent lock ages into a provably stale lock instead of turning the update into a missing plugin.
  const runtime = await retryStateLock(() => new Runtime(ctx, machine, restart))
  ctx.effect(() => async () => { await runtime.stop() })
  // The Runtime registers its management HTTP routes before probing external accounts. Complete plugin activation
  // without waiting for those network checks, so an update during an outage still leaves the panel available.
  void runtime.ready.then(() => {
    ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  }).catch((error: unknown) => {
    ctx.logger.error('dsh-superagent startup failed: %s', String(error))
  })
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
