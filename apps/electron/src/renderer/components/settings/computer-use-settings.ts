/**
 * Computer Use 设置页的纯逻辑。
 *
 * 页面只负责渲染，平台标签、状态文案、更新/安装入口判断与 Agent 提示词拼装
 * 都在这里集中实现，便于单测覆盖而不依赖 React 或 Electron 运行时。
 */

import type {
  ComputerUseInstallation,
  ComputerUsePlatform,
  CuaUpdateStatus,
} from '@proma/shared'

/** 平台展示名；`unsupported` 不展示具体系统名。 */
export const COMPUTER_USE_PLATFORM_LABELS: Record<ComputerUsePlatform, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  unsupported: '当前系统',
}

/** 更新检查只在桌面版依赖的 macOS / Windows 上开放；Linux 走实验性流程。 */
const UPDATE_CHECK_PLATFORMS: readonly ComputerUsePlatform[] = ['macos', 'windows']

/** 安装状态徽章的语气，用于选择配色与图标。 */
type ComputerUseStatusTone = 'success' | 'warning' | 'neutral'

/** 徽章与说明文案。 */
interface ComputerUseStatusSummary {
  /** 徽章文字 */
  label: string
  /** 徽章下方说明 */
  description: string
  tone: ComputerUseStatusTone
}

interface ComputerUseStatusInput {
  installation: ComputerUseInstallation | null
  /** 是否正在检测 */
  detecting: boolean
  /** 最近一次检测是否失败 */
  failed: boolean
}

/**
 * 生成安装状态徽章文案。
 *
 * 检测失败时优先展示失败结论，避免把网络或权限故障误报成「未安装」。
 */
export function describeComputerUseStatus(input: ComputerUseStatusInput): ComputerUseStatusSummary {
  const { installation, detecting, failed } = input

  const label = detecting
    ? '正在检测…'
    : failed
      ? '检测失败'
      : installation?.status === 'installed'
        ? '已安装'
        : installation?.status === 'needs_attention'
          ? '需要检查'
          : installation?.status === 'not_installed'
            ? '未安装'
            : '暂不支持'

  const description = failed
    ? '暂时无法检测本机安装，请重新检测。'
    : installation?.status === 'installed'
      ? '已检测到 Cua Driver，无需重复安装。'
      : installation?.status === 'needs_attention'
        ? '已找到 Cua Driver，但未能确认版本，请让 Agent 检查现有安装。'
        : installation?.status === 'not_installed'
          ? '未在配置记录、默认安装目录或 PATH 中找到 Cua Driver。'
          : detecting
            ? '正在检查本机 Cua Driver 安装。'
            : '目前支持 macOS、Windows 和 Linux。'

  const tone: ComputerUseStatusTone = installation?.status === 'installed'
    ? 'success'
    : installation?.status === 'needs_attention' || installation?.status === 'not_installed' || failed
      ? 'warning'
      : 'neutral'

  return { label, description, tone }
}

/** 是否展示版本与 Driver 路径明细（安装成功或需要检查时才有意义）。 */
export function shouldShowComputerUseDriverDetail(installation: ComputerUseInstallation | null): boolean {
  return installation?.status === 'installed' || installation?.status === 'needs_attention'
}

/** 是否展示「检查更新」按钮：已安装且平台支持更新检查（Linux 走实验性流程，不提供）。 */
export function canCheckComputerUseUpdate(installation: ComputerUseInstallation | null): boolean {
  return installation?.status === 'installed' && installation.platform !== 'linux'
}

/** 更新条与安装条的展示条件。 */
interface ComputerUseIndicators {
  /** 展示「有新版本可用」更新条 */
  showUpdate: boolean
  /** 展示「开始配置 Computer Use」安装条 */
  showInstall: boolean
}

interface ComputerUseIndicatorInput {
  installation: ComputerUseInstallation | null
  /** 是否正在检测；检测中不展示安装/更新条，避免结论闪烁 */
  detecting: boolean
  updateStatus: CuaUpdateStatus
}

/**
 * 判断更新条与安装条是否展示。
 *
 * 更新条只在本机已安装、平台支持且确有新版本时出现；
 * 安装条只在确认未安装且平台受支持时出现，避免误装或重复安装。
 */
