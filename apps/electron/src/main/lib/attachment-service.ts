/**
 * 附件读取与文件选择服务
 *
 * 只保留通用能力：
 * - 读取：本机文件 → base64 编码（Agent 图片回传模型、附件打开）
 * - 文件选择对话框：Electron dialog → 小文件读取为 base64，大文件返回本地路径引用
 *
 * Agent 附件由会话目录授权管理，这里不再保存或删除任何文件。
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, basename, join, isAbsolute, normalize, relative } from 'node:path'
import { dialog, BrowserWindow } from 'electron'
import { getConfigDir } from './config-paths'
import type {
  FileDialogResult,
  FileDialogFile,
  FileDialogLargeFile,
  FileDialogSkippedFile,
  FileDialogDirectory,
  FileOrFolderDialogResult,
} from '@proma/shared'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'

/**
 * 历史 Chat 附件相对路径的解析前缀。
 *
 * 仅做纯路径计算：不创建目录、不写入文件，二进制文件缺失时按「附件不存在」报错。
 */
const LEGACY_CHAT_ATTACHMENTS_DIRNAME = 'attachments'

/** 支持的图片 MIME 类型 */
const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/** 扩展名 → MIME 类型映射 */
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.dot': 'application/msword',
  '.wps': 'application/vnd.ms-works',
  '.wpt': 'application/vnd.ms-works',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.dotm': 'application/vnd.ms-word.template.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.xlt': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  '.xltm': 'application/vnd.ms-excel.template.macroEnabled.12',
  '.et': 'application/vnd.ms-excel',
  '.ett': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pot': 'application/vnd.ms-powerpoint',
  '.pps': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  '.potm': 'application/vnd.ms-powerpoint.template.macroEnabled.12',
  '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
  '.dps': 'application/vnd.ms-powerpoint',
  '.dpt': 'application/vnd.ms-powerpoint',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
}

/** 文件选择对话框支持的过滤器 */
const FILE_FILTERS = [
  {
    name: '支持的文件',
    extensions: [
      'png', 'jpg', 'jpeg', 'gif', 'webp',
      'pdf', 'txt', 'md', 'json', 'csv', 'xml', 'html',
      'doc', 'dot', 'docx', 'docm', 'dotx', 'dotm', 'wps', 'wpt', 'rtf',
      'xls', 'xlt', 'xlsx', 'xlsm', 'xltx', 'xltm', 'et', 'ett',
      'ppt', 'pot', 'pps', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'dps', 'dpt',
      'odt', 'odp', 'ods',
    ],
  },
  {
    name: '所有文件',
    extensions: ['*'],
  },
]

/**
 * 判断是否为图片附件
 */
export function isImageAttachment(mediaType: string): boolean {
  return IMAGE_MIME_TYPES.has(mediaType)
}

/**
 * 根据扩展名获取 MIME 类型
 */
function getMimeType(ext: string): string {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return MIME_MAP[normalized] || 'application/octet-stream'
}

/**
 * 读取附件并返回 base64 编码
 *
 * 支持两种路径格式：
 * 1. 绝对路径（Agent 会话附件）→ 需在 ~/.proma/ 目录下，直接读取
 * 2. 历史 Chat 相对路径 {conversationId}/{uuid}.ext → 按 ~/.proma/attachments/ 只读推算，
 *    不创建目录也不写入；文件已不存在时按缺失处理
 *
 * @param localPath 相对路径或绝对路径
 * @returns base64 编码的文件数据
 */
export function readAttachmentAsBase64(localPath: string): string {
  let fullPath: string

  if (isAbsolute(localPath)) {
    // 绝对路径：验证在 ~/.proma/ 目录下，防止路径穿越
    const configDir = getConfigDir()
    const normalized = normalize(localPath)
    if (!normalized.startsWith(configDir)) {
      throw new Error(`附件路径不在安全目录内: ${localPath}`)
    }
    fullPath = normalized
  } else {
    // 历史相对路径仅做纯路径推算：不建目录、不写文件，并保证不越出历史附件根。
    const legacyRoot = join(getConfigDir(), LEGACY_CHAT_ATTACHMENTS_DIRNAME)
    const candidate = normalize(join(legacyRoot, localPath))
    if (relative(legacyRoot, candidate).startsWith('..')) {
      throw new Error(`附件路径不在安全目录内: ${localPath}`)
    }
    fullPath = candidate
  }

  if (!existsSync(fullPath)) {
    throw new Error(`附件文件不存在: ${localPath}`)
  }

  const buffer = readFileSync(fullPath)
  return buffer.toString('base64')
}

