/**
 * 自动更新核心模块
 *
 * 检测新版本 → 自动后台下载 → 用户选择立即或空闲时重启安装。
 * 自动更新仅在打包后的生产环境中启用。
 *
 * 国内网络回退：直连 GitHub 失败（网络错误/超时）时，先经 release 服务解析最新
 * release tag，再把 feed 切换到代理镜像上「带 tag 的 download 目录」（generic
 * provider），逐个镜像重试；可用镜像进程内粘滞，重启后重新尝试直连。
 * 404（release 缺少 latest.yml）等真实错误不做代理重试，直接给出可读提示。
 */

import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { createIdleInstallScheduler } from './idle-install-scheduler'
import { isNewerVersion } from './version'
import { createUpdateCacheCleanup, getDefaultUpdaterBaseCacheDirectory, shouldDeferUpdateCacheCleanup } from './update-cache-cleanup'
import { GITHUB_FILE_PROXY_MIRRORS, isMissingFeedErrorMessage, isNetworkErrorMessage, proxiedReleaseFeedUrl } from '../github-proxy'
import { GITHUB_REPO_OWNER, GITHUB_REPO_NAME, getLatestReleaseTag } from '../github-release-service'

/** 当前更新状态 */
let currentStatus: UpdateStatus = { status: 'idle' }

/** 主窗口引用 */
let win: BrowserWindow | null = null

/** 定时检查定时器 */
let checkInterval: ReturnType<typeof setInterval> | null = null

/** 新版窗口稳定后执行的更新缓存清理定时器。 */
let appliedUpdateCacheCleanupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 已下载更新时仍会定期检查最新 Release。保留该快照可以在“更新源版本
 * 未变化”或检查失败时继续展示已就绪更新，也不会打断已经安排的空闲安装。
 */
let downloadedStatusDuringCheck: Extract<UpdateStatus, { status: 'downloaded' }> | null = null

/** 当前主动下载的版本，用于合并 electron-updater 的 error 事件和 Promise rejection。 */
let activeDownloadVersion: string | null = null

/** 进程内记住可用的文件代理镜像；重启后重新尝试直连 */
let activeProxyMirror: string | null = null

/** 代理回退进行中：抑制中间错误上屏与重复触发 */
let fallbackInProgress = false

/** 由 Agent 服务注入，覆盖所有窗口/后台 Agent 的运行状态。 */
let hasActiveAgents = (): boolean => false

/** 已安装更新包的延后清理：新版窗口稳定后才执行，避免安装链路中途删包。 */
const APPLIED_UPDATE_CACHE_CLEANUP_DELAY_MS = 15_000
/** Windows Defender、索引器等短暂占用缓存文件时的异步重试策略。 */
const APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS = 1_000
const APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES = 2

/**
 * 用户选择「空闲时更新」后，等待所有 Agent 结束再安装。
 *
 * 状态检查留在主进程，避免渲染进程漏掉后台运行或其他窗口中的 Agent。
 */
const idleInstallScheduler = createIdleInstallScheduler({
  canInstall: () => currentStatus.status === 'downloaded' && !hasActiveAgents(),
  install: () => {
    console.log('[更新] 当前没有运行中的 Agent，开始安装已下载更新')
    quitAndInstall()
  },
})

/** 更新状态并推送给渲染进程 */
function setStatus(status: UpdateStatus): void {
  currentStatus = status
  if (status.status !== 'downloaded') {
    idleInstallScheduler.cancel()
  }
  win?.webContents?.send(UPDATER_IPC_CHANNELS.ON_STATUS_CHANGED, status)
}

/**
 * 处理主动下载的失败。electron-updater 可能同时发出 error 事件并 reject
 * downloadUpdate Promise，因此由 activeDownloadVersion 确保状态只恢复一次。
 */
function handleDownloadFailure(err: unknown): void {
  if (!activeDownloadVersion) return

  const failedVersion = activeDownloadVersion
  activeDownloadVersion = null
  console.error(`[更新] 下载 v${failedVersion} 失败:`, err)

  // electron-updater 可能在下载新版本时清理旧 pending 工件；不能只恢复 UI
  // 状态，否则会把不可安装的旧版本伪装成“更新已就绪”。下个检查周期会重试。
  setStatus({
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
  })
}

/** 开始下载已确认需要替换的最新更新。 */
function downloadAvailableUpdate(): void {
  void autoUpdater.downloadUpdate().catch(handleDownloadFailure)
}

/** 把更新 feed 切换到代理镜像上带 tag 的 download 目录 */
function applyProxyFeed(mirror: string, tag: string): void {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: proxiedReleaseFeedUrl(mirror, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, tag),
    channel: 'latest',
  })
}

/** 404 等真实错误给出可读提示：换代理也取不到不存在的文件 */
function describeFeedError(message: string): string {
  if (isMissingFeedErrorMessage(message)) {
    return `GitHub Release 缺少 latest.yml 更新清单（发布时需由 electron-builder 生成）。原始错误: ${message}`
  }
  return message
}

/**
 * 直连失败后的代理回退：解析最新 tag → 逐个镜像挂代理 feed → 重新检查。
 * 检查成功后 update-available 事件会自动触发代理下载；全部失败才把错误上屏。
 */
async function runProxyFallback(): Promise<void> {
  if (fallbackInProgress) return
  fallbackInProgress = true
  try {
    const tag = await getLatestReleaseTag()
    if (!tag) {
      setStatus({ status: 'error', error: '无法连接 GitHub，且未能获取最新 Release 标签（可能暂无发布或网络受限）' })
      return
    }
    for (const mirror of GITHUB_FILE_PROXY_MIRRORS) {
      applyProxyFeed(mirror, tag)
      try {
        await autoUpdater.checkForUpdates()
        activeProxyMirror = mirror
        console.log(`[更新] 已切换到代理镜像: ${mirror}`)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!isNetworkErrorMessage(message)) {
          setStatus({ status: 'error', error: describeFeedError(message) })
          return
        }
        console.warn(`[更新] 代理镜像不可用，尝试下一个: ${mirror} (${message})`)
      }
    }
    setStatus({ status: 'error', error: '无法连接 GitHub，所有代理镜像均不可用' })
  } finally {
    fallbackInProgress = false
  }
}

/**
 * 绑定更新器所需的主窗口与 Agent 状态。
 */
export function configureUpdater(
  mainWindow: BrowserWindow,
  options?: { hasActiveAgents?: () => boolean },
): void {
  hasActiveAgents = options?.hasActiveAgents ?? hasActiveAgents
  win = mainWindow
}

/** 获取当前更新状态 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

/** 手动触发检查更新 */
export async function checkForUpdates(): Promise<void> {
  // 下载未完成时不能启动第二次下载；已下载版本仍需检查，以便追赶随后发布的新版。
  if (currentStatus.status === 'downloading') {
    console.log('[更新] 跳过检查：正在下载更新')
    return
  }

  downloadedStatusDuringCheck = currentStatus.status === 'downloaded' ? currentStatus : null

  // 已确认代理可用时刷新 tag，避免钉死旧版本目录；解析失败则沿用上次 feed
  if (activeProxyMirror) {
    const tag = await getLatestReleaseTag()
    if (tag) applyProxyFeed(activeProxyMirror, tag)
  }

  try {
    // 已有下载完成的更新时保持它在界面中可见，也保留用户已安排的空闲安装。
    if (!downloadedStatusDuringCheck) {
      setStatus({ status: 'checking' })
    }
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[更新] 检查更新失败:', err)
    if (downloadedStatusDuringCheck) {
      console.warn('[更新] 保留已下载更新，稍后继续检查是否有新版')
      downloadedStatusDuringCheck = null
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    // 直连网络失败 → 代理回退；error 事件可能已先触发回退，这里避免重复
    if (!activeProxyMirror && !fallbackInProgress && isNetworkErrorMessage(message)) {
      await runProxyFallback()
      return
    }
    setStatus({
      status: 'error',
      error: describeFeedError(message),
    })
  }
}

/**
 * 请求在没有运行中 Agent 时安装已下载的更新。
 *
 * @returns 是否已接受请求；仅 downloaded 状态可排队。
 */
export function installWhenIdle(): boolean {
  if (currentStatus.status !== 'downloaded') {
    console.warn('[更新] 跳过空闲安装：当前没有已下载的更新')
    return false
  }

  console.log('[更新] 已请求空闲安装，等待所有 Agent 结束')
  setStatus({ ...currentStatus, installScheduled: true })
  idleInstallScheduler.request()
  return true
}

/** 取消尚未执行的空闲安装请求。 */
export function cancelIdleInstall(): void {
  idleInstallScheduler.cancel()
  if (currentStatus.status === 'downloaded' && currentStatus.installScheduled) {
    setStatus({ ...currentStatus, installScheduled: false })
  }
  console.log('[更新] 已取消空闲安装请求')
}

/**
 * 退出并安装已下载的更新。
 *
 * 所有安装入口最终都经过这里：即使调用方绕过空闲调度器，也不会在 Agent
 * 运行时退出；在真正安装前再次检查一次，避免检查与退出之间启动新 Agent。
 */
function quitAndInstall(): void {
  if (!app.isPackaged) {
    console.warn('[更新] 开发环境不支持安装更新')
    return
  }

  if (hasActiveAgents()) {
    console.log('[更新] 检测到运行中的 Agent，改为等待空闲后安装')
    installWhenIdle()
    return
  }

  // 延迟调用确保 IPC 响应已发送回渲染进程；回调内再次检查防止竞态。
  setImmediate(() => {
    if (hasActiveAgents()) {
      console.log('[更新] 安装前出现新的运行中 Agent，继续等待空闲')
      installWhenIdle()
      return
    }

    // 移除所有窗口的 close 监听器，避免 preventDefault 阻止退出。
    for (const w of BrowserWindow.getAllWindows()) {
      w.removeAllListeners('close')
    }
    autoUpdater.quitAndInstall(true, true)
  })
}

/** 清理更新器资源（定时器等） */
export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  if (appliedUpdateCacheCleanupTimer) {
    clearTimeout(appliedUpdateCacheCleanupTimer)
    appliedUpdateCacheCleanupTimer = null
  }
  downloadedStatusDuringCheck = null
  activeDownloadVersion = null
  activeProxyMirror = null
  fallbackInProgress = false
  idleInstallScheduler.dispose()
}

