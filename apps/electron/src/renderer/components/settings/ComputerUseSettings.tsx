/**
 * ComputerUseSettings - Computer Use 设置页
 *
 * 展示本机 Cua Driver 的安装状态与更新入口，并把安装、检查与升级任务交给
 * Agent 会话实际执行：页面只启动会话并提交提示词，不直接下载或修改系统。
 * 页面重新获得焦点（窗口 focus / 标签可见）时自动复检安装状态。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  Monitor,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ComputerUseInstallation, CuaUpdateStatus } from '@proma/shared'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionsAtom,
  agentSessionDraftsAtom,
  agentSessionDraftSyncVersionsAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useOpenSession } from '@/hooks/useOpenSession'
import { useComputerUseUpdateStatus } from '@/hooks/useComputerUseUpdateStatus'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'
import {
  fetchComputerUseInstallation,
  requestComputerUseUpdateCheck,
} from './computer-use-bridge'
import {
  buildComputerUseAgentPrompt,
  buildComputerUseSessionTitle,
  canCheckComputerUseUpdate,
  COMPUTER_USE_PLATFORM_LABELS,
  describeComputerUseIndicators,
  describeComputerUseStatus,
  shouldShowComputerUseDriverDetail,
  type ComputerUseAgentIntent,
} from './computer-use-settings'

/** 状态徽章配色：仅「已安装」使用绿色系，其余保持中性或警示色。 */
const TONE_CLASS: Record<'success' | 'warning' | 'neutral', string> = {
  success: 'bg-green-500/10 text-green-700 dark:text-green-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  neutral: 'bg-muted text-muted-foreground',
}

/** 需要警示图标的状态：检测失败、需要检查、未安装。 */
function installWarningStatus(
  installation: ComputerUseInstallation | null,
  detectFailed: boolean,
): boolean {
  if (detectFailed) return true
  return installation?.status === 'needs_attention' || installation?.status === 'not_installed'
}

