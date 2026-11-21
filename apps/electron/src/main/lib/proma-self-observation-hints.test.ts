import { describe, expect, test } from 'bun:test'
import {
  describeClickObstruction,
  describeWaitTimeout,
  extractVisibleTextSample,
  summarizeVisibleText,
} from './proma-self-observation-hints'

describe('可见文本摘要', () => {
  test('Given 多行文本 When 摘要 Then 折叠成单行', () => {
    expect(summarizeVisibleText('设置\n\n  外观\t主题  ')).toBe('设置 外观 主题')
  })

  test('Given 超长文本 When 摘要 Then 按上限截断并加省略号', () => {
    const summary = summarizeVisibleText('x'.repeat(500), 100)
    expect(summary.length).toBe(101)
    expect(summary.endsWith('…')).toBe(true)
  })

  test('Given 空白文本 When 摘要 Then 返回空串', () => {
    expect(summarizeVisibleText('   \n\t ')).toBe('')
  })
})

describe('可见文本取样还原', () => {
  test('Given 正常对象或字符串 When 还原 Then 拼接标题与文本', () => {
    expect(extractVisibleTextSample({ text: '正文', title: '标题' })).toBe('标题 正文')
    expect(extractVisibleTextSample({ text: '正文' })).toBe('正文')
    expect(extractVisibleTextSample('纯文本')).toBe('纯文本')
    expect(extractVisibleTextSample(null)).toBe('')
  })

  test('Given 超长文本被序列化截断 When 还原 Then 从预览前缀取回文本而不是空串', () => {
    const longText = `设置 外观 主题 ${'x'.repeat(70_000)}`
    const serialized = JSON.stringify({ text: longText, title: '长页面' })
    const truncated = {
      truncated: true,
      preview: serialized.slice(0, 64_000),
      totalChars: serialized.length,
    }

    const sample = extractVisibleTextSample(truncated)

    expect(sample).not.toBe('')
    // 标题排在正文之后，超长正文会把它挤出预览前缀，但正文取样必须被取回。
    expect(sample).toContain('设置 外观 主题')
    expect(sample.length).toBeGreaterThan(1_000)
  })

  test('Given 截断对象但没有可用字段 When 还原 Then 返回空串', () => {
    expect(extractVisibleTextSample({ truncated: true, preview: '{"other":"value"}', totalChars: 99 })).toBe('')
    expect(extractVisibleTextSample({ truncated: true })).toBe('')
  })
})

describe('等待超时提示', () => {
  test('Given 文本条件未出现 When 生成提示 Then 说明目标并给出当前界面文本', () => {
    const message = describeWaitTimeout('text', '已保存', '设置 外观 主题 深色')

    expect(message).toContain('文本「已保存」超时')
    expect(message).toContain('当前可见文本：设置 外观 主题 深色')
    expect(message).toContain('重新调用 PromaObserve')
    // 明确劝阻重复同一个等待。
    expect(message).toContain('不要重复同一个等待')
  })

  test('Given selector 条件未出现 When 生成提示 Then 指向 selector 与实际内容', () => {
    const message = describeWaitTimeout('selector', '.dialog', '首页 会话列表')

    expect(message).toContain('selector「.dialog」')
    expect(message).toContain('当前可见文本：首页 会话列表')
  })

  test('Given 页面没有可见文本 When 生成提示 Then 明确说明为空', () => {
    expect(describeWaitTimeout('text', 'x', '')).toContain('当前页面没有可见文本')
  })
})

describe('点击遮挡提示', () => {
  test('Given 挡在前面的是具名控件 When 生成提示 Then 报出具体控件', () => {
    const message = describeClickObstruction({ role: 'button', name: '切换思考强度' })

    expect(message).toContain('被button「切换思考强度」遮挡')
    expect(message).toContain('点击未执行')
    expect(message).toContain('重新调用 PromaObserve')
  })

  test('Given 只有 role When 生成提示 Then 仍能说明', () => {
    expect(describeClickObstruction({ role: 'generic', name: '' })).toContain('被generic遮挡')
  })

  test('Given 完全不知道挡了什么 When 生成提示 Then 退回通用说法', () => {
    expect(describeClickObstruction(null)).toContain('其他界面元素遮挡')
  })
})
