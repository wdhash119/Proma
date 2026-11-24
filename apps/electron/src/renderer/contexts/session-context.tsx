/**
 * Session Context — 为 AgentView 提供会话上下文
 *
 * 避免逐层 props 透传，子组件通过 useAgentSessionId() 获取当前会话。
 * Chat 模式退役后不再提供 conversationId 维度的上下文。
 */

// Conversation（Chat 模式）上下文已随 Chat 退役移除；此处保留会话上下文入口，
// 便于后续按 sessionId 维度扩展，而不必再区分两种会话类型。
export {}
