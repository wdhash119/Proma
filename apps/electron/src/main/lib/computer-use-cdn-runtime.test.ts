import { describe, expect, spyOn, test } from 'bun:test'
import type { ComputerUseInstallation } from '@proma/shared'
import { CuaUpdateCheckRunner } from './computer-use-cdn-runtime'
import type { CuaUpdateCheckRunnerDependencies } from './computer-use-cdn-runtime'
import type { CuaCdnManifest } from './computer-use-cdn-update'
import { LABELS } from './computer-use-cdn-update'

function manifestOf(version: string): CuaCdnManifest {
  return {
    schemaVersion: 1,
    version,
    assets: LABELS.map((label) => ({
      label,
      name: `cua-driver-rs-${version}-${label}.${label.startsWith('windows-') ? 'zip' : 'tar.gz'}`,
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
    })),
  }
}

interface RunnerHarness {
  runner: CuaUpdateCheckRunner
  saved: string[]
  manifestCalls: () => number
}

/** 组装被测 runner：安装状态、清单与落盘全部用内存替身。 */
function createRunner(
  options: {
    installation?: ComputerUseInstallation
    latest?: string
    manifest?: () => Promise<CuaCdnManifest>
    platform?: NodeJS.Platform
    arch?: string
  } = {},
): RunnerHarness {
  const saved: string[] = []
  let manifestCalls = 0
  const deps: CuaUpdateCheckRunnerDependencies = {
    installation: async () => options.installation ?? { platform: 'windows', status: 'installed', version: 'cua-driver 0.3.1' },
    manifest: () => {
      manifestCalls += 1
      return options.manifest ? options.manifest() : Promise.resolve(manifestOf('0.3.1'))
    },
    saveLatest: (version) => {
      saved.push(version)
    },
    latest: options.latest,
    platform: options.platform ?? 'win32',
    arch: options.arch ?? 'x64',
  }
  return { runner: new CuaUpdateCheckRunner(deps), saved, manifestCalls: () => manifestCalls }
}

describe('更新检查结论', () => {
  test('Given Linux 已安装驱动 When 查询结论 Then 返回 unknown', async () => {
    const { runner } = createRunner({
      platform: 'linux',
      installation: { platform: 'linux', status: 'installed', version: 'cua-driver 0.3.1' },
    })

    expect(await runner.status()).toEqual({ status: 'unknown' })
  })

  test('Given 平台不受清单覆盖 When 查询结论 Then 返回 unknown', async () => {
    const { runner } = createRunner({
      platform: 'win32',
      arch: 'ia32',
      installation: { platform: 'windows', status: 'installed', version: 'cua-driver 0.3.1' },
    })

    expect(await runner.status()).toEqual({ status: 'unknown' })
  })

  test('Given 驱动未安装 When 查询结论 Then 返回 unknown', async () => {
    const { runner } = createRunner({ installation: { platform: 'windows', status: 'not_installed' } })

    expect(await runner.status()).toEqual({ status: 'unknown' })
  })

  test('Given 已安装但版本输出缺失 When 查询结论 Then 返回 unknown', async () => {
    const { runner } = createRunner({ installation: { platform: 'windows', status: 'installed' } })

    expect(await runner.status()).toEqual({ status: 'unknown' })
  })

  test('Given 版本输出无法解析 When 查询结论 Then 返回 error', async () => {
    for (const version of ['cua-driver abc', 'cua-driver', 'something 1.0.0', 'cua-driver 1.0 beta']) {
      const { runner } = createRunner({ installation: { platform: 'windows', status: 'installed', version } })
      expect(await runner.status()).toEqual({ status: 'error' })
    }
  })

  test('Given 尚未拿到清单且未失败 When 查询结论 Then 返回 unknown 并带本地版本', async () => {
    const { runner } = createRunner()

    expect(await runner.status()).toEqual({ status: 'unknown', currentVersion: '0.3.1' })
  })

  test('Given 清单版本更新 When 查询结论 Then 返回 available', async () => {
    const { runner } = createRunner({ latest: '0.4.0' })

    expect(await runner.status()).toEqual({ status: 'available', currentVersion: '0.3.1', latestVersion: '0.4.0' })
  })

  test('Given 清单版本相同 When 查询结论 Then 返回 current', async () => {
    const { runner } = createRunner({ latest: '0.3.1' })

    expect(await runner.status()).toEqual({ status: 'current', currentVersion: '0.3.1', latestVersion: '0.3.1' })
  })

  test('Given 传入的缓存版本非法 When 查询结论 Then 视为未检查', async () => {
    const { runner } = createRunner({ latest: 'not-a-version' })

    expect(await runner.status()).toEqual({ status: 'unknown', currentVersion: '0.3.1' })
  })
})

