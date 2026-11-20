/** Adapter output. Native payloads and private provider continuation stay outside core. */
type EventBase = { id: string; runId: string; threadId: string };
export type RuntimeEvent = EventBase &
  (
    | { type: 'turn.started'; turnId?: string }
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
    | { type: 'message.completed'; text: string }
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
    event.type !== 'progress'
  );
}
