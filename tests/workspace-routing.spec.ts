import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { SettingsSchema, type WorkspaceBinding } from '../src/policy.ts'
import { WorkspaceRouter, workspaceBindingHash } from '../src/app/workspace-routing.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function binding(id: 'payments' | 'ledger'): WorkspaceBinding {
  const payment = id === 'payments'
  return { workspace_id: payment ? 'workspace-pay' : 'workspace-ledger', workspace_slug: id,
    workspace_name: payment ? '支付平台' : '账务平台', repository_id: `repo-${id}`,
    provider: 'github', repository_key: payment ? 'acme/payments' : 'acme/ledger',
    api_base_url: 'https://api.github.com', web_base_url: `https://github.com/acme/${id}`,
    clone_url: `https://github.com/acme/${id}.git`, default_branch: 'main', credential_ref: '', custom_ca_ref: null,
    description: payment ? '负责支付、退款和渠道回调' : '负责账务、凭证和总账核算', description_version: 1,
    description_hash: `sha256:${(payment ? 'a' : 'b').repeat(64)}`,
    short_description: payment ? '处理支付、退款和支付渠道回调' : '处理总账、凭证和会计期间结账',
    capabilities: payment ? ['支付', '退款', '回调'] : ['账务', '凭证', '结账'],
    routing_keywords: payment ? ['支付', '退款', '回调', '渠道'] : ['账务', '凭证', '总账', '结账'],
    exclusions: [], confidence: 0.95 }
}

function settingsValue() {
  const payments = binding('payments'), ledger = binding('ledger')
  return SettingsSchema.parse({ sources: {
    'github-payments': { enabled: true, kind: 'github', config: { repository: payments.repository_key }, workspace: payments },
    'github-ledger': { enabled: true, kind: 'github', config: { repository: ledger.repository_key }, workspace: ledger },
  } })
}

function setup() {
  const payments = binding('payments'), ledger = binding('ledger')
  const sources = new SourceRegistry(() => settingsValue())
  sources.register(githubKind)
  return { payments, ledger, sources }
}

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return { id: 'github:9', source: 'feishu', threads: [{ source: 'feishu', id: 'chat:1' }],
    actor: { source: 'feishu', id: 'ou_user' }, human: true, addressed: 'mention', at: '2026-11-04T00:00:00.000Z',
    text: '需要调整支付退款回调', meta: {}, ...overrides }
}

describe('workspace routing', () => {
  it('routes native events and clear semantic matches, but asks for people on ambiguity', () => {
    const { payments, ledger, sources } = setup()
    const router = new WorkspaceRouter(sources, () => settingsValue())
    expect(router.route({ trigger: trigger({ source: 'github-payments' }), text: 'issue', at: '2026-11-04T00:00:00.000Z' }))
      .toMatchObject({ workspace_id: payments.workspace_id, repository_id: payments.repository_id, mode: 'native' })
    expect(router.route({ trigger: trigger(), text: '支付退款渠道回调异常', at: '2026-11-04T00:00:00.000Z' }))
      .toMatchObject({ workspace_id: payments.workspace_id, repository_id: payments.repository_id, mode: 'semantic', requires_human: false })
    expect(router.route({ trigger: trigger(), text: '请处理支付和账务都相关的退款凭证', at: '2026-11-04T00:00:00.000Z' }))
      .toMatchObject({ workspace_id: null, requires_human: true })
    expect(router.route({ trigger: trigger({ meta: { workspace_id: ledger.workspace_id, repository_id: ledger.repository_id } }),
      text: '支付退款', at: '2026-11-04T00:00:00.000Z' }))
      .toMatchObject({ workspace_id: ledger.workspace_id, repository_id: ledger.repository_id, mode: 'explicit' })
    expect(workspaceBindingHash(payments)).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('constructs a workspace Source context before deployment and commands resolve', () => {
    const { sources } = setup()
    let deploymentReads = 0
    let commandReads = 0
    const deps = {
      sources,
      get deployment() { deploymentReads++; throw new Error('setup has not run') },
      get commands() { commandReads++; throw new Error('commands are not resolved') },
      ready: new Promise<void>(() => {}),
      configured: () => false,
    } as unknown as SourceContextDeps
    const context = sourceContextOf(deps, { kind: 'github', instanceId: 'github-payments', health: ['github'] })
    expect(deploymentReads).toBe(0)
    expect(commandReads).toBe(0)
    expect(context.configured()).toBe(false)
    expect(() => context.commands).toThrow('commands are not resolved')
    expect(() => context.deployment).toThrow('setup has not run')
    expect(commandReads).toBe(1)
    expect(deploymentReads).toBe(1)
  })

  it('namespaces trigger ids, threads and poll state for same-kind instances', () => {
    const { sources } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'workspace-context-'))
    dirs.push(dir)
    const store = new Store(join(dir, 'state', 'orchestrator.sqlite'))
    store.saveSettings(settingsValue())
    const received: Trigger[] = []
    const deps: SourceContextDeps = { store, outbox: { send: vi.fn() }, engine: { bindThread: vi.fn(), threadClosed: vi.fn() },
      commands: { withRepository: vi.fn(() => ({ withGitHubHost: vi.fn(() => ({})) })) } as never, sources,
      deployment: { stateDir: dir, repository: 'acme/default', github: { cli: 'gh', login: 'bot', noreply: 'bot@example.test' } } as never,
      ready: Promise.resolve(), configured: () => true, receive: next => { received.push(next); return 'stored' } }
    const pay = sourceContextOf(deps, { kind: 'github', instanceId: 'github-payments', health: ['github'] })
    const ledger = sourceContextOf(deps, { kind: 'github', instanceId: 'github-ledger', health: ['github'] })
    pay.state.set('cursor', 'pay')
    ledger.state.set('cursor', 'ledger')
    const native = trigger({ source: 'github', threads: [{ source: 'github', id: '9' }], actor: { source: 'github', id: 'alice' } })
    pay.receive(native)
    ledger.receive(native)
    expect(received.map(item => item.id)).toEqual(['github-payments:github:9', 'github-ledger:github:9'])
    expect(received.map(item => item.threads[0]?.source)).toEqual(['github-payments', 'github-ledger'])
    expect(store.get('github-payments:cursor')).toBe('pay')
    expect(store.get('github-ledger:cursor')).toBe('ledger')
    store.close()
  })
})
