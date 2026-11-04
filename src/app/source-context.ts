/** Scoped runtime context exposed to each Source instance, isolating Sources from direct Store or Engine access. */
import type { EngineForSources, ReceiveResult, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SetupProblem } from '../setup.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export interface SourceContextDeps {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  readonly commands: Commands
  readonly sources: SourceRegistry
  readonly deployment: Deployment
  readonly ready: Promise<void>
  configured(): boolean
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

function githubHost(workspace: { api_base_url: string | null; web_base_url: string; provider: string }): string | undefined {
  if (workspace.provider !== 'github') return undefined
  const value = workspace.api_base_url ?? workspace.web_base_url
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === 'api.github.com' ? 'github.com' : host
  } catch { return undefined }
}

interface TicketWorkspace {
  workspace_id: string
  repository_id: string
}

/** Builds one Source instance context. Thread keys, state keys and health are namespaced away from other instances. */
export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; instanceId?: string; health: readonly string[] }): SourceContext {
  const { store } = deps
  const instanceId = kind.instanceId ?? kind.kind
  const instance = deps.sources.instance(instanceId)
  const workspace = instance?.workspace
  const statePrefix = instanceId === kind.kind ? '' : `${instanceId}:`
  const health = deps.sources.healthEntriesFor(instanceId, kind.kind, kind.health)
  const scopeKey = (key: string): string => instanceId !== kind.kind && key.startsWith(`${kind.kind}:`)
    ? `${instanceId}:${key.slice(kind.kind.length + 1)}` : key
  const scopeThread = (ref: ThreadRef): ThreadRef => ref.source === kind.kind || ref.source === instanceId
    ? { ...ref, source: instanceId } : ref
  const stateName = (name: string): string => instanceId === kind.kind || name.startsWith(statePrefix) ? name : `${statePrefix}${name}`
  const ticketMatches = (ticket: Ticket): boolean => {
    const binding = (ticket as Ticket & { workspace?: TicketWorkspace }).workspace
    if (!workspace) return true
    return binding
      ? binding.workspace_id === workspace.workspace_id && binding.repository_id === workspace.repository_id
      : instanceId === kind.kind
  }
  const scopedCommands = workspace?.repository_key
    ? deps.commands.withRepository(workspace.repository_key).withGitHubHost(githubHost(workspace))
    : deps.commands
  const scopedDeployment = workspace?.repository_key ? { ...deps.deployment, repository: workspace.repository_key } : deps.deployment
  const receive = (trigger: Trigger): ReceiveResult | Promise<ReceiveResult> => {
    const id = instanceId !== kind.kind && !trigger.id.startsWith(`${instanceId}:`) ? `${instanceId}:${trigger.id}` : trigger.id
    return deps.receive({
      ...trigger,
      id,
      source: trigger.source === kind.kind || trigger.source === instanceId ? instanceId : trigger.source,
      threads: trigger.threads.map(scopeThread),
      actor: trigger.actor.source === kind.kind || trigger.actor.source === instanceId ? { ...trigger.actor, source: instanceId } : trigger.actor,
      ...trigger.channel ? { channel: { ...trigger.channel,
        source: trigger.channel.source === kind.kind || trigger.channel.source === instanceId ? instanceId : trigger.channel.source } } : {},
      meta: { ...trigger.meta, source_instance_id: instanceId,
        ...(workspace ? { workspace_source: 'instance', workspace_id: workspace.workspace_id, repository_id: workspace.repository_id,
          workspace: { ...workspace } } : {}) },
    })
  }
  return {
    instanceId,
    kindId: kind.kind,
    get deployment() { return scopedDeployment },
    commands: scopedCommands,
    ready: deps.ready,
    configured: () => deps.configured(),
    get problem() { return [deps.feishuProblem, deps.setupProblem].find(problem => problem?.place === kind.kind) },
    config: <C extends Record<string, unknown>>(id: string) => {
      const target = deps.sources.instance<C>(id === kind.kind || id === instanceId ? instanceId : id)
      return target?.enabled ? target.config : undefined
    },
    receive,
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(stateName(name)) as never,
      set: (name, value) => { if (value === undefined) store.delete(stateName(name)); else store.set(stateName(name), value) },
      keys: prefix => store.keys(typeof prefix === 'string' ? `${statePrefix}${prefix}` : `${statePrefix}${prefix.prefix}`)
        .map(name => instanceId === kind.kind ? name : name.slice(statePrefix.length)) as never,
    },
    threads: {
      get: key => store.threads.get(scopeKey(key)),
      subscribed: source => store.read.subscribedThreads(source === kind.kind || source === instanceId ? instanceId : source),
      describe: (key, description) => store.threads.describe(scopeKey(key), description),
      patch: (key, meta) => { store.threads.patchMeta(scopeKey(key), meta) },
    },
    tickets: {
      get: id => {
        const ticket = store.tickets.get(id)
        return ticket && ticketMatches(ticket) ? ticket : undefined
      },
      open: () => store.tickets.open().filter(ticketMatches),
      bindThread: (id, thread, own) => { deps.engine.bindThread(id, scopeThread(thread), own) },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed(scopeThread(thread), outcome, at) },
    },
    triggers: {
      get: id => {
        const trigger = store.triggers.get(id.startsWith(`${instanceId}:`) ? id : instanceId === kind.kind ? id : `${instanceId}:${id}`)
        return trigger ?? store.triggers.get(id)
      },
      latest: thread => store.read.threadTriggers(scopeKey(thread), 1)[0],
    },
    notify: message => {
      deps.outbox.send({ ...message, channel: { ...message.channel,
        source: message.channel.source === kind.kind || message.channel.source === instanceId ? instanceId : message.channel.source } })
    },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(entry)?.set(value)
    },
  }
}
