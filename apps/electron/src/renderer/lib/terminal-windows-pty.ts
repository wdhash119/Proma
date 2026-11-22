interface WindowsPtyOptions {
  backend: 'conpty'
  buildNumber: number
}

/** 未知构建号时的保守回退：最早完整支持 ConPTY 的 Windows 10 build。 */
export const CONSERVATIVE_CONPTY_BUILD_NUMBER = 19041

/** xterm.js 关闭旧版 ConPTY 包装启发式、启用现代 reflow 的最低 build（Windows 11 21H2）。 */
export const MODERN_CONPTY_BUILD_NUMBER = 21376

/**
 * xterm.js 必须知道 ConPTY 的真实 build 才能选择正确的 Windows buffer 路径：
 * - build ≥ 21376：ConPTY 自身正确处理换行与 resize 重绘，xterm 关闭旧版
 *   包装启发式并启用 reflow；若仍用保守值，启发式会与 ConPTY 重复重排，
 *   导致长行片段叠影、clear 后残留旧行。
 * - build < 21376（旧 Win10）：保留保守兼容路径。
 * - 未知 build：回退保守值。
 */
export function getWindowsPtyOptions(buildNumber?: number): WindowsPtyOptions {
  const resolved = typeof buildNumber === 'number' && Number.isFinite(buildNumber) && buildNumber > 0
    ? Math.floor(buildNumber)
    : CONSERVATIVE_CONPTY_BUILD_NUMBER
  return { backend: 'conpty', buildNumber: resolved }
}

/** 从 os.release()（如 '10.0.22631'）解析 Windows build 号；无法解析返回 0。 */
export function parseWindowsBuildNumber(release: string): number {
  const parts = release.split('.')
  const build = Number(parts[2])
  return Number.isFinite(build) && build > 0 ? Math.floor(build) : 0
}