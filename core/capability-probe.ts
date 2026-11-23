import { DomainError } from './ports.ts';
import type { ModelMessage, ModelProvider } from '../agent/contracts/model.ts';
export type ProbeResult = {
  runtimeId: string;
  configurationRevision: string;
  checkedAt: string;
  status: 'passed';
  tools: true;
  structured: true;
  reportedModel: string;
};
export type ProbeReceipt = {
  id: string;
  fingerprint: string;
  runtimeId: string;
  status: 'started' | 'completed' | 'failed';
  result?: ProbeResult;
  error?: { code: string; message: string };
};
export interface ProbeStore {
  loadRequest(id: string): Promise<ProbeReceipt | undefined>;
  saveRequest(receipt: ProbeReceipt): Promise<void>;
  saveResult(result: ProbeResult): Promise<void>;
}
export type ProbeBinding = {
  provider: ModelProvider;
  model: string;
  configurationRevision: string;
  contextTokens: number;
  maxOutputTokens: number;
};

/** A tiny diagnostic proves supported mechanics, not coding quality. Paid calls are explicit. */
export class CapabilityProbeService {
  private options: {
    binding: (runtimeId: string) => ProbeBinding;
    store: ProbeStore;
    now: () => string;
    id: () => string;
    timeoutMs?: number;
  };
  private jobs = new Map<
    string,
    {
      fingerprint: string;
      runtimeId: string;
      controller: AbortController;
      done: Promise<ProbeResult>;
    }
  >();
  private closed = false;
  constructor(options: CapabilityProbeService['options']) {
    this.options = options;
  }
  probe(id: string, fingerprint: string, runtimeId: string): Promise<ProbeResult> {
    if (this.closed)
      return Promise.reject(new DomainError('PROBE_UNAVAILABLE', 'Capability probing stopped.'));
    const existing = this.jobs.get(id);
    if (existing)
      return existing.fingerprint === fingerprint && existing.runtimeId === runtimeId
        ? existing.done
        : Promise.reject(
            new DomainError('IDEMPOTENCY_CONFLICT', 'This probe ID was used for another request.'),
          );
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(id, fingerprint, runtimeId, controller.signal))
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, { fingerprint, runtimeId, controller, done });
    return done;
  }
  private async execute(id: string, fingerprint: string, runtimeId: string, signal: AbortSignal) {
    const { store } = this.options;
    const receipt = await store.loadRequest(id);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint || receipt.runtimeId !== runtimeId)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'This probe ID was used for another request.',
        );
      if (receipt.status === 'completed' && receipt.result) return receipt.result;
      if (receipt.status === 'failed' && receipt.error)
        throw new DomainError(receipt.error.code, receipt.error.message);
      throw new DomainError(
        'PROBE_INTERRUPTED',
        'The earlier probe outcome is unknown. It will not be automatically repeated.',
      );
    }
    const binding = this.options.binding(runtimeId);
    const request: ProbeReceipt = { id, fingerprint, runtimeId, status: 'started' };
    await store.saveRequest(request);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(abort, this.options.timeoutMs || 120000);
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content:
          'Capability diagnostic. Call diagnostic_echo exactly once with value "buro-ready", then stop and wait for its result. Do not answer before calling the tool.',
      },
    ];
    const generate = (final = false) =>
      binding.provider.complete({
        requestId: 'probe-' + this.options.id(),
        model: binding.model,
        messages,
        tools: final
          ? []
          : [
              {
                name: 'diagnostic_echo',
                description: 'Read-only readiness diagnostic',
                parameters: {
                  type: 'object',
                  properties: { value: { type: 'string', enum: ['buro-ready'] } },
                  required: ['value'],
                  additionalProperties: false,
                },
              },
            ],
        schema: final
          ? {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            }
          : undefined,
        contextTokens: binding.contextTokens,
        maxOutputTokens: binding.maxOutputTokens,
        signal: controller.signal,
        onProgress() {},
      });
    try {
      controller.signal.throwIfAborted();
      const first = await generate(),
        calls = first.message.toolCalls || [];
      const argumentsObject = calls[0]?.arguments;
      if (
        first.finish !== 'tools' ||
        calls.length !== 1 ||
        calls[0].name !== 'diagnostic_echo' ||
        !argumentsObject ||
        typeof argumentsObject !== 'object' ||
        Array.isArray(argumentsObject) ||
        Object.keys(argumentsObject).length !== 1 ||
        (argumentsObject as { value?: unknown }).value !== 'buro-ready'
      )
        throw new DomainError(
          'MODEL_CAPABILITY_FAILED',
          'The model did not produce the required diagnostic tool call.',
        );
      messages.push(
        first.message,
        {
          role: 'tool',
          toolCallId: calls[0].id,
          toolName: calls[0].name,
          content: '{"value":"buro-ready"}',
        },
        {
          role: 'user',
          content:
            'The diagnostic tool result is available. Return only JSON {"ok":true}. Do not call tools again.',
        },
      );
      const second = await generate(true);
      controller.signal.throwIfAborted();
      let answer: unknown;
      try {
        answer = JSON.parse(second.message.content);
      } catch {}
      if (
        second.finish !== 'stop' ||
        second.message.toolCalls?.length ||
        !answer ||
        typeof answer !== 'object' ||
        Array.isArray(answer) ||
        Object.keys(answer).length !== 1 ||
        (answer as { ok?: unknown }).ok !== true
      )
        throw new DomainError(
          'MODEL_CAPABILITY_FAILED',
          'The model did not finish the structured diagnostic.',
        );
      const result: ProbeResult = {
        runtimeId,
        configurationRevision: binding.configurationRevision,
        checkedAt: this.options.now(),
        status: 'passed',
        tools: true,
        structured: true,
        reportedModel: second.model,
      };
      await store.saveResult(result);
      await store.saveRequest({ ...request, status: 'completed', result });
      return result;
    } catch (error) {
      const failure = controller.signal.aborted
        ? new DomainError('PROBE_INTERRUPTED', 'The capability probe was interrupted.')
        : error instanceof DomainError
          ? error
          : new DomainError('PROBE_FAILED', 'The model capability probe did not complete.');
      await store
        .saveRequest({
          ...request,
          status: 'failed',
          error: { code: failure.code, message: failure.message },
        })
        .catch(() => {});
      throw failure;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }
  async dispose() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }
}
