/**
 * Cua Driver 更新检查运行时。
 *
 * 把「清单拉取」与「本机安装状态」合成一条给 UI 的结论，并负责：
 *
 * - 进程内单例：同一时刻只有一个 runner，避免设置页与定时任务各自开检查；
 * - 并发去重：多次手动「检查更新」共享同一个进行中的请求；
 * - 按天调度：启动后先给出缓存结论，到期才真正访问 CDN；
 * - 结论广播：状态变化通过回调交给主进程转发给 renderer。
 *
 * 检查只涉及版本比对，不下载、不安装、不修改驱动文件。
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { valid } from 'semver'
import type { ComputerUseInstallation, CuaUpdateStatus } from '@proma/shared'
import { cuaAssetLabel, CuaCdnCheckSchedule, fetchCuaCdnManifest } from './computer-use-cdn-update'
import type { CuaCdnFetcher, CuaCdnManifest } from './computer-use-cdn-update'
import { getComputerUseInstallationStatus } from './computer-use-installation'
import { parseCuaDriverVersion } from './computer-use-version'
import { writeTextFileAtomic } from './safe-file'
import { isNewerVersion } from './updater/version'

/**
 * 清单协议错误（版本不可解析、版本降级）。
 *
 * 这类失败说明 CDN 返回的内容本身有问题，不能被当作网络抖动退回缓存结论，
 * 否则用户会在清单已损坏时仍看到「已是最新」。
 */
export class CuaUpdateProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CuaUpdateProtocolError'
  }
}

/** setTimeout 能接受的最大延迟（约 24.8 天）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** 调度时间落在过去时的重试间隔，避免忙等。 */
const RETRY_DELAY_MS = 60 * 60 * 1000

/** 更新检查所需的全部外部依赖，便于单元测试注入。 */
export interface CuaUpdateCheckRunnerDependencies {
  /** 读取本机安装状态。 */
  installation: () => Promise<ComputerUseInstallation>
  /** 拉取并解析 CDN 清单。 */
  manifest: () => Promise<CuaCdnManifest>
  /** 持久化最近一次成功拿到的清单版本。 */
  saveLatest: (version: string) => void
  /** 上次成功记录的清单版本（可来自磁盘缓存）。 */
  latest?: string
  platform: NodeJS.Platform
  arch: string
}

/**
 * 版本比对器。
 *
 * 只做「已安装版本 → 清单版本」比较；清单降级（旧值比新值大）视为异常，
 * 防止 CDN 缓存回滚把用户导向旧版本。
 */
export class CuaUpdateCheckRunner {
  private readonly deps: CuaUpdateCheckRunnerDependencies
  private latest: string | undefined
  private failed = false
  /** 最近一次检查是否因清单协议问题失败；在成功检查前不允许回退到缓存的版本结论。 */
  private protocolFailed = false

  constructor(deps: CuaUpdateCheckRunnerDependencies) {
    this.deps = deps
    // 缓存版本可能是旧格式或手改内容，非法时直接丢弃，当作尚未检查。
    this.latest = deps.latest && valid(deps.latest) ? deps.latest : undefined
  }

  /**
   * 计算当前结论。
   *
   * Linux 暂不支持安装更新（资产存在但安装流程未实现），按「无法判断」返回，
   * 让 UI 不显示更新入口。本地版本缺失或格式异常时给出 error，提示用户修复安装。
   */
  async status(): Promise<CuaUpdateStatus> {
    if (!cuaAssetLabel(this.deps.platform, this.deps.arch) || this.deps.platform === 'linux') {
      return { status: 'unknown' }
    }

    const installation = await this.deps.installation()
    if (installation.status !== 'installed' || !installation.version) return { status: 'unknown' }

    const currentVersion = parseCuaDriverVersion(installation.version)
    if (!currentVersion) return { status: 'error' }

    if (!this.latest) return { status: this.failed ? 'error' : 'unknown', currentVersion }
    if (this.protocolFailed) {
      // 清单协议错误不能被缓存的上一次结论掩盖；等下一次成功检查再恢复。
      return { status: 'error', currentVersion, latestVersion: this.latest }
    }
    return {
      status: isNewerVersion(this.latest, currentVersion) ? 'available' : 'current',
      currentVersion,
      latestVersion: this.latest,
    }
  }

  /**
   * 主动检查一次。
   *
   * 分两类处理：
   * - 网络/请求失败：已有成功结果时只记录日志并保留上次结论，避免一次抖动就把 UI
   *   从「有新版本」跳回「未知」；从未成功过则向上抛错并标记失败。
   * - 清单自身异常（版本无法解析、版本降级）：一律抛错，绝不据此推断版本高低。
   *
   * 缓存写入失败不影响本次结论，只会在下次启动时退回到「尚未检查」。
   */
  async check(): Promise<CuaUpdateStatus> {
    const before = await this.status()
    if (!before.currentVersion) return before

    let manifest: CuaCdnManifest
    try {
      manifest = await this.deps.manifest()
    } catch (error) {
      this.failed = true
      if (!this.latest) throw error
      console.warn('[Computer Use] 更新检查未完成，保留上次结果')
      return this.status()
    }

    if (!valid(manifest.version)) {
      this.failed = true
      this.protocolFailed = true
      throw new CuaUpdateProtocolError('Cua CDN 版本无法解析')
    }
    if (this.latest && isNewerVersion(this.latest, manifest.version)) {
      this.failed = true
      this.protocolFailed = true
      throw new CuaUpdateProtocolError('Cua CDN 清单出现降级')
    }

    let persisted = true
    try {
      this.deps.saveLatest(manifest.version)
    } catch (error) {
      persisted = false
      console.warn(
        '[Computer Use] 更新检查结果未能写入缓存:',
        error instanceof Error ? error.message : '未知错误',
      )
    }

    this.latest = manifest.version
    this.failed = !persisted
    this.protocolFailed = false
    return this.status()
  }
}

