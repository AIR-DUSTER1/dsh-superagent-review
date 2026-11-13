import type { StateView } from './api.ts'
import type { DeploymentForm } from './deployment.tsx'
import { EvalStatus } from './eval.tsx'
import { ExecutionStatus } from './execution.tsx'
import { OverviewPage } from './overview.tsx'
import { SettingsPage } from './settings.tsx'
import { SourceStatus } from './source.tsx'
import { ThreadPage } from './thread.tsx'
import { TicketPage } from './ticket.tsx'
import { TriggerStatus } from './trigger.tsx'
import type { Route } from './route.ts'

/** Maps a validated route to its page. It owns no history and performs no data mutation. */
export function RouteView({ route, state, error, reload, deploymentForm, loadingLabel }: {
  route: Route
  state: StateView | undefined
  error: Error | undefined
  reload: () => Promise<void>
  deploymentForm: DeploymentForm
  loadingLabel: string
}) {
  switch (route.page) {
    case 'overview': return <OverviewPage />
    case 'source': return <SourceStatus />
    case 'trigger': return route.id !== undefined ? <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
      : <TriggerStatus filter={route.query?.filter ?? 'subscribed'} />
    case 'eval': return <EvalStatus filter={route.query?.filter ?? 'work'} window={route.query?.window} paused={!!state?.paused} />
    case 'execution': return route.id !== undefined ? <TicketPage key={route.id} id={route.id} />
      : state ? <ExecutionStatus filter={route.query?.filter ?? 'open'} state={state} reload={reload} />
        : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{loadingLabel}</p>
    case 'settings': return state ? <SettingsPage key={state.masterId} group={route.query.group} query={route.query} state={state}
      deploymentForm={deploymentForm} /> : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{loadingLabel}</p>
  }
}
