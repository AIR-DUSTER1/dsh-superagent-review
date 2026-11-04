/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/** Manages installed kinds and any number of stored instances of each kind. */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  private readonly healthOwners = new Map<string, string>()
  private readonly healthNames = new Map<string, string>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim' | 'has'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a Source kind and claims the legacy health names used by its default instance. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    for (const name of kind.health) {
      const owner = this.healthNames.get(name)
      const ownHealth = this.healthOwners.get(name) === kind.kind
      if ((owner && owner !== kind.kind) || (this.board.has(name) && !ownHealth)) throw refused(name)
      this.healthNames.set(name, kind.kind)
    }
    try {
      for (const name of kind.health) {
        if (this.health.has(name)) continue
        this.health.set(name, this.board.claim(name, { state: 'starting', detail: '' }))
        this.healthOwners.set(name, kind.kind)
      }
    } catch (error) {
      this.releaseKind(kind.kind)
      for (const name of kind.health) if (this.healthNames.get(name) === kind.kind) this.healthNames.delete(name)
      throw error
    }
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => {
      this.kinds.delete(kind.kind)
      for (const name of kind.health) if (this.healthNames.get(name) === kind.kind) this.healthNames.delete(name)
      this.releaseKind(kind.kind)
      unregistered()
    }
  }

  /** Health entries for the default instance of a kind. */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }

  /** Health entries namespaced by instance id; the legacy default instance keeps its bare names. */
  healthEntriesFor(instanceId: string, kind: string, names: readonly string[]): Map<string, HealthEntry> {
    if (!this.kinds.has(kind)) return new Map()
    return new Map(names.flatMap(name => {
      const key = instanceId === kind ? name : `${instanceId}:${name}`
      let entry = this.health.get(key)
      if (!entry) {
        entry = this.board.claim(key, { state: 'starting', detail: '' })
        this.health.set(key, entry)
        this.healthOwners.set(key, kind)
      }
      return [[name, entry] as const]
    }))
  }

  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** Resolves an instance id to its installed kind id. */
  kindFor(id: string, settings = this.settings()): string | undefined {
    const stored = settings.sources[id]
    if (stored) return stored.kind ?? (this.kinds.has(id) ? id : undefined)
    return this.kinds.has(id) ? id : undefined
  }

  /** Every configured instance, including the implicit legacy instance for each installed kind. */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const result: (SourceInstance & { installed: boolean })[] = []
    const seen = new Set<string>()
    for (const [id, stored] of Object.entries(settings.sources)) {
      const kindId = stored.kind ?? (this.kinds.has(id) ? id : undefined)
      const kind = kindId ? this.kinds.get(kindId) : undefined
      if (!kind) {
        result.push({ id, kind: stored.kind ?? id, enabled: stored.enabled, config: stored.config,
          ...stored.workspace ? { workspace: stored.workspace } : {}, installed: false })
        seen.add(id)
        continue
      }
      result.push({ ...this.resolve(kind, stored, id), installed: true })
      seen.add(id)
    }
    for (const kind of [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind))) {
      if (seen.has(kind.kind)) continue
      result.push({ ...this.resolve(kind, undefined, kind.kind), installed: true })
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }

  instancesForKind(kindId: string, settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    return this.instances(settings).filter(instance => instance.kind === kindId)
  }

  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const stored = settings.sources[id]
    if (!stored) {
      const kind = this.kinds.get(id)
      return kind ? this.resolve(kind, undefined, id) as SourceInstance<C> : undefined
    }
    const kind = this.kinds.get(stored.kind ?? id)
    return kind ? this.resolve(kind, stored, id) as SourceInstance<C> : undefined
  }

  validate(id: string, value: { enabled: boolean; config: unknown; kind?: string; workspace?: unknown }): Record<string, unknown> {
    const kindId = value.kind ?? id
    const kind = this.kinds.get(kindId)
    if (!kind) throw new Error(`Source kind not installed: ${kindId}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config),
      ...(id !== kindId ? { kind: kindId } : {}), ...(value.workspace ? { workspace: value.workspace } : {}) }
  }

  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const kind = this.kinds.get(this.kindFor(id) ?? id)
      const policy = kind?.policy
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }

  policyPart(id: string, settings = this.settings()): Record<string, unknown> & { allowed: { id: string; name?: string }[] } | undefined {
    const kind = this.kinds.get(this.kindFor(id, settings) ?? '')
    const policy = kind?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }

  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kinds.get(this.kindFor(channel.source, settings) ?? '')
    if (!kind) return false
    const instance = this.instance(channel.source, settings)
    return !!instance?.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }

  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }

  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = instance.installed ? this.kinds.get(instance.kind) : undefined
      return kind?.environment && instance.enabled ? [{ instance, kind, environment: kind.environment, config: instance.config }] : []
    })
  }

  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kinds.get(this.kindFor(message.channel.source) ?? '')
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message) : 'gone'
  }

  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kinds.get(this.kindFor(channel.source) ?? '')?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }

  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }

  repliesTo(trigger: Trigger): string | undefined {
    return this.kinds.get(this.kindFor(trigger.source) ?? '')?.repliesTo?.(trigger)
  }

  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kinds.get(this.kindFor(trigger.source, settings) ?? '')
    const context = kind?.threadContext
    const instance = this.instance(trigger.source, settings)
    if (!kind || !context || !instance) return undefined
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, instance.config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }

  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kinds.get(this.kindFor(input.source, settings) ?? '')
    const stored = settings.sources[input.source]
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, stored, input.source)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }

  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown>; workspace?: SourceInstance['workspace'] } | undefined,
    id: string): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true),
      config: parsed.success ? parsed.data : kind.schema.parse({}), ...stored?.workspace ? { workspace: stored.workspace } : {} }
  }

  private releaseKind(kindId: string): void {
    for (const [key, owner] of this.healthOwners) {
      if (owner !== kindId) continue
      this.health.get(key)?.release()
      this.health.delete(key)
      this.healthOwners.delete(key)
    }
  }
}
