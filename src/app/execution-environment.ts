/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_WORKSPACE_ID', ticket: true, description: { zh: '工单所属工作区 id', en: 'Workspace id of this ticket' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY_ID', ticket: true, description: { zh: '工单所属仓库 id', en: 'Repository id of this ticket' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', ticket: true, description: { zh: '工单执行的目标仓库，owner/name 或 Provider 项目 ID', en: 'Target repository for this ticket, as owner/name or a Provider project id' } },
  { key: 'DSH_SUPERAGENT_PROVIDER', ticket: true, description: { zh: '目标仓库的 Provider', en: 'Provider of the target repository' } },
  { key: 'DSH_SUPERAGENT_API_BASE_URL', ticket: true, description: { zh: '目标 Provider 的 API 地址；使用默认地址时为空', en: 'Provider API base URL; empty when the default is used' } },
  { key: 'DSH_SUPERAGENT_WEB_BASE_URL', ticket: true, description: { zh: '目标仓库的 Web 基础地址', en: 'Web base URL of the target repository' } },
  { key: 'DSH_SUPERAGENT_DEFAULT_BRANCH', ticket: true, description: { zh: '目标仓库的默认分支', en: 'Default branch of the target repository' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings;
  ticket?: { id: string; name: string; directory: string; workspace_id?: string; repository_id?: string };
  trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const workspace = trigger?.meta.workspace && typeof trigger.meta.workspace === 'object'
    ? trigger.meta.workspace as Record<string, unknown>
    : trigger ? sources.instance(trigger.source)?.workspace : undefined
  const repository = typeof workspace?.repository_key === 'string' ? workspace.repository_key : ''
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '),
    ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id,
      DSH_SUPERAGENT_WORKSPACE_ID: ticket.workspace_id ?? String(workspace?.workspace_id ?? ''),
      DSH_SUPERAGENT_REPOSITORY_ID: ticket.repository_id ?? String(workspace?.repository_id ?? ''),
      DSH_SUPERAGENT_REPOSITORY: repository, DSH_SUPERAGENT_PROVIDER: String(workspace?.provider ?? ''),
      DSH_SUPERAGENT_API_BASE_URL: String(workspace?.api_base_url ?? ''),
      DSH_SUPERAGENT_WEB_BASE_URL: String(workspace?.web_base_url ?? ''),
      DSH_SUPERAGENT_DEFAULT_BRANCH: String(workspace?.default_branch ?? '') } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { instance, kind, environment, config } of sources.environments(settings)) {
    if (trigger && instance.id !== trigger.source && !(trigger.source === kind.kind && instance.id === kind.kind)) continue
    const scoped = instance.workspace?.repository_key ? { ...deployment, repository: instance.workspace.repository_key } : deployment
    const values = environment.values({ deployment: scoped, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const binding = ticket.workspace
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '',
    ...(binding ? { workspace_id: binding.workspace_id, repository_id: binding.repository_id } : {}) }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
