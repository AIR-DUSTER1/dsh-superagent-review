import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Store } from '../src/app/store.ts'
import { WorkspaceService } from '../src/app/workspace-service.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { genericKind } from '../src/sources/generic.ts'
import type { WorkspaceBinding } from '../src/policy.ts'

const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
function binding(overrides: Partial<WorkspaceBinding> = {}): WorkspaceBinding {
  return { workspace_id: 'workspace-pay', workspace_slug: 'payments', workspace_name: '支付平台', repository_id: 'repo-pay',
    provider: 'github', repository_key: 'acme/payments', api_base_url: 'https://api.github.com',
    web_base_url: 'https://github.com/acme/payments', clone_url: 'https://github.com/acme/payments.git', default_branch: 'main',
    credential_ref: '', custom_ca_ref: null, description: '支付、结算与对账服务', description_version: 2,
    description_hash: `sha256:${'a'.repeat(64)}`, short_description: '负责支付、结算与对账的后端服务',
    capabilities: ['支付', '结算', '对账'], routing_keywords: ['支付', '对账', '退款'], exclusions: ['前端样式'], confidence: 0.94,
    ...overrides }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-service-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'state', 'orchestrator.sqlite'))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(githubKind)
  sources.register(genericKind)
  const restart = vi.fn()
  return { store, sources, restart }
}

