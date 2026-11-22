/**
 * 工具展示的可复用函数和常量。
 * 供 SDK 内容块与工具行渲染复用。
 */

import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  Bot,
  CalendarClock,
  CalendarDays,
  CalendarX,
  ClipboardList,
  Database,
  Download,
  FilePenLine,
  FileText,
  FolderSearch,
  GitBranch,
  Globe,
  Code2,
  ImagePlus,
  MousePointer2,
  Layers,
  LoaderCircle,
  ListChecks,
  LogIn,
  LogOut,
  Map,
  MapPinOff,
  MessageCircleQuestion,
  OctagonX,
  Pencil,
  Plug,
  Radio,
  Search,
  Send,
  Server,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-react'

/** 工具名称到图标组件的映射 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  Edit: Pencil,
  Write: FilePenLine,
  Read: FileText,
  Bash: Terminal,
  Glob: FolderSearch,
  Grep: Search,
  Task: GitBranch,
  WebFetch: Download,
  WebSearch: Globe,
  NotebookEdit: BookOpen,
  Skill: Zap,
  TodoWrite: ListChecks,
  TodoRead: ClipboardList,
  Agent: Bot,
  EnterPlanMode: Map,
  ExitPlanMode: MapPinOff,
  generate_image: ImagePlus,
  TaskOutput: Layers,
  TaskStop: OctagonX,
  AskUserQuestion: MessageCircleQuestion,
  REPL: Terminal,
  Workflow: GitBranch,
  ScheduleWakeup: CalendarClock,
  Monitor: Radio,
  PushNotification: Send,
  CronCreate: CalendarClock,
  CronDelete: CalendarX,
  CronList: CalendarDays,
  RemoteTrigger: Radio,
  EnterWorktree: LogIn,
  ExitWorktree: LogOut,
  ReadMcpResourceTool: Database,
  ListMcpResourcesTool: Server,
  SendMessage: Send,
  BrowserObserve: Globe,
  BrowserFind: Search,
  BrowserNavigate: Globe,
  BrowserWaitFor: LoaderCircle,
  BrowserClick: Globe,
  BrowserAct: MousePointer2,
  BrowserFill: Globe,
  BrowserPress: Globe,
  BrowserHover: MousePointer2,
  BrowserDrag: MousePointer2,
  BrowserScroll: Globe,
  BrowserExtract: FileText,
  BrowserSelectOption: MousePointer2,
  BrowserUpload: FilePenLine,
  BrowserScreenshot: Globe,
  BrowserListTabs: Globe,
  BrowserNewTab: Globe,
  BrowserSelectTab: Globe,
  BrowserCloseTab: Globe,
  BrowserClose: Globe,
  BrowserPreviewOpen: Globe,
  BrowserDomAction: MousePointer2,
  BrowserExecuteJavaScript: Code2,
}

/**
 * 根据工具名称获取对应的图标组件
 * MCP 工具（mcp__serverName__toolName）使用 Plug 图标
 * 未匹配时返回默认的 Wrench 图标
 */
export function getToolIcon(toolName: string): LucideIcon {
  if (TOOL_ICONS[toolName]) return TOOL_ICONS[toolName]
  if (toolName.startsWith('mcp__')) return Plug
  return Wrench
}

/** 内置工具显示名称映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Edit: '编辑文件',
  Write: '写入文件',
  Read: '读取文件',
  Bash: '执行命令',
  Glob: '搜索文件',
  Grep: '搜索内容',
  Task: '任务工具',
  WebFetch: '抓取网页',
  WebSearch: '搜索网页',
  NotebookEdit: '编辑笔记本',
  Skill: '使用技能',
  TodoWrite: '更新待办',
  TodoRead: '阅读待办',
  Agent: 'Agent',
  EnterPlanMode: '正在生成计划',
  ExitPlanMode: '正在退出计划',
  generate_image: '生成图片',
  TaskOutput: '获取任务输出',
  TaskStop: '停止任务',
  AskUserQuestion: '等待用户输入',
  REPL: '执行 REPL',
  Workflow: '运行工作流',
  ScheduleWakeup: '安排唤醒',
  Monitor: '监控任务',
  PushNotification: '发送通知',
  CronCreate: '创建定时任务',
  CronDelete: '删除定时任务',
  CronList: '列出定时任务',
  RemoteTrigger: '远程触发器',
  EnterWorktree: '进入 Worktree',
  ExitWorktree: '退出 Worktree',
  ReadMcpResourceTool: '读取 MCP 资源',
  ListMcpResourcesTool: '列出 MCP 资源',
  SendMessage: '发送消息',
  BrowserObserve: '查看受管浏览器',
  BrowserFind: '语义定位网页元素',
  BrowserNavigate: '打开网页',
  BrowserWaitFor: '等待网页状态',
  BrowserClick: '点击网页元素',
  BrowserAct: '点击并等待网页状态',
  BrowserFill: '填写网页字段',
  BrowserPress: '按下浏览器按键',
  BrowserHover: '悬停网页元素',
  BrowserDrag: '拖拽网页元素',
  BrowserScroll: '滚动网页或容器',
  BrowserExtract: '抽取网页内容',
  BrowserSelectOption: '选择下拉选项',
  BrowserUpload: '选择网页上传文件',
  BrowserScreenshot: '截取网页',
  BrowserListTabs: '列出浏览器标签',
  BrowserNewTab: '新建浏览器标签',
  BrowserSelectTab: '切换浏览器标签',
  BrowserCloseTab: '关闭浏览器标签',
  BrowserClose: '关闭受管浏览器',
  BrowserPreviewOpen: '打开本地网页预览',
  BrowserDomAction: '操作网页 DOM',
  BrowserExecuteJavaScript: '执行网页 JavaScript',
}

/**
 * 获取工具的显示名称
 * MCP 工具解析为 "serverName / toolName" 格式
 * 内置工具返回中文名称，其余返回原始名称
 */
export function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName]
  // MCP 工具：mcp__serverName__toolName → "SERVERNAME / TOOLNAME"
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3 && parts[1]) {
    return `${parts[1].toUpperCase()} / ${parts.slice(2).join('_').toUpperCase()}`
  }
  return toolName
}

/**
 * 从工具输入参数中提取文件路径
 * 按优先级依次检查常见的路径字段名
 */
export function extractFilePath(
  input: Record<string, unknown>
): string | null {
  const value =
    input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
  if (typeof value === 'string') {
    return value
  }
  return null
}

/**
 * 计算 Edit 工具的差异统计（新增/删除行数）
 * 仅对 Edit 工具有效，其他工具返回 null
 */
export function computeDiffStats(
  toolName: string,
  input: Record<string, unknown>
): { additions: number; deletions: number } | null {
  if (toolName !== 'Edit') {
    return null
  }

  const oldString = input.old_string
  const newString = input.new_string

  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    return null
  }

  const oldLines = oldString ? oldString.split('\n').length : 0
  const newLines = newString ? newString.split('\n').length : 0

  return {
    additions: newLines,
    deletions: oldLines,
  }
}
