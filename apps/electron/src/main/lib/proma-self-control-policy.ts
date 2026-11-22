/**
 * Proma 自操作的安全边界。
 *
 * 让 Agent 操作 Proma 自己的界面，必须明确哪些东西永远不能碰：
 * - 带 `data-proma-self-control="deny"` 的区块、alertdialog、密码框；
 * - 语义上属于「不可替用户决定」的动作（删除、支付、授权、退出登录、发送、确认…）。
 *
 * 另外「创建项目」是唯一需要用户明确同意的界面动作：它会在磁盘上产生新目录，
 * 事后回滚成本高，因此要求先通过 AskUserQuestion 取得同意。
 *
 * 这里只**生成**检测函数源码，由 CDP 在页面上下文执行，
 * 因此判断逻辑必须在目标页面的 DOM 语义下成立，不能依赖 Node 侧状态。
 */

/** 内容永远不可操作的容器。 */
export const PROMA_SELF_CONTROL_PROTECTED_SELECTOR = [
  '[data-proma-self-control="deny"]',
  '[role="alertdialog"]',
  'input[type="password"]',
].join(', ')

export const PROMA_SELF_CONTROL_PROTECTED_ERROR
  = '该控件需要用户亲自操作，Proma 自操作已拒绝。请保留当前界面并交给用户处理。'

/** 这些动词属于用户的决定权，Agent 不能代为点击。 */
const PROMA_SELF_CONTROL_BLOCKED_ACTION_PATTERN
  = /(?:删除|清空|移除|支付|购买|订阅|授权|允许|批准|拒绝|退出登录|停止\s*Agent|发送|确认|清理|delete|remove|pay|purchase|subscribe|authorize|allow|approve|reject|sign\s*out|stop\s*agent|send|confirm)/i

const PROMA_SELF_CONTROL_PROJECT_CREATION_SELECTOR = '[data-proma-self-control="create-project"]'

export const PROMA_SELF_CONTROL_PROJECT_CONSENT_ERROR
  = '创建项目前必须获得用户明确同意。请先通过 AskUserQuestion 询问，并等待用户选择同意。'

export const PROMA_SELF_CONTROL_PROJECT_CONSENT_DENIED = '用户未同意创建项目，本次操作已取消。'

/** AskUserQuestion 批准创建项目时使用的预定义同意选项。 */
export const PROMA_SELF_PROJECT_CONSENT_LABEL = '同意'

/**
 * 判断 AskUserQuestion 的回答是否构成创建项目的明确同意。
 *
 * 只接受与预定义「同意」选项精确相等的答案（多选按 `, ` 连接的集合判定）。
 * 不能用自然语言子串匹配授权：「不同意」「不要创建」「yesn't」都不得视为同意，
 * 用户在「其他」里输入的自定义文本也不会恰好等于该选项。
 */
export function hasPromaSelfProjectConsent(answers: Record<string, unknown>): boolean {
  return Object.values(answers).some((value) => {
    if (typeof value !== 'string') return false
    return value.split(',').some((part) => part.trim() === PROMA_SELF_PROJECT_CONSENT_LABEL)
  })
}

const PROMA_SELF_CONTROL_PROJECT_CREATION_PATTERN
  = /(?:新建空白项目|从本地文件夹创建项目|新建项目|创建项目|new\s+(?:blank\s+)?project|create\s+(?:a\s+)?project)/i

/** 动作标签是否命中受保护语义。 */
export function isPromaSelfControlActionLabelProtected(label: string): boolean {
  return PROMA_SELF_CONTROL_BLOCKED_ACTION_PATTERN.test(label)
}

export function isPromaSelfControlProjectCreationLabel(label: string): boolean {
  return PROMA_SELF_CONTROL_PROJECT_CREATION_PATTERN.test(label)
}

/** 注入页面上下文的检测函数：命中受保护容器或受保护动作标签。 */
export function buildPromaSelfControlProtectionFunction(): string {
  return `function isPromaSelfControlProtected(element) {
    if (!element) return false;
    let current = element.nodeType === 1 ? element : element.parentElement;
    while (current) {
      if (current.matches && current.matches(${JSON.stringify(PROMA_SELF_CONTROL_PROTECTED_SELECTOR)})) return true;
      if (current.matches && current.matches('button, [role="button"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="tab"], input[type="submit"]')) {
        const label = [current.getAttribute('aria-label'), current.innerText, current.value].filter(Boolean).join(' ');
        if (${PROMA_SELF_CONTROL_BLOCKED_ACTION_PATTERN.toString()}.test(label)) return true;
      }
      const root = current.getRootNode && current.getRootNode();
      current = current.parentElement || (root && root.host ? root.host : null);
    }
    return false;
  }`
}

/** 注入页面上下文的检测函数：判断元素是否位于「创建项目」入口内。 */
export function buildPromaSelfControlProjectCreationFunction(): string {
  return `function isPromaSelfControlProjectCreation(element) {
    if (!element) return false;
    let current = element.nodeType === 1 ? element : element.parentElement;
    while (current) {
      if (current.matches && current.matches(${JSON.stringify(PROMA_SELF_CONTROL_PROJECT_CREATION_SELECTOR)})) return true;
      if (current.matches && current.matches('button, [role="button"], [role="menuitem"], input[type="submit"]')) {
        const label = [current.getAttribute('aria-label'), current.getAttribute('title'), current.innerText, current.value].filter(Boolean).join(' ');
        if (${PROMA_SELF_CONTROL_PROJECT_CREATION_PATTERN.toString()}.test(label)) return true;
      }
      const root = current.getRootNode && current.getRootNode();
      current = current.parentElement || (root && root.host ? root.host : null);
    }
    return false;
  }`
}

interface PromaSelfControlDomGuard {
  protectionFunctionSource: string
  projectCreationFunctionSource: string
  errorMessage: string
}

/** DOM 操作的统一守卫配置。 */
export function createPromaSelfControlDomGuard(): PromaSelfControlDomGuard {
  return {
    protectionFunctionSource: buildPromaSelfControlProtectionFunction(),
    projectCreationFunctionSource: buildPromaSelfControlProjectCreationFunction(),
    errorMessage: PROMA_SELF_CONTROL_PROTECTED_ERROR,
  }
}
