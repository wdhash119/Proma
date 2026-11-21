import { describe, expect, test } from 'bun:test'
import type { ComputerUseInstallation, ComputerUsePlatform, CuaUpdateStatus } from '@proma/shared'
import {
  buildComputerUseAgentPrompt,
  buildComputerUseSessionTitle,
  canCheckComputerUseUpdate,
  describeComputerUseIndicators,
  describeComputerUseStatus,
  shouldShowComputerUseDriverDetail,
} from './computer-use-settings'

function installation(
  platform: ComputerUsePlatform,
  status: ComputerUseInstallation['status'],
): ComputerUseInstallation {
  return { platform, status, driverPath: status === 'not_installed' ? undefined : '/usr/local/bin/cua-driver' }
}

const UNKNOWN_UPDATE: CuaUpdateStatus = { status: 'unknown' }
const AVAILABLE_UPDATE: CuaUpdateStatus = { status: 'available', latestVersion: '0.39.0' }

describe('Computer Use 提示词拼装', () => {
  test('Given setup 意图 When 拼装提示词 Then 包含配置记录 driver_path 行与视觉验收要求', () => {
    const prompt = buildComputerUseAgentPrompt('setup', 'windows')

    expect(prompt).toContain('driver_path: <实际可执行文件绝对路径>')
    expect(prompt).toContain('computer-use.md')
    expect(prompt).toContain('cua-driver-cli Skill')
    expect(prompt).toContain('6 × 7')
    expect(prompt).toContain('42')
    expect(prompt).toContain('不能假装完成了视觉验收')
    expect(prompt).toContain('原生 PowerShell')
    expect(prompt).toContain('含空格的可执行文件路径用 & 调用')
    expect(prompt).toContain('UIPI')
    // 首次配置不应要求跳过完整性校验
    expect(prompt).toContain('完整性校验与平台原生签名验证都不能跳过')
  })

  test('Given setup 意图且平台为 macOS When 拼装提示词 Then 要求辅助功能与屏幕录制权限核验', () => {
    const prompt = buildComputerUseAgentPrompt('setup', 'macos')

    expect(prompt).toContain('使用 Bash')
    expect(prompt).toContain('辅助功能')
    expect(prompt).toContain('屏幕录制')
    expect(prompt).toContain('permissions status')
    expect(prompt).not.toContain('原生 PowerShell')
  })

  test('Given check 意图 When 拼装提示词 Then 包含 check-update 命令与缓存判定要求', () => {
    const prompt = buildComputerUseAgentPrompt('check', 'macos')

    expect(prompt).toContain('check-update --json --no-cache')
    expect(prompt).toContain('cache_hit')
    expect(prompt).toContain('update_available')
    expect(prompt).toContain('不主动切换 stable/nightly')
    expect(prompt).toContain('不当作已是最新')
    expect(prompt).toContain('复用现有安装')
    expect(prompt).toContain('driver_path')
  })

  test('Given cdn-update 意图 When 拼装提示词 Then 说明目标版本并保留回退要求', () => {
    const prompt = buildComputerUseAgentPrompt('cdn-update', 'windows', '0.39.0')

    expect(prompt).toContain('目标版本 0.39.0')
    expect(prompt).toContain('check-update --json --no-cache')
    expect(prompt).toContain('服务重启')
    expect(prompt).toContain('保留已有路径、更新渠道与启动配置')
    expect(prompt).toContain('升级失败时保留现有可用安装')
    expect(prompt).toContain('原生 PowerShell')
  })

  test('Given Linux 平台 When 拼装任一意图 Then 说明实验性支持与 GNOME 50+ 限制', () => {
    for (const intent of ['setup', 'check', 'cdn-update'] as const) {
      const prompt = buildComputerUseAgentPrompt(intent, 'linux')
      expect(prompt).toContain('实验性支持')
      expect(prompt).toContain('GNOME 50+')
    }
  })

  test('Given 不同意图 When 生成会话标题 Then 前缀与平台名正确', () => {
    expect(buildComputerUseSessionTitle('setup', 'windows')).toBe('配置 Computer Use · Windows')
    expect(buildComputerUseSessionTitle('check', 'macos')).toBe('检查/升级 Computer Use · macOS')
    expect(buildComputerUseSessionTitle('cdn-update', 'linux')).toBe('更新 Computer Use · Linux')
  })
})

