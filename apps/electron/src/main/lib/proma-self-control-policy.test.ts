import { describe, expect, test } from 'bun:test'
import {
  PROMA_SELF_CONTROL_PROJECT_CONSENT_DENIED,
  PROMA_SELF_CONTROL_PROJECT_CONSENT_ERROR,
  PROMA_SELF_CONTROL_PROTECTED_ERROR,
  PROMA_SELF_CONTROL_PROTECTED_SELECTOR,
  PROMA_SELF_PROJECT_CONSENT_LABEL,
  buildPromaSelfControlProjectCreationFunction,
  buildPromaSelfControlProtectionFunction,
  createPromaSelfControlDomGuard,
  hasPromaSelfProjectConsent,
  isPromaSelfControlActionLabelProtected,
  isPromaSelfControlProjectCreationLabel,
} from './proma-self-control-policy'
import { cdpAxPropertyBoolean, cdpTextValue, isEditableCdpAxNode } from './cdp-ax'

describe('受保护控件判定', () => {
  test('Given 删除/支付/授权类标签 When 判定 Then 命中禁止规则', () => {
    for (const label of ['删除项目', '清空记录', '购买套餐', '订阅专业版', '退出登录', '停止 Agent', '发送消息', '确认删除', 'Delete project', 'Sign out']) {
      expect(isPromaSelfControlActionLabelProtected(label)).toBe(true)
    }
  })

  test('Given 普通浏览类标签 When 判定 Then 不命中', () => {
    for (const label of ['设置', '外观设置', '打开文件', '查看详情', '切换标签']) {
      expect(isPromaSelfControlActionLabelProtected(label)).toBe(false)
    }
  })

  test('Given 创建项目标签 When 判定 Then 需要用户同意', () => {
    for (const label of ['新建项目', '创建项目', '新建空白项目', '从本地文件夹创建项目', 'New project', 'Create project']) {
      expect(isPromaSelfControlProjectCreationLabel(label)).toBe(true)
    }
    expect(isPromaSelfControlProjectCreationLabel('项目设置')).toBe(false)
  })

  test('Given 受保护选择器 When 检查 Then 覆盖 deny 区块、弹窗与密码框', () => {
    expect(PROMA_SELF_CONTROL_PROTECTED_SELECTOR).toContain('data-proma-self-control="deny"')
    expect(PROMA_SELF_CONTROL_PROTECTED_SELECTOR).toContain('[role="alertdialog"]')
    expect(PROMA_SELF_CONTROL_PROTECTED_SELECTOR).toContain('input[type="password"]')
  })
})

describe('注入页面上下文的检测函数', () => {
  test('Given 保护函数 When 生成 Then 是自包含的函数声明', () => {
    const source = buildPromaSelfControlProtectionFunction()

    expect(source.startsWith('function isPromaSelfControlProtected(element)')).toBe(true)
    // 需要向上遍历 shadow root，否则富文本与 Web Component 里的按钮会被漏判。
    expect(source).toContain('getRootNode')
    expect(source).toContain('root.host')
    // 动作标签规则以正则字面量注入（中文被转义成 unicode escape），核对可见关键词即可。
    expect(source).toContain('delete|remove|pay|purchase')
  })

  test('Given 创建项目函数 When 生成 Then 检查专用选择器与标签', () => {
    const source = buildPromaSelfControlProjectCreationFunction()

    expect(source.startsWith('function isPromaSelfControlProjectCreation(element)')).toBe(true)
    expect(source).toContain('create-project')
    expect(source).toContain('new\\s+(?:blank\\s+)?project')
  })

  test('Given 守卫配置 When 生成 Then 携带两个源码与错误文案', () => {
    const guard = createPromaSelfControlDomGuard()

    expect(guard.protectionFunctionSource).toContain('isPromaSelfControlProtected')
    expect(guard.projectCreationFunctionSource).toContain('isPromaSelfControlProjectCreation')
    expect(guard.errorMessage).toBe(PROMA_SELF_CONTROL_PROTECTED_ERROR)
  })

  test('Given 提示文案 When 检查 Then 都指向用户亲自处理', () => {
    expect(PROMA_SELF_CONTROL_PROTECTED_ERROR).toContain('需要用户亲自操作')
    expect(PROMA_SELF_CONTROL_PROJECT_CONSENT_ERROR).toContain('AskUserQuestion')
    expect(PROMA_SELF_CONTROL_PROJECT_CONSENT_DENIED).toContain('取消')
  })
})

describe('创建项目授权回答判定', () => {
  test('Given 预定义同意选项 When 判定 Then 授权通过', () => {
    expect(PROMA_SELF_PROJECT_CONSENT_LABEL).toBe('同意')
    expect(hasPromaSelfProjectConsent({ 创建项目: '同意' })).toBe(true)
    // 多选按集合判定：连接字符串里包含精确的同意选项即可。
    expect(hasPromaSelfProjectConsent({ 创建项目: '先说明用途, 同意' })).toBe(true)
  })

  test('Given 拒绝或否定语义 When 判定 Then 一律不授权', () => {
    for (const answer of ['拒绝', '不同意', '不要创建', 'yesn\'t', '不', '']) {
      expect(hasPromaSelfProjectConsent({ 创建项目: answer })).toBe(false)
    }
  })

  test('Given 自定义自然语言 When 判定 Then 不视为授权', () => {
    for (const answer of ['同意吧', '我认为可以创建', 'yes', 'approve', 'OK', '同意（但先备份）']) {
      expect(hasPromaSelfProjectConsent({ 创建项目: answer })).toBe(false)
    }
  })

  test('Given 空答案或非字符串 When 判定 Then 不授权', () => {
    expect(hasPromaSelfProjectConsent({})).toBe(false)
    expect(hasPromaSelfProjectConsent({ 创建项目: null })).toBe(false)
    expect(hasPromaSelfProjectConsent({ 创建项目: ['同意'] })).toBe(false)
  })
})

describe('CDP AX 工具', () => {
  test('Given 字符串或对象形态的 AX 值 When 取值 Then 都能读出文本', () => {
    expect(cdpTextValue('按钮')).toBe('按钮')
    expect(cdpTextValue({ type: 'string', value: '按钮' })).toBe('按钮')
    expect(cdpTextValue({ type: 'boolean', value: true })).toBe('true')
    expect(cdpTextValue(undefined)).toBe('')
    expect(cdpTextValue({})).toBe('')
  })

  test('Given properties 里的布尔属性 When 读取 Then 支持对象与字符串两种形态', () => {
    expect(cdpAxPropertyBoolean({ properties: [{ name: 'focused', value: { value: true } }] }, 'focused')).toBe(true)
    expect(cdpAxPropertyBoolean({ properties: [{ name: 'focused', value: 'true' }] }, 'focused')).toBe(true)
    expect(cdpAxPropertyBoolean({ properties: [{ name: 'focused', value: { value: false } }] }, 'focused')).toBe(false)
    expect(cdpAxPropertyBoolean({}, 'focused')).toBe(false)
  })

  test('Given editable 属性或输入类 role When 判断可编辑 Then 命中', () => {
    expect(isEditableCdpAxNode({ role: 'textbox' })).toBe(true)
    expect(isEditableCdpAxNode({ role: 'searchbox' })).toBe(true)
    expect(isEditableCdpAxNode({ role: 'combobox' })).toBe(true)
    expect(isEditableCdpAxNode({ role: 'generic', properties: [{ name: 'editable', value: { value: true } }] })).toBe(true)
    expect(isEditableCdpAxNode({ role: 'button' })).toBe(false)
  })
})
