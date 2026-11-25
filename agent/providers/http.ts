import { ProviderFailure, isProviderFailure } from '../contracts/provider-errors.ts';

const failure = (
  code: string,
  message: string,
  outcome: 'not-dispatched' | 'rejected' | 'unknown' = 'unknown',
) => new ProviderFailure(code, message, { outcome });
export function observer(callback: (() => void) | undefined) {
  if (!callback) return;
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Progress telemetry never controls the model request or its outcome.
  }
}
const aborted = (outcome: 'not-dispatched' | 'unknown') =>
  failure('MODEL_ABORTED', 'Interrupted', outcome);

export class RequestGate {
  private active = 0;
  private waiting: { grant: () => void; signal: AbortSignal }[] = [];
  constructor(privateCapacity: number) {
    if (!Number.isSafeInteger(privateCapacity) || privateCapacity < 1)
      throw failure(
        'INVALID_PROVIDER_CONFIGURATION',
        'Invalid endpoint capacity.',
        'not-dispatched',
      );
    this.capacity = privateCapacity;
  }
  private capacity: number;
  /** Apply a capacity change without dropping active work or queued cancellation handlers. */
  setCapacity(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw failure(
        'INVALID_PROVIDER_CONFIGURATION',
        'Invalid endpoint capacity.',
        'not-dispatched',
      );
    this.capacity = capacity;
    while (this.active < this.capacity && this.waiting.length) {
      const next = this.waiting.shift()!;
      if (!next.signal.aborted) next.grant();
    }
  }

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw aborted('not-dispatched');
    await new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        grant: () => {
          signal.removeEventListener('abort', abort);
          this.active++;
          resolve();
        },
      };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(aborted('not-dispatched'));
      };
      if (this.active < this.capacity) entry.grant();
      else {
        this.waiting.push(entry);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      if (signal.aborted) throw aborted('not-dispatched');
      return await action();
    } finally {
      this.active--;
      while (this.active < this.capacity && this.waiting.length) {
        const next = this.waiting.shift()!;
        if (!next.signal.aborted) next.grant();
      }
    }
  }
}

export interface RequestLimiter {
  run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T>;
}
export type HttpOptions = { endpoint: string; fetch: typeof fetch; gate?: RequestLimiter };
export function endpointURL(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  } catch {
    throw failure(
      'INVALID_ENDPOINT',
      'Use a valid HTTP(S) endpoint without embedded credentials.',
      'not-dispatched',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    endpoint.includes('?') ||
    endpoint.includes('#') ||
    endpoint.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]?.includes('@')
  )
    throw failure(
      'INVALID_ENDPOINT',
      'Use an HTTP(S) endpoint without embedded credentials, query or fragment.',
      'not-dispatched',
    );
  return url;
}
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function tokenCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function encodeJSON(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw Error();
    return result;
  } catch (cause) {
    throw new ProviderFailure(
      'MODEL_INVALID_REQUEST',
      'The model request is not JSON serializable.',
      { outcome: 'not-dispatched', cause },
    );
  }
}

export async function request(options: HttpOptions, route: string, init: RequestInit) {
  if (init.signal?.aborted) throw aborted('not-dispatched');
  if (typeof options.fetch !== 'function')
    throw failure(
      'INVALID_PROVIDER_CONFIGURATION',
      'An explicit fetch implementation is required.',
      'not-dispatched',
    );
  const url = new URL(route, endpointURL(options.endpoint));
  let response: Response;
  try {
    response = await options.fetch(url, {
      ...init,
      redirect: 'error',
    });
  } catch (error) {
    if (init.signal?.aborted) throw aborted('unknown');
    throw new ProviderFailure(
      'MODEL_UNAVAILABLE',
      'The configured model endpoint could not be reached.',
      { outcome: 'unknown', cause: error },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const codes: Record<number, string> = {
      400: 'MODEL_REQUEST_REJECTED',
      401: 'MODEL_AUTH_FAILED',
      402: 'MODEL_BILLING_BLOCKED',
      403: 'MODEL_AUTH_FAILED',
      404: 'MODEL_NOT_FOUND',
      429: 'MODEL_RATE_LIMITED',
    };
    throw failure(
      codes[response.status] || 'MODEL_UNAVAILABLE',
      `Model endpoint returned HTTP ${response.status}. No provider fallback was used.`,
      codes[response.status] ? 'rejected' : 'unknown',
    );
  }
  return response;
}

export async function* lines(response: Response, onProgress: () => void) {
  if (!response.body) throw failure('MODEL_INVALID_RESPONSE', 'The model response has no body.');
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw failure('MODEL_INVALID_RESPONSE', 'The model response body cannot be read.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (value?: Uint8Array, streaming = false) => {
    try {
      return decoder.decode(value, { stream: streaming });
    } catch {
      throw failure('MODEL_INVALID_RESPONSE', 'The endpoint returned invalid UTF-8.');
    }
  };
  let buffer = '',
    size = 0,
    finished = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        buffer += decode();
        break;
      }
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024)
        throw failure('MODEL_RESPONSE_LIMIT', 'The model response exceeds 4 MB.');
      observer(onProgress);
      buffer += decode(chunk.value, true);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
      }
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  } catch (error) {
    if (isProviderFailure(error)) {
      if (error.outcome === 'unknown') throw error;
      throw new ProviderFailure(error.code, error.message, { outcome: 'unknown', cause: error });
    }
    if (error instanceof DOMException && error.name === 'AbortError') throw aborted('unknown');
    throw new ProviderFailure(
      'MODEL_STREAM_INTERRUPTED',
      'The model response stream was interrupted.',
      { outcome: 'unknown', cause: error },
    );
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function json(response: Response) {
  let body = '';
  for await (const line of lines(response, () => {})) body += line + '\n';
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw failure('MODEL_INVALID_RESPONSE', 'The endpoint returned invalid JSON.');
  }
}
export function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw failure('MODEL_INVALID_RESPONSE', 'The model returned malformed JSON or tool arguments.');
  }
}
export async function* sse(response: Response, onProgress: () => void) {
  let data: string[] = [];
  for await (const line of lines(response, onProgress)) {
    if (!line) {
      if (data.length) yield data.join('\n');
      data = [];
    } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length) yield data.join('\n');
}
