import { describe, expect, test } from 'bun:test'
import { attributesToRecord, buildElementHint, describeUnnamedElement } from './proma-self-element-hint'

describe('属性数组转换', () => {
  test('Given 扁平属性数组 When 转换 Then 变成键值对象', () => {
    expect(attributesToRecord(['id', 'ok', 'class', 'size-4 text-sm', 'data-testid', 'save'])).toEqual({
      id: 'ok',
      class: 'size-4 text-sm',
      'data-testid': 'save',
    })
  })

  test('Given 属性名大写 When 转换 Then 统一小写键', () => {
    expect(attributesToRecord(['ARIA-LABEL', '关闭'])).toEqual({ 'aria-label': '关闭' })
  })

  test('Given 奇数个或非字符串 When 转换 Then 跳过异常项', () => {
    expect(attributesToRecord(['a', '1', 'b'])).toEqual({ a: '1' })
    expect(attributesToRecord(undefined)).toEqual({})
  })
})

describe('识别线索提炼', () => {
  test('Given data-testid When 提炼 Then 优先返回它', () => {
    expect(buildElementHint({ 'data-testid': 'sidebar-collapse', id: 'btn', class: 'other' })).toBe('sidebar-collapse')
  })

  test('Given 只有 aria-label 或 title When 提炼 Then 直接使用', () => {
    expect(buildElementHint({ 'aria-label': '收起侧边栏' })).toBe('收起侧边栏')
    expect(buildElementHint({ title: '设置' })).toBe('设置')
  })

  test('Given 只有 id When 提炼 Then 返回 id', () => {
    expect(buildElementHint({ id: 'composer-input' })).toBe('composer-input')
  })

  test('Given 只有 class When 提炼 Then 过滤纯样式类只留语义 token', () => {
    const hint = buildElementHint({
      class: 'sidebar-collapse-button mt-2 size-10 flex-shrink-0 flex items-center justify-center rounded-[10px] text-foreground/40 hover:text-foreground',
    })
    expect(hint).toBe('sidebar-collapse-button')
  })

  test('Given class 全是样式类 When 提炼 Then 退到 type', () => {
    expect(buildElementHint({ class: 'flex items-center size-4 text-sm', type: 'submit' })).toBe('type=submit')
  })

  test('Given 什么都没有 When 提炼 Then 返回空串', () => {
    expect(buildElementHint({})).toBe('')
  })

  test('Given 超长标识 When 提炼 Then 截断到 60 字', () => {
    expect(buildElementHint({ 'data-testid': 'x'.repeat(200) }).length).toBe(60)
  })
})

describe('无名元素提示语', () => {
  test('Given 无名按钮 When 生成提示 Then 明确否决凭顺序猜', () => {
    const message = describeUnnamedElement('button')

    expect(message).toContain('无名 button')
    expect(message).toContain('PromaDomAction')
    expect(message).toContain('不要凭顺序猜')
  })
})
