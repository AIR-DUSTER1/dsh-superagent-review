/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** Posts a bot reply, inside the target thread when the message belongs to one; one idempotency key prevents duplicates. */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  // New Trigger channels record whether their message belongs to a thread. Legacy addresses lack the marker and keep
  // the old thread-first behavior, with the fallback below for a Feishu top-level message rejected by that mode.
  const threaded = message.channel.address.threaded !== 'false'
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', text,
    ...threaded ? ['--reply-in-thread'] : [], '--idempotency-key', message.id]
  try { await host.commands.lark(reply) }
  catch (error) {
    // Feishu 2200 is generic, but thread replies to a top-level message are a known cause. Retrying the same
    // idempotency key without the thread flag keeps this message deliverable without duplicating an uncertain send.
    if (threaded && error instanceof CliError && error.code === 2200) {
      try { await host.commands.lark(reply.filter(arg => arg !== '--reply-in-thread')) }
      catch (fallback) {
        if (gone(fallback)) return 'gone'
        throw fallback
      }
    } else {
      if (gone(error)) return 'gone'
      throw error
    }
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
