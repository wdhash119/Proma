/**
 * DataManagementSettings — 数据管理设置面板
 *
 * 四个区块：
 * 1. 存储用量：各数据类别的磁盘占用统计。
 * 2. 数据清理：临时文件、过期孤儿数据（扫描→预览→确认清理）与已归档会话。
 * 3. 数据目录：当前路径、整体迁移（指针文件方案）、删除旧数据与回滚。
 * 4. 跨设备迁移：原「数据迁移」页的压缩包/恢复引导。
 */

import * as React from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from './primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'
import type {
  CleanupResult,
  DataMigrationPreflightResult,
  DataMigrationProgress,
  DataRootInfo,
  OrphanScanResult,
} from '@/types/settings'
import {
  MIGRATION_PHASE_LABELS,
  describeRunningSessionsBlock,
  formatBytes,
  formatMigratedAt,
  getMigrationPercent,
  type StorageStats,
} from './data-management'

const ARCHIVE_MIGRATION_PROMPT = `请帮我创建一个可迁移的 Proma 数据压缩包。

Proma 的本地数据通常存放在 ~/.proma。请按以下步骤处理：

1. 先确认当前 Proma 数据文件夹的位置、计划生成的 ZIP 路径，以及压缩包是否可能包含会话记录、工作区配置和本地文件。
2. 在开始压缩前向我展示范围并征得确认；不要删除、移动或修改原始数据文件夹。
3. 将完整的 .proma 数据文件夹压缩为一个 ZIP 文件，并告诉我生成路径和文件大小。
4. 提醒我将 ZIP 通过可信方式传输到新设备，并在新设备的 Proma 对话中附上该 ZIP，执行恢复、项目路径分配和索引重建。
5. 不要尝试导出系统钥匙串、OAuth 登录或其他系统级凭据；这些内容需要在新设备上重新登录或配置。`

const RESTORE_MIGRATION_PROMPT = `我正在恢复来自另一台设备的 Proma 数据，并已附上旧设备 .proma 文件夹的 ZIP 压缩包。

请按以下步骤处理：

1. 先检查 ZIP 的内容，并说明将要写入的此设备 Proma 数据目录以及可能覆盖的文件；在任何覆盖前征得我的确认，并为现有数据创建可恢复备份。
2. 将压缩包解压到此设备的 Proma 数据目录，按当前版本的数据结构完成必要迁移。
3. 为每个恢复的工作区核对对应的本地项目目录；旧设备路径不可用时，询问我如何重新分配或跳过。
4. 重建会话、工作区和本地文件索引，检查恢复的数据是否能正常读取。
5. 完成后说明恢复的会话、工作区和需要重新绑定的本地项目；不要尝试恢复系统钥匙串、API Key 或 OAuth 登录，缺失的凭据请提示我重新配置。`

const BAR_COLORS = [
  'bg-blue-500',
  'bg-purple-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-cyan-500',
]

function StorageBar({ stats }: { stats: StorageStats }): React.ReactElement {
  if (stats.totalBytes === 0) {
    return <div className="h-3 w-full rounded-full bg-muted" />
  }
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
      {stats.categories.map((cat, i) => {
        const pct = (cat.bytes / stats.totalBytes) * 100
        if (pct < 0.5) return null
        return (
          <div
            key={cat.key}
            className={cn('h-full transition-all', BAR_COLORS[i % BAR_COLORS.length])}
            style={{ width: `${pct}%` }}
            title={`${cat.label}: ${formatBytes(cat.bytes)}`}
          />
        )
      })}
    </div>
  )
}

function CleanupNotice({ title, result }: { title: string; result: CleanupResult }): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-0.5">
        {result.freedBytes > 0 && result.deletedCount > 0 ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            已释放 {formatBytes(result.freedBytes)}，删除 {result.deletedCount} 项
          </span>
        ) : (
          <span className="text-muted-foreground">没有需要清理的数据</span>
        )}
      </div>
      {result.errors.length > 0 && (
        <div className="mt-1 text-xs text-destructive">
          {result.errors.map((err, i) => <div key={i}>{err}</div>)}
        </div>
      )}
    </div>
  )
}