describe('Computer Use 安装状态文案', () => {
  test('Given 检测中 When 生成文案 Then 显示正在检测', () => {
    const summary = describeComputerUseStatus({ installation: null, detecting: true, failed: false })

    expect(summary.label).toBe('正在检测…')
    expect(summary.description).toBe('正在检查本机 Cua Driver 安装。')
    expect(summary.tone).toBe('neutral')
  })

  test('Given 检测失败 When 生成文案 Then 提示重新检测且语气为警示', () => {
    const summary = describeComputerUseStatus({ installation: null, detecting: false, failed: true })

    expect(summary.label).toBe('检测失败')
    expect(summary.description).toBe('暂时无法检测本机安装，请重新检测。')
    expect(summary.tone).toBe('warning')
  })

  test('Given 已安装 When 生成文案 Then 绿色系且说明无需重复安装', () => {
    const summary = describeComputerUseStatus({
      installation: installation('windows', 'installed'),
      detecting: false,
      failed: false,
    })

    expect(summary.label).toBe('已安装')
    expect(summary.description).toBe('已检测到 Cua Driver，无需重复安装。')
    expect(summary.tone).toBe('success')
  })

  test('Given 需要检查 When 生成文案 Then 提示版本未知', () => {
    const summary = describeComputerUseStatus({
      installation: installation('macos', 'needs_attention'),
      detecting: false,
      failed: false,
    })

    expect(summary.label).toBe('需要检查')
    expect(summary.description).toBe('已找到 Cua Driver，但未能确认版本，请让 Agent 检查现有安装。')
    expect(summary.tone).toBe('warning')
  })

  test('Given 未安装 When 生成文案 Then 说明查找范围', () => {
    const summary = describeComputerUseStatus({
      installation: installation('linux', 'not_installed'),
      detecting: false,
      failed: false,
    })

    expect(summary.label).toBe('未安装')
    expect(summary.description).toBe('未在配置记录、默认安装目录或 PATH 中找到 Cua Driver。')
    expect(summary.tone).toBe('warning')
  })

  test('Given 平台不支持 When 生成文案 Then 说明受支持平台', () => {
    const summary = describeComputerUseStatus({
      installation: installation('unsupported', 'unsupported'),
      detecting: false,
      failed: false,
    })

    expect(summary.label).toBe('暂不支持')
    expect(summary.description).toBe('目前支持 macOS、Windows 和 Linux。')
    expect(summary.tone).toBe('neutral')
  })

  test('Given 已安装或需要检查 When 判断明细行 Then 展示版本与路径', () => {
    expect(shouldShowComputerUseDriverDetail(installation('windows', 'installed'))).toBe(true)
    expect(shouldShowComputerUseDriverDetail(installation('windows', 'needs_attention'))).toBe(true)
    expect(shouldShowComputerUseDriverDetail(installation('windows', 'not_installed'))).toBe(false)
    expect(shouldShowComputerUseDriverDetail(null)).toBe(false)
  })

  test('Given Linux 已安装 When 判断更新检查入口 Then 不提供检查更新', () => {
    expect(canCheckComputerUseUpdate(installation('linux', 'installed'))).toBe(false)
    expect(canCheckComputerUseUpdate(installation('windows', 'installed'))).toBe(true)
    expect(canCheckComputerUseUpdate(installation('macos', 'needs_attention'))).toBe(false)
  })
})

describe('Computer Use 更新条与安装条', () => {
  test('Given 已安装且有新版本 When 判断指示器 Then 展示更新条', () => {
    const indicators = describeComputerUseIndicators({
      installation: installation('windows', 'installed'),
      detecting: false,
      updateStatus: AVAILABLE_UPDATE,
    })

    expect(indicators.showUpdate).toBe(true)
    expect(indicators.showInstall).toBe(false)
  })

  test('Given 未安装且平台受支持 When 判断指示器 Then 展示安装条', () => {
    const indicators = describeComputerUseIndicators({
      installation: installation('macos', 'not_installed'),
      detecting: false,
      updateStatus: UNKNOWN_UPDATE,
    })

    expect(indicators.showUpdate).toBe(false)
    expect(indicators.showInstall).toBe(true)
  })

  test('Given 平台不支持 When 判断指示器 Then 两条都不展示', () => {
    const indicators = describeComputerUseIndicators({
      installation: installation('unsupported', 'unsupported'),
      detecting: false,
      updateStatus: { status: 'available', latestVersion: '0.39.0' },
    })

    expect(indicators.showUpdate).toBe(false)
    expect(indicators.showInstall).toBe(false)
  })

  test('Given Linux 已安装且有新版本 When 判断指示器 Then 不展示更新条', () => {
    const indicators = describeComputerUseIndicators({
      installation: installation('linux', 'installed'),
      detecting: false,
      updateStatus: AVAILABLE_UPDATE,
    })

    expect(indicators.showUpdate).toBe(false)
  })

  test('Given 检测进行中 When 判断指示器 Then 即使状态已就绪也不展示', () => {
    const installed = describeComputerUseIndicators({
      installation: installation('windows', 'installed'),
      detecting: true,
      updateStatus: AVAILABLE_UPDATE,
    })
    const missing = describeComputerUseIndicators({
      installation: installation('windows', 'not_installed'),
      detecting: true,
      updateStatus: UNKNOWN_UPDATE,
    })

    expect(installed.showUpdate).toBe(false)
    expect(missing.showInstall).toBe(false)
  })

  test('Given 未检查到更新 When 判断指示器 Then 不展示更新条', () => {
    const indicators = describeComputerUseIndicators({
      installation: installation('windows', 'installed'),
      detecting: false,
      updateStatus: { status: 'current', currentVersion: '0.39.0', latestVersion: '0.39.0' },
    })

    expect(indicators.showUpdate).toBe(false)
  })
})
