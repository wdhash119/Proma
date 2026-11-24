/**
 * 会话消息搜索（迷你地图定位）相关类型
 *
 * 与具体会话实现解耦：数据源只返回命中元数据，
 * 不向 UI 泄露完整历史正文。
 */

/** 搜索结果里的消息角色 */
export type SessionMessageSearchRole = 'user' | 'assistant' | 'system'

/**
 * 消息搜索结果
 */
export interface SessionMessageSearchResult {
  /** 消息 ID */
  messageId: string
  /** 消息角色 */
  role: SessionMessageSearchRole
  /** 匹配上下文片段，完整保留命中的查询文本 */
  snippet: string
  /** snippet 内匹配起始位置 */
  matchStart: number
  /** 匹配长度 */
  matchLength: number
}

export interface SessionMessageSearchResponse {
  /** 当前查询返回的最佳命中 */
  results: SessionMessageSearchResult[]
  /** 为防止主进程资源耗尽，是否只检索了当前会话的可索引前缀 */
  truncated: boolean
  /** 查询文本过长，已拒绝模糊匹配以保护事件循环 */
  queryTooLong: boolean
}
