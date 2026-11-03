/** Human-facing messages for review-mode handoff and approved development schedules. */
import { checkedImText } from '../infra/text.ts'
import type { Settings } from '../policy.ts'

export type ResponseLanguage = Settings['eval']['language']

const REVIEW_HANDOFF = {
  'zh-CN': '问题已经帮你记录并移交给开发。人工审批和排期完成前，不会执行任何修复操作。',
  en: 'This issue has been recorded and handed off to development. No fix will be performed until human approval and scheduling are complete.',
} as const

/** Compose the initial review acknowledgement without claiming that any repair or cleanup already happened. */
export function composeReviewAcknowledgement(explanation: string, language: ResponseLanguage): string {
  return checkedImText(`${explanation.trim()}\n\n${REVIEW_HANDOFF[language]}`)
}

function shanghaiTime(value: string, language: ResponseLanguage): string {
  const date = new Date(value)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value ?? ''
  const year = part('year'), month = Number(part('month')), day = Number(part('day'))
  const hour = part('hour'), minute = part('minute')
  return language === 'zh-CN' ? `${year}年${month}月${day}日 ${hour}:${minute}` : `${year}-${part('month')}-${part('day')} ${hour}:${minute}`
}

/** Compose the approval notice, making clear that the schedule is a development start time, not delivery time. */
export function composeScheduleNotification(scheduleAt: string, language: ResponseLanguage): string {
  const time = shanghaiTime(scheduleAt, language)
  return checkedImText(language === 'zh-CN'
    ? `开发排期已确认：${time}（北京时间）开始。\n\n这是开发开始时间，不是完成时间。开发完成后还需要测试和部署，请耐心等待后续结果。`
    : `Development is scheduled to start at ${time} (Asia/Shanghai).\n\nThis is the development start time, not the completion time. Testing and deployment still follow, so please wait for the next update.`)
}
