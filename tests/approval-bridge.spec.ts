import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Candidate, type Executor, type OutboundMessage, type Policy, type Trigger } from '../src/core/index.ts'
import { ApprovalBridge, ApprovalError } from '../src/app/approval.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'approval-bridge-test-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'state', 'orchestrator.sqlite'))
  const requests: Candidate[] = []
  const launches: string[] = []
  const executor: Executor = { start: (ticket) => { launches.push(ticket.id) }, deliver: vi.fn(), stop: vi.fn() }
  const outbox: { send(message: OutboundMessage): void; status(): undefined; withdraw(): void } = {
    send: vi.fn(), status: () => undefined, withdraw: vi.fn(),
  }
  let clock = Date.parse('2026-11-02T08:00:00.000Z')
  let bridge: ApprovalBridge
  const policy: Policy = { version: 'review-v1', paused: false, evalTimeoutMs: 60_000, reviewOnly: true,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention', source: 'feishu', sender: '陈晓' } }),
    revalidate: () => true, admitsInferred: rules => rules.length > 0 }
  const engine = new Engine({
    repo: store, scope: { scope: () => ({ listened: true, observed: true }) }, policy: () => policy,
    assessor: { request: candidate => requests.push(candidate), release: vi.fn() }, executor, outbox,
    reviewProposal: draft => bridge.createProposal(draft), emit: event => bridge.onDomainEvent(event),
    now: () => new Date(clock).toISOString(),
  })
  bridge = new ApprovalBridge({ store, engine, now: () => new Date(clock).toISOString(),
    console: { url: 'http://console.test', eventSecret: 'event-secret', sharedSecret: 'shared-secret' },
    fetcher: async () => new Response(null, { status: 200 }) })
  const trigger: Trigger = { id: 'trigger-1', source: 'feishu', threads: [{ source: 'feishu', id: 'chat:1' }],
    actor: { source: 'feishu', id: 'ou_chen' }, human: true, addressed: 'mention', at: new Date(clock).toISOString(),
    text: '请新增 HSE 导出功能', url: 'https://example.test/message/1', meta: {} }
  return { store, engine, bridge, requests, launches, trigger,
    tick: (ms: number) => { clock += ms } }
}

function accept(h: ReturnType<typeof harness>) {
  h.engine.receive(h.trigger); h.engine.evaluateDue()
  const candidate = h.requests.at(-1)!
  return h.engine.decide(h.trigger.id, { kind: 'accept', title: 'HSE 导出', scope: '新增导出接口\n补充字段映射',
    reason: '明确需求', acknowledgement: '已进入复核', rules: ['copy'], name: 'hse-export', evalId: candidate.evalId,
    review: { summary: '实现 HSE 导出', impact_files: ['src/export.ts'], test_plan: ['接口测试', '导出性能测试'],
      estimated_cost: '2 小时', risk: 'high', risk_reason: '涉及导出契约' } })
}

describe('approval bridge', () => {
  it('turns review-mode acceptance into a Proposal without creating a Ticket', () => {
    const h = harness()
    const decision = accept(h)
    const proposal = h.bridge.list()[0]!
    expect(decision.kind).toBe('ignore')
    expect(proposal).toMatchObject({ status: 'pending_review', title: 'HSE 导出', risk: 'high', scope_hash: expect.stringMatching(/^sha256:/) })
    expect(h.store.tickets.list()).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.store.keys(KV.approval.event.prefix)).toHaveLength(1)
    h.store.close()
  })

  it('requires an approved Grant and consumes it exactly once before creating a Ticket', () => {
    const h = harness()
    accept(h)
    const proposal = h.bridge.list()[0]!
    h.tick(60_000)
    const approved = h.bridge.decide(proposal.id, { proposal_id: proposal.id, decision: 'approve', reviewer: '演示复核人',
      comment: '范围明确', requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: new Date(Date.parse('2026-11-02T08:05:00.000Z')).toISOString(),
      expires_at: new Date(Date.parse('2026-11-02T09:00:00.000Z')).toISOString(), trace_id: 'trace-1', idempotency_key: 'decision-1' })
    expect(approved.proposal.status).toBe('approved')
    expect(h.store.tickets.list()).toEqual([])

    expect(() => h.bridge.execute({ proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, execution_id: 'execution-1',
      trace_id: 'trace-2', idempotency_key: 'execute-1' })).toThrowError(/schedule has not arrived/)

    h.tick(10 * 60_000)
    const executed = h.bridge.execute({ proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, execution_id: 'execution-1',
      trace_id: 'trace-2', idempotency_key: 'execute-1' })
    expect(executed.ticket_id).toBe(key('ticket', 'approval', proposal.id))
    expect(h.store.tickets.get(executed.ticket_id)).toBeTruthy()
    expect(h.bridge.get(proposal.id)).toMatchObject({ status: 'executing', grant: { status: 'consumed' }, execution: { id: 'execution-1' } })
    expect(h.bridge.execute({ proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, execution_id: 'execution-1',
      trace_id: 'trace-2', idempotency_key: 'execute-1' }).replayed).toBe(true)
    h.store.close()
  })

  it('verifies console HMAC, rejects replay, and delivers queued events idempotently', async () => {
    const h = harness()
    accept(h)
    const body = { hello: 'world' }
    const timestamp = String(Date.now())
    const nonce = 'nonce-1'
    const signature = createHmac('sha256', 'shared-secret').update(`${timestamp}.${nonce}.${JSON.stringify(body)}`).digest('hex')
    h.bridge.verifyIncoming({ timestamp, nonce, signature, body })
    expect(() => h.bridge.verifyIncoming({ timestamp, nonce, signature, body })).toThrowError(ApprovalError)
    const delivered = await h.bridge.pump()
    expect(delivered.delivered).toBe(1)
    expect(h.store.keys(KV.approval.event.prefix)).toHaveLength(0)
    h.store.close()
  })
})
