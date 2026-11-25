import { useState } from 'react';

/** A UI action can fail normally without losing the form or pretending its command was undone. */
export interface OperationOutcome<T = void> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** State belongs to the initiating feature, not a global command queue. */
export interface Operation {
  busy: boolean;
  error?: string;
  /** Runs exactly the requested action and returns its observed outcome. */
  perform<T>(work: () => Promise<OperationOutcome<T>>): Promise<OperationOutcome<T>>;
  /** Clears a dismissed local error. */
  clear(): void;
}

/** Captures action feedback without replaying failed mutations after reconnecting. */
export function useOperation(): Operation {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return {
    busy,
    error,
    clear: () => setError(undefined),
    async perform(work) {
      setBusy(true);
      setError(undefined);
      try {
        const result = await work();
        if (!result.ok)
          setError(result.error ?? 'The operation failed.');

        return result;
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
  };
}
