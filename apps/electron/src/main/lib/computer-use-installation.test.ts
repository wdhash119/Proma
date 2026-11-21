import { describe, expect, test } from 'bun:test'
import { ComputerUseDriverError } from './computer-use-driver'
import { detectComputerUseInstallation } from './computer-use-installation'

describe('安装状态检测', () => {
  test('Given 不受支持的平台 When 检测 Then 直接返回 unsupported', async () => {
    const result = await detectComputerUseInstallation({
      platform: 'aix',
      resolvePath: () => {
        throw new Error('不应触碰文件系统')
      },
      readVersion: async () => {
        throw new Error('不应执行驱动')
      },
    })

    expect(result).toEqual({ platform: 'unsupported', status: 'unsupported' })
  })

  test('Given 找不到驱动 When 检测 Then 返回 not_installed', async () => {
    const result = await detectComputerUseInstallation({
      platform: 'win32',
      resolvePath: () => {
        throw new ComputerUseDriverError('driver_not_found')
      },
      readVersion: async () => '',
    })

    expect(result).toEqual({ platform: 'windows', status: 'not_installed' })
  })

  test('Given 驱动版本可识别 When 检测 Then 返回 installed 与版本号', async () => {
    const result = await detectComputerUseInstallation({
      platform: 'darwin',
      resolvePath: () => '/Users/devix/.local/bin/cua-driver',
      readVersion: async () => 'cua-driver 0.3.1 (build 9f2c)\n',
    })

    expect(result.status).toBe('installed')
    expect(result.platform).toBe('macos')
    expect(result.version).toBe('cua-driver 0.3.1 (build 9f2c)')
    expect(result.driverPath).toBe('/Users/devix/.local/bin/cua-driver')
  })

  test('Given 版本输出无法识别 When 检测 Then 返回 needs_attention 并保留路径', async () => {
    const result = await detectComputerUseInstallation({
      platform: 'linux',
      resolvePath: () => '/opt/cua/bin/cua-driver',
      readVersion: async () => 'unexpected output',
    })

    expect(result.status).toBe('needs_attention')
    expect(result.driverPath).toBe('/opt/cua/bin/cua-driver')
  })

  test('Given 版本命令执行失败 When 检测 Then 返回 needs_attention', async () => {
    const result = await detectComputerUseInstallation({
      platform: 'linux',
      resolvePath: () => '/opt/cua/bin/cua-driver',
      readVersion: async () => {
        throw new Error('spawn EACCES')
      },
    })

    expect(result.status).toBe('needs_attention')
  })

  test('Given 路径解析抛出非 driver_not_found 错误 When 检测 Then 继续向上抛出', async () => {
    const failing = detectComputerUseInstallation({
      platform: 'linux',
      resolvePath: () => {
        throw new Error('磁盘读取失败')
      },
      readVersion: async () => '',
    })

    await expect(failing).rejects.toThrow('磁盘读取失败')
  })
})
