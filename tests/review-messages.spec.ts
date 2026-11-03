import { describe, expect, it } from 'vitest'
import { composeReviewAcknowledgement, composeScheduleNotification } from '../src/app/review-messages.ts'

describe('review messages', () => {
  it('hands a reviewed issue to development without claiming any action', () => {
    const message = composeReviewAcknowledgement(
      '这个报错是切换仓库前遗留的旧仓库订阅；它仍在用新仓库读取 PR #1，所以每次轮询都会返回 404。',
      'zh-CN',
    )
    expect(message).toContain('旧仓库订阅')
    expect(message).toContain('问题已经帮你记录并移交给开发。')
    expect(message).toContain('不会执行任何修复操作。')
  })

  it('states that the approved schedule is a development start time', () => {
    const message = composeScheduleNotification('2026-11-02T08:05:00.000Z', 'zh-CN')
    expect(message).toContain('2026年11月2日 16:05（北京时间）')
    expect(message).toContain('这是开发开始时间，不是完成时间。')
    expect(message).toContain('还需要测试和部署')
  })
})