export function describeComputerUseIndicators(input: ComputerUseIndicatorInput): ComputerUseIndicators {
  const platform = input.installation?.platform
  const updateSupported = platform !== undefined && UPDATE_CHECK_PLATFORMS.includes(platform)

  return {
    showUpdate: !input.detecting
      && input.installation?.status === 'installed'
      && updateSupported
      && input.updateStatus.status === 'available',
    showInstall: !input.detecting
      && input.installation?.status === 'not_installed'
      && platform !== 'unsupported',
  }
}

/** Agent 配置会话的意图。 */
export type ComputerUseAgentIntent = 'setup' | 'check' | 'cdn-update'

/** 会话标题前缀。 */
const INTENT_TITLES: Record<ComputerUseAgentIntent, string> = {
  setup: '配置',
  check: '检查/升级',
  'cdn-update': '更新',
}

/** 生成配置会话标题，例如「配置 Computer Use · Windows」。 */
export function buildComputerUseSessionTitle(
  intent: ComputerUseAgentIntent,
  platform: ComputerUsePlatform,
): string {
  return `${INTENT_TITLES[intent]} Computer Use · ${COMPUTER_USE_PLATFORM_LABELS[platform]}`
}

/** 配置记录路径说明；开发模式落到 `.proma-dev`。 */
const RECORD_PATH_HINT = '用户主目录的 .proma（开发环境为 .proma-dev）下的 computer-use.md'

/** 按平台给出的执行环境与权限检查要求。 */
function buildPlatformRequirements(platform: ComputerUsePlatform): string {
  switch (platform) {
    case 'macos':
      return [
        '当前目标是 macOS。使用 Bash；检查 Cua Driver 的辅助功能和屏幕录制权限，用 permissions status 核验。',
        '缺少授权时引导我到系统设置 → 隐私与安全性操作，等我回复后再复查，不循环轮询；不要把安装完成当成已授权。',
      ].join('')
    case 'windows':
      return [
        '当前目标是 Windows。使用原生 PowerShell，含空格的可执行文件路径用 & 调用，不使用 WSL 驱动宿主桌面。',
        '检查 Driver 与 Proma 是否处于同一个已登录且已解锁的交互式桌面；',
        '区分服务未启动、断开的远程桌面、Session 0、UAC 安全桌面和 UIPI 限制，这些都不是缺少安装。',
        '不要关闭 UAC、安全软件或企业策略，也不需要 macOS 的辅助功能或屏幕录制开关。',
      ].join('')
    case 'linux':
      return [
        '当前目标是 Linux，属于实验性支持：能力取决于桌面环境和授权，安装成功不代表桌面操作可用。',
        'GNOME 50+ 等较新桌面仍有限制，不要把这类限制当成配置失败；需要时说明实际受限的能力。',
      ].join('')
    case 'unsupported':
      return '当前平台暂不支持 Computer Use，请说明限制并停止配置，不要尝试安装或绕过限制。'
  }
}

/** 首次配置的提示词：安装、验证、记录三件事都要落地。 */
function buildSetupPrompt(platform: ComputerUsePlatform): string {
  return [
    '请作为 Proma 的 Computer Use 配置助手，实际帮我完成配置，不要只列命令。沿用当前会话的工具与目录边界，复用已有环境，不修改业务项目代码。',
    '先核实本机平台与现有安装：已在配置记录、默认安装目录或 PATH 中找到可用 Cua Driver 时不重装、不无故升级。',
    '发现残留安装、目标路径冲突或仍有共享服务与活跃任务时，说明实际状况，不覆盖旧文件，也不停止共享服务。',
    '下载失败时区分网络、代理、CPU 架构和签名原因；只在本次下载进程里使用已核验的临时代理并恢复环境，不修改系统代理。',
    '完整性校验与平台原生签名验证都不能跳过。',
    buildPlatformRequirements(platform),
    '配置完成后读取 cua-driver-cli Skill，用实际 Driver 路径验证 status、doctor 和 list_apps，并报告所有警告。',
    '然后用系统计算器完成 6 × 7，从最新窗口观察确认结果为 42，并把截图保存到本会话工作目录，用 Markdown 图片展示给我。',
    '截图是否成功、输入是否成功、计算结果是否正确要分别核验；当前模型不能看图且没有可用视觉助手时明确报告，不能假装完成了视觉验收。',
    `完成后在 ${RECORD_PATH_HINT} 保存简短配置记录（已有内容先读后合并）：系统、Driver 绝对路径、版本、启动方式、已验证能力、验证时间、截图路径和未完成项。`,
    '记录中必须保留一行 driver_path: <实际可执行文件绝对路径>，只写路径、不带命令参数；已有该字段则原位更新，避免出现多个冲突路径。Proma 的安装检测与预览都会读取这一行。',
    '不要保存密钥、PID、窗口 ID 或会过期的元素 token；旧记录不是实时健康证明，需要时重新核验。',
  ].join('\n')
}

