import { describe, expect, test } from 'bun:test'
import {
  extractChangeRequestUrls,
  isCheckPending,
  normalizeChangeRequestState,
  normalizeChangeRequestUrl,
  parseChangeRequestUrl,
  sameChangeRequestUrl,
} from '@proma/shared'

describe('变更请求链接解析', () => {
  test('Given 标准 PR 链接 When 解析 Then 拆出 host/owner/repo/number', () => {
    expect(parseChangeRequestUrl('https://github.com/proma-ai/Proma/pull/123')).toEqual({
      host: 'github.com',
      owner: 'proma-ai',
      repo: 'Proma',
      number: 123,
    })
  })

  test('Given 企业 host 与大小写 When 归一化 Then 统一成小写 host', () => {
    expect(normalizeChangeRequestUrl('https://GitHub.Example.COM/Team/Repo/pull/7'))
      .toBe('https://github.example.com/Team/Repo/pull/7')
  })

  test('Given 非法链接 When 解析 Then 全部拒绝', () => {
    for (const input of [
      'http://github.com/a/b/pull/1',
      'https://github.com/a/b/issues/1',
      'https://github.com/a/b/pull/0',
      'https://user:pass@github.com/a/b/pull/1',
      'https://github.com/a/../pull/1',
      'ftp://github.com/a/b/pull/1',
      '',
    ]) {
      expect(parseChangeRequestUrl(input)).toBeNull()
    }
  })

  test('Given PR 链接带子路径 When 解析 Then 仍按同一条 PR 处理', () => {
    expect(normalizeChangeRequestUrl('https://github.com/a/b/pull/1/files'))
      .toBe('https://github.com/a/b/pull/1')
  })

  test('Given 同一 PR 的不同写法 When 比较 Then 视为同一条', () => {
    expect(sameChangeRequestUrl('https://GitHub.com/A/B/pull/1', 'https://github.com/a/b/pull/1')).toBe(true)
  })

  test('Given 正文里夹着 PR 链接 When 抽取 Then 去重并去掉尾随标点', () => {
    const text = '已创建 https://github.com/a/b/pull/2。也见 (https://github.com/a/b/pull/2) 和 https://github.com/a/b/pull/3'
    expect(extractChangeRequestUrls(text)).toEqual([
      'https://github.com/a/b/pull/2',
      'https://github.com/a/b/pull/3',
    ])
  })

  test('Given PR 状态值 When 归一化 Then 只保留三种终态语义', () => {
    expect(normalizeChangeRequestState('merged')).toBe('MERGED')
    expect(normalizeChangeRequestState('CLOSED')).toBe('CLOSED')
    expect(normalizeChangeRequestState('draft')).toBe('OPEN')
    expect(normalizeChangeRequestState(undefined)).toBe('OPEN')
  })

  test('Given check 状态 When 判断是否还在跑 Then 覆盖 pending/queued/in_progress', () => {
    expect(isCheckPending({ name: 'build', status: 'pending', conclusion: '' })).toBe(true)
    expect(isCheckPending({ name: 'build', status: 'queued', conclusion: '' })).toBe(true)
    expect(isCheckPending({ name: 'build', status: 'in_progress', conclusion: '' })).toBe(true)
    expect(isCheckPending({ name: 'build', status: 'completed', conclusion: 'SUCCESS' })).toBe(false)
  })
})
