/**
 * 文件附件与原生文件对话框相关类型
 *
 * 附件只作为「一次性读入内存」或「工作区路径引用」使用，
 * 不再有 Chat 时代的对话附件持久化目录。
 */

// ===== 附件相关 =====

/** 附件文件大小上限：100MB */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

/** 文件附件 */
export interface FileAttachment {
  /** 附件唯一标识 */
  id: string
  /** 原始文件名 */
  filename: string
  /** MIME 类型 */
  mediaType: string
  /** 文件路径：Agent 工作区附件为绝对路径，历史 Chat 附件为相对路径 */
  localPath: string
  /** 文件大小（字节） */
  size: number
}

// ===== 文件选择对话框 =====

/** 文件选择对话框结果 */
export interface FileDialogResult {
  /** 已读取为 base64 的小文件列表 */
  files: FileDialogFile[]
  /** 超过内存导入上限的大文件，仅返回路径，供 Agent 作为附加文件引用 */
  largeFiles?: FileDialogLargeFile[]
  /** 无法读取或无法识别的文件 */
  skippedFiles?: FileDialogSkippedFile[]
}

export interface FileDialogFile {
  filename: string
  mediaType: string
  data: string
  size: number
}

export interface FileDialogLargeFile {
  filename: string
  mediaType: string
  size: number
  path: string
}

export interface FileDialogSkippedFile {
  filename: string
  mediaType?: string
  size?: number
  path?: string
  reason: 'unreadable'
  message?: string
}

/** Agent Composer 混合选择器中返回的目录；目录只授权访问，不作为消息附件复制。 */
export interface FileDialogDirectory {
  name: string
  path: string
}

/** 支持同时选择文件与文件夹的 Agent Composer 选择结果。 */
export interface FileOrFolderDialogResult extends FileDialogResult {
  directories: FileDialogDirectory[]
}
