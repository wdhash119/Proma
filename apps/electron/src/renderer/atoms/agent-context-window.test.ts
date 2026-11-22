import { describe, expect, test } from 'bun:test'
import { applyAgentEvent, type AgentStreamState } from './agent-atoms'

const MANUAL_CONTEXT_WINDOW = 262_144
const QWEN_INFERRED_CONTEXT_WINDOW = 1_000_000

describe('Agent 上下文窗口来源优先级', () => {
  test('Given Qwen 先显示推断 1M When 手动运行时值到达后又收到推断与 result Then 始终保持 262144', () => {
    const initial: AgentStreamState = {
      running: true,
      contextWindow: QWEN_INFERRED_CONTEXT_WINDOW,
      contextWindowSource: 'inferred',
    }

    const resolved = applyAgentEvent(initial, {
      type: 'usage_update',
      usage: {
        contextWindow: MANUAL_CONTEXT_WINDOW,
        contextWindowSource: 'runtime',
      },
    })
    expect(resolved.contextWindow).toBe(MANUAL_CONTEXT_WINDOW)
    expect(resolved.contextWindowSource).toBe('runtime')

    const afterAssistant = applyAgentEvent(resolved, {
      type: 'usage_update',
      usage: {
        inputTokens: 32_200,
        contextWindow: QWEN_INFERRED_CONTEXT_WINDOW,
        contextWindowSource: 'inferred',
      },
    })
    expect(afterAssistant.contextWindow).toBe(MANUAL_CONTEXT_WINDOW)

    const afterResult = applyAgentEvent(afterAssistant, {
      type: 'complete',
      usage: { contextWindow: QWEN_INFERRED_CONTEXT_WINDOW },
    })
    expect(afterResult.contextWindow).toBe(MANUAL_CONTEXT_WINDOW)
    expect(afterResult.contextWindowSource).toBe('runtime')
  })

  test('Given 只有模型名推断 When 收到更大值与运行时值 Then 保留旧有推断兜底且运行时值可向上或向下校正', () => {
    const initial: AgentStreamState = { running: true, contextWindow: 200_000 }
    const inferred = applyAgentEvent(initial, {
      type: 'usage_update',
      usage: { contextWindow: QWEN_INFERRED_CONTEXT_WINDOW },
    })
    expect(inferred.contextWindow).toBe(QWEN_INFERRED_CONTEXT_WINDOW)
    expect(inferred.contextWindowSource).toBe('inferred')

    const resolved = applyAgentEvent(inferred, {
      type: 'usage_update',
      usage: { contextWindow: 128_000, contextWindowSource: 'runtime' },
    })
    expect(resolved.contextWindow).toBe(128_000)

    const afterFallback = applyAgentEvent(resolved, {
      type: 'usage_update',
      usage: { contextWindow: QWEN_INFERRED_CONTEXT_WINDOW },
    })
    expect(afterFallback.contextWindow).toBe(128_000)
  })
})
