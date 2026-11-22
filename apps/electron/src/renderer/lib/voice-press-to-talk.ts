/**
 * 「按住说话」长按管理器
 *
 * 按下麦克风按钮后先等待一段阈值，超过阈值才真正开始录音；松开或移动过远则结束。
 * 渲染端无法直接感知全局快捷键的松开，所以长按只能在按钮上用 pointer 事件实现。
 *
 * 关键细节：松开时 `start` 的 IPC 可能尚未返回，此时不能立刻判定会话未建立，
 * 而是在 start 回调里补发 stop，保证「按下→立刻松开」也能收尾。
 */

/** 一次长按会话的可变状态。 */
interface PressToTalkSession {
  pointerId: number
  /** 按下时的坐标，用于计算移动距离。 */
  x: number
  y: number
  /** 阈值未到时的定时器；到点后置空，同时表示会话已进入「已启动或启动中」。 */
  timer: ReturnType<typeof setTimeout> | null
  /** 用户是否已松手。 */
  released: boolean
  /** 主进程是否确认开始了录音。 */
  started: boolean
  /** 本次按下专属 token，start 与 stop 必须一致。 */
  token: string
}

interface PressToTalkControllerOptions {
  /** 请求主进程开始一次长按会话；返回 false 表示被状态守卫拒绝。 */
  start: (token: string) => Promise<boolean>
  /** 请求主进程结束本次长按会话。 */
  stop: (token: string) => Promise<unknown>
  /** token 生成器，测试可注入固定值。 */
  makeToken?: () => string
  /** 长按阈值，默认 450ms。 */
  delayMs?: number
  /** 允许的指针位移，超过即取消，默认 8px。 */
  movementThreshold?: number
}

const DEFAULT_DELAY_MS = 450
const DEFAULT_MOVEMENT_THRESHOLD = 8

export class PressToTalkController {
  private readonly startRequest: (token: string) => Promise<boolean>
  private readonly stopRequest: (token: string) => Promise<unknown>
  private readonly makeToken: () => string
  private readonly delayMs: number
  private readonly movementThreshold: number
  private current: PressToTalkSession | null = null

  constructor(options: PressToTalkControllerOptions) {
    this.startRequest = options.start
    this.stopRequest = options.stop
    this.makeToken = options.makeToken ?? (() => crypto.randomUUID())
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS
    this.movementThreshold = options.movementThreshold ?? DEFAULT_MOVEMENT_THRESHOLD
  }

  /** 是否正处于一次长按会话中（阈值等待也算）。 */
  get isPressing(): boolean {
    return this.current !== null
  }

  /** 按下：已在会话中时忽略，避免第二个 pointer 叠加出新会话。 */
  down(pointerId: number, x: number, y: number): void {
    if (this.current) return
    const session: PressToTalkSession = {
      pointerId,
      x,
      y,
      timer: null,
      released: false,
      started: false,
      token: this.makeToken(),
    }
    this.current = session
    session.timer = setTimeout(() => {
      session.timer = null
      this.startRequest(session.token)
        .then((started) => {
          session.started = started
          // 用户在 start 返回前就松手：此时才补发 stop，否则该会话会一直录音。
          if (started && session.released) return this.stopRequest(session.token)
          return undefined
        })
        .catch((error: unknown) => {
          console.error('[语音输入] 长按会话失败:', error)
        })
    }, this.delayMs)
  }

  /** 移动：阈值期间位移超限即取消；已启动后不再判断移动。 */
  move(pointerId: number, x: number, y: number): void {
    const session = this.current
    if (!session || session.pointerId !== pointerId || !session.timer) return
    if (Math.hypot(x - session.x, y - session.y) > this.movementThreshold) {
      this.finish(pointerId)
    }
  }

  /** 取消尚未启动的会话（例如按下 Esc）。 */
  cancelPending(): void {
    const session = this.current
    if (!session || !session.timer) return
    this.finish(session.pointerId)
  }

  /** 松手/取消：清空会话；已真正开始录音时才通知主进程结束。 */
  finish(pointerId?: number): void {
    const session = this.current
    if (!session) return
    if (pointerId !== undefined && session.pointerId !== pointerId) return

    this.current = null
    session.released = true
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    if (!session.started) return
    this.stopRequest(session.token).catch((error: unknown) => {
      console.error('[语音输入] 结束长按会话失败:', error)
    })
  }
}