/**
 * 初始化自动更新
 *
 * @param mainWindow - 主窗口实例，用于推送更新状态
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  configureUpdater(mainWindow)

  const updateCacheCleanup = createUpdateCacheCleanup({
    stateFilePath: join(app.getPath('userData'), 'updater-cache-state.json'),
    baseCacheDirectory: getDefaultUpdaterBaseCacheDirectory(),
  })

  // 不在刚启动时立即删包：只有主窗口实际可展示且连续稳定 15 秒，才视为基础健康检查通过。
  // Renderer 加载失败或进程崩溃时，保留安装包供重试与诊断；不以错误页的 did-finish-load 为健康信号。
  let rendererFailedDuringHealthCheck = false
  const cancelAppliedUpdateCacheCleanup = () => {
    rendererFailedDuringHealthCheck = true
    if (appliedUpdateCacheCleanupTimer) {
      clearTimeout(appliedUpdateCacheCleanupTimer)
      appliedUpdateCacheCleanupTimer = null
    }
  }
  let cleanupRetryCount = 0
  const runAppliedUpdateCacheCleanup = () => {
    appliedUpdateCacheCleanupTimer = null
    if (rendererFailedDuringHealthCheck || mainWindow.isDestroyed()) return
    // pending 是 electron-updater 的共享下载目录；任何下载进行中都不能与清理并发。
    if (shouldDeferUpdateCacheCleanup(activeDownloadVersion !== null, currentStatus.status === 'downloading')) {
      console.log('[更新缓存] 有更新正在下载，跳过本次已安装包清理')
      return
    }
    const result = updateCacheCleanup.cleanupForRunningVersion(app.getVersion())
    if (result.status === 'skipped-unsafe') {
      console.warn('[更新缓存] 跳过了未通过路径安全校验的缓存清理')
    } else if (result.status === 'failed') {
      if (cleanupRetryCount < APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES) {
        cleanupRetryCount += 1
        console.warn(`[更新缓存] 清理未完成，${APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS / 1_000} 秒后重试（${cleanupRetryCount}/${APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES}）`)
        appliedUpdateCacheCleanupTimer = setTimeout(runAppliedUpdateCacheCleanup, APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS)
      } else {
        console.warn('[更新缓存] 缓存清理多次失败，将在下次启动时重试')
      }
    }
  }
  const cleanupAppliedUpdateCache = () => {
    if (rendererFailedDuringHealthCheck || mainWindow.isDestroyed()) return
    if (appliedUpdateCacheCleanupTimer) clearTimeout(appliedUpdateCacheCleanupTimer)
    cleanupRetryCount = 0
    appliedUpdateCacheCleanupTimer = setTimeout(runAppliedUpdateCacheCleanup, APPLIED_UPDATE_CACHE_CLEANUP_DELAY_MS)
  }
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) cancelAppliedUpdateCacheCleanup()
  })
  mainWindow.webContents.once('render-process-gone', cancelAppliedUpdateCacheCleanup)
  if (mainWindow.isVisible()) {
    cleanupAppliedUpdateCache()
  } else {
    mainWindow.once('ready-to-show', cleanupAppliedUpdateCache)
  }

  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log('[更新-updater]', ...args),
    warn: (...args: unknown[]) => console.warn('[更新-updater]', ...args),
    error: (...args: unknown[]) => console.error('[更新-updater]', ...args),
    debug: (...args: unknown[]) => console.log('[更新-updater:debug]', ...args),
  }

  // 手动开始下载，确保重新检查时只在 Release 比已下载版本更新时替换安装包。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // 监听更新事件
  autoUpdater.on('checking-for-update', () => {
    console.log('[更新] 正在检查更新...')
    if (!downloadedStatusDuringCheck) {
      setStatus({ status: 'checking' })
    }
  })

  autoUpdater.on('update-available', (info) => {
    const downloadedStatus = downloadedStatusDuringCheck
      ?? (currentStatus.status === 'downloaded' ? currentStatus : null)

    if (downloadedStatus && !isNewerVersion(info.version, downloadedStatus.version)) {
      console.log(`[更新] 最新 Release v${info.version} 未超过已下载版本 v${downloadedStatus.version}，保留现有安装包`)
      downloadedStatusDuringCheck = null
      return
    }

    downloadedStatusDuringCheck = null
    activeDownloadVersion = info.version
    console.log('[更新] 发现新版本:', info.version)
    setStatus({
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined,
    })
    downloadAvailableUpdate()
  })

  autoUpdater.on('download-progress', (progress) => {
    downloadedStatusDuringCheck = null
    setStatus({
      status: 'downloading',
      version: (currentStatus as { version?: string }).version || '',
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedStatusDuringCheck = null
    activeDownloadVersion = null
    updateCacheCleanup.recordDownloadedUpdate(info.version, info.downloadedFile)
    console.log('[更新] 下载完成:', info.version)
    setStatus({
      status: 'downloaded',
      version: info.version,
      installScheduled: false,
    })
  })

  autoUpdater.on('update-not-available', () => {
    if (downloadedStatusDuringCheck) {
      console.log('[更新] 已下载版本仍是最新，保留现有安装包')
      downloadedStatusDuringCheck = null
      return
    }
    console.log('[更新] 已是最新版本')
    setStatus({ status: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    if (activeDownloadVersion) {
      handleDownloadFailure(err)
      // 直连下载失败（检查已成功、下载链路被断）→ 代理回退重查重下
      if (!activeProxyMirror && !fallbackInProgress && isNetworkErrorMessage(err.message)) {
        void runProxyFallback()
      }
      return
    }

    // 回退尝试中的中间错误不上屏，由 runProxyFallback 统一汇报
    if (fallbackInProgress) return

    console.error('[更新] 更新出错:', err)
    if (downloadedStatusDuringCheck) {
      console.warn('[更新] 保留已下载更新，稍后继续检查是否有新版')
      downloadedStatusDuringCheck = null
      return
    }
    if (!activeProxyMirror && isNetworkErrorMessage(err.message)) {
      void runProxyFallback()
      return
    }
    setStatus({
      status: 'error',
      error: describeFeedError(err.message),
    })
  })

  // 启动后延迟 10 秒首次检查
  setTimeout(() => {
    console.log('[更新] 首次自动检查更新')
    void checkForUpdates()
  }, 10_000)

  // 每 4 小时自动检查一次；已下载版本也会检查，发现更高版本即自动替换下载。
  checkInterval = setInterval(() => {
    console.log('[更新] 定时自动检查更新')
    void checkForUpdates()
  }, 4 * 60 * 60 * 1000)

  // 窗口关闭时清理定时器
  mainWindow.on('closed', () => {
    cancelAppliedUpdateCacheCleanup()
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
    if (appliedUpdateCacheCleanupTimer) {
      clearTimeout(appliedUpdateCacheCleanupTimer)
      appliedUpdateCacheCleanupTimer = null
    }
    downloadedStatusDuringCheck = null
    activeDownloadVersion = null
    idleInstallScheduler.dispose()
    win = null
  })

  console.log('[更新] 自动更新模块已初始化（自动下载最新版本，支持空闲时安装与国内代理回退）')
}
