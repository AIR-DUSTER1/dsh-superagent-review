/** Durable Proposal and ApprovalGrant bridge between dsh-superagent and the review console. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { key, type DomainEvent, type EngineForApproval, type Outbox, type ReviewProposalDraft } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import { composeScheduleNotification, composeScheduleUpdatedNotification, composeScheduleWithdrawnNotification } from './review-messages.ts'

export type ApprovalRisk = 'low' | 'medium' | 'high' | 'critical'
export type ApprovalStatus = 'pending_review' | 'info_requested' | 'approved' | 'rejected' | 'scheduled' | 'executing' | 'completed' | 'failed' | 'superseded'

export interface ApprovalGrant {
  id: string
  reviewer: string
  requirement_hash: string
  scope_hash: string
  approved_at: string
  schedule_at: string
  expires_at: string
  consumed_at: string | null
  status: 'active' | 'consumed' | 'revoked' | 'expired'
}

export interface ApprovalExecution {
  id: string
  idempotency_key: string
  status: 'starting' | 'executing' | 'completed' | 'failed'
  started_at: string
  finished_at?: string
  ticket_id?: string
  error?: string
}

export interface ApprovalProposal {
  id: string
  plugin_case_id: string
  thread_key: string
  decision_id: string
  assessment_revision: number
  title: string
  requester: string
  source: 'feishu' | 'github'
  requirement_text: string
  requirement_hash: string
  summary: string
  scope: string[]
  scope_hash: string
  rule_hits: string[]
  impact_files: string[]
  test_plan: string[]
  estimated_cost: string
  risk: ApprovalRisk
  risk_reason: string
  status: ApprovalStatus
  created_at: string
  updated_at: string
  draft: ReviewProposalDraft
  decision?: { type: 'approve' | 'reject' | 'request_info'; reviewer: string; comment: string; idempotency_key: string; request_hash: string; at: string }
  grant?: ApprovalGrant
  execution?: ApprovalExecution
  schedule_change?: { idempotency_key: string; request_hash: string; schedule_at: string; expires_at: string; revision: number; at: string }
  schedule_changes?: Array<{ idempotency_key: string; request_hash: string; schedule_at: string; expires_at: string; revision: number; at: string }>
  revocation?: { idempotency_key: string; request_hash: string; reason: string; at: string }
  revocations?: Array<{ idempotency_key: string; request_hash: string; reason: string; at: string }>
}

export interface ApprovalConsoleEvent {
  version: '1.0'
  event_id: string
  event_type: 'proposal.created' | 'proposal.updated' | 'proposal.superseded' | 'execution.started' | 'execution.finished' | 'execution.failed'
  occurred_at: string
  trace_id: string
  data: Record<string, unknown>
}

export interface ApprovalConsoleConfig {
  url: string
  eventSecret: string
  sharedSecret: string
}

export const ApprovalDecisionSchema = z.object({
  proposal_id: z.string().min(1),
  decision: z.enum(['approve', 'reject', 'request_info']),
  reviewer: z.string().trim().min(1).max(200),
  comment: z.string().trim().max(2000).default(''),
  grant_id: z.string().min(1).optional(),
  requirement_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scope_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  schedule_at: z.iso.datetime({ offset: true }).optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  trace_id: z.string().min(1),
  idempotency_key: z.string().min(1).max(300),
}).strict()

export const ApprovalExecutionSchema = z.object({
  proposal_id: z.string().min(1),
  grant_id: z.string().min(1),
  requirement_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scope_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  execution_id: z.string().min(1).max(300),
  trace_id: z.string().min(1),
  idempotency_key: z.string().min(1).max(300),
}).strict()

export const ApprovalScheduleChangeSchema = z.object({
  proposal_id: z.string().min(1),
  grant_id: z.string().min(1),
  requirement_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scope_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  schedule_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  trace_id: z.string().min(1),
  idempotency_key: z.string().min(1).max(300),
}).strict()

export const ApprovalWithdrawalSchema = z.object({
  proposal_id: z.string().min(1),
  grant_id: z.string().min(1),
  requirement_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scope_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  reason: z.string().trim().max(1000).default(''),
  trace_id: z.string().min(1),
  idempotency_key: z.string().min(1).max(300),
}).strict()

export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionSchema>
export type ApprovalExecutionInput = z.infer<typeof ApprovalExecutionSchema>

/** Stable API failure surfaced to the review console with an HTTP status and recovery action. */
export class ApprovalError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly action = 'Refresh the proposal state and try again') {
    super(message)
  }
}