describe('workspace service', () => {
  it('persists multiple workspace source instances and is idempotent', () => {
    vi.stubEnv('DSH_SUPERAGENT_REPOSITORY_HOST_ALLOWLIST', 'gitlab.example')
    vi.stubEnv('DSH_SUPERAGENT_ALLOW_PRIVATE_REPOSITORY_HOSTS', 'true')
    const { store, sources, restart } = setup()
    const pay = binding()
    const internal = binding({ workspace_id: 'workspace-core', workspace_slug: 'core', workspace_name: '核心系统',
      repository_id: 'repo-core', provider: 'gitlab', repository_key: 'group/core', api_base_url: 'https://gitlab.example/api/v4',
      web_base_url: 'https://gitlab.example/group/core', clone_url: 'https://gitlab.example/group/core.git',
      description_hash: `sha256:${'b'.repeat(64)}`, routing_keywords: ['核心', '权限'] })
    const workspaces = [syncItem(pay, 'github-payments'), syncItem(internal, 'gitlab-core')]
    const payload = { trace_id: 'trace-sync', idempotency_key: 'sync-1', config_version: 1,
      config_hash: hash(JSON.stringify(workspaces)), workspaces }
    const service = new WorkspaceService({ context: {} as Context, store, sources, restart, model: async () => undefined,
      now: () => '2026-11-04T00:00:00.000Z' })
    const applied = service.sync(payload)
    expect(applied).toMatchObject({ applied: 2, config_version: 1, replayed: false })
    expect(store.settings().sources).toMatchObject({
      github: { enabled: false },
      'github-payments': { enabled: true, kind: 'github', workspace: { workspace_id: 'workspace-pay' } },
      'gitlab-core': { enabled: true, kind: 'generic', workspace: { workspace_id: 'workspace-core' } },
    })
    expect(sources.instances().find(instance => instance.id === 'github-payments')).toMatchObject({ kind: 'github', enabled: true })
    expect(sources.instances().find(instance => instance.id === 'gitlab-core')).toMatchObject({ kind: 'generic', enabled: true })
    expect(restart).toHaveBeenCalledOnce()
    expect(service.sync(payload)).toMatchObject({ replayed: true, applied: 2 })
    expect(restart).toHaveBeenCalledOnce()
    store.close()
  })

  it('discovers a repository and lets the configured model produce a confirmed description suggestion', async () => {
    const { store, sources, restart } = setup()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/readme')) return new Response('# Payments\nHandles payment, settlement and reconciliation.', { status: 200 })
      return new Response(JSON.stringify({ full_name: 'acme/payments', html_url: 'https://github.com/acme/payments',
        default_branch: 'main', language: 'TypeScript', topics: ['payments', 'ledger'], permissions: { push: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const llmText = JSON.stringify({ short_description: '该仓库负责支付、结算、退款与对账能力，包含支付渠道适配和账务处理模块。',
      capabilities: ['支付', '退款', '对账'], routing_keywords: ['支付', '退款', '结算', '对账', '账单'],
      exclusions: ['纯前端视觉'], confidence: 0.93 })
    const context = { llm: { stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: llmText }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() } } as unknown as Context
    const service = new WorkspaceService({ context, store, sources, restart, fetcher: fetcher as unknown as typeof fetch,
      model: async () => ({ provider: 'mock', model: 'mock-model' }), now: () => '2026-11-04T00:00:00.000Z' })
    const request = repositoryRequest(binding())
    const discovery = await service.discover(request)
    expect(discovery).toMatchObject({ repository_key: 'acme/payments', language: 'TypeScript',
      permissions: { read: true, push: true, change_requests: true } })
    const suggestion = await service.describe(request)
    expect(suggestion).toMatchObject({ model: 'mock/mock-model', confidence: 0.93,
      source_fingerprint: discovery.source_fingerprint })
    expect(suggestion.routing_keywords).toContain('对账')
    store.close()
  })

  it('requires an explicit allowlist entry for private repository hosts', async () => {
    const { store, sources, restart } = setup()
    const service = new WorkspaceService({ context: {} as Context, store, sources, restart, model: async () => undefined })
    vi.stubEnv('DSH_SUPERAGENT_ALLOW_PRIVATE_REPOSITORY_HOSTS', 'true')
    vi.stubEnv('DSH_SUPERAGENT_REPOSITORY_HOST_ALLOWLIST', '')
    await expect(service.discover(repositoryRequest(binding({ provider: 'gitlab',
      api_base_url: 'https://git.internal.example/api/v4', web_base_url: 'https://git.internal.example/acme/payments',
      clone_url: 'https://git.internal.example/acme/payments.git' })))).rejects.toThrow('REPOSITORY_HOST_NOT_ALLOWED')
    vi.unstubAllEnvs()
    store.close()
  })

  it('rejects unsupported credential and custom CA references instead of ignoring them', async () => {
    const { store, sources, restart } = setup()
    const service = new WorkspaceService({ context: {} as Context, store, sources, restart, model: async () => undefined })
    await expect(service.discover(repositoryRequest(binding({ credential_ref: 'system:build-bot' }))))
      .rejects.toThrow('CREDENTIAL_REFERENCE_UNSUPPORTED')
    await expect(service.discover(repositoryRequest(binding({ custom_ca_ref: 'file:C:/certs/internal-ca.pem' }))))
      .rejects.toThrow('CUSTOM_CA_REFERENCE_UNSUPPORTED')
    const items = [syncItem(binding({ credential_ref: 'system:build-bot' }), 'github-payments')]
    expect(() => service.sync({ trace_id: 'trace-sync', idempotency_key: 'sync-invalid-credential', config_version: 1,
      config_hash: hash(JSON.stringify(items)), workspaces: items })).toThrow('CREDENTIAL_REFERENCE_UNSUPPORTED')
    store.close()
  })

  it('rejects a payload whose configuration hash does not match', () => {
    const { store, sources, restart } = setup()
    const service = new WorkspaceService({ context: {} as Context, store, sources, restart, model: async () => undefined })
    expect(() => service.sync({ trace_id: 't', idempotency_key: 'i', config_version: 1,
      config_hash: `sha256:${'0'.repeat(64)}`, workspaces: [] })).toThrow('WORKSPACE_CONFIG_HASH_MISMATCH')
    store.close()
  })
})

function syncItem(item: WorkspaceBinding, sourceInstanceId: string) {
  return { workspace_id: item.workspace_id, repository_id: item.repository_id, provider: item.provider,
    repository_key: item.repository_key, api_base_url: item.api_base_url, web_base_url: item.web_base_url,
    clone_url: item.clone_url, default_branch: item.default_branch, credential_ref: item.credential_ref,
    custom_ca_ref: item.custom_ca_ref, observe: { issues: true, change_requests: true, comments: true, ci: true },
    trace_id: 'trace-repo', idempotency_key: `repo:${sourceInstanceId}`, workspace_slug: item.workspace_slug,
    workspace_name: item.workspace_name, workspace_status: 'active' as const, description: item.description,
    description_version: item.description_version, description_hash: item.description_hash,
    short_description: item.short_description, capabilities: item.capabilities, routing_keywords: item.routing_keywords,
    exclusions: item.exclusions, confidence: item.confidence, source_instance_id: sourceInstanceId }
}

function repositoryRequest(item: WorkspaceBinding) {
  return { workspace_id: item.workspace_id, repository_id: item.repository_id, provider: item.provider,
    repository_key: item.repository_key, api_base_url: item.api_base_url, web_base_url: item.web_base_url,
    clone_url: item.clone_url, default_branch: item.default_branch, credential_ref: item.credential_ref,
    custom_ca_ref: item.custom_ca_ref, observe: { issues: true, change_requests: true, comments: true, ci: true },
    trace_id: 'trace-repo', idempotency_key: 'repo:test' }
}
