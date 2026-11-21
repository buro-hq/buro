/** Adapter output. Native payloads and private provider continuation stay outside core. */
type EventBase = { id: string; runId: string; threadId: string };
export type RuntimeEvent = EventBase &
  (
    | { type: 'turn.started'; turnId?: string }
    | { type: 'segment.started'; turnId: string; segmentIndex: number }
    | {
        type: 'segment.completed';
        turnId: string;
        segmentIndex: number;
        reason: 'continue' | 'complete';
        workspaceFingerprint?: string;
      }
    | {
        type: 'turn.completed';
        turnId?: string;
        status: 'completed' | 'failed' | 'interrupted';
      }
    | {
        type: 'agent.activity';
        parentThreadId: string;
        completed: boolean;
        message?: string;
        /** Temporary metadata for legacy native children, never a permission grant. */
        legacyAssignment?: { path?: string; prompt?: string; name?: string };
      }
    /** Transient text only; completion and durable generation receipts are separate. */
    | { type: 'message.delta'; turnId: string; requestId: string; text: string }
    | { type: 'message.completed'; text: string }
    | { type: 'tool.started'; actionId: string; toolName: string }
    | { type: 'tool.completed'; actionId: string; toolName: string; isError: boolean }
    | { type: 'command.started'; commandId: string; command: string }
    | {
        type: 'command.completed';
        commandId: string;
        command: string;
        exitCode?: number | null;
        output: string;
      }
    | { type: 'progress' }
  );

export function recordableRuntimeEvent(event: RuntimeEvent) {
  return (
    !!event.runId &&
    !/^(setup-|result-|environment-)/.test(event.runId) &&
    event.type !== 'progress' &&
    event.type !== 'message.delta'
  );
}