export function DataManagementSettings(): React.ReactElement {
  // 存储用量
  const [stats, setStats] = React.useState<StorageStats | null>(null)
  const [loadingStats, setLoadingStats] = React.useState(false)
  const [cleaningTemp, setCleaningTemp] = React.useState(false)
  const [tempResult, setTempResult] = React.useState<CleanupResult | null>(null)

  // 清理相关设置
  const [autoCleanupTemp, setAutoCleanupTemp] = React.useState(true)
  const [archivedDays, setArchivedDays] = React.useState(0)
  const [orphanDays, setOrphanDays] = React.useState(30)
  const [autoCleanupOrphans, setAutoCleanupOrphans] = React.useState(false)

  // 过期孤儿数据扫描 / 清理
  const [orphanScan, setOrphanScan] = React.useState<OrphanScanResult | null>(null)
  const [scanningOrphans, setScanningOrphans] = React.useState(false)
  const [expandedCategory, setExpandedCategory] = React.useState<string | null>(null)
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = React.useState(false)
  const [cleaningOrphans, setCleaningOrphans] = React.useState(false)
  const [orphanResult, setOrphanResult] = React.useState<CleanupResult | null>(null)

  // 数据目录
  const [rootInfo, setRootInfo] = React.useState<DataRootInfo | null>(null)
  const [loadingRoot, setLoadingRoot] = React.useState(false)
  const [targetDir, setTargetDir] = React.useState<string | null>(null)
  const [preflight, setPreflight] = React.useState<DataMigrationPreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = React.useState(false)
  const [migrateConfirmOpen, setMigrateConfirmOpen] = React.useState(false)
  const [migrating, setMigrating] = React.useState(false)
  const [progress, setProgress] = React.useState<DataMigrationProgress | null>(null)
  const [deleteOldConfirmOpen, setDeleteOldConfirmOpen] = React.useState(false)
  const [deletingOld, setDeletingOld] = React.useState(false)
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = React.useState(false)
  const [rollingBack, setRollingBack] = React.useState(false)
  const [restartDialog, setRestartDialog] = React.useState<{ title: string; description: string } | null>(null)

  const loadStats = React.useCallback(async (): Promise<void> => {
    setLoadingStats(true)
    try {
      const result = await window.electronAPI.getStorageStats() as StorageStats
      setStats(result)
    } catch (e) {
      console.error('[数据管理] 获取存储统计失败:', e)
    } finally {
      setLoadingStats(false)
    }
  }, [])

  const loadRootInfo = React.useCallback(async (): Promise<void> => {
    setLoadingRoot(true)
    try {
      setRootInfo(await window.electronAPI.dataRoot.getInfo())
    } catch (e) {
      console.error('[数据管理] 读取数据目录信息失败:', e)
    } finally {
      setLoadingRoot(false)
    }
  }, [])

  React.useEffect(() => {
    void loadStats()
    void loadRootInfo()
    window.electronAPI.getSettings().then((settings) => {
      setAutoCleanupTemp(settings.autoCleanupTempOnStart !== false)
      setArchivedDays(settings.autoCleanupArchivedDays ?? 0)
      setOrphanDays(settings.orphanCleanupDays ?? 30)
      setAutoCleanupOrphans(settings.autoCleanupOrphansOnStart === true)
    }).catch(console.error)
  }, [loadRootInfo, loadStats])

  React.useEffect(() => {
    const unsubscribe = window.electronAPI.dataRoot.onProgress((next) => setProgress(next))
    return () => { unsubscribe() }
  }, [])

  const tempCategory = stats?.categories.find((cat) => cat.key === 'temp-files')
  const migratedAtLabel = formatMigratedAt(rootInfo?.migratedAt)
  const runningBlock = rootInfo ? describeRunningSessionsBlock(rootInfo.runningSessions) : null
  const rootBusy = migrating || deletingOld || rollingBack || preflightLoading
  const migrationBlocked = runningBlock !== null || rootBusy

  const handleCleanTemp = async (): Promise<void> => {
    setCleaningTemp(true)
    setTempResult(null)
    try {
      const result = await window.electronAPI.cleanupTempStorage() as CleanupResult
      setTempResult(result)
      await loadStats()
    } catch (e) {
      console.error('[数据管理] 清理临时文件失败:', e)
      toast.error(e instanceof Error ? e.message : '清理临时文件失败')
    } finally {
      setCleaningTemp(false)
    }
  }

  const handleAutoCleanupTempChange = async (enabled: boolean): Promise<void> => {
    setAutoCleanupTemp(enabled)
    try {
      await window.electronAPI.updateSettings({ autoCleanupTempOnStart: enabled })
    } catch (e) {
      console.error('[数据管理] 更新自动清理设置失败:', e)
    }
  }

  const handleArchivedDaysChange = async (value: string): Promise<void> => {
    const days = parseInt(value, 10)
    setArchivedDays(days)
    try {
      await window.electronAPI.updateSettings({ autoCleanupArchivedDays: days })
    } catch (e) {
      console.error('[数据管理] 更新已归档会话清理天数失败:', e)
    }
  }

  const handleOrphanDaysChange = async (value: string): Promise<void> => {
    const days = parseInt(value, 10)
    setOrphanDays(days)
    // 阈值变化后旧预览不再对应当前口径，清空避免误删。
    setOrphanScan(null)
    setExpandedCategory(null)
    try {
      await window.electronAPI.updateSettings({ orphanCleanupDays: days })
    } catch (e) {
      console.error('[数据管理] 更新孤儿数据阈值失败:', e)
    }
  }

  const handleAutoCleanupOrphansChange = async (enabled: boolean): Promise<void> => {
    setAutoCleanupOrphans(enabled)
    try {
      await window.electronAPI.updateSettings({ autoCleanupOrphansOnStart: enabled })
    } catch (e) {
      console.error('[数据管理] 更新启动自动清理设置失败:', e)
    }
  }

  const handleScanOrphans = async (): Promise<void> => {
    setScanningOrphans(true)
    setOrphanResult(null)
    try {
      const result = await window.electronAPI.storage.scanOrphans(orphanDays)
      setOrphanScan(result)
      setExpandedCategory(result.categories[0]?.key ?? null)
      if (result.totalCount === 0) toast.success('没有发现可清理的过期数据')
    } catch (e) {
      console.error('[数据管理] 扫描孤儿数据失败:', e)
      toast.error(e instanceof Error ? e.message : '扫描孤儿数据失败')
    } finally {
      setScanningOrphans(false)
    }
  }

  const handleCleanupOrphans = async (): Promise<void> => {
    setCleaningOrphans(true)
    try {
      const result = await window.electronAPI.storage.cleanupOrphans(orphanDays)
      setOrphanResult(result)
      setCleanupConfirmOpen(false)
      setOrphanScan(null)
      setExpandedCategory(null)
      await loadStats()
    } catch (e) {
      console.error('[数据管理] 清理孤儿数据失败:', e)
      toast.error(e instanceof Error ? e.message : '清理孤儿数据失败')
    } finally {
      setCleaningOrphans(false)
    }
  }

  const handleOpenDataFolder = async (): Promise<void> => {
    try {
      await window.electronAPI.openMigrationDataFolder()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开数据文件夹')
    }
  }

  const handleSelectTarget = async (): Promise<void> => {
    if (migrationBlocked) return
    setPreflightLoading(true)
    setPreflight(null)
    try {
      const dir = await window.electronAPI.dataRoot.selectDirectory()
      if (!dir) return
      setTargetDir(dir)
      const result = await window.electronAPI.dataRoot.preflight(dir)
      setPreflight(result)
      if (!result.ok) {
        toast.error(result.reason ?? '该目录不能作为新的数据目录')
        return
      }
      setMigrateConfirmOpen(true)
    } catch (e) {
      console.error('[数据管理] 检查目标目录失败:', e)
      toast.error(e instanceof Error ? e.message : '检查目标目录失败')
    } finally {
      setPreflightLoading(false)
    }
  }

  const handleMigrate = async (): Promise<void> => {
    if (!targetDir || migrating) return
    setMigrating(true)
    setMigrateConfirmOpen(false)
    setProgress(null)
    try {
      const result = await window.electronAPI.dataRoot.migrate(targetDir)
      if (result.success) {
        setRestartDialog({
          title: '数据迁移完成',
          description: `已复制 ${result.copiedFiles} 个文件（${formatBytes(result.copiedBytes)}）并通过校验。重启 Proma 后从新位置加载数据；旧位置的数据仍保留，确认无误后可在此页删除。`,
        })
      } else {
        toast.error(result.error ?? '数据迁移失败')
      }
    } catch (e) {
      console.error('[数据管理] 迁移数据目录失败:', e)
      toast.error(e instanceof Error ? e.message : '数据迁移失败')
    } finally {
      setMigrating(false)
      setProgress(null)
      setPreflight(null)
      setTargetDir(null)
    }
  }

  const handleDeleteOld = async (): Promise<void> => {
    if (deletingOld) return
    setDeletingOld(true)
    try {
      const result = await window.electronAPI.dataRoot.deleteOld()
      setDeleteOldConfirmOpen(false)
      if (result.errors.length > 0) {
        toast.error(`删除旧数据时出错：${result.errors[0]}`)
      } else {
        toast.success(`已释放 ${formatBytes(result.freedBytes)}，删除 ${result.deletedCount} 项`)
      }
      await loadRootInfo()
    } catch (e) {
      console.error('[数据管理] 删除旧数据失败:', e)
      toast.error(e instanceof Error ? e.message : '删除旧数据失败')
    } finally {
      setDeletingOld(false)
    }
  }

  const handleRollback = async (): Promise<void> => {
    if (rollingBack) return
    setRollingBack(true)
    try {
      const result = await window.electronAPI.dataRoot.rollback()
      setRollbackConfirmOpen(false)
      if (result.success) {
        setRestartDialog({
          title: '已回滚到旧数据目录',
          description: '数据指针文件已删除。重启 Proma 后从默认位置加载旧数据；新位置复制出的数据仍保留在原处，可自行处理。',
        })
        await loadRootInfo()
      } else {
        toast.error(result.error ?? '回滚失败')
      }
    } catch (e) {
      console.error('[数据管理] 回滚数据目录失败:', e)
      toast.error(e instanceof Error ? e.message : '回滚失败')
    } finally {
      setRollingBack(false)
    }
  }

  const handleRestart = async (): Promise<void> => {
    try {
      await window.electronAPI.dataRoot.restart()
    } catch (e) {
      console.error('[数据管理] 重启应用失败:', e)
      toast.error('重启失败，请手动退出并重新打开 Proma')
    }
  }

  const handleCopyPrompt = (prompt: string, successMessage: string): void => {
    void copyTextToClipboard(prompt).then(
      () => toast.success(successMessage),
      () => toast.error('复制失败，请手动复制提示词'),
    )
  }

  return (
    <div className="space-y-8">
      {/* 1. 存储用量 */}
      <SettingsSection
        title="存储用量"
        description={stats ? `总计 ${formatBytes(stats.totalBytes)}` : '正在计算...'}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadStats()}
            disabled={loadingStats}
            className="gap-1.5"
          >
            <RefreshCw size={14} className={cn(loadingStats && 'animate-spin')} />
            刷新
          </Button>
        }
      >
        {stats && (
          <div className="mb-4">
            <StorageBar stats={stats} />
          </div>
        )}
        <SettingsCard>
          {stats?.categories.map((cat, i) => (
            <SettingsRow key={cat.key} label={cat.label}>
              <div className="flex items-center gap-2">
                <span
                  className={cn('inline-block h-2.5 w-2.5 rounded-full', BAR_COLORS[i % BAR_COLORS.length])}
                />
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatBytes(cat.bytes)}
                </span>
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      {/* 2. 数据清理 */}
      <SettingsSection
        title="数据清理"
        description="临时文件可随时重建；过期孤儿数据是已无任何会话或索引引用的残留；已归档会话可整体回收。"
      >
        <SettingsCard>
          <SettingsRow
            label="临时文件"
            description="预览缓存与安装包缓存，删除后需要时自动重建"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground tabular-nums">
                {tempCategory ? formatBytes(tempCategory.bytes) : '—'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCleanTemp()}
                disabled={cleaningTemp || !tempCategory || tempCategory.bytes === 0}
                className="h-7 gap-1 text-xs"
              >
                <Trash2 size={12} />
                {cleaningTemp ? '清理中...' : '清理'}
              </Button>
            </div>
          </SettingsRow>

          <SettingsToggle
            label="启动时清理临时文件"
            description="每次启动时自动删除预览和安装缓存"
            checked={autoCleanupTemp}
            onCheckedChange={(enabled) => void handleAutoCleanupTempChange(enabled)}
          />

          <SettingsRow
            label="过期孤儿数据"
            description="已无会话或索引引用的会话消息、Pi 产物、无主工作区和遗留 SDK 目录；按最后修改时间超过所选天数判定"
          >
            <div className="flex items-center gap-2">
              <Select value={String(orphanDays)} onValueChange={(value) => void handleOrphanDaysChange(value)}>
                <SelectTrigger className="w-24" aria-label="过期孤儿数据阈值">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 天</SelectItem>
                  <SelectItem value="30">30 天</SelectItem>
                  <SelectItem value="90">90 天</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleScanOrphans()}
                disabled={scanningOrphans || cleaningOrphans || migrating}
                className="h-9 gap-1.5 px-3"
              >
                <RefreshCw size={13} className={cn(scanningOrphans && 'animate-spin')} />
                {scanningOrphans ? '扫描中...' : '扫描'}
              </Button>
            </div>
          </SettingsRow>

          <SettingsToggle
            label="启动时自动清理过期孤儿数据"
            description="每次启动时按上面的阈值静默扫描并清理，默认关闭"
            checked={autoCleanupOrphans}
            onCheckedChange={(enabled) => void handleAutoCleanupOrphansChange(enabled)}
          />

          <SettingsRow
            label="清理已归档会话数据"
            description="自动清理超过指定天数的已归档会话消息、Pi 产物和会话工作目录"
          >
            <Select value={String(archivedDays)} onValueChange={(value) => void handleArchivedDaysChange(value)}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">禁用</SelectItem>
                <SelectItem value="7">7 天</SelectItem>
                <SelectItem value="30">30 天</SelectItem>
                <SelectItem value="90">90 天</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>

        {orphanScan && (
          <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm">
                <span className="font-medium text-foreground">扫描结果</span>
                <span className="ml-2 text-muted-foreground tabular-nums">
                  共 {orphanScan.totalCount} 项 · {formatBytes(orphanScan.totalSizeBytes)}
                </span>
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                阈值 {orphanScan.days} 天 · {new Date(orphanScan.scannedAt).toLocaleTimeString('zh-CN')}
              </span>
            </div>

            {orphanScan.categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有发现可清理的过期数据。</p>
            ) : (
              <div className="space-y-1">
                {orphanScan.categories.map((cat) => {
                  const expanded = expandedCategory === cat.key
                  return (
                    <div key={cat.key} className="overflow-hidden rounded-lg border border-border/40">
                      <button
                        type="button"
                        onClick={() => setExpandedCategory(expanded ? null : cat.key)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ChevronRight
                            size={14}
                            className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
                          />
                          <span className="truncate text-foreground">{cat.label}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
                          <span>{cat.count} 项</span>
                          <span>{formatBytes(cat.sizeBytes)}</span>
                        </span>
                      </button>
                      {expanded && (
                        <div className="max-h-64 overflow-y-auto border-t border-border/40 px-3 py-2">
                          {cat.entries.length === 0 ? (
                            <p className="text-xs text-muted-foreground">没有可展示的明细。</p>
                          ) : (
                            <ul className="space-y-1 text-xs text-muted-foreground">
                              {cat.entries.map((entry) => (
                                <li key={entry.path} className="flex items-start justify-between gap-4">
                                  <span className="break-all">{entry.path}</span>
                                  <span className="shrink-0 tabular-nums">{formatBytes(entry.sizeBytes)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {cat.totalEntries > cat.entries.length && (
                            <p className="mt-2 text-xs text-muted-foreground/70">
                              仅显示前 {cat.entries.length} 项，共 {cat.totalEntries} 项
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                清理前会重新扫描并校验引用关系，只删除预览中列出的过期数据。
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setCleanupConfirmOpen(true)}
                disabled={cleaningOrphans || orphanScan.totalCount === 0}
                className="gap-1.5"
              >
                <Trash2 size={13} />
                清理过期数据
              </Button>
            </div>
          </div>
        )}

        {tempResult && <CleanupNotice title="临时文件清理结果" result={tempResult} />}
        {orphanResult && <CleanupNotice title="过期孤儿数据清理结果" result={orphanResult} />}
      </SettingsSection>

      {/* 3. 数据目录 */}
      <SettingsSection
        title="数据目录"
        description="会话、工作区与附件都存放在当前数据目录。迁移只改变数据位置，不会丢失已有数据。"
      >
        <SettingsCard>
          <SettingsRow
            label="当前数据目录"
            description={
              <span className="break-all font-mono text-xs">
                {rootInfo?.currentRoot ?? (loadingRoot ? '正在读取...' : '未读取到数据目录')}
              </span>
            }
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleOpenDataFolder()}
              className="gap-1.5"
            >
              <FolderOpen size={14} />
              打开文件夹
            </Button>
          </SettingsRow>
        </SettingsCard>

        {rootInfo?.isCustom && (
          <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-foreground">数据已迁移到自定义位置</div>
              <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{rootInfo.currentRoot}</div>
              {migratedAtLabel && (
                <div className="mt-1 text-xs text-muted-foreground">
                  迁移时间：{migratedAtLabel}
                </div>
              )}
              <div className="mt-1 text-xs text-muted-foreground">
                {rootInfo.oldDataPresent
                  ? `旧位置 ${rootInfo.defaultRoot} 仍有数据${rootInfo.oldDataSizeBytes !== undefined ? `（${formatBytes(rootInfo.oldDataSizeBytes)}）` : ''}，确认新位置运行正常后可删除。`
                  : `旧位置 ${rootInfo.defaultRoot} 已无数据，回滚功能不可用。`}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteOldConfirmOpen(true)}
                disabled={!rootInfo.oldDataPresent || migrationBlocked}
                className="gap-1.5 text-destructive"
              >
                <Trash2 size={14} />
                删除旧数据
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRollbackConfirmOpen(true)}
                disabled={!rootInfo.oldDataPresent || migrationBlocked}
                className="gap-1.5"
              >
                <RotateCcw size={14} />
                回滚到旧目录
              </Button>
            </div>
          </div>
        )}

        {runningBlock && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200">
            <AlertTriangle size={16} className="mt-1 shrink-0" />
            <span>{runningBlock}</span>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void handleSelectTarget()}
              disabled={migrationBlocked}
              className="gap-1.5"
            >
              <ArrowRightLeft size={14} />
              迁移到新位置
            </Button>
            {loadingRoot && !rootInfo && (
              <span className="text-sm text-muted-foreground">正在读取数据目录...</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            迁移会先复制并逐文件校验，再写入数据指针，重启 Proma 后生效；旧位置的数据保留，可在确认无误后删除。
          </p>
        </div>

        {preflight && (
          <div
            className={cn(
              'space-y-1 rounded-lg border px-4 py-3 text-sm',
              preflight.ok
                ? 'border-border/60 bg-muted/20'
                : 'border-destructive/30 bg-destructive/5',
            )}
          >
            <div className={cn('font-medium', preflight.ok ? 'text-foreground' : 'text-destructive')}>
              {preflight.ok ? '目标目录检查通过' : '目标目录不可用'}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              源数据 {formatBytes(preflight.sourceSizeBytes)} · {preflight.sourceFileCount} 个文件 · 目标剩余空间 {formatBytes(preflight.targetFreeBytes)}
            </div>
            {!preflight.ok && preflight.reason && (
              <div className="text-xs text-destructive">{preflight.reason}</div>
            )}
          </div>
        )}

        {migrating && !progress && (
          <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
            正在准备迁移，随后会显示复制进度...
          </div>
        )}

        {progress && (
          <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">{MIGRATION_PHASE_LABELS[progress.phase]}</span>
              <span className="text-muted-foreground tabular-nums">{getMigrationPercent(progress)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  progress.phase === 'error' ? 'bg-destructive' : 'bg-primary',
                )}
                style={{ width: `${getMigrationPercent(progress)}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
              <span>{progress.copiedFiles} / {progress.totalFiles} 个文件</span>
              <span>{formatBytes(progress.copiedBytes)} / {formatBytes(progress.totalBytes)}</span>
            </div>
            {progress.message && <div className="text-xs text-muted-foreground">{progress.message}</div>}
          </div>
        )}
      </SettingsSection>

      {/* 4. 跨设备迁移 */}
      <SettingsSection
        title="跨设备迁移"
        description="Proma 的本地数据通常存放在 .proma 文件夹。迁移时先压缩该文件夹，再在新设备上由 Proma 解压、分配项目路径并重建索引。"
      >
        <ol className="space-y-3 text-sm leading-6 text-muted-foreground">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">1</span>
            <span>在当前设备将完整的 .proma 数据文件夹压缩为 ZIP，原始数据保持不变。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">2</span>
            <span>将 ZIP 通过可信方式传输到新设备，并附到任意一个 Proma 对话中。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">3</span>
            <span>新设备上的 Proma 解压数据、重新分配本地项目目录，并重建会话、工作区和文件索引。</span>
          </li>
        </ol>

        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium text-foreground">当前设备：创建迁移压缩包</div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              先打开 Proma 数据文件夹；随后可将提示词粘贴到任意 Proma 对话，由 Agent 协助创建 ZIP。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void handleOpenDataFolder()} className="gap-2">
              <FolderOpen size={16} />
              打开数据文件夹
            </Button>
            <Button
              variant="outline"
              onClick={() => handleCopyPrompt(ARCHIVE_MIGRATION_PROMPT, '创建压缩包提示词已复制到剪贴板')}
              className="gap-2"
            >
              <Copy size={16} />
              复制创建压缩包提示词
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium text-foreground">新设备：恢复 Proma 数据</div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              在新设备的任意 Proma 对话中附上 ZIP，再粘贴以下提示词完成解压、项目分配和索引重建。
            </p>
          </div>
          <div className="relative rounded-lg border border-border/60 bg-muted/30 p-4 pr-14">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-muted-foreground">{RESTORE_MIGRATION_PROMPT}</pre>
            <button
              type="button"
              aria-label="复制恢复数据提示词"
              title="复制恢复数据提示词"
              onClick={() => handleCopyPrompt(RESTORE_MIGRATION_PROMPT, '恢复数据提示词已复制到剪贴板')}
              className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground active:scale-[0.96]"
            >
              <Copy size={16} />
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200">
          数据文件夹可能包含会话记录、文件和配置。请仅通过可信渠道传输并妥善保管压缩包。系统钥匙串中的 API Key 和登录凭据不会随文件夹复制，迁移后可能需要重新登录或配置。
        </div>
      </SettingsSection>

      {/* 确认与结果对话框 */}

      <ConfirmDialog
        open={cleanupConfirmOpen}
        onOpenChange={setCleanupConfirmOpen}
        title="清理过期孤儿数据？"
        confirmLabel="确认清理"
        loadingLabel="清理中..."
        loading={cleaningOrphans}
        onConfirm={() => void handleCleanupOrphans()}
      >
        <div className="space-y-2 text-sm">
          <p>
            将永久删除 {orphanScan?.totalCount ?? 0} 项无引用数据，合计约 {formatBytes(orphanScan?.totalSizeBytes ?? 0)}。删除后无法恢复。
          </p>
          {orphanScan && orphanScan.categories.length > 0 && (
            <ul className="space-y-0.5 text-xs">
              {orphanScan.categories.map((cat) => (
                <li key={cat.key}>
                  {cat.label}：{cat.count} 项（{formatBytes(cat.sizeBytes)}）
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs">已归档会话的索引条目会保留，会话消息与产物按上面的规则回收。</p>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={migrateConfirmOpen}
        onOpenChange={setMigrateConfirmOpen}
        title="迁移数据目录？"
        confirmLabel="开始迁移"
        cancelLabel="取消"
        variant="default"
        loadingLabel="迁移中..."
        loading={migrating}
        onConfirm={() => void handleMigrate()}
      >
        <div className="space-y-2 text-sm">
          <p>将把当前数据复制到：</p>
          <p className="break-all font-mono text-xs">{targetDir}</p>
          {preflight && (
            <p className="text-xs tabular-nums">
              源数据 {formatBytes(preflight.sourceSizeBytes)}（{preflight.sourceFileCount} 个文件），目标剩余空间 {formatBytes(preflight.targetFreeBytes)}。
            </p>
          )}
          <p className="text-xs">复制并校验完成后写入数据指针，重启 Proma 生效；旧位置的数据保留。</p>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOldConfirmOpen}
        onOpenChange={setDeleteOldConfirmOpen}
        title="删除旧位置的数据？"
        confirmLabel="删除旧数据"
        loadingLabel="删除中..."
        loading={deletingOld}
        onConfirm={() => void handleDeleteOld()}
      >
        <div className="space-y-2 text-sm">
          <p>将从默认位置 {rootInfo?.defaultRoot} 删除除数据指针外的全部旧数据，删除后无法恢复。</p>
          {rootInfo?.oldDataSizeBytes !== undefined && (
            <p className="text-xs tabular-nums">预计释放 {formatBytes(rootInfo.oldDataSizeBytes)}。</p>
          )}
          <p className="text-xs">请确认当前新位置的数据已能正常使用，再执行此操作。</p>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={rollbackConfirmOpen}
        onOpenChange={setRollbackConfirmOpen}
        title="回滚到旧数据目录？"
        description="将删除数据指针文件，重启 Proma 后从默认位置加载旧数据。新位置复制出的数据不会被自动删除。"
        confirmLabel="回滚"
        cancelLabel="取消"
        variant="default"
        loadingLabel="回滚中..."
        loading={rollingBack}
        onConfirm={() => void handleRollback()}
      />

      <Dialog
        open={restartDialog !== null}
        onOpenChange={(open) => { if (!open) setRestartDialog(null) }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{restartDialog?.title}</DialogTitle>
            <DialogDescription>{restartDialog?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestartDialog(null)}>
              稍后重启
            </Button>
            <Button onClick={() => void handleRestart()} className="gap-1.5">
              立即重启
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