/** 检查与升级共用的正文（升级意图在此基础上加一段确认与回滚要求）。 */
function buildCheckBody(platform: ComputerUsePlatform): string[] {
  return [
    `请检查当前 ${COMPUTER_USE_PLATFORM_LABELS[platform]} 的 Computer Use 配置，并在有新版本时帮助我完成升级。设置页已发现 Cua Driver，请复用现有安装；没有更新时不重装。`,
    `从 ${RECORD_PATH_HINT} 的 driver_path、当前平台默认安装位置或 PATH 查找实际可执行文件。读取 cua-driver-cli Skill，检查版本、status、doctor，并用 list_apps 验证连接，分别报告安装、服务和权限状态；检查失败不等于未安装。若文件已被移除，说明实际情况，并提示我回设置页刷新安装状态。`,
    '通过实际 Driver 路径执行 check-update --json --no-cache，检查当前更新渠道是否有新版本，不主动切换 stable/nightly。',
    '检查 error、cache_hit 和 update_available：网络失败或仅返回缓存时说明未能确认最新版本，不当作已是最新，也不据此升级。旧版本不支持该命令时，查阅官方说明 https://cua.ai/docs/cua-driver/quickstart 核实对应版本的检查和升级方式。',
    buildPlatformRequirements(platform),
  ]
}

/** 升级环节的具体要求：来源核验、影响说明、升级后复查与失败回退。 */
function buildUpgradeRequirements(): string[] {
  return [
    '确认有更新后，先说明当前版本、目标版本以及服务重启的影响，再按官方当前平台升级流程实际完成升级。',
    '升级前核验安装器来源与参数，保留归档校验和与平台原生签名检查；保留已有路径、更新渠道与启动配置，不修改永久 PATH。',
    '有正在进行的桌面任务时先等任务结束，避免中断共享服务。',
    `升级后重新检查版本、status、doctor、list_apps 和平台权限，报告升级前后版本及未完成项；读取并合并更新 ${RECORD_PATH_HINT} 中的版本、验证时间和唯一的 driver_path 字段。`,
    '升级失败时保留现有可用安装并说明原因，不反复重装。',
  ]
}

/** 收尾边界说明，避免 Agent 顺手改系统或业务代码。 */
const CLOSING_REQUIREMENTS = '遵循当前会话的工具与目录边界，需要更改配置时先说明实际变化；除升级所需的服务重启外不停止共享服务，不要关闭系统保护或修改业务项目代码。'

/**
 * 拼装交给 Agent 的配置/检查/升级提示词。
 *
 * - `setup`：安装并验证 Driver，写配置记录；
 * - `check`：复用现有安装，检查版本、服务、权限与更新；
 * - `cdn-update`：在检查结论上完成升级并复查。
 */
export function buildComputerUseAgentPrompt(
  intent: ComputerUseAgentIntent,
  platform: ComputerUsePlatform,
  latestVersion?: string,
): string {
  if (intent === 'setup') {
    return [...buildSetupPrompt(platform).split('\n'), CLOSING_REQUIREMENTS].join('\n')
  }

  const header = intent === 'cdn-update'
    ? `设置页检测到 Cua Driver 有新版本${latestVersion ? `（目标版本 ${latestVersion}）` : ''}，请帮我完成升级；升级前先核实实际版本，若已是最新则说明结果并停止，不重装。`
    : null

  const body = [...buildCheckBody(platform)]
  body.push(...buildUpgradeRequirements())
  body.push(CLOSING_REQUIREMENTS)

  return [...(header ? [header] : []), ...body].join('\n')
}
