/** Workspace/repository routing over Gatehouse-confirmed repository descriptions. */
import { createHash } from 'node:crypto'
import type { Trigger } from '../core/index.ts'
import { key } from '../core/index.ts'
import type { Settings, WorkspaceBinding } from '../policy.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export type WorkspaceRouteSource = 'feishu' | 'github' | 'gitlab' | 'gitea' | 'webhook' | 'manual'
export type WorkspaceRouteMode = 'explicit' | 'native' | 'thread' | 'semantic' | 'manual'

export interface WorkspaceRouteCandidate {
  workspace_id: string
  repository_id: string | null
  confidence: number
  reason: string
}

export interface WorkspaceRouteDecision {
  id: string
  workspace_id: string | null
  repository_id: string | null
  source: WorkspaceRouteSource
  mode: WorkspaceRouteMode
  confidence: number | null
  reason: string
  candidates: WorkspaceRouteCandidate[]
  requires_human: boolean
  created_at: string
}

interface ScoredCandidate {
  binding: WorkspaceBinding
  score: number
  reasons: string[]
}

/** Resolves native source bindings and scores unbound requests against confirmed descriptions. */
export class WorkspaceRouter {
  constructor(private readonly sources: SourceRegistry, private readonly settings: () => Settings) {}

  bindings(): WorkspaceBinding[] {
    const seen = new Set<string>()
    return this.sources.instances(this.settings()).flatMap(instance => {
      const binding = instance.workspace
      if (!instance.enabled || !binding || seen.has(binding.repository_id)) return []
      seen.add(binding.repository_id)
      return [binding]
    })
  }

  native(trigger: Trigger): WorkspaceBinding | undefined {
    return this.sources.instance(trigger.source)?.workspace
  }

  binding(workspaceId: string | null, repositoryId: string | null): WorkspaceBinding | undefined {
    if (!workspaceId) return undefined
    const candidates = this.bindings().filter(binding => binding.workspace_id === workspaceId)
    return (repositoryId ? candidates.find(binding => binding.repository_id === repositoryId) : candidates[0])
  }

  route(input: { trigger: Trigger; text: string; prior?: { workspace_id: string | null; repository_id: string | null }; at: string }): WorkspaceRouteDecision {
    const source = sourceOf(input.trigger.source, this.sources)
    const sourceBound = input.trigger.meta.workspace_source === 'instance'
    const explicitWorkspace = !sourceBound && typeof input.trigger.meta.workspace_id === 'string' ? input.trigger.meta.workspace_id : null
    const explicitRepository = !sourceBound && typeof input.trigger.meta.repository_id === 'string' ? input.trigger.meta.repository_id : null
    const textual = explicitTarget(input.text, this.bindings())
    if (!sourceBound && textual.requested) {
      return decision(input, source, 'explicit', textual.binding, textual.binding ? 1 : 0,
        textual.binding ? '任务文本显式指定了目标工作区或仓库' : '任务文本指定的工作区或仓库当前不可用', false)
    }
    if (explicitWorkspace) {
      const binding = this.binding(explicitWorkspace, explicitRepository)
      return decision(input, source, 'explicit', binding, binding ? 1 : 0,
        binding ? '请求显式指定了目标工作区与仓库' : '显式指定的工作区或仓库当前不可用', true)
    }
    const native = this.native(input.trigger)
    if (native) return decision(input, source, 'native', native, 1, '原生仓库事件已携带确定的来源仓库', true)
    if (input.prior?.workspace_id) {
      const previous = this.binding(input.prior.workspace_id, input.prior.repository_id)
      if (previous) return decision(input, source, 'thread', previous, 1, '沿用同一线程或工单已确认的工作区绑定', true)
    }
    const scored = this.bindings().map(binding => score(binding, input.text)).sort((a, b) => b.score - a.score)
    const alternatives = scored.slice(0, 5).map(item => ({
      workspace_id: item.binding.workspace_id,
      repository_id: item.binding.repository_id,
      confidence: confidenceFor(item.score, scored[1]?.score ?? 0),
      reason: item.reasons.join('；') || '仅作为候选仓库参与判断',
    }))
    const top = scored[0]
    if (!top || top.score < 4) {
      return { ...decision(input, source, 'semantic', undefined, 0,
        scored.length ? '没有仓库描述达到确定性路由阈值，需要人工选择' : '当前没有已启用的仓库描述可用于路由', false),
        candidates: alternatives, requires_human: true }
    }
    const second = scored[1]
    const confidence = confidenceFor(top.score, second?.score ?? 0)
    if ((second && top.score - second.score < 2) || confidence < 0.75) {
      return { ...decision(input, source, 'semantic', undefined, confidence,
        '多个候选仓库接近或置信度不足，需要人工确认', false),
        candidates: alternatives, requires_human: true }
    }
    return { ...decision(input, source, 'semantic', top.binding, confidence,
      `仓库描述与任务关键词匹配：${top.reasons.join('；')}`, true), candidates: alternatives }
  }
}