function readDialogFiles(
  filePaths: string[],
  directories?: FileDialogDirectory[],
): FileDialogResult {
  const files: FileDialogFile[] = []
  const largeFiles: FileDialogLargeFile[] = []
  const skippedFiles: FileDialogSkippedFile[] = []

  for (const filePath of filePaths) {
    const filename = basename(filePath)
    const ext = extname(filePath)
    const mediaType = getMimeType(ext)

    let fileSize: number
    try {
      const fileStat = statSync(filePath)
      if (directories && fileStat.isDirectory()) {
        directories.push({ name: filename || 'folder', path: filePath })
        continue
      }
      if (!fileStat.isFile()) {
        skippedFiles.push({
          filename,
          mediaType,
          path: filePath,
          reason: 'unreadable',
          message: '不是普通文件',
        })
        continue
      }
      fileSize = fileStat.size
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法获取文件大小'
      console.warn(`[附件服务] 无法获取文件大小，跳过: ${filePath}`, error)
      skippedFiles.push({ filename, mediaType, path: filePath, reason: 'unreadable', message })
      continue
    }

    if (fileSize > MAX_ATTACHMENT_SIZE) {
      largeFiles.push({
        filename,
        mediaType,
        size: fileSize,
        path: filePath,
      })
      continue
    }

    try {
      const buffer = readFileSync(filePath)
      files.push({
        filename,
        mediaType,
        data: buffer.toString('base64'),
        size: buffer.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件失败'
      console.warn(`[附件服务] 读取文件失败，跳过: ${filePath}`, error)
      skippedFiles.push({ filename, mediaType, size: fileSize, path: filePath, reason: 'unreadable', message })
    }
  }

  return {
    files,
    ...(largeFiles.length > 0 && { largeFiles }),
    ...(skippedFiles.length > 0 && { skippedFiles }),
  }
}

/**
 * 打开文件选择对话框
 *
 * 弹出 Electron 文件选择对话框，支持多选，
 * 读取选中的小文件并返回 base64 编码数据；超过内存导入上限的大文件仅返回路径。
 *
 * @returns 选中的文件列表
 */
export async function openFileDialog(): Promise<FileDialogResult> {
  // macOS 上必须传入父窗口，否则对话框可能出现在应用窗口后面
  const parentWindow = BrowserWindow.getFocusedWindow()
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: FILE_FILTERS,
  }

  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return { files: [] }
  }

  const fileResult = readDialogFiles(result.filePaths)
  console.log(`[附件服务] 文件对话框选择了 ${fileResult.files.length} 个内存附件，${fileResult.largeFiles?.length ?? 0} 个大文件引用，${fileResult.skippedFiles?.length ?? 0} 个跳过`)
  return fileResult
}

/**
 * 打开 Agent Composer 的混合选择对话框。
 * 文件按附件语义读取，文件夹只返回路径，交由会话目录授权流程处理。
 */
export async function openFileOrFolderDialog(): Promise<FileOrFolderDialogResult> {
  const parentWindow = BrowserWindow.getFocusedWindow()
  let dialogOptions: Electron.OpenDialogOptions

  if (process.platform === 'win32' || process.platform === 'linux') {
    const choiceOptions: Electron.MessageBoxOptions = {
      type: 'question',
      title: '附加文件或文件夹',
      message: '请选择要附加的内容类型',
      buttons: ['文件', '文件夹', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const choice = parentWindow
      ? await dialog.showMessageBox(parentWindow, choiceOptions)
      : await dialog.showMessageBox(choiceOptions)
    if (choice.response === 2) return { files: [], directories: [] }

    dialogOptions = choice.response === 0
      ? { properties: ['openFile', 'multiSelections'], filters: FILE_FILTERS, title: '附加文件' }
      : { properties: ['openDirectory', 'multiSelections'], title: '附加文件夹' }
  } else {
    dialogOptions = {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      title: '附加文件或文件夹',
    }
  }

  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return { files: [], directories: [] }
  }

  const directories: FileDialogDirectory[] = []
  const fileResult = readDialogFiles(result.filePaths, directories)
  console.log(`[附件服务] 混合对话框选择了 ${fileResult.files.length} 个内存附件，${fileResult.largeFiles?.length ?? 0} 个大文件引用，${directories.length} 个目录，${fileResult.skippedFiles?.length ?? 0} 个跳过`)
  return { ...fileResult, directories }
}
