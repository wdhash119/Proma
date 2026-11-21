import { describe, expect, test } from 'bun:test'
import type { AgentStreamCompletePayload, AutomationResultNotifyPolicy } from '@proma/shared'
import type { CompletionNotificationDecisionInput } from './agent-completion-presence'
import { decideCompletionNotification } from './agent-completion-presence'

interface DecisionOverrides extends Partial<Omit<CompletionNotificationDecisionInput, 'completion' | 'session'>> {
  completion?: Partial<AgentStreamCompletePayload>
  session?: CompletionNotificationDecisionInput['session']
}

function decide(overrides: DecisionOverrides = {}) {
  const { completion, ...rest } = overrides
  return decideCompletionNotification({
    completion: { sessionId: 'session-1', triggeredBy: 'user', resultSubtype: 'success', ...completion },
    session: {},
    hasStreamError: false,
    backgroundTasksPending: false,
    unviewed: true,
    notificationsEnabled: true,
    soundEnabled: true,
    ...rest,
  })
}

describe('完成提醒的单一入口', () => {
  test('Given 顶层成功且未查看 When 完成 Then 只发一次桌面通知并带声音', () => {
    expect(decide()).toEqual({ notify: true, sound: true })
  })

  test('Given 成功但已查看 When 完成 Then 桌面通知与声音都不触发', () => {
    expect(decide({ unviewed: false })).toEqual({ notify: false, sound: false })
  })

  test('Given 用户停止或流错误或异常 subtype When 完成 Then 不伪装成完成提醒', () => {
    expect(decide({ completion: { stoppedByUser: true } })).toEqual({ notify: false, sound: false })
    expect(decide({ hasStreamError: true })).toEqual({ notify: false, sound: false })
    expect(decide({ completion: { resultSubtype: 'error_during_execution' } })).toEqual({ notify: false, sound: false })
    expect(decide({ completion: { resultSubtype: 'error_max_turns' } })).toEqual({ notify: false, sound: false })
  })

  test('Given 仍有后台任务 When 完成 Then 等真正结束再提醒', () => {
    expect(decide({ backgroundTasksPending: true })).toEqual({ notify: false, sound: false })
  })

  test('Given 委派子会话 When 完成 Then 由父会话汇总，不单独提醒', () => {
    expect(decide({ completion: { triggeredBy: 'delegation' } })).toEqual({ notify: false, sound: false })
    expect(decide({ session: { sourceDelegationId: 'delegation-1' } })).toEqual({ notify: false, sound: false })
  })

  test('Given 通知或声音被用户关闭 When 成功未查看 Then 只保留对应开关的行为', () => {
    expect(decide({ notificationsEnabled: false })).toEqual({ notify: false, sound: false })
    expect(decide({ soundEnabled: false })).toEqual({ notify: true, sound: false })
  })
})

describe('定时任务策略矩阵', () => {
  const policies: Array<AutomationResultNotifyPolicy | undefined> = [undefined, 'always', 'failures-only', 'never']

  test('Given 成功结果 When 按策略判断 Then 只有 always/未设置会提醒', () => {
    const decisions = policies.map((notifyPolicy) => ({
      notifyPolicy,
      decision: decide({ session: { sourceAutomationId: 'automation-1' }, notifyPolicy }),
    }))

    for (const { notifyPolicy, decision } of decisions) {
      expect(decision.notify).toBe(notifyPolicy === undefined || notifyPolicy === 'always')
      expect(decision.sound).toBe(notifyPolicy === undefined || notifyPolicy === 'always')
    }
  })

  test('Given 失败或停止 When 完成 Then 无论策略与查看状态都不提醒', () => {
    for (const notifyPolicy of policies) {
      expect(decide({
        session: { sourceAutomationId: 'automation-1' },
        notifyPolicy,
        completion: { resultSubtype: 'error_during_execution' },
      })).toEqual({ notify: false, sound: false })
      expect(decide({
        session: { sourceAutomationId: 'automation-1' },
        notifyPolicy,
        completion: { stoppedByUser: true },
      })).toEqual({ notify: false, sound: false })
    }
  })

  test('Given 非定时任务 When 用户未查看成功 Then 不受任何任务策略影响', () => {
    expect(decide({ session: {}, notifyPolicy: 'never' })).toEqual({ notify: true, sound: true })
  })
})
