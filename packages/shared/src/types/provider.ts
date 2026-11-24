/**
 * 供应商请求使用的通用消息类型
 *
 * 该类型只描述「发给模型的历史消息」需要的最小字段，
 * 不包含 Chat 时代的持久化专属字段（工具活动、上下文分隔线等）。
 */

/** 供应商消息角色 */
export type ProviderMessageRole = 'user' | 'assistant' | 'system'

/**
 * 传给供应商适配器的历史消息
 */
export interface ProviderMessage {
  /** 消息唯一标识 */
  id: string
  /** 发送者角色 */
  role: ProviderMessageRole
  /** 消息内容 */
  content: string
  /** 创建时间戳 */
  createdAt: number
  /** 使用的模型 ID（assistant 消息） */
  model?: string
  /** 推理内容（如果模型支持） */
  reasoning?: string
  /** 是否被用户中止 */
  stopped?: boolean
  /** 流式生成时遇到的错误信息 */
  error?: string
  /** 文件附件列表 */
  attachments?: import('./attachment').FileAttachment[]
}
