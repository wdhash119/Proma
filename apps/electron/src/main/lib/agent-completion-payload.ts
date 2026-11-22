import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentSendInput,
  AgentStreamCompletePayload,
} from '@proma/shared'

type AgentStreamCompletionDetails = Omit<
  AgentStreamCompletePayload,
  'sessionId' | 'triggeredBy'
>

interface AgentStreamCompleteTarget {
  send(channel: string, payload: AgentStreamCompletePayload): void
}

function buildAgentStreamCompletePayload(
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'> & { runGeneration?: number }>,
  details: AgentStreamCompletionDetails = {},
): AgentStreamCompletePayload {
  const { runGeneration, ...otherDetails } = details
  return {
    sessionId: run.sessionId,
    triggeredBy: run.triggeredBy,
    ...otherDetails,
    ...(runGeneration != null ? { runGeneration } : run.runGeneration != null ? { runGeneration: run.runGeneration } : {}),
  }
}

export function sendAgentStreamComplete(
  target: AgentStreamCompleteTarget,
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'> & { runGeneration?: number }>,
  details: AgentStreamCompletionDetails = {},
): void {
  target.send(
    AGENT_IPC_CHANNELS.STREAM_COMPLETE,
    buildAgentStreamCompletePayload(run, details),
  )
}
