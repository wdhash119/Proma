/**
 * Computer Use 窗口镜像预览的共享契约。
 *
 * 主进程负责采集、状态机与生命周期；renderer 只能读取状态快照，并触发
 * 打开窗口 / 重试 / 关闭预览。截图始终以 data URL 形式传给 renderer，
 * 不落盘到用户目录，也不回传给 Agent 模型。
 */

/** 预览目标：单个应用窗口，或整个桌面。 */
export type ComputerUsePreviewTarget = 'window' | 'desktop'

/**
 * 预览状态。
 *
 * - `running`：正在展示画面，可能已附带最近一次采集结果；
 * - `error`：最近一次采集失败，可重试；
 * - `finished`：Agent 已调用 finish，主进程会在 2 秒后清理。
 */
export type ComputerUsePreviewStatus = 'running' | 'error' | 'finished'

/** 预览传输方式；当前只支持快照轮询，保留字段以便未来区分原生实时流。 */
export type ComputerUsePreviewTransport = 'snapshot'

/** 主进程返回给 renderer 的预览状态快照。 */
export interface ComputerUsePreviewState {
  /** 本次预览的唯一 ID，用于 activate / retry / dismiss 定位。 */
  id: string
  sessionId: string
  target: ComputerUsePreviewTarget
  /** 展示给用户的窗口或应用名称。 */
  label: string
  transport: ComputerUsePreviewTransport
  status: ComputerUsePreviewStatus
  /** PNG 画面，形如 `data:image/png;base64,...`。 */
  image?: string
  /** 最近一次成功采集的时间戳（毫秒）。 */
  capturedAt?: number
  /** Agent 调用 finish 的时间戳（毫秒）。 */
  finishedAt?: number
  /** 面向用户的中文错误说明。 */
  error?: string
  /** 错误分类标识，对应主进程 ComputerUseDriverError.code。 */
  errorCode?: string
}

/** Computer Use 预览相关 IPC 通道。 */
export const COMPUTER_USE_IPC_CHANNELS = {
  /** renderer 轮询当前会话的预览状态（含 base64 画面）。 */
  GET_PREVIEW: 'computer-use:get-preview',
  /** 把预览目标窗口切换到前台。 */
  ACTIVATE: 'computer-use:activate',
  /** 采集失败后重新采集。 */
  RETRY: 'computer-use:retry',
  /** 关闭预览，主进程立即释放采集会话。 */
  DISMISS: 'computer-use:dismiss',
  /** 查询本地驱动安装状态（平台、路径、版本）。 */
  GET_INSTALLATION_STATUS: 'computer-use:get-installation-status',
  /** 主动向 CDN 发起一次更新检查（并发调用会合并为一次请求）。 */
  CHECK_UPDATE_STATUS: 'computer-use:check-update-status',
  /** 读取缓存的更新检查结论，不触发网络请求。 */
  GET_UPDATE_STATUS: 'computer-use:get-update-status',
  /** 更新检查结论变化时由主进程广播。 */
  UPDATE_STATUS_CHANGED: 'computer-use:update-status-changed',
} as const

/** Computer Use 支持的平台归类，便于 UI 直接展示文案。 */
export type ComputerUsePlatform = 'macos' | 'windows' | 'linux' | 'unsupported'

/**
 * 驱动安装状态：
 * - `installed`：驱动存在且版本可识别；
 * - `not_installed`：找不到驱动；
 * - `needs_attention`：找到驱动但版本输出异常，需要用户重新安装或修复；
 * - `unsupported`：当前平台不支持 Computer Use。
 */
export type ComputerUseInstallationStatus = 'installed' | 'not_installed' | 'needs_attention' | 'unsupported'

/** 主进程返回给 renderer 的安装状态快照；不包含任何可执行内容。 */
export interface ComputerUseInstallation {
  platform: ComputerUsePlatform
  status: ComputerUseInstallationStatus
  /** 驱动可执行文件绝对路径；仅 `installed` / `needs_attention` 时存在。 */
  driverPath?: string
  /** `cua-driver --version` 的原始输出；仅 `installed` 时存在。 */
  version?: string
}

/**
 * 驱动更新检查结论：
 * - `unknown`：无法判断（平台不支持、未安装、尚未拿到清单）；
 * - `current`：已是最新；
 * - `available`：CDN 上有更新版本；
 * - `error`：本地版本或清单无法解析，更新检查本身失败。
 */
export type CuaUpdateStatusKind = 'unknown' | 'current' | 'available' | 'error'

/** 更新检查结果；版本号均为纯 SemVer 字符串（不含 `cua-driver` 前缀）。 */
export interface CuaUpdateStatus {
  status: CuaUpdateStatusKind
  /** 本地已安装版本。 */
  currentVersion?: string
  /** CDN 清单中的最新版本；仅在已取得清单（`current` / `available`）时有意义。 */
  latestVersion?: string
}