describe('主动检查', () => {
  test('Given 无本地版本 When 检查 Then 不访问 CDN 并直接返回结论', async () => {
    const harness = createRunner({ installation: { platform: 'windows', status: 'not_installed' } })

    expect(await harness.runner.check()).toEqual({ status: 'unknown' })
    expect(harness.manifestCalls()).toBe(0)
  })

  test('Given 清单版本更新 When 检查 Then 落盘一次并返回 available', async () => {
    const harness = createRunner({ manifest: async () => manifestOf('0.5.0') })

    expect(await harness.runner.check()).toEqual({ status: 'available', currentVersion: '0.3.1', latestVersion: '0.5.0' })
    expect(harness.saved).toEqual(['0.5.0'])
    expect(await harness.runner.status()).toEqual({
      status: 'available',
      currentVersion: '0.3.1',
      latestVersion: '0.5.0',
    })
  })

  test('Given 清单版本与本地一致 When 检查 Then 返回 current', async () => {
    const harness = createRunner({ manifest: async () => manifestOf('0.3.1') })

    expect(await harness.runner.check()).toEqual({ status: 'current', currentVersion: '0.3.1', latestVersion: '0.3.1' })
    expect(harness.saved).toEqual(['0.3.1'])
  })

  test('Given 清单版本低于已知版本 When 检查 Then 抛出降级且不落盘', async () => {
    const harness = createRunner({ latest: '0.5.0', manifest: async () => manifestOf('0.4.0') })

    await expect(harness.runner.check()).rejects.toThrow('Cua CDN 清单出现降级')
    expect(harness.saved).toEqual([])
  })

  test('Given 清单版本无法解析 When 检查 Then 抛出解析失败', async () => {
    const harness = createRunner({ manifest: async () => ({ ...manifestOf('0.4.0'), version: 'latest' }) })

    await expect(harness.runner.check()).rejects.toThrow('Cua CDN 版本无法解析')
    expect(harness.saved).toEqual([])
  })

  test('Given 已有成功结论且本次请求失败 When 检查 Then 保留旧结论', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const harness = createRunner({
        latest: '0.4.0',
        manifest: async () => {
          throw new Error('Cua CDN 请求失败: HTTP 502')
        },
      })

      expect(await harness.runner.check()).toEqual({
        status: 'available',
        currentVersion: '0.3.1',
        latestVersion: '0.4.0',
      })
      expect(harness.saved).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('Given 从未成功检查且请求失败 When 检查 Then 向上抛出', async () => {
    const harness = createRunner({
      manifest: async () => {
        throw new Error('Cua CDN 请求失败: HTTP 502')
      },
    })

    await expect(harness.runner.check()).rejects.toThrow('Cua CDN 请求失败: HTTP 502')
    expect(harness.saved).toEqual([])
  })

  test('Given 无缓存版本且检查失败 When 再次查询结论 Then 返回 error 并保留本地版本', async () => {
    const harness = createRunner({
      manifest: async () => {
        throw new Error('Cua CDN 请求失败: HTTP 502')
      },
    })

    await expect(harness.runner.check()).rejects.toThrow('Cua CDN 请求失败: HTTP 502')
    // 失败状态需要让设置页把「无法判断」升级为可操作提示，因此本地版本仍然保留。
    expect(await harness.runner.status()).toEqual({ status: 'error', currentVersion: '0.3.1' })
  })

  test('Given 先失败后成功 When 检查 Then 清空失败标记并落盘', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      let attempt = 0
      const harness = createRunner({
        manifest: async () => {
          attempt += 1
          if (attempt === 2) throw new Error('Cua CDN 请求失败: HTTP 502')
          return manifestOf('0.6.0')
        },
      })

      expect((await harness.runner.check()).status).toBe('available')
      // 第二次失败时保留上次结论，不把 UI 打回未知状态。
      expect((await harness.runner.check()).latestVersion).toBe('0.6.0')
      expect(harness.saved).toEqual(['0.6.0'])
    } finally {
      warn.mockRestore()
    }
  })
})