/** 当前活跃的 runner；同一进程只保留一个。 */
let activeRunner: CuaUpdateCheckRunner | undefined
/** 结论变化回调，由 startCuaCdnChecks 注入。 */
let notifyChanged: ((status: CuaUpdateStatus) => void) | undefined
/** 进行中的检查，用于合并并发请求。 */
let pendingCheck: Promise<CuaUpdateStatus> | undefined
/** 当前调度器的停止函数。 */
let stopChecks: (() => void) | undefined

/** 读取缓存的检查结论，不触发网络请求。 */
export async function getCuaUpdateStatus(): Promise<CuaUpdateStatus> {
  return activeRunner ? activeRunner.status() : { status: 'unknown' }
}

/** 只需要读取结论的来源；测试可注入最小实现。 */
export interface CuaUpdateStatusSource {
  status: () => Promise<CuaUpdateStatus>
}

/**
 * 一次检查失败后的结论。
 *
 * - 协议错误（版本无法解析、清单降级）：直接返回 error，绝不能退回上一次的
 *   current/available，否则会把损坏的清单伪装成正常结果；
 * - 网络错误：沿用缓存结论（runner 内部已有 last-known-good），连缓存都读不到时兜底 error。
 */
export async function statusAfterCuaCheckFailure(
  source: CuaUpdateStatusSource,
  error: unknown,
): Promise<CuaUpdateStatus> {
  if (error instanceof CuaUpdateProtocolError) return { status: 'error' }
  return source.status().catch(() => ({ status: 'error' }))
}

/** 触发一次检查，并把结论通知给 renderer。 */
export async function refreshCuaUpdateStatus(): Promise<CuaUpdateStatus> {
  if (!activeRunner) return { status: 'unknown' }
  if (pendingCheck) return pendingCheck

  const runner = activeRunner
  const task = runner.check().catch((error: unknown): Promise<CuaUpdateStatus> => (
    statusAfterCuaCheckFailure(runner, error)
  ))
  pendingCheck = task
  try {
    const status = await task
    if (activeRunner === runner) notifyChanged?.(status)
    return status
  } finally {
    if (pendingCheck === task) pendingCheck = undefined
  }
}

/** 读取缓存的清单版本；非法或缺失时返回 undefined。 */
function readLatestVersion(latestPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(latestPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && valid(version) ? version : undefined
  } catch {
    return undefined
  }
}

/** 停止当前调度器（若有）。 */
export function stopCuaCdnChecks(): void {
  stopChecks?.()
}

/**
 * 启动按天检查的调度器。
 *
 * 启动即刻把缓存结论推给 UI，真正的网络检查由持久化时间点决定。
 * 返回的停止函数会清理定时器并解除单例绑定。
 */
export function startCuaCdnChecks(statePath: string, onChanged: (status: CuaUpdateStatus) => void): () => void {
  stopChecks?.()

  const fetcher = fetch as unknown as CuaCdnFetcher
  const latestPath = `${statePath}.latest`
  const schedule = new CuaCdnCheckSchedule(statePath)
  const runner = new CuaUpdateCheckRunner({
    installation: getComputerUseInstallationStatus,
    manifest: () => fetchCuaCdnManifest(fetcher),
    saveLatest: (version) => {
      mkdirSync(dirname(latestPath), { recursive: true })
      writeTextFileAtomic(latestPath, JSON.stringify({ version }))
    },
    latest: readLatestVersion(latestPath),
    platform: process.platform,
    arch: process.arch,
  })

  activeRunner = runner
  notifyChanged = onChanged

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const arm = (minimumDelay = 0): void => {
    if (stopped) return
    // 时钟回拨或状态超前都可能算出负值，用下限兜底，避免高频空转。
    const delay = Math.max(minimumDelay, Math.min(schedule.nextCheckAt - Date.now(), MAX_TIMER_DELAY_MS))
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      void runOnce()
        .catch(async (error: unknown) => {
          console.warn(
            '[Computer Use] 更新检查未完成:',
            error instanceof Error ? error.message : '未知错误',
          )
          if (!stopped) onChanged(await runner.status().catch(() => ({ status: 'error' })))
        })
        .finally(() => {
          arm(schedule.nextCheckAt <= Date.now() ? RETRY_DELAY_MS : 0)
        })
    }, delay)
    // 定时器不应阻止应用退出。
    timer.unref()
  }

  /** 一次到期检查：只有成功占用调度才真正访问网络。 */
  const runOnce = async (): Promise<void> => {
    if (schedule.claimIfDue()) await refreshCuaUpdateStatus()
  }

  arm()
  void runner
    .status()
    .then((status) => {
      if (!stopped) onChanged(status)
    })
    .catch(() => undefined)

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (activeRunner === runner) {
      activeRunner = undefined
      notifyChanged = undefined
    }
    if (stopChecks === stop) stopChecks = undefined
  }

  stopChecks = stop
  return stop
}
