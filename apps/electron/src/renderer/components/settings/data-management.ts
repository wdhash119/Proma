/**
 * 数据管理设置页的纯逻辑与共享类型。
 *
 * 页面只负责渲染与调用 preload 桥接；存储统计类型、字节格式化、迁移进度换算
 * 和守卫文案都在这里集中实现，便于单测覆盖而不依赖 React 或 Electron 运行时。
 *
 * 迁移 / 孤儿清理的契约类型由 `@/types/settings` 提供（与主进程、preload 共用），
 * 这里不重复声明，避免渲染层与主进程的形状漂移。
 */

import type { DataMigrationProgress } from '@/types/settings'

/** 存储统计类目。 */
export interface StorageCategory {
  label: string
  key: string
  bytes: number
  count: number
}

/** 存储统计结果（主进程 get-storage-stats 的返回形状）。 */
export interface StorageStats {
  categories: StorageCategory[]
  totalBytes: number
  calculatedAt: number
}

/** 迁移阶段的展示文案。 */
export const MIGRATION_PHASE_LABELS: Record<DataMigrationProgress['phase'], string> = {
  scan: '正在统计源数据',
  copy: '正在复制数据',
  verify: '正在校验完整性',
  done: '迁移完成',
  error: '迁移失败',
}

/** 按 1024 进制格式化字节数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 迁移进度百分比（0-100 的整数）。
 *
 * 复制阶段按字节推进；校验阶段视为复制已完成，避免进度条回退；
 * 扫描阶段没有可靠的完成比例，保持 0。失败时保留已复制的比例，便于判断中断点。
 */
export function getMigrationPercent(progress: DataMigrationProgress): number {
  const ratio = progress.totalBytes > 0
    ? Math.round((progress.copiedBytes / progress.totalBytes) * 100)
    : 0
  const clamped = Math.max(0, Math.min(100, ratio))

  switch (progress.phase) {
    case 'done':
    case 'verify':
      return 100
    case 'copy':
    case 'error':
      return clamped
    default:
      return 0
  }
}

/** 迁移时间展示；缺省或非法值返回 null，由调用方决定是否渲染。 */
export function formatMigratedAt(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 有运行中会话时禁用迁移/删除/回滚的原因文案；没有则返回 null。 */
export function describeRunningSessionsBlock(runningSessions: number): string | null {
  if (!Number.isFinite(runningSessions) || runningSessions <= 0) return null
  return `有 ${runningSessions} 个会话正在运行，数据目录读写尚未停止。请先完成或停止这些会话，再迁移、删除或回滚数据目录。`
}
