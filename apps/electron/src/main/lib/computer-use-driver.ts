/**
 * Cua Driver 调用封装。
 *
 * Cua Driver 是外部可执行文件（`cua-driver` / `cua-driver.exe`），Proma 通过
 * `cua-driver call <tool> <json>` 驱动桌面操作。本模块负责：
 *
 * 1. 从配置目录的 `computer-use.md` 解析用户显式记录的驱动路径；
 * 2. 找不到记录时回退到常见安装位置与 PATH；
 * 3. 以固定超时调用驱动，并把失败归类成面向用户的中文错误。
 *
 * 解析逻辑与文件系统访问全部通过环境接口注入，方便单元测试在任意平台上
 * 覆盖 Windows / POSIX 路径规则，而不依赖真实安装。
 */

import { execFile } from 'node:child_process'
import { statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, posix, win32 } from 'node:path'
import { resolveConfigDir } from './config-paths'

/** 驱动调用错误分类。 */
export type ComputerUseDriverErrorCode =
  | 'driver_not_found'
  | 'window_unavailable'
  | 'desktop_unavailable'
  | 'activation_blocked'
  | 'permission_denied'
  | 'timeout'
  | 'capture_failed'
  | 'driver_error'

/** 面向用户的中文错误说明。 */
const DRIVER_ERROR_MESSAGES: Record<ComputerUseDriverErrorCode, string> = {
  driver_not_found: '找不到 Cua Driver，请在 Computer Use 设置中确认已安装路径。',
  window_unavailable: '目标窗口已关闭、重建或不再属于原应用，请让 Agent 重新查找窗口。',
  desktop_unavailable: '桌面当前不可用，请解锁电脑并确认 Driver 运行在当前登录的桌面会话中。',
  permission_denied: '系统拒绝访问目标应用，请检查系统授权以及 Driver 与目标应用的权限级别。',
  timeout: '获取窗口响应超时，请稍后重试。',
  activation_blocked: '系统未允许切换到目标窗口，请手动打开该 App 后再试。',
  capture_failed: '未能取得有效窗口画面，请恢复目标窗口后重试。',
  driver_error: 'Cua Driver 调用失败，请检查当前连接或工具版本后重试。',
}

/** 带分类标识的驱动错误；message 直接可展示给用户。 */
export class ComputerUseDriverError extends Error {
  readonly code: ComputerUseDriverErrorCode

  constructor(code: ComputerUseDriverErrorCode) {
    super(DRIVER_ERROR_MESSAGES[code])
    this.name = 'ComputerUseDriverError'
    this.code = code
  }
}

function driverBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** 配置文件中可识别的驱动路径键名：英文 driver_path 与两种中文写法。 */
const DRIVER_RECORD_ENTRY_PATTERN = /^\s*(?:[-*]\s*)?(driver_path|(?:Driver\s*)?绝对路径|Driver\s*路径)\s*[:：]\s*(.+?)\s*$/gim

