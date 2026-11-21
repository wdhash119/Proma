import { describe, expect, test } from 'bun:test'
import {
  canStartVoicePressToTalk,
  canStopVoicePressToTalk,
  normalizeVoicePressToTalkRequest,
} from './voice-press-to-talk-ownership'

describe('canStartVoicePressToTalk', () => {
  test('Given 空闲且已启用 When 请求开始 Then 允许', () => {
    expect(canStartVoicePressToTalk('idle', true)).toBe(true)
  })

  test('Given 空闲但未启用按住说话 When 请求开始 Then 拒绝', () => {
    expect(canStartVoicePressToTalk('idle', false)).toBe(false)
    expect(canStartVoicePressToTalk('idle', undefined)).toBe(false)
  })

  test('Given 正在录音或收尾 When 请求开始 Then 拒绝', () => {
    expect(canStartVoicePressToTalk('active', true)).toBe(false)
    expect(canStartVoicePressToTalk('stopping', true)).toBe(false)
  })
})

describe('canStopVoicePressToTalk', () => {
  test('Given 录音中且 token 一致 When 请求结束 Then 允许', () => {
    expect(canStopVoicePressToTalk('active', 'token-a', 'token-a')).toBe(true)
  })

  test('Given 录音中但 token 不一致 When 请求结束 Then 拒绝', () => {
    // 旧会话迟到的松开事件不能停掉新会话。
    expect(canStopVoicePressToTalk('active', 'token-a', 'token-b')).toBe(false)
  })

  test('Given 非长按发起的会话 When 请求结束 Then 拒绝', () => {
    expect(canStopVoicePressToTalk('active', null, 'token-a')).toBe(false)
  })

  test('Given 未在录音 When 请求结束 Then 拒绝', () => {
    expect(canStopVoicePressToTalk('idle', 'token-a', 'token-a')).toBe(false)
    expect(canStopVoicePressToTalk('stopping', 'token-a', 'token-a')).toBe(false)
  })
})

describe('normalizeVoicePressToTalkRequest', () => {
  test('Given 合法长按事件 When 校验 Then 原样返回', () => {
    expect(normalizeVoicePressToTalkRequest({ action: 'start', token: 'token-a' }))
      .toEqual({ action: 'start', token: 'token-a' })
  })

  test('Given 非法输入 When 校验 Then 丢弃', () => {
    expect(normalizeVoicePressToTalkRequest(undefined)).toBeUndefined()
    expect(normalizeVoicePressToTalkRequest(null)).toBeUndefined()
    expect(normalizeVoicePressToTalkRequest('start')).toBeUndefined()
    expect(normalizeVoicePressToTalkRequest({ action: 'pause', token: 'token-a' })).toBeUndefined()
    expect(normalizeVoicePressToTalkRequest({ action: 'start', token: '' })).toBeUndefined()
    expect(normalizeVoicePressToTalkRequest({ action: 'start', token: 'x'.repeat(129) })).toBeUndefined()
  })
})