export function workspaceBindingHash(binding: WorkspaceBinding): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ workspace_id: binding.workspace_id,
    repository_id: binding.repository_id, description_hash: binding.description_hash })).digest('hex')}`
}

function decision(input: { trigger: Trigger; at: string }, source: WorkspaceRouteSource, mode: WorkspaceRouteMode,
  binding: WorkspaceBinding | undefined, confidence: number, reason: string, candidateIsSelected: boolean): WorkspaceRouteDecision {
  return {
    id: `routing-${key('workspace-route', input.trigger.id, input.at)}`,
    workspace_id: binding?.workspace_id ?? null,
    repository_id: binding?.repository_id ?? null,
    source,
    mode,
    confidence,
    reason,
    candidates: binding && candidateIsSelected ? [{ workspace_id: binding.workspace_id, repository_id: binding.repository_id,
      confidence, reason }] : [],
    requires_human: !binding,
    created_at: input.at,
  }
}

function sourceOf(source: string, sources: SourceRegistry): WorkspaceRouteSource {
  const kind = sources.kindFor(source) ?? source
  return kind === 'feishu' || kind === 'github' || kind === 'gitlab' || kind === 'gitea' || kind === 'webhook'
    ? kind : 'manual'
}

function score(binding: WorkspaceBinding, text: string): ScoredCandidate {
  const tokens = tokenize(text)
  const keywords = binding.routing_keywords.map(normalize).filter(Boolean)
  const capabilities = binding.capabilities.map(normalize).filter(Boolean)
  const description = normalize(`${binding.short_description} ${binding.description}`)
  const excluded = binding.exclusions.map(normalize).filter(Boolean)
  let value = 0
  const reasons: string[] = []
  for (const token of tokens) {
    if (keywords.some(item => item.includes(token) || token.includes(item))) { value += 4; reasons.push(`关键词 ${token}`) }
    else if (capabilities.some(item => item.includes(token) || token.includes(item))) { value += 2; reasons.push(`能力 ${token}`) }
    else if (description.includes(token)) { value += 1; reasons.push(`描述命中 ${token}`) }
    if (excluded.some(item => item.includes(token) || token.includes(item))) { value -= 6; reasons.push(`排除项 ${token}`) }
  }
  if (normalize(text).includes(normalize(binding.repository_key))) { value += 8; reasons.push('仓库标识精确命中') }
  return { binding, score: value, reasons: [...new Set(reasons)].slice(0, 6) }
}

function confidenceFor(top: number, second: number): number {
  if (top <= 0) return 0
  return Math.max(0, Math.min(0.99, Math.round((top / Math.max(top + Math.max(0, second) + 1, 1)) * 100) / 100))
}

function normalize(value: string): string { return value.toLocaleLowerCase().replace(/\s+/g, '') }

function tokenize(value: string): string[] {
  const text = value.toLocaleLowerCase()
  const tokens = new Set<string>()
  for (const word of text.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []) tokens.add(word)
  for (const run of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    if (run.length <= 8) tokens.add(run)
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return [...tokens].slice(0, 80)
}

function explicitTarget(text: string, bindings: WorkspaceBinding[]): { requested: boolean; binding?: WorkspaceBinding } {
  const repo = /(?:^|\s)repo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(text)?.[1]
  if (repo) return { requested: true, binding: bindings.find(item => item.repository_key.toLowerCase() === repo.toLowerCase()) }
  const workspace = /(?:^|\s)workspace:([a-z0-9-]+)/i.exec(text)?.[1]
  if (workspace) return { requested: true, binding: bindings.find(item => item.workspace_slug.toLowerCase() === workspace.toLowerCase()) }
  return { requested: false }
}