const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`
const jsonHash = (value: unknown): string => sha256(JSON.stringify(value))
const iso = (date = new Date()): string => date.toISOString()
const signature = (secret: string, timestamp: string, nonce: string, body: unknown): string =>
  createHmac('sha256', secret).update(`${timestamp}.${nonce}.${JSON.stringify(body)}`).digest('hex')

function scopeItems(scope: string): string[] {
  const lines = scope.split(/\n+/).map(item => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
  return lines.length ? lines : [scope]
}

export interface ApprovalBridgeHost {
  store: Store
  engine: EngineForApproval
  outbox: Pick<Outbox, 'send'>
  console?: ApprovalConsoleConfig | undefined
  now?: () => string
  fetcher?: typeof fetch
}

/** Durable review-mode Proposal store, approval gate, execution gateway and console event outbox. */
export class ApprovalBridge {
  private timer?: NodeJS.Timeout
  private pumping = false
  private readonly now: () => string
  private readonly fetcher: typeof fetch

  constructor(private readonly host: ApprovalBridgeHost) {
    this.now = host.now ?? iso
    this.fetcher = host.fetcher ?? fetch
  }

  private store(): Store { return this.host.store }
  private proposal(id: string): ApprovalProposal | undefined { return this.store().get(KV.approval.proposal(id)) }

  list(): ApprovalProposal[] {
    return this.store().keys(KV.approval.proposal.prefix).flatMap(name => {
      const value = this.store().get(name as never) as ApprovalProposal | undefined
      return value ? [value] : []
    }).sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  get(id: string): ApprovalProposal {
    const proposal = this.proposal(id)
    if (!proposal) throw new ApprovalError('PROPOSAL_NOT_FOUND', 404, `Proposal ${id} was not found`)
    return proposal
  }

  /** Turn an Engine accept under review mode into a durable Proposal and a queued console event. */
  createProposal(draft: ReviewProposalDraft): ApprovalProposal {
    const thread = draft.trigger.threads[0]
    if (!thread) throw new ApprovalError('THREAD_REQUIRED', 400, 'A review proposal requires a primary thread')
    const threadKey = `${thread.source}:${thread.id}`
    const review = draft.outcome.review ?? {}
    const requirements = draft.trigger.text
    const scope = scopeItems(draft.outcome.scope)
    const risk = review.risk ?? 'medium'
    const summary = review.summary ?? draft.outcome.scope
    const source = draft.trigger.source === 'feishu' ? 'feishu' : 'github'
    const pluginCaseId = threadKey
    const prior = this.list().filter(item => item.plugin_case_id === pluginCaseId)
    const at = draft.at
    const proposal: ApprovalProposal = {
      id: draft.id,
      plugin_case_id: pluginCaseId,
      thread_key: threadKey,
      decision_id: draft.decisionId,
      assessment_revision: prior.length + 1,
      title: draft.outcome.title,
      requester: draft.mandate.basis.sender ?? draft.trigger.actor.id,
      source,
      requirement_text: requirements,
      requirement_hash: sha256(requirements),
      summary,
      scope,
      scope_hash: jsonHash(scope),
      rule_hits: draft.outcome.rules ?? [],
      impact_files: review.impact_files ?? [],
      test_plan: review.test_plan ?? ['Run the repository build and targeted verification before delivery'],
      estimated_cost: review.estimated_cost ?? 'To be estimated by the executor',
      risk,
      risk_reason: review.risk_reason ?? 'The assessment did not provide a separate risk explanation.',
      status: 'pending_review',
      created_at: at,
      updated_at: at,
      draft,
    }
    this.store().atomic(() => {
      for (const old of prior.filter(item => ['pending_review', 'info_requested'].includes(item.status))) {
        const superseded = { ...old, status: 'superseded' as const, updated_at: at }
        this.store().set(KV.approval.proposal(old.id), superseded)
        this.enqueue({
          version: '1.0', event_id: `proposal-superseded:${old.id}`, event_type: 'proposal.superseded',
          occurred_at: at, trace_id: `dsh:${old.id}`, data: { proposal_id: old.id, superseded_by: proposal.id, updated_at: at },
        })
      }
      this.store().set(KV.approval.proposal(proposal.id), proposal)
      this.enqueue(this.proposalEvent(proposal, 'proposal.created'))
      if (draft.outcome.acknowledgement && draft.trigger.channel && draft.trigger.human) {
        this.host.outbox.send({ id: key('ack', draft.trigger.id), channel: draft.trigger.channel,
          text: draft.outcome.acknowledgement, kind: 'acknowledgement' })
      }
    })
    return proposal
  }
  /** Record a console decision. Approval creates the one-time Grant consumed by execute(). */
  decide(id: string, raw: unknown): { proposal: ApprovalProposal; grant?: ApprovalGrant; replayed: boolean } {
    const body = ApprovalDecisionSchema.parse(raw)
    if (body.proposal_id !== id) throw new ApprovalError('PROPOSAL_MISMATCH', 409, 'Path and body proposal_id do not match')
    const current = this.get(id)
    const requestHash = jsonHash({ proposalId: id, body })
    if (current.decision?.idempotency_key === body.idempotency_key) {
      if (current.decision.request_hash !== requestHash) throw new ApprovalError('IDEMPOTENCY_CONFLICT', 409, 'The idempotency key was reused with different content')
      return { proposal: current, ...(current.grant ? { grant: current.grant } : {}), replayed: true }
    }
    if (current.status !== 'pending_review') throw new ApprovalError('PROPOSAL_NOT_REVIEWABLE', 409, `Proposal is ${current.status}`)
    if (current.requirement_hash !== body.requirement_hash) throw new ApprovalError('REQUIREMENT_CHANGED', 409, 'The requirement changed after the Proposal was created')
    if (current.scope_hash !== body.scope_hash) throw new ApprovalError('SCOPE_CHANGED', 409, 'The execution scope changed after the Proposal was created')
    const at = this.now()
    let grant: ApprovalGrant | undefined
    let status: ApprovalStatus
    if (body.decision === 'approve') {
      if (!body.schedule_at || !body.expires_at) throw new ApprovalError('SCHEDULE_REQUIRED', 400, 'Approval requires schedule_at and expires_at')
      if (!body.grant_id) throw new ApprovalError('GRANT_ID_REQUIRED', 400, 'Approval requires the canonical grant_id')
      const schedule = new Date(body.schedule_at).toISOString()
      const expires = new Date(body.expires_at).toISOString()
      if (Date.parse(expires) <= Date.parse(schedule)) throw new ApprovalError('INVALID_GRANT_EXPIRY', 400, 'expires_at must be after schedule_at')
      status = 'approved'
      grant = { id: body.grant_id, reviewer: body.reviewer, requirement_hash: current.requirement_hash,
        scope_hash: current.scope_hash, approved_at: at, schedule_at: schedule, expires_at: expires, consumed_at: null, status: 'active' }
    } else status = body.decision === 'reject' ? 'rejected' : 'info_requested'
    const proposal: ApprovalProposal = { ...current, status, updated_at: at,
      decision: { type: body.decision, reviewer: body.reviewer, comment: body.comment,
        idempotency_key: body.idempotency_key, request_hash: requestHash, at },
      ...(grant ? { grant } : {}) }
    this.store().atomic(() => {
      this.store().set(KV.approval.proposal(id), proposal)
      if (grant && current.draft.trigger.channel && current.draft.trigger.human) {
        this.host.outbox.send({ id: key('approval-schedule', proposal.id), channel: current.draft.trigger.channel,
          text: composeScheduleNotification(grant.schedule_at, this.store().settings().eval.language), kind: 'reply' })
      }
    })
    return { proposal, ...(grant ? { grant } : {}), replayed: false }
  }

  /** Move an active Grant to a new schedule and notify the requester. */
  reschedule(id: string, raw: unknown): { proposal: ApprovalProposal; replayed: boolean } {
    const body = ApprovalScheduleChangeSchema.parse(raw)
    if (body.proposal_id !== id) throw new ApprovalError('PROPOSAL_MISMATCH', 409, 'Path and body proposal_id do not match')
    const current = this.get(id)
    const requestHash = jsonHash({ proposalId: id, body })
    const previousChange = current.schedule_changes?.find(change => change.idempotency_key === body.idempotency_key)
    if (previousChange) {
      if (previousChange.request_hash !== requestHash) throw new ApprovalError('IDEMPOTENCY_CONFLICT', 409, 'The idempotency key was reused with different content')
      return { proposal: current, replayed: true }
    }
    if (current.status !== 'approved') throw new ApprovalError('PROPOSAL_NOT_APPROVED', 409, `Proposal is ${current.status}`)
    const grant = current.grant
    if (!grant || grant.id !== body.grant_id) throw new ApprovalError('GRANT_NOT_FOUND', 409, 'The ApprovalGrant does not match this Proposal')
    if (grant.status !== 'active' || grant.consumed_at) throw new ApprovalError('GRANT_CONSUMED', 409, 'The ApprovalGrant is no longer active')
    if (current.requirement_hash !== body.requirement_hash) throw new ApprovalError('REQUIREMENT_CHANGED', 409, 'The requirement changed after approval')
    if (current.scope_hash !== body.scope_hash) throw new ApprovalError('SCOPE_CHANGED', 409, 'The execution scope changed after approval')
    const at = this.now()
    const schedule = new Date(body.schedule_at).toISOString()
    const expires = new Date(body.expires_at).toISOString()
    if (Date.parse(schedule) <= Date.parse(at)) throw new ApprovalError('SCHEDULE_IN_PAST', 400, 'The new schedule must be in the future')
    if (Date.parse(expires) <= Date.parse(schedule)) throw new ApprovalError('INVALID_GRANT_EXPIRY', 400, 'expires_at must be after schedule_at')
    const revision = (current.schedule_change?.revision ?? 0) + 1
    const change = { idempotency_key: body.idempotency_key, request_hash: requestHash,
      schedule_at: schedule, expires_at: expires, revision, at }
    const proposal: ApprovalProposal = { ...current, updated_at: at,
      grant: { ...grant, schedule_at: schedule, expires_at: expires },
      schedule_change: change, schedule_changes: [...current.schedule_changes ?? [], change].slice(-50) }
    this.store().atomic(() => {
      this.store().set(KV.approval.proposal(id), proposal)
      if (current.draft.trigger.channel && current.draft.trigger.human) {
        this.host.outbox.send({ id: key('approval-reschedule', body.idempotency_key), channel: current.draft.trigger.channel,
          text: composeScheduleUpdatedNotification(schedule, this.store().settings().eval.language), kind: 'reply' })
      }
    })
    return { proposal, replayed: false }
  }

  /** Revoke an active Grant, return the Proposal to review, and notify the requester. */
  withdraw(id: string, raw: unknown): { proposal: ApprovalProposal; replayed: boolean } {
    const body = ApprovalWithdrawalSchema.parse(raw)
    if (body.proposal_id !== id) throw new ApprovalError('PROPOSAL_MISMATCH', 409, 'Path and body proposal_id do not match')
    const current = this.get(id)
    const requestHash = jsonHash({ proposalId: id, body })
    const previousRevocation = current.revocations?.find(revocation => revocation.idempotency_key === body.idempotency_key)
    if (previousRevocation) {
      if (previousRevocation.request_hash !== requestHash) throw new ApprovalError('IDEMPOTENCY_CONFLICT', 409, 'The idempotency key was reused with different content')
      return { proposal: current, replayed: true }
    }
    if (current.status !== 'approved') throw new ApprovalError('PROPOSAL_NOT_APPROVED', 409, `Proposal is ${current.status}`)
    const grant = current.grant
    if (!grant || grant.id !== body.grant_id) throw new ApprovalError('GRANT_NOT_FOUND', 409, 'The ApprovalGrant does not match this Proposal')
    if (grant.status !== 'active' || grant.consumed_at) throw new ApprovalError('GRANT_CONSUMED', 409, 'The ApprovalGrant is no longer active')
    if (current.requirement_hash !== body.requirement_hash) throw new ApprovalError('REQUIREMENT_CHANGED', 409, 'The requirement changed after approval')
    if (current.scope_hash !== body.scope_hash) throw new ApprovalError('SCOPE_CHANGED', 409, 'The execution scope changed after approval')
    const at = this.now()
    const revocation = { idempotency_key: body.idempotency_key, request_hash: requestHash, reason: body.reason, at }
    const proposal: ApprovalProposal = { ...current, status: 'pending_review', updated_at: at,
      grant: { ...grant, status: 'revoked' },
      revocation, revocations: [...current.revocations ?? [], revocation].slice(-50) }
    this.store().atomic(() => {
      this.store().set(KV.approval.proposal(id), proposal)
      if (current.draft.trigger.channel && current.draft.trigger.human) {
        this.host.outbox.send({ id: key('approval-withdraw', body.idempotency_key), channel: current.draft.trigger.channel,
          text: composeScheduleWithdrawnNotification(this.store().settings().eval.language), kind: 'reply' })
      }
    })
    return { proposal, replayed: false }
  }

  /** Consume the Grant and create the Ticket only after every review binding has been rechecked. */
  execute(raw: unknown): { execution_id: string; ticket_id: string; replayed: boolean } {
    const body = ApprovalExecutionSchema.parse(raw)
    const current = this.get(body.proposal_id)
    if (current.execution) {
      if (current.execution.idempotency_key === body.idempotency_key && current.execution.id === body.execution_id && current.execution.ticket_id) {
        return { execution_id: current.execution.id, ticket_id: current.execution.ticket_id, replayed: true }
      }
      throw new ApprovalError('EXECUTION_CONFLICT', 409, 'This Proposal already has a different execution')
    }
    if (current.status !== 'approved') throw new ApprovalError('PROPOSAL_NOT_APPROVED', 409, `Proposal is ${current.status}`)
    const grant = current.grant
    if (!grant || grant.id !== body.grant_id) throw new ApprovalError('GRANT_NOT_FOUND', 409, 'The ApprovalGrant does not match this Proposal')
    if (grant.status !== 'active' || grant.consumed_at) throw new ApprovalError('GRANT_CONSUMED', 409, 'The ApprovalGrant is no longer active')
    if (current.requirement_hash !== body.requirement_hash) throw new ApprovalError('REQUIREMENT_CHANGED', 409, 'The requirement no longer matches the Grant')
    if (current.scope_hash !== body.scope_hash) throw new ApprovalError('SCOPE_CHANGED', 409, 'The scope no longer matches the Grant')
    const at = this.now()
    if (Date.parse(at) < Date.parse(grant.schedule_at)) throw new ApprovalError('EXECUTION_TOO_EARLY', 409, 'The approved schedule has not arrived')
    if (Date.parse(at) >= Date.parse(grant.expires_at)) throw new ApprovalError('GRANT_EXPIRED', 409, 'The ApprovalGrant has expired')
    if (this.store().settings().paused) throw new ApprovalError('EXECUTION_PAUSED', 409, 'Agent processing is paused')

    const ticketId = key('ticket', 'approval', current.id)
    let result = ''
    this.store().atomic(() => {
      const executing: ApprovalProposal = { ...current, status: 'executing', updated_at: at,
        grant: { ...grant, status: 'consumed', consumed_at: at },
        execution: { id: body.execution_id, idempotency_key: body.idempotency_key, status: 'starting', started_at: at, ticket_id: ticketId } }
      this.store().set(KV.approval.proposal(current.id), executing)
      this.store().set(KV.approval.ticket(ticketId), current.id)
      result = this.host.engine.executeProposal(current.draft)
      const started = this.proposal(current.id) ?? executing
      this.store().set(KV.approval.proposal(current.id), { ...started, execution: { ...started.execution!, ticket_id: result } })
    })
    return { execution_id: body.execution_id, ticket_id: result, replayed: false }
  }

  /** Project Engine lifecycle events into console execution events. */
  onDomainEvent(event: DomainEvent): void {
    if (event.type !== 'ticket.created' && event.type !== 'ticket.ended' && event.type !== 'worker.reported') return
    const proposalId = this.store().get(KV.approval.ticket(event.data.ticketId))
    if (!proposalId) return
    const proposal = this.proposal(proposalId)
    if (!proposal?.execution) return
    if (event.type === 'ticket.created') {
      if (proposal.status === 'executing' && proposal.execution.status === 'executing') return
      const updated: ApprovalProposal = { ...proposal, status: 'executing', updated_at: event.at,
        execution: { ...proposal.execution, status: 'executing', ticket_id: event.data.ticketId } }
      this.store().atomic(() => {
        this.store().set(KV.approval.proposal(proposal.id), updated)
        this.enqueue(this.executionEvent(updated, 'execution.started', event.at))
      })
      return
    }
    if (event.type === 'worker.reported') {
      if (event.data.state !== 'failed' && event.data.state !== 'blocked') return
      const failed: ApprovalProposal = { ...proposal, status: 'failed', updated_at: event.at,
        execution: { ...proposal.execution, status: 'failed', finished_at: event.at, error: event.data.summary } }
      this.store().atomic(() => {
        this.store().set(KV.approval.proposal(proposal.id), failed)
        this.enqueue(this.executionEvent(failed, 'execution.failed', event.at))
      })
      return
    }
    const outcome = event.data.outcome
    const completed = outcome === 'completed' || outcome === 'merged'
    const updated: ApprovalProposal = { ...proposal, status: completed ? 'completed' : 'failed', updated_at: event.at,
      execution: { ...proposal.execution, status: completed ? 'completed' : 'failed', finished_at: event.at,
        ...(completed ? {} : { error: event.data.reason ?? `Ticket ended as ${outcome}` }) } }
    this.store().atomic(() => {
      this.store().set(KV.approval.proposal(proposal.id), updated)
      this.enqueue(this.executionEvent(updated, completed ? 'execution.finished' : 'execution.failed', event.at))
    })
  }

  /** Verify a console HMAC request and persist its nonce to prevent replay. */
  verifyIncoming(input: { timestamp: string; nonce: string; signature: string; body: unknown }): void {
    const secret = this.host.console?.sharedSecret
    if (!secret) throw new ApprovalError('CONSOLE_SECRET_UNSET', 503, 'Console shared secret is not configured')
    const timestamp = Number(input.timestamp)
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000) {
      throw new ApprovalError('SIGNATURE_EXPIRED', 401, 'The request timestamp is outside the allowed window')
    }
    if (!input.nonce || this.store().get(KV.approval.nonce(input.nonce))) throw new ApprovalError('NONCE_REPLAYED', 409, 'The request nonce was already used')
    const expected = Buffer.from(signature(secret, input.timestamp, input.nonce, input.body), 'hex')
    const received = Buffer.from(input.signature, 'hex')
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new ApprovalError('INVALID_SIGNATURE', 401, 'The request signature is invalid')
    }
    this.store().set(KV.approval.nonce(input.nonce), this.now())
  }

  start(): void {
    if (this.timer || !this.host.console?.url) return
    this.timer = setInterval(() => void this.pump().catch(() => {}), 2_000)
    this.timer.unref()
    void this.pump().catch(() => {})
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async pump(): Promise<{ delivered: number; retried: number }> {
    const console = this.host.console
    if (this.pumping || !console?.url || !console.eventSecret) return { delivered: 0, retried: 0 }
    this.pumping = true
    let delivered = 0, retried = 0
    try {
      const at = this.now()
      for (const name of this.store().keys(KV.approval.event.prefix)) {
        const queued = this.store().get(name as never) as { event: ApprovalConsoleEvent; attempts: number; nextAt: string; error?: string } | undefined
        if (!queued || queued.nextAt > at) continue
        const timestamp = String(Date.now())
        const nonce = randomUUID()
        try {
          const response = await this.fetcher(`${console.url.replace(/\/$/, '')}/api/plugin/events`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-nonce': nonce,
              'x-signature': signature(console.eventSecret, timestamp, nonce, queued.event) },
            body: JSON.stringify(queued.event), signal: AbortSignal.timeout(5_000),
          })
          if (!response.ok) throw new Error(`console ${response.status}: ${(await response.text()).slice(0, 300)}`)
          this.store().delete(name)
          delivered += 1
        } catch (error) {
          const attempts = queued.attempts + 1
          const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))
          this.store().set(name as never, { ...queued, attempts, nextAt: new Date(Date.now() + delay).toISOString(),
            error: error instanceof Error ? error.message : String(error) })
          retried += 1
        }
      }
      return { delivered, retried }
    } finally { this.pumping = false }
  }

  private enqueue(event: ApprovalConsoleEvent): void {
    if (this.store().get(KV.approval.event(event.event_id))) return
    this.store().set(KV.approval.event(event.event_id), { event, attempts: 0, nextAt: this.now() })
  }

  private proposalEvent(proposal: ApprovalProposal, type: 'proposal.created' | 'proposal.updated'): ApprovalConsoleEvent {
    const caseId = `case_${sha256(proposal.plugin_case_id).slice(7, 23)}`
    return {
      version: '1.0', event_id: `${type}:${proposal.id}`, event_type: type, occurred_at: proposal.updated_at,
      trace_id: `dsh:${proposal.id}`,
      data: {
        case: { id: caseId, plugin_case_id: proposal.plugin_case_id, source: proposal.source, requester: proposal.requester,
          title: proposal.title, requirement_text: proposal.requirement_text, requirement_hash: proposal.requirement_hash,
          status: proposal.status, risk_level: proposal.risk, source_context: `dsh-superagent / ${proposal.thread_key}`,
          message_url: proposal.draft.trigger.url ?? null, created_at: proposal.created_at, updated_at: proposal.updated_at },
        proposal: { id: proposal.id, review_case_id: caseId, assessment_revision: proposal.assessment_revision,
          summary: proposal.summary, scope: proposal.scope, scope_hash: proposal.scope_hash, rule_hits: proposal.rule_hits,
          impact_files: proposal.impact_files, test_plan: proposal.test_plan, estimated_cost: proposal.estimated_cost,
          risk: proposal.risk, risk_reason: proposal.risk_reason, status: proposal.status,
          created_at: proposal.created_at, updated_at: proposal.updated_at },
      },
    }
  }

  private executionEvent(proposal: ApprovalProposal, type: 'execution.started' | 'execution.finished' | 'execution.failed', at: string): ApprovalConsoleEvent {
    return {
      version: '1.0', event_id: `${type}:${proposal.execution!.id}${type === 'execution.failed' ? `:${at}` : ''}`, event_type: type, occurred_at: at,
      trace_id: `dsh:${proposal.id}`,
      data: { proposal_id: proposal.id, execution_id: proposal.execution!.id, pr_url: null,
        ...(proposal.execution!.error ? { error: proposal.execution!.error } : {}) },
    }
  }
}