/** 去掉包裹路径的成对引号或反引号。 */
function stripPathQuotes(value: string): string {
  return /^([`'"]).*\1$/.test(value) ? value.slice(1, -1) : value
}

/** Windows 绝对路径判定：必须带盘符；POSIX 交给平台实现。 */
function isAbsoluteDriverPath(value: string, platform: NodeJS.Platform): boolean {
  if (/[\r\n\0]/.test(value)) return false
  return platform === 'win32' ? /^[a-z]:[\\/]/i.test(value) : isAbsolute(value)
}

/**
 * 从 `computer-use.md` 文本中解析唯一的驱动绝对路径。
 *
 * 规则：
 * - 支持 `driver_path:`、`绝对路径:`、`Driver 路径:` 等键名，兼容 Markdown 列表前缀；
 * - 忽略相对路径、含换行/NUL 的值，以及文件名不是 `cua-driver(.exe)` 的项；
 * - 显式 `driver_path` 优先；显式项去重后必须唯一，否则视为无法确定。
 */
export function parseComputerUseDriverPath(
  record: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (!record) return undefined
  const paths = pathApi(platform)
  const expectedName = driverBinaryName(platform)
  const explicitValues: string[] = []
  const fallbackValues: string[] = []

  for (const match of record.matchAll(new RegExp(DRIVER_RECORD_ENTRY_PATTERN))) {
    const rawKey = match[1] ?? ''
    const rawValue = match[2] ?? ''
    const value = stripPathQuotes(rawValue.trim())
    if (!isAbsoluteDriverPath(value, platform)) continue
    if (paths.basename(value).toLowerCase() !== expectedName) continue
    const target = rawKey.toLowerCase() === 'driver_path' ? explicitValues : fallbackValues
    target.push(paths.normalize(value))
  }

  const unique = [...new Set(explicitValues.length > 0 ? explicitValues : fallbackValues)]
  return unique.length === 1 ? unique[0] : undefined
}

/**
 * 依据驱动返回的文本判定失败类别。
 *
 * 匹配顺序即优先级：窗口失效优先于桌面/权限问题，超时优先于一般采集失败，
 * 避免一条 stderr 同时命中多个模式时给出误导性的提示。
 */
export function classifyComputerUseDriverError(detail: string): ComputerUseDriverError {
  const text = detail.toLowerCase()
  if (/window_id_not_found|window_owner_pid_mismatch|invalid window|stale.*hwnd|0x80070578/.test(text)) {
    return new ComputerUseDriverError('window_unavailable')
  }
  if (/screen_locked|session.?0|interactive.*(?:session|desktop)|desktop.*unavailable|disconnected.*session/.test(text)) {
    return new ComputerUseDriverError('desktop_unavailable')
  }
  if (/landed_on_target.*false|foreground.*(?:reject|denied)|activation.*blocked/.test(text)) {
    return new ComputerUseDriverError('activation_blocked')
  }
  if (/access.denied|permission.denied|eacces|eperm|uipi|0x80070005/.test(text)) {
    return new ComputerUseDriverError('permission_denied')
  }
  if (/timed?.?out|timeout/.test(text)) {
    return new ComputerUseDriverError('timeout')
  }
  if (/px_frame_mismatch|px_capture_unavailable|capture.failed|screenshot.*(?:fail|unavailable)/.test(text)) {
    return new ComputerUseDriverError('capture_failed')
  }
  return new ComputerUseDriverError('driver_error')
}

/** 驱动返回结构中的判定相关字段（只读取需要的键）。 */
interface ComputerUseDriverResponse {
  isError?: unknown
  success?: unknown
  error?: unknown
  landed_on_target?: unknown
  structuredContent?: unknown
}

function readResponse(value: unknown): ComputerUseDriverResponse | null {
  return value && typeof value === 'object' ? value as ComputerUseDriverResponse : null
}

function isFailureResponse(response: ComputerUseDriverResponse): boolean {
  if (response.isError === true || response.success === false || response.error) return true
  if (response.landed_on_target === false) return true
  const structured = readResponse(response.structuredContent)
  if (!structured) return false
  if (structured.isError === true || structured.success === false || structured.error) return true
  return structured.landed_on_target === false
}

/**
 * 校验驱动 stdout。
 *
 * 驱动成功时输出 JSON；非 JSON 或非对象输出不阻断调用（旧版驱动可能只打印日志），
 * 但明确的失败标记（isError / success=false / error / landed_on_target=false）
 * 必须转换成分类错误，否则调用方会把失败当成成功继续执行。
 */
export function checkComputerUseDriverResponse(stdout: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return
  }
  const response = readResponse(parsed)
  if (!response) return
  if (isFailureResponse(response)) {
    throw classifyComputerUseDriverError(stdout)
  }
}

/** 驱动解析所依赖的文件系统能力，测试可完全替换。 */
export interface ComputerUseDriverEnvironment {
  platform: NodeJS.Platform
  home: string
  /** 当前配置目录（开发模式 ~/.proma-dev，正式版 ~/.proma）。 */
  configDir: string
  /** Windows 本地 AppData 根目录，缺省时回退 ~/AppData/Local。 */
  localAppData?: string
  path: string
  recordVersion: (recordPath: string) => string
  readRecord: (recordPath: string) => string
  isFile: (candidate: string) => boolean
}

/**
 * 驱动路径解析器。
 *
 * 记录文件的 mtime/ctime/size 作为缓存版本：用户用 UI 写入新路径后无需重启，
 * 下一次调用即可生效；解析失败时清空缓存，避免复用已删除的路径。
 */
export class ComputerUseDriverResolver {
  private cached: { path: string; recordVersion: string } | undefined

  constructor(private readonly environment: ComputerUseDriverEnvironment) {}

  invalidate(): void {
    this.cached = undefined
  }

  resolve(): string {
    const env = this.environment
    const paths = pathApi(env.platform)
    const name = driverBinaryName(env.platform)
    const recordPath = paths.join(env.configDir, 'computer-use.md')
    const recordVersion = env.recordVersion(recordPath)
    if (this.cached?.recordVersion === recordVersion && env.isFile(this.cached.path)) {
      return this.cached.path
    }

    const recorded = parseComputerUseDriverPath(env.readRecord(recordPath), env.platform)
    const localAppData = env.localAppData
      ? env.localAppData
      : paths.join(env.home, 'AppData', 'Local')
    const defaults = env.platform === 'win32'
      ? [
          paths.join(localAppData, 'Programs', 'Cua', 'cua-driver', 'bin', name),
          paths.join(localAppData, 'Programs', 'trycua', 'cua-driver-rs', 'bin', name),
        ]
      : [
          paths.join(env.home, '.local', 'bin', name),
          ...(env.platform === 'darwin' ? ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver'] : []),
        ]
    // PATH 分隔符必须按目标平台判断，而不是宿主机：测试与跨平台解析都依赖这一点。
    const pathSeparator = env.platform === 'win32' ? ';' : ':'
    const fromPath = env.path
      .split(pathSeparator)
      .map((dir) => dir.replace(/^"|"$/g, ''))
      .filter((dir) => (env.platform === 'win32' ? /^[a-z]:[\\/]/i.test(dir) : isAbsolute(dir)))
      .map((dir) => paths.join(dir, name))

    const found = [recorded, ...defaults, ...fromPath]
      .find((candidate): candidate is string => !!candidate && env.isFile(candidate))
    if (!found) {
      this.invalidate()
      throw new ComputerUseDriverError('driver_not_found')
    }

    this.cached = { path: found, recordVersion }
    return found
  }
}

function statRecordVersion(recordPath: string): string {
  try {
    const stats = statSync(recordPath)
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`
  } catch {
    return ''
  }
}

function readRecordText(recordPath: string): string {
  try {
    // 记录文件只是路径清单；超大文件视为不可信输入，直接忽略。
    return statSync(recordPath).size <= 64 * 1024 ? readFileSync(recordPath, 'utf8') : ''
  } catch {
    return ''
  }
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** 默认环境：真实文件系统 + 当前进程平台。 */
function createDefaultEnvironment(): ComputerUseDriverEnvironment {
  const home = homedir()
  return {
    platform: process.platform,
    home,
    // 只解析数据根，不触发 config-paths 的目录创建副作用（数据根可能已迁移）。
    configDir: resolveConfigDir(),
    localAppData: process.env.LOCALAPPDATA,
    path: process.env.PATH ?? '',
    recordVersion: statRecordVersion,
    readRecord: readRecordText,
    isFile: isRegularFile,
  }
}

let defaultResolver: ComputerUseDriverResolver | undefined

/** 延迟创建默认解析器：导入本模块本身不应读取配置目录或探测文件系统。 */
function getDefaultResolver(): ComputerUseDriverResolver {
  defaultResolver ??= new ComputerUseDriverResolver(createDefaultEnvironment())
  return defaultResolver
}

/** 解析当前机器上的 Cua Driver 可执行文件路径；找不到时抛出 driver_not_found。 */
export function computerUseDriverPath(): string {
  return getDefaultResolver().resolve()
}

/** 驱动调用超时（毫秒）。窗口卡死时不能无限等待。 */
const DRIVER_CALL_TIMEOUT_MS = 8_000
/** 驱动 stdout 上限；截图路径与结构化结果都很小，2MB 足够并防止内存被灌爆。 */
const DRIVER_MAX_BUFFER_BYTES = 2 * 1024 * 1024

/** execFile 抛出的错误附带的自定义字段。 */
interface DriverProcessError extends Error {
  code?: string
  killed?: boolean
  driverDetail?: string
}

function readProcessError(error: unknown): DriverProcessError {
  return error instanceof Error ? error as DriverProcessError : new Error(String(error))
}

interface CallComputerUseDriverOptions {
  /** 覆盖驱动路径解析，测试或自定义安装位置使用。 */
  resolveDriver?: () => string
}

/**
 * 调用驱动工具。
 *
 * 以 `cua-driver call <tool> <json>` 形式执行，固定 8 秒超时与 2MB 输出上限。
 * ENOENT 会失效缓存并重试一次：用户刚安装完驱动时，缓存里可能还是旧路径。
 */
export async function callComputerUseDriver(
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  options: CallComputerUseDriverOptions = {},
): Promise<string> {
  const resolveDriver = options.resolveDriver ?? computerUseDriverPath

  const invoke = (driverFile: string): Promise<string> => new Promise((resolve, reject) => {
    execFile(
      driverFile,
      ['call', tool, JSON.stringify(args)],
      { timeout: DRIVER_CALL_TIMEOUT_MS, maxBuffer: DRIVER_MAX_BUFFER_BYTES, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(error ?? signal.reason)
          return
        }
        if (error) {
          reject(Object.assign(error, { driverDetail: `${stdout}\n${stderr}` }))
          return
        }
        try {
          checkComputerUseDriverResponse(stdout)
          resolve(stdout)
        } catch (failure) {
          reject(failure)
        }
      },
    )
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await invoke(resolveDriver())
    } catch (error) {
      if (signal?.aborted || error instanceof ComputerUseDriverError) throw error
      const failure = readProcessError(error)
      if (failure.code === 'ENOENT') {
        getDefaultResolver().invalidate()
        if (attempt === 0) continue
        throw new ComputerUseDriverError('driver_not_found')
      }
      if (failure.killed) throw new ComputerUseDriverError('timeout')
      throw classifyComputerUseDriverError(`${failure.code ?? ''} ${failure.driverDetail ?? failure.message}`)
    }
  }
  throw new ComputerUseDriverError('driver_not_found')
}
