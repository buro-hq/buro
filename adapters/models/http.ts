import { DomainError } from '../../core/ports.ts';

export class RequestGate {
  private active = 0;
  private waiting: { grant: () => void; signal: AbortSignal }[] = [];
  constructor(privateCapacity: number) {
    if (!Number.isSafeInteger(privateCapacity) || privateCapacity < 1)
      throw Error('Invalid endpoint capacity.');
    this.capacity = privateCapacity;
  }
  private capacity: number;
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
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
        reject(new DOMException('Interrupted', 'AbortError'));
      };
      if (this.active < this.capacity) entry.grant();
      else {
        this.waiting.push(entry);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
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

export type HttpOptions = { endpoint: string; fetch?: typeof fetch; gate?: RequestGate };
export function endpointURL(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  } catch {
    throw new DomainError(
      'INVALID_ENDPOINT',
      'Use a valid HTTP(S) endpoint without embedded credentials.',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new DomainError(
      'INVALID_ENDPOINT',
      'Use an HTTP(S) endpoint without embedded credentials, query or fragment.',
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

export async function request(options: HttpOptions, route: string, init: RequestInit) {
  let response: Response;
  try {
    response = await (options.fetch || fetch)(new URL(route, endpointURL(options.endpoint)), {
      ...init,
      redirect: 'error',
    });
  } catch (error) {
    if (init.signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
    throw new DomainError(
      'MODEL_UNAVAILABLE',
      'The configured model endpoint could not be reached.',
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
    throw new DomainError(
      codes[response.status] || 'MODEL_UNAVAILABLE',
      `Model endpoint returned HTTP ${response.status}. No provider fallback was used.`,
    );
  }
  return response;
}

export async function* lines(response: Response, onProgress: () => void) {
  if (!response.body)
    throw new DomainError('MODEL_INVALID_RESPONSE', 'The model response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (value?: Uint8Array, streaming = false) => {
    try {
      return decoder.decode(value, { stream: streaming });
    } catch {
      throw new DomainError('MODEL_INVALID_RESPONSE', 'The endpoint returned invalid UTF-8.');
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
        throw new DomainError('MODEL_RESPONSE_LIMIT', 'The model response exceeds 4 MB.');
      onProgress();
      buffer += decode(chunk.value, true);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
      }
    }
    if (buffer) yield buffer.replace(/\r$/, '');
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
    throw new DomainError('MODEL_INVALID_RESPONSE', 'The endpoint returned invalid JSON.');
  }
}
export function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new DomainError(
      'MODEL_INVALID_RESPONSE',
      'The model returned malformed JSON or tool arguments.',
    );
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
