/** Execution-only repository Source for GitLab/Gitea/bare Git targets without native event polling. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'generic'
const GenericConfigSchema = z.object({
  provider: z.enum(['gitlab', 'gitea', 'bitbucket', 'generic']).default('generic'),
  repository: z.string().trim().default(''),
  apiBaseUrl: z.string().url().nullable().default(null),
  credentialRef: z.string().trim().max(300).default(''),
}).strict()
export type GenericConfig = z.infer<typeof GenericConfigSchema>

export const genericKind: SourceKind<GenericConfig> = {
  kind: SOURCE,
  title: { zh: '通用 Git 仓库', en: 'Generic Git repository' },
  description: { zh: '仅作为执行目标，不轮询 Issue、MR 或评论；任务来源使用飞书、Webhook 或人工录入。',
    en: 'Execution target only; it does not poll Issues, MRs or comments. Tasks come from Feishu, Webhook or manual entry.' },
  schema: GenericConfigSchema,
  fields: [
    { key: 'provider', type: 'text', readonly: true, label: { zh: 'Provider', en: 'Provider' } },
    { key: 'repository', type: 'text', readonly: true, label: { zh: '仓库标识', en: 'Repository' } },
    { key: 'apiBaseUrl', type: 'text', readonly: true, label: { zh: 'API 地址', en: 'API base URL' } },
    { key: 'credentialRef', type: 'text', readonly: true, label: { zh: '凭据引用', en: 'Credential reference' } },
  ],
  health: ['generic'],
  scope: () => ({ listened: true, observed: false }),
}

export const name = 'dsh-superagent-generic'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const unregister = ctx.orchestrator.sources.register(genericKind)
    for (const instance of ctx.orchestrator.sources.instancesForKind(SOURCE)) {
      sourceContext(ctx.orchestrator, genericKind, instance.id).report('generic', {
        state: 'ready', detail: instance.workspace ? `${instance.workspace.provider} · ${instance.workspace.repository_key}` : 'Execution-only repository',
      })
    }
    return unregister
  })
}
