import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Candidate, type Executor, type OutboundMessage, type Policy, type Trigger } from '../src/core/index.ts'
import { ApprovalBridge, ApprovalDecisionSchema, ApprovalError } from '../src/app/approval.ts'
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
  const delivered: OutboundMessage[] = []
  const executor: Executor = { start: (ticket) => { launches.push(ticket.id) }, deliver: vi.fn(), stop: vi.fn() }
  const outbox: { send(message: OutboundMessage): void; status(): undefined; withdraw(): void } = {
    send: message => { delivered.push(message) }, status: () => undefined, withdraw: vi.fn(),
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
  bridge = new ApprovalBridge({ store, engine, outbox: { send: outbox.send }, now: () => new Date(clock).toISOString(),
    console: { url: 'http://console.test', eventSecret: 'event-secret', sharedSecret: 'shared-secret' },
    fetcher: async () => new Response(null, { status: 200 }) })
  const trigger: Trigger = { id: 'trigger-1', source: 'feishu', threads: [{ source: 'feishu', id: 'chat:1' }],
    actor: { source: 'feishu', id: 'ou_chen' }, human: true, addressed: 'mention', at: new Date(clock).toISOString(),
    text: '请新增 HSE 导出功能', url: 'https://example.test/message/1',
    channel: { source: 'feishu', thread: 'chat:1', address: { message_id: 'om_1' } }, meta: {} }
  return { store, engine, bridge, requests, launches, delivered, trigger,
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
  it('accepts a decision without a review comment', () => {
    const hash = `sha256:${'a'.repeat(64)}`
    const decision = ApprovalDecisionSchema.parse({
      proposal_id: 'proposal-1', decision: 'approve', reviewer: '演示复核人',
      grant_id: 'grant-test-1',
      requirement_hash: hash, scope_hash: hash,
      schedule_at: '2026-11-02T08:05:00.000Z', expires_at: '2026-11-02T09:00:00.000Z',
      trace_id: 'trace-1', idempotency_key: 'decision-1',
    })
    expect(decision.comment).toBe('')
    expect(ApprovalDecisionSchema.safeParse({ ...decision, comment: '   ' }).success).toBe(true)
  })

  it('turns review-mode acceptance into a Proposal without creating a Ticket', () => {
    const h = harness()
    const decision = accept(h)
    const proposal = h.bridge.list()[0]!
    expect(decision.kind).toBe('ignore')
    expect(proposal).toMatchObject({ status: 'pending_review', title: 'HSE 导出', risk: 'high', scope_hash: expect.stringMatching(/^sha256:/) })
    expect(h.store.tickets.list()).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.store.keys(KV.approval.event.prefix)).toHaveLength(1)
    expect(h.delivered).toContainEqual(expect.objectContaining({ id: key('ack', h.trigger.id), text: '已进入复核',
      kind: 'acknowledgement', channel: h.trigger.channel }))
    h.store.close()
  })

  it('requires an approved Grant and consumes it exactly once before creating a Ticket', () => {
    const h = harness()
    accept(h)
    const proposal = h.bridge.list()[0]!
    h.tick(60_000)
    const approved = h.bridge.decide(proposal.id, { proposal_id: proposal.id, decision: 'approve', reviewer: '演示复核人',
      comment: '范围明确', grant_id: 'grant-gatehouse-1', requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: new Date(Date.parse('2026-11-02T08:05:00.000Z')).toISOString(),
      expires_at: new Date(Date.parse('2026-11-02T09:00:00.000Z')).toISOString(), trace_id: 'trace-1', idempotency_key: 'decision-1' })
    expect(approved.proposal.status).toBe('approved')
    expect(approved.grant?.id).toBe('grant-gatehouse-1')
    expect(h.store.tickets.list()).toEqual([])
    const scheduleNotice = h.delivered.find(message => message.id === key('approval-schedule', proposal.id))
    expect(scheduleNotice).toMatchObject({ kind: 'reply', channel: h.trigger.channel })
    expect(scheduleNotice?.text).toContain('开发排期已确认')
    expect(scheduleNotice?.text).toContain('这是开发开始时间，不是完成时间。')

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

  it('moves an active Grant to a new schedule before execution', () => {
    const h = harness()
    accept(h)
    const proposal = h.bridge.list()[0]!
    h.tick(60_000)
    const approved = h.bridge.decide(proposal.id, { proposal_id: proposal.id, decision: 'approve', reviewer: '演示复核人',
      comment: '', grant_id: 'grant-gatehouse-1', requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: '2026-11-02T08:05:00.000Z', expires_at: '2026-11-02T09:00:00.000Z',
      trace_id: 'trace-1', idempotency_key: 'decision-1' })

    const changed = h.bridge.reschedule(proposal.id, { proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: '2026-11-02T08:15:00.000Z', expires_at: '2026-11-02T09:15:00.000Z',
      trace_id: 'trace-change', idempotency_key: 'change-1' })
    expect(changed.proposal.grant).toMatchObject({ schedule_at: '2026-11-02T08:15:00.000Z', status: 'active' })
    expect(changed.proposal.schedule_change).toMatchObject({ revision: 1 })
    expect(h.delivered.some(message => message.text.includes('开发排期已调整'))).toBe(true)

    const changedAgain = h.bridge.reschedule(proposal.id, { proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: '2026-11-02T08:20:00.000Z', expires_at: '2026-11-02T09:20:00.000Z',
      trace_id: 'trace-change-2', idempotency_key: 'change-2' })
    const replayedOld = h.bridge.reschedule(proposal.id, { proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: '2026-11-02T08:15:00.000Z', expires_at: '2026-11-02T09:15:00.000Z',
      trace_id: 'trace-change', idempotency_key: 'change-1' })
    expect(replayedOld.replayed).toBe(true)
    expect(changedAgain.proposal.grant?.schedule_at).toBe('2026-11-02T08:20:00.000Z')
    expect(replayedOld.proposal.grant?.schedule_at).toBe('2026-11-02T08:20:00.000Z')

    expect(() => h.bridge.execute({ proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, execution_id: 'execution-1',
      trace_id: 'trace-2', idempotency_key: 'execute-1' })).toThrowError(/schedule has not arrived/)

    h.tick(19 * 60_000)
    const executed = h.bridge.execute({ proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, execution_id: 'execution-1',
      trace_id: 'trace-2', idempotency_key: 'execute-1' })
    expect(executed.ticket_id).toBe(key('ticket', 'approval', proposal.id))
    h.store.close()
  })

  it('withdraws an active Grant and allows a fresh approval', () => {
    const h = harness()
    accept(h)
    const proposal = h.bridge.list()[0]!
    h.tick(60_000)
    const approved = h.bridge.decide(proposal.id, { proposal_id: proposal.id, decision: 'approve', reviewer: '演示复核人',
      comment: '', grant_id: 'grant-gatehouse-1', requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: '2026-11-02T08:05:00.000Z', expires_at: '2026-11-02T09:00:00.000Z',
      trace_id: 'trace-1', idempotency_key: 'decision-1' })
    const withdrawn = h.bridge.withdraw(proposal.id, { proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, reason: '排期调整',
      trace_id: 'trace-withdraw', idempotency_key: 'withdraw-1' })
    expect(withdrawn.proposal).toMatchObject({ status: 'pending_review', grant: { status: 'revoked' } })
    expect(h.delivered.some(message => message.text.includes('开发排期已撤回'))).toBe(true)
    expect(() => h.bridge.execute({ proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, execution_id: 'execution-1',
      trace_id: 'trace-2', idempotency_key: 'execute-1' })).toThrowError(/pending_review/)

    const renewed = h.bridge.decide(proposal.id, { proposal_id: proposal.id, decision: 'approve', reviewer: '演示复核人',
      comment: '', grant_id: 'grant-gatehouse-2', requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash,
      schedule_at: '2026-11-02T08:30:00.000Z', expires_at: '2026-11-02T09:30:00.000Z',
      trace_id: 'trace-renew', idempotency_key: 'decision-2' })
    expect(renewed.proposal).toMatchObject({ status: 'approved', grant: { status: 'active' } })
    const oldWithdrawal = h.bridge.withdraw(proposal.id, { proposal_id: proposal.id, grant_id: approved.grant!.id,
      requirement_hash: proposal.requirement_hash, scope_hash: proposal.scope_hash, reason: '排期调整',
      trace_id: 'trace-withdraw', idempotency_key: 'withdraw-1' })
    expect(oldWithdrawal.replayed).toBe(true)
    expect(h.bridge.get(proposal.id)).toMatchObject({ status: 'approved', grant: { status: 'active' } })
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
