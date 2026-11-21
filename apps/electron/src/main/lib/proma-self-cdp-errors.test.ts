import { describe, expect, test } from 'bun:test'
import {
  INTERFACE_MAY_HAVE_CHANGED_MESSAGE,
  STALE_ELEMENT_MESSAGE,
  extractErrorMessage,
  isDocumentNotRequestedError,
  isStaleNodeError,
  normalizeCdpError,
} from './proma-self-cdp-errors'

describe('错误信息提取', () => {
  test('Given Error 或字符串 When 提取 Then 返回 message', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom')
    expect(extractErrorMessage('boom')).toBe('boom')
  })

  test('Given CDP 的 message 或 error 字段 When 提取 Then 都能取到', () => {
    expect(extractErrorMessage({ message: 'No node with given id found' })).toBe('No node with given id found')
    expect(extractErrorMessage({ error: 'detached node' })).toBe('detached node')
  })

  test('Given 无信息 When 提取 Then 返回空串', () => {
    expect(extractErrorMessage(null)).toBe('')
    expect(extractErrorMessage({})).toBe('')
  })
})

describe('失效节点识别', () => {
  test('Given CDP 报节点不存在 When 判断 Then 命中失效', () => {
    for (const message of [
      'No node with given id found',
      'No node found for given backend id',
      'Could not find node with given id',
      'Node with given id does not belong to the document',
      'Cannot find context with specified id',
      'Execution context was destroyed.',
      'Attempted to use detached node',
      'Node is detached from document',
    ]) {
      expect(isStaleNodeError(new Error(message))).toBe(true)
    }
  })

  test('Given 普通错误 When 判断 Then 不算失效', () => {
    expect(isStaleNodeError(new Error('访问路径超出授权范围'))).toBe(false)
    expect(isStaleNodeError(new Error('超时'))).toBe(false)
    expect(isStaleNodeError(null)).toBe(false)
  })
})

describe('文档树未请求识别', () => {
  test('Given CDP 报文档未请求 When 判断 Then 命中', () => {
    expect(isDocumentNotRequestedError(new Error('Document needs to be requested first'))).toBe(true)
  })

  test('Given 其它错误 When 判断 Then 不命中', () => {
    expect(isDocumentNotRequestedError(new Error('No node with given id found'))).toBe(false)
  })
})

describe('错误归一化', () => {
  test('Given 失效节点 When 归一化 Then 换成可执行提示并保留原文', () => {
    const result = normalizeCdpError(new Error('No node with given id found'))

    expect(result.stale).toBe(true)
    expect(result.message).toBe(STALE_ELEMENT_MESSAGE)
    // 原始信息保留给日志，不进模型上下文。
    expect(result.original).toBe('No node with given id found')
  })

  test('Given 可执行提示 When 检查 Then 明确要求重新观察且不要原样重试', () => {
    expect(STALE_ELEMENT_MESSAGE).toContain('失效')
    expect(STALE_ELEMENT_MESSAGE).toContain('重新调用 PromaObserve')
    expect(STALE_ELEMENT_MESSAGE).toContain('不要原样重试')
  })

  test('Given 普通错误 When 归一化 Then 原样返回且不标记失效', () => {
    const result = normalizeCdpError(new Error('目标元素当前被浮层遮挡'))

    expect(result.stale).toBe(false)
    expect(result.message).toBe('目标元素当前被浮层遮挡')
  })

  test('Given 空错误 When 归一化 Then 退回通用文案', () => {
    expect(normalizeCdpError(null).message).toBe('Proma 界面操作失败。')
  })

  test('Given 等待用户后的提示 When 检查 Then 要求先重新观察', () => {
    expect(INTERFACE_MAY_HAVE_CHANGED_MESSAGE).toContain('重新调用 PromaObserve')
  })
})