/** 把异常转换为可读文案。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ComputerUseSettings(): React.ReactElement {
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setDrafts = useSetAtom(agentSessionDraftsAtom)
  const setDraftSyncVersions = useSetAtom(agentSessionDraftSyncVersionsAtom)
  const openSession = useOpenSession()
  const { status: updateStatus, applyStatus: applyUpdateStatus } = useComputerUseUpdateStatus()

  const [installation, setInstallation] = React.useState<ComputerUseInstallation | null>(null)
  const [detecting, setDetecting] = React.useState(true)
  const [detectFailed, setDetectFailed] = React.useState(false)
  const [checkingUpdate, setCheckingUpdate] = React.useState(false)
  const [startingSession, setStartingSession] = React.useState(false)

  /** 防止并发检测：检测进行中时忽略重复触发。 */
  const detectingRef = React.useRef(false)
  /** 卸载后不再写入状态。 */
  const mountedRef = React.useRef(false)
  /** 防止并发启动配置会话。 */
  const startingRef = React.useRef(false)

  const refreshInstallation = React.useCallback(async (): Promise<void> => {
    if (detectingRef.current) return
    detectingRef.current = true
    if (mountedRef.current) {
      setDetecting(true)
      setDetectFailed(false)
    }
    try {
      const next = await fetchComputerUseInstallation()
      if (mountedRef.current) setInstallation(next)
    } catch (error) {
      console.error('[Computer Use 设置] 安装检测失败:', error)
      if (mountedRef.current) {
        setInstallation(null)
        setDetectFailed(true)
      }
    } finally {
      detectingRef.current = false
      if (mountedRef.current) setDetecting(false)
    }
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    const handleVisibilityOrFocus = (): void => {
      if (document.visibilityState === 'visible') void refreshInstallation()
    }
    void refreshInstallation()
    window.addEventListener('focus', handleVisibilityOrFocus)
    document.addEventListener('visibilitychange', handleVisibilityOrFocus)
    return () => {
      mountedRef.current = false
      window.removeEventListener('focus', handleVisibilityOrFocus)
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus)
    }
  }, [refreshInstallation])

  const platform = installation && installation.platform !== 'unsupported' ? installation.platform : null
  const platformLabel = platform ? COMPUTER_USE_PLATFORM_LABELS[platform] : ''
  const hasDriverDetail = shouldShowComputerUseDriverDetail(installation)
  const isInstalled = installation?.status === 'installed'
  const indicators = describeComputerUseIndicators({ installation, detecting, updateStatus })
  const status = describeComputerUseStatus({ installation, detecting, failed: detectFailed })
  const modelConfigured = Boolean(agentChannelId && agentModelId)

  /** 主动检查 CDN 上的新版本，并用返回值立即刷新更新条。 */
  const handleCheckUpdate = React.useCallback(async (): Promise<void> => {
    if (checkingUpdate) return
    setCheckingUpdate(true)
    try {
      const result = await requestComputerUseUpdateCheck()
      applyUpdateStatus(result)
      if (result.status === 'available') {
        toast.info(`发现 Cua Driver ${result.latestVersion ?? ''} 更新`)
      } else if (result.status === 'current') {
        toast.success('当前 Cua Driver 已是最新版本')
      } else {
        toast.error('暂时无法检查 Cua Driver 更新')
      }
    } catch (error) {
      console.error('[Computer Use 设置] 更新检查失败:', error)
      toast.error('暂时无法检查 Cua Driver 更新')
    } finally {
      setCheckingUpdate(false)
    }
  }, [checkingUpdate, applyUpdateStatus])

  /** 启动 Agent 会话；提示词按意图与平台拼装，失败时把提示词留回输入框。 */
  const startAgentSession = React.useCallback(async (intent: ComputerUseAgentIntent): Promise<void> => {
    if (startingRef.current || detecting || !platform) return
    if (!agentChannelId || !agentModelId) {
      toast.error('请先配置一个可用的 Agent 模型')
      return
    }
    if (intent === 'cdn-update' && (!updateStatus.latestVersion || updateStatus.status !== 'available')) return

    startingRef.current = true
    setStartingSession(true)
    const prompt = buildComputerUseAgentPrompt(intent, platform, updateStatus.latestVersion)

    try {
      const title = buildComputerUseSessionTitle(intent, platform)
      const session = await window.electronAPI.createAgentSession(
        title,
        agentChannelId,
        workspaceId ?? undefined,
        agentModelId,
      )
      setAgentSessions((previous) => [session, ...previous])
      openSession('agent', session.id, session.title || title)

      try {
        await window.electronAPI.submitOrEnqueueAgentMessage({
          sessionId: session.id,
          channelId: session.channelId ?? agentChannelId,
          modelId: session.modelId ?? agentModelId,
          workspaceId: session.workspaceId ?? workspaceId ?? undefined,
          userMessage: prompt,
          queueMessageId: crypto.randomUUID(),
          dispatch: 'after_current',
        })
      } catch (error) {
        // 提交失败时保留提示词到输入框草稿，避免用户重写整段要求。
        setDrafts((previous) => new Map(previous).set(session.id, prompt))
        setDraftSyncVersions((previous) => {
          const next = new Map(previous)
          next.set(session.id, (next.get(session.id) ?? 0) + 1)
          return next
        })
        throw error
      }
    } catch (error) {
      console.error('[Computer Use 设置] 配置会话启动失败:', error)
      toast.error('配置会话启动失败', { description: describeError(error) })
    } finally {
      startingRef.current = false
      setStartingSession(false)
    }
  }, [
    detecting,
    platform,
    agentChannelId,
    agentModelId,
    workspaceId,
    updateStatus.latestVersion,
    updateStatus.status,
    setAgentSessions,
    openSession,
    setDrafts,
    setDraftSyncVersions,
  ])

  /** 更新条按钮仅在确有可用版本时生效。 */
  const startUpdateSession = React.useCallback((): void => {
    void startAgentSession('cdn-update')
  }, [startAgentSession])

  /** 帮助卡片与安装条的共用入口：已安装时检查，未安装时配置。 */
  const startInstallOrCheckSession = React.useCallback((): void => {
    void startAgentSession(hasDriverDetail ? 'check' : 'setup')
  }, [hasDriverDetail, startAgentSession])

  const sessionButtonDisabled = detecting || startingSession || !platform || !modelConfigured
  const updateButtonDisabled = sessionButtonDisabled || !updateStatus.latestVersion

  /** 状态徽章图标：检测中旋转，已安装打勾，需要检查/未安装/失败用警示图标。 */
  const statusIcon = detecting
    ? <Loader2 className="size-3.5 animate-spin" />
    : isInstalled
      ? <CheckCircle2 className="size-3.5" />
      : installWarningStatus(installation, detectFailed)
        ? <AlertTriangle className="size-3.5" />
        : <CircleSlash className="size-3.5" />

  return (
    <div className="w-full space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Computer Use</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">让 Agent 看见并操作电脑，协助你完成跨应用任务。</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={detecting}
          onClick={() => void refreshInstallation()}
        >
          <RefreshCw className={detecting ? 'animate-spin' : undefined} />
          重新检测
        </Button>
      </div>

      <SettingsSection
        title="设备与 Driver"
        action={platformLabel && <span className="text-xs text-muted-foreground">{platformLabel}</span>}
      >
        <SettingsCard divided={false}>
          <div className="flex items-start gap-3 px-4 py-4">
            <Monitor aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">Cua Driver</span>
                <span
                  role="status"
                  aria-live="polite"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                    isInstalled && !detecting ? TONE_CLASS.success : TONE_CLASS[status.tone],
                  )}
                >
                  {statusIcon}
                  {status.label}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{status.description}</p>
              {isInstalled && (
                <p className="mt-1 text-xs text-muted-foreground">安装状态不代表服务已启动或系统权限已开启。</p>
              )}
              {platform === 'linux' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Linux 为实验性支持，能力取决于桌面环境和授权；安装成功不代表桌面操作可用。
                </p>
              )}
            </div>
          </div>

          {hasDriverDetail && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/25 px-4 py-2 text-xs text-muted-foreground">
              {installation?.version && (
                <span>
                  当前版本 <span className="font-medium tabular-nums text-foreground">{installation.version}</span>
                </span>
              )}
              {installation?.driverPath && (
                <span className="min-w-0 flex-1 break-all" title={installation.driverPath}>
                  {installation.driverPath}
                </span>
              )}
              {canCheckComputerUseUpdate(installation) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={checkingUpdate}
                  onClick={() => void handleCheckUpdate()}
                >
                  <RefreshCw className={checkingUpdate ? 'animate-spin' : undefined} />
                  {checkingUpdate ? '正在检查…' : '检查更新'}
                </Button>
              )}
            </div>
          )}

          {indicators.showUpdate && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border/25 bg-muted/40 px-4 py-3">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-red-500" />
              <div className="min-w-[180px] flex-1">
                <p className="text-sm font-medium">
                  有新版本可用{' '}
                  <span className="tabular-nums">{updateStatus.latestVersion || '暂不可用'}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Agent 将协助下载和验证，更新前会征得你的同意。</p>
              </div>
              <Button type="button" disabled={updateButtonDisabled} onClick={startUpdateSession}>
                {startingSession ? '正在打开会话…' : '用 Agent 更新'}
              </Button>
            </div>
          )}

          {indicators.showInstall && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border/25 bg-muted/40 px-4 py-3">
              <div className="min-w-[180px] flex-1">
                <p className="text-sm font-medium">开始配置 Computer Use</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Agent 会协助安装 Driver，并检查必要的权限。</p>
              </div>
              <Button type="button" disabled={sessionButtonDisabled} onClick={startInstallOrCheckSession}>
                {startingSession ? '正在打开会话…' : '用 Agent 配置'}
              </Button>
            </div>
          )}
        </SettingsCard>

        {indicators.showUpdate && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            更新可能短暂重启共享服务；正在进行的桌面任务需要先安全结束。
          </p>
        )}

        {!modelConfigured && (
          <p className="text-sm text-muted-foreground">请先在模型配置中配置可用模型，并在 Agent 会话中选用。</p>
        )}
      </SettingsSection>

      <SettingsSection title="需要帮助？">
        <SettingsCard>
          <SettingsRow
            label={hasDriverDetail ? '让 Agent 检查配置' : '让 Agent 协助配置'}
            icon={<Terminal className="size-4 text-muted-foreground" />}
            description={hasDriverDetail
              ? '检查现有安装、服务和权限，并协助解决问题。'
              : '协助安装 Driver、完成配置并验证实际操作。'}
            className="flex-wrap gap-y-3"
          >
            <Button
              type="button"
              variant="outline"
              disabled={sessionButtonDisabled}
              onClick={startInstallOrCheckSession}
            >
              {startingSession ? '正在打开会话…' : hasDriverDetail ? '开始检查' : '开始配置'}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="配置后可以这样用" description="直接在 Agent 会话中描述任务。">
        <div className="grid gap-2 sm:grid-cols-2">
          <SettingsCard>
            <SettingsRow label="查看与整理" description="帮我看看微信里的新消息，整理待回复事项。" />
          </SettingsCard>
          <SettingsCard>
            <SettingsRow label="操作前确认" description="帮我填写表单，提交前截图给我确认。" />
          </SettingsCard>
        </div>
      </SettingsSection>
    </div>
  )
}
