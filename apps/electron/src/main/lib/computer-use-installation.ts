/**
 * Computer Use 安装状态检测。
 *
 * 安装页和设置页只需要结论：当前平台是否受支持、驱动是否已安装、版本是否可识别。
 * 检测本身不下载、不修改磁盘，只解析驱动路径并执行一次 `--version`。
 * 当前阶段只提供检测能力，下载/更新与设置页入口由后续阶段接入。
 */

import { execFile } from 'node:child_process'
import type {
  ComputerUseInstallation,
  ComputerUseInstallationStatus as ComputerUseInstallationState,
  ComputerUsePlatform,
} from '@proma/shared'
import { ComputerUseDriverError, computerUseDriverPath } from './computer-use-driver'

/** 平台归类，便于 UI 直接展示文案。 */
export type ComputerUseInstallationPlatform = ComputerUsePlatform

/**
 * 安装状态：
 * - `installed`：驱动存在且版本可识别；
 * - `not_installed`：找不到驱动；
 * - `needs_attention`：找到驱动但版本输出异常，需要用户重新安装或修复；
 * - `unsupported`：当前平台不支持 Computer Use。
 */
export type ComputerUseInstallationStatus = ComputerUseInstallationState

/** 检测结果：与 shared 层的 ComputerUseInstallation 完全一致，可直接过 IPC。 */
export type ComputerUseInstallationResult = ComputerUseInstallation

/** 版本输出格式：`cua-driver 0.1.2 ...`。 */
const DRIVER_VERSION_PATTERN = /^cua-driver\s+\d+\.\d+\.\d+[^\r\n]*$/i
/** 版本字符串上限，防止异常输出进入 UI。 */
const DRIVER_VERSION_MAX_LENGTH = 120

export interface ComputerUseInstallationDependencies {
  platform: NodeJS.Platform
  /** 解析驱动路径；找不到时抛 ComputerUseDriverError('driver_not_found')。 */
  resolvePath: () => string
  /** 执行 `cua-driver --version` 并返回 stdout。 */
  readVersion: (driverPath: string) => Promise<string>
}

function toInstallationPlatform(platform: NodeJS.Platform): ComputerUseInstallationPlatform {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'unsupported'
}

/** 检测驱动安装状态；不支持的平台直接返回 unsupported，不触碰文件系统。 */
export async function detectComputerUseInstallation(
  dependencies: ComputerUseInstallationDependencies,
): Promise<ComputerUseInstallationResult> {
  const platform = toInstallationPlatform(dependencies.platform)
  if (platform === 'unsupported') return { platform, status: 'unsupported' }

  let driverPath: string
  try {
    driverPath = dependencies.resolvePath()
  } catch (error) {
    // 只有「找不到驱动」是正常的未安装状态，其他异常必须向上抛，避免掩盖真实故障。
    if (error instanceof ComputerUseDriverError && error.code === 'driver_not_found') {
      return { platform, status: 'not_installed' }
    }
    throw error
  }

  try {
    const version = (await dependencies.readVersion(driverPath)).trim()
    if (version.length > DRIVER_VERSION_MAX_LENGTH || !DRIVER_VERSION_PATTERN.test(version)) {
      return { platform, status: 'needs_attention', driverPath }
    }
    return { platform, status: 'installed', driverPath, version }
  } catch {
    return { platform, status: 'needs_attention', driverPath }
  }
}

let pendingInstallation: Promise<ComputerUseInstallationResult> | undefined

/** 读取一次驱动版本，5 秒超时，输出上限 16KB。 */
function readDriverVersion(driverPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      driverPath,
      ['--version'],
      { timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

/**
 * 获取当前机器的安装状态。
 *
 * 同一时刻只跑一次检测：并发的启动检查与设置页查询共享结果，避免重复拉起进程。
 */
export function getComputerUseInstallationStatus(): Promise<ComputerUseInstallationResult> {
  pendingInstallation ??= detectComputerUseInstallation({
    platform: process.platform,
    resolvePath: computerUseDriverPath,
    readVersion: readDriverVersion,
  }).finally(() => {
    pendingInstallation = undefined
  })
  return pendingInstallation
}
