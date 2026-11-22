/**
 * Live Compact 上游同步与设置页的共享契约。
 *
 * 算法本体（bundled 基线 / 同步覆盖层）留在主进程与 utility 进程，renderer 只拿到
 * 版本状态、检查结论与同步结果。这里的形状必须与主进程同步服务（
 * `apps/electron/src/main/lib/live-compact-sync.ts`）的返回值一致：该服务直接复用
 * 这些类型，契约漂移会在 typecheck 阶段暴露。
 */

/** 当前生效的算法覆盖层清单（`<configDir>/live-compact/active.json`）。 */
export interface LiveCompactActiveManifest {
  /** 覆盖层算法版本（上游 package.json 的 version）。 */
  version: string
  /** 覆盖层对应的上游 commit sha（40 位小写十六进制）。 */
  sha: string
  /** 激活时间（本机 ISO 8601）。 */
  syncedAt: string
  /** 已激活版本目录的绝对路径（内含 src/ 四件与 Proma 的 index.ts 再导出）。 */
  path: string
}

/** 一次上游 HEAD 检查记录（落盘在 `state.json`，只做展示，不参与决策）。 */
export interface LiveCompactCheckRecord {
  /** 上游默认分支 HEAD 的 commit sha。 */
  sha: string
  /** commit.author.date（ISO 8601，UTC）。 */
  date: string
  /** 本机执行检查的时间（ISO 8601）。 */
  checkedAt: string
}

/** 上游检查结果：在检查记录上补充「是否有更新」。 */
export interface LiveCompactCheckResult extends LiveCompactCheckRecord {
  /** 上游 HEAD 与本机基线（覆盖层 sha，否则随包 sha）不同。 */
  updateAvailable: boolean
}

/** 设置页使用的状态快照。 */
export interface LiveCompactState {
  /** 随 App 发版的算法版本。 */
  bundledVersion: string
  /** 随 App 发版对应的上游 commit sha；旧版本可能缺少该字段。 */
  bundledSha?: string
  /** 当前生效的覆盖层；不存在或清单不可用时缺省。 */
  active?: LiveCompactActiveManifest
  /** 最近一次上游检查结果。 */
  upstream?: LiveCompactCheckRecord
  /** 是否正在同步（进程内实时状态，不落盘）。 */
  syncing: boolean
  /** 最近一次同步失败的原因（中文）。 */
  lastError?: string
}

/** 同步结果：失败时也带最新状态，设置页可直接渲染。 */
export type LiveCompactSyncResult =
  | { ok: true; state: LiveCompactState }
  | { ok: false; error: string; state: LiveCompactState }

/** Live Compact 同步相关 IPC 通道。 */
export const LIVE_COMPACT_IPC_CHANNELS = {
  /** 读取版本状态快照（不触发网络请求）。 */
  GET_STATE: 'live-compact:get-state',
  /** 主动向上游查一次 HEAD，并记录检查结果。 */
  CHECK_UPSTREAM: 'live-compact:check-upstream',
  /** 下载上游 HEAD 并经过三重闸后激活。 */
  SYNC: 'live-compact:sync',
  /** 删除激活标记，回退到随 App 发版的内置算法。 */
  RESET: 'live-compact:reset',
} as const
