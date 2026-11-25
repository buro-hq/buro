import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../agent/providers/ollama.ts';
import { DeepSeekProvider } from '../agent/providers/deepseek.ts';
import { OpenAICompatibleProvider } from '../agent/providers/openai-compatible.ts';
import { RequestGate } from '../agent/providers/http.ts';
import { ProviderFailure } from '../agent/contracts/provider-errors.ts';
import type { ModelProvider, ModelStreamEvent } from '../agent/contracts/model.ts';

type Kind = 'ollama' | 'deepseek' | 'openai-compatible';
type Input = Parameters<ModelProvider['complete']>[0];
const privateReasoning = 'PRIVATE_PORTABLE_REASONING';
const encoder = new TextEncoder();
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const input = (extra: Partial<Input> = {}): Input => ({
  requestId: 'portable',
  model: 'fixture-model',
  messages: [{ role: 'user', content: 'Return a result.' }],
  tools: [],
  schema: null,
  contextTokens: 4096,
  maxOutputTokens: 128,
  signal: new AbortController().signal,
  onProgress() {},
  ...extra,
});
function provider(kind: Kind, fetch: typeof globalThis.fetch, gate?: RequestGate): ModelProvider {
  const options = {
    id: 'independent-consumer',
    revision: 'consumer-v1',
    local: true,
    endpoint: kind === 'ollama' ? 'http://127.0.0.1:11434' : 'https://provider.invalid/v1',
    fetch,
    gate,
  };
  if (kind === 'openai-compatible')
    return new OpenAICompatibleProvider(options);

  return kind === 'ollama'
    ? new OllamaProvider(options)
    : new DeepSeekProvider({
        ...options,
        apiKey: () => 'SYNTHETIC_PORTABLE_KEY',
      });
}
function textFrame(kind: Kind, text: string, reasoning = '') {
  return kind === 'ollama'
    ? JSON.stringify({
      model: 'reported-model',
      message: { role: 'assistant', content: text, thinking: reasoning },
      done: false,
    }) + '\n'
    : 'data: ' +
      JSON.stringify({
        model: 'reported-model',
        choices: [{ index: 0, delta: { content: text, reasoning_content: reasoning } }],
      }) +
      '\r\n\r\n';
}
function terminal(kind: Kind, usage = true, finish = 'stop') {
  return kind === 'ollama'
    ? JSON.stringify({
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: finish,
      ...(usage ? { prompt_eval_count: 3, eval_count: 2 } : {}),
    }) + '\n'
    : 'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
      }) +
      '\n\n' +
      (usage
        ? 'data: ' +
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }) +
        '\n\n'
        : '') +
        'data: [DONE]\n\n';
}
const outcome = (code: string, expected: ProviderFailure['outcome']) => (error: unknown) => {
  assert.ok(error instanceof ProviderFailure);
  assert.equal(error.code, code);
  assert.equal(error.outcome, expected);
  return true;
};

for (const kind of ['ollama', 'deepseek', 'openai-compatible'] as const) {
  test(
    `${kind}: actual UTF-8 stream deltas arrive before completion without exposing reasoning`,
    {
      timeout: 5000,
    },
    async (t) => {
      const ready = deferred();
      const firstText = deferred();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      let settled = false;
      const events: ModelStreamEvent[] = [];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      t.after(() => {
        try {
          stream.close();
        } catch {
          // The transport may already have closed the stream.
        }
      });
      const transport = provider(kind, async () => {
        ready.resolve();
        return new Response(body);
      });
      const completion = transport.complete(
        input({
          onEvent(event) {
            events.push(event);
            if (event.type === 'text.delta' && event.text)
              firstText.resolve();
          },
        }),
      );
      void completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await ready.promise;
      const first = encoder.encode(textFrame(kind, 'Пр', privateReasoning));
      for (let index = 0; index < first.length; index++)
        stream.enqueue(first.slice(index, index + 1));
      await firstText.promise;
      assert.equal(settled, false);
      assert.equal(
        events.some((event) => event.type === 'usage' || event.type === 'response.completed'),
        false,
      );
      stream.enqueue(encoder.encode(textFrame(kind, 'ивет') + terminal(kind)));
      stream.close();
      const result = await completion;
      assert.equal(result.message.content, 'Привет');
      assert.equal(result.model, 'reported-model');
      assert.equal(result.finish, 'stop');
      assert.deepEqual(result.usage, {
        inputTokens: 3,
        outputTokens: 2,
      });
      assert.equal(
        events
          .filter((event) => event.type === 'text.delta')
          .map((event) => event.text)
          .join(''),
        result.message.content,
      );
      assert.deepEqual(
        events.filter((event) => event.type !== 'text.delta'),
        [
          { type: 'usage', usage: result.usage },
          { type: 'response.completed', model: 'reported-model', finish: 'stop' },
        ],
      );
      assert.doesNotMatch(
        JSON.stringify(events),
        /PRIVATE_PORTABLE_REASONING|continuation|thinking|reasoning_content/,
      );
      assert.match(JSON.stringify(result.message.continuation), /PRIVATE_PORTABLE_REASONING/);
    },
  );

  test(`${kind}: lost terminal preserves provisional deltas but emits no usage or completion receipt`, async () => {
    const events: ModelStreamEvent[] = [];
    const transport = provider(
      kind,
      async () => new Response(textFrame(kind, 'Provisional', privateReasoning)),
    );
    await assert.rejects(
      transport.complete(input({
        onEvent: (event) => events.push(event),
      })),
      outcome('MODEL_STREAM_INTERRUPTED', 'unknown'),
    );
    assert.equal(
      events
        .filter((event) => event.type === 'text.delta')
        .map((event) => event.text)
        .join(''),
      'Provisional',
    );
    assert.equal(
      events.some((event) => event.type !== 'text.delta'),
      false,
    );
  });

  test(`${kind}: malformed terminal tool arguments never publish a normalized completion`, async () => {
    const events: ModelStreamEvent[] = [];
    const tool =
      kind === 'ollama'
        ? JSON.stringify({
          message: {
            role: 'assistant',
            tool_calls: [{ function: { index: 0, name: 'edit_file', arguments: '{"path":' } }],
          },
          done: false,
        }) + '\n'
        : 'data: ' +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      function: { name: 'edit_file', arguments: '{"path":' },
                    },
                  ],
                },
              },
            ],
          }) +
          '\n\n';
    const transport = provider(
      kind,
      async () =>
        new Response(
          textFrame(kind, 'Provisional') +
          tool +
          terminal(kind, true, kind === 'deepseek' ? 'tool_calls' : 'stop'),
        ),
    );
    await assert.rejects(
      transport.complete(input({
        onEvent: (event) => events.push(event),
      })),
      outcome('MODEL_INVALID_RESPONSE', 'unknown'),
    );
    assert.equal(
      events.some((event) => event.type === 'usage' || event.type === 'response.completed'),
      false,
    );
  });

  test(`${kind}: absent usage stays unknown and length remains incomplete despite a wire terminal`, async () => {
    const events: ModelStreamEvent[] = [];
    const transport = provider(
      kind,
      async () => new Response(textFrame(kind, 'Partial result') + terminal(kind, false, 'length')),
    );
    const result = await transport.complete(input({
      onEvent: (event) => events.push(event),
    }));
    assert.equal(result.finish, 'length');
    assert.equal(result.usage, undefined);
    assert.equal(
      events.some((event) => event.type === 'usage'),
      false,
    );
    assert.deepEqual(events.at(-1), {
      type: 'response.completed',
      model: 'reported-model',
      finish: 'length',
    });
  });

  test(`${kind}: throwing event observers cannot turn a completed generation into an unknown request`, async () => {
    let observations = 0;
    const transport = provider(
      kind,
      async () => new Response(textFrame(kind, 'Observed') + terminal(kind)),
    );
    const result = await transport.complete(
      input({
        onEvent() {
          observations++;
          throw Error('Consumer observer failed');
        },
      }),
    );
    assert.equal(result.message.content, 'Observed');
    assert.equal(result.finish, 'stop');
    assert.ok(observations >= 3);
  });

  test(`${kind}: an observer cannot rewrite observed usage or invoke ambient fetch`, async (t) => {
    const ambient = globalThis.fetch;
    let ambientRequests = 0;
    globalThis.fetch = async () => {
      ambientRequests++;
      throw Error('Ambient fetch must not be used');
    };
    t.after(() => {
      globalThis.fetch = ambient;
    });
    const transport = provider(
      kind,
      async () => new Response(textFrame(kind, 'Observed') + terminal(kind)),
    );
    const result = await transport.complete(
      input({
        onEvent(event) {
          if (event.type === 'usage')
            event.usage.inputTokens = 99999;
        },
      }),
    );
    assert.deepEqual(result.usage, {
      inputTokens: 3,
      outputTokens: 2,
    });
    assert.equal(ambientRequests, 0);
  });

  test(`${kind}: missing or invalid injected fetch fails before dispatch without using ambient fetch`, async (t) => {
    const ambient = globalThis.fetch;
    let ambientRequests = 0;
    globalThis.fetch = async () => {
      ambientRequests++;
      throw Error('No implicit networking');
    };
    t.after(() => {
      globalThis.fetch = ambient;
    });
    for (const invalid of [undefined, null, 42])
      await assert.rejects(
        provider(kind, invalid as never).complete(input()),
        outcome('INVALID_PROVIDER_CONFIGURATION', 'not-dispatched'),
      );
    assert.equal(ambientRequests, 0);
  });

  test(`${kind}: asynchronous observer failures cannot escape as unhandled rejections or change completion`, async (t) => {
    const unhandled: unknown[] = [];
    const observe = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', observe);
    t.after(() => {
      process.off('unhandledRejection', observe);
    });
    let progress = 0;
    let events = 0;
    const transport = provider(
      kind,
      async () => new Response(textFrame(kind, 'Observed') + terminal(kind)),
    );
    const result = await transport.complete(
      input({
        onProgress: async () => {
          progress++;
          throw Error('ASYNC_PROGRESS_OBSERVER');
        },
        onEvent: async () => {
          events++;
          throw Error('ASYNC_EVENT_OBSERVER');
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.finish, 'stop');
    assert.equal(result.message.content, 'Observed');
    assert.ok(progress > 0);
    assert.ok(events >= 3);
    assert.deepEqual(unhandled, []);
  });

  test(
    `${kind}: a reader failure after a visible delta remains unknown without a terminal event`,
    {
      timeout: 5000,
    },
    async () => {
      const firstText = deferred();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const events: ModelStreamEvent[] = [];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      const transport = provider(kind, async () => new Response(body));
      const completion = transport.complete(
        input({
          onEvent(event) {
            events.push(event);
            if (event.type === 'text.delta' && event.text)
              firstText.resolve();
          },
        }),
      );
      stream.enqueue(encoder.encode(textFrame(kind, 'Before disconnect')));
      await firstText.promise;
      stream.error(Error('Socket broke after an observed chunk'));
      await assert.rejects(completion, outcome('MODEL_STREAM_INTERRUPTED', 'unknown'));
      assert.equal(
        events.some((event) => event.type === 'usage' || event.type === 'response.completed'),
        false,
      );
    },
  );

  test(`${kind}: pre-abort and queued abort never dispatch a request or inherit an active request outcome`, async () => {
    const gate = new RequestGate(1);
    const active = deferred();
    const release = deferred<Response>();
    let requests = 0;
    const transport = provider(
      kind,
      async () => {
        requests++;
        active.resolve();
        return release.promise;
      },
      gate,
    );
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(
      transport.complete(input({
        signal: alreadyAborted.signal,
      })),
      outcome('MODEL_ABORTED', 'not-dispatched'),
    );
    assert.equal(requests, 0);
    const first = transport.complete(input());
    await active.promise;
    const queued = new AbortController();
    const second = transport.complete(input({
      requestId: 'queued',
      signal: queued.signal,
    }));
    queued.abort();
    await assert.rejects(second, outcome('MODEL_ABORTED', 'not-dispatched'));
    assert.equal(requests, 1);
    release.resolve(new Response(textFrame(kind, 'Completed active request') + terminal(kind)));
    assert.equal((await first).finish, 'stop');
  });

  test(`${kind}: negative HTTP, connection loss and post-dispatch cancellation have explicit distinct outcomes`, async () => {
    let requests = 0;
    const rejected = provider(kind, async () => {
      requests++;
      return new Response('Do not expose provider details', {
        status: 401,
      });
    });
    await assert.rejects(rejected.complete(input()), outcome('MODEL_AUTH_FAILED', 'rejected'));
    assert.equal(requests, 1, 'A negative response cannot silently retry');
    const lost = provider(kind, async () => {
      throw Error('Socket disappeared after dispatch');
    });
    await assert.rejects(lost.complete(input()), outcome('MODEL_UNAVAILABLE', 'unknown'));
    const cancelled = new AbortController();
    const aborted = provider(kind, async () => {
      cancelled.abort();
      throw new DOMException('Interrupted fetch', 'AbortError');
    });
    await assert.rejects(
      aborted.complete(input({
        signal: cancelled.signal,
      })),
      outcome('MODEL_ABORTED', 'unknown'),
    );
  });

  test(`${kind}: unserializable tool arguments fail before fetch and keep diagnostic causes private`, async () => {
    const cyclic: Record<string, unknown> = { private: 'PRIVATE_UNSERIALIZABLE_INPUT' };
    cyclic.self = cyclic;
    let requests = 0;
    const transport = provider(kind, async () => {
      requests++;
      throw Error('No dispatch expected');
    });
    for (const argumentsValue of [cyclic, 1n])
      await assert.rejects(
        transport.complete(
          input({
            messages: [
              {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'prior-call', name: 'edit_file', arguments: argumentsValue }],
              },
            ],
          }),
        ),
        (error: unknown) => {
          outcome('MODEL_INVALID_REQUEST', 'not-dispatched')(error);
          assert.ok(error instanceof ProviderFailure && error.cause instanceof Error);
          assert.doesNotMatch(
            String(error) + JSON.stringify(error),
            /PRIVATE_UNSERIALIZABLE_INPUT/,
          );
          return true;
        },
      );
    assert.equal(requests, 0);
  });
}

test('Ollama cannot promote an unknown or failed terminal reason to tools merely because complete calls were reconstructed', async () => {
  for (const reason of ['error', 'unknown-stop']) {
    const events: ModelStreamEvent[] = [];
    const call =
      JSON.stringify({
        message: {
          role: 'assistant',
          tool_calls: [
            { function: { index: 0, name: 'edit_file', arguments: { path: 'src/value.ts' } } },
          ],
        },
        done: false,
      }) + '\n';
    const transport = provider(
      'ollama',
      async () => new Response(call + terminal('ollama', true, reason)),
    );
    const result = await transport.complete(input({
      onEvent: (event) => events.push(event),
    }));
    assert.equal(result.message.toolCalls?.length, 1);
    assert.deepEqual(result.message.toolCalls?.[0].arguments, {
      path: 'src/value.ts',
    });
    assert.equal(result.finish, 'failed');
    assert.deepEqual(events.at(-1), {
      type: 'response.completed',
      model: 'fixture-model',
      finish: 'failed',
    });
  }
});

test('missing DeepSeek credentials are rejected before any generation fetch', async () => {
  let requests = 0;
  const transport = new DeepSeekProvider({
    id: 'standalone',
    revision: 'v1',
    local: false,
    endpoint: 'https://provider.invalid',
    apiKey: () => undefined,
    fetch: async () => {
      requests++;
      throw Error('No request expected');
    },
  });
  await assert.rejects(
    transport.complete(input()),
    outcome('MODEL_AUTH_REQUIRED', 'not-dispatched'),
  );
  assert.equal(requests, 0);
});

test('a failing credential callback is a private not-dispatched auth failure, not an unknown generation', async () => {
  const cause = Error('PRIVATE_CREDENTIAL_CALLBACK_SENTINEL');
  let requests = 0;
  const transport = new DeepSeekProvider({
    id: 'standalone',
    revision: 'v1',
    local: false,
    endpoint: 'https://provider.invalid',
    apiKey: () => {
      throw cause;
    },
    fetch: async () => {
      requests++;
      throw Error('No request expected');
    },
  });
  await assert.rejects(transport.complete(input()), (error: unknown) => {
    outcome('MODEL_AUTH_REQUIRED', 'not-dispatched')(error);
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.cause, cause);
    assert.doesNotMatch(
      String(error) + JSON.stringify(error),
      /PRIVATE_CREDENTIAL_CALLBACK_SENTINEL/,
    );
    return true;
  });
  assert.equal(requests, 0);
});

test('unserializable Ollama schema cannot become a dispatched generation', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let requests = 0;
  const transport = provider('ollama', async () => {
    requests++;
    throw Error('No request expected');
  });
  for (const schema of [cyclic, { invalid: 1n }])
    await assert.rejects(
      transport.complete(input({
        schema,
      })),
      outcome('MODEL_INVALID_REQUEST', 'not-dispatched'),
    );
  assert.equal(requests, 0);
});

test('a streamed provider error remains an unknown request outcome and keeps private details out of errors', async () => {
  const transport = provider(
    'deepseek',
    async () => new Response('data: {"error":{"message":"PRIVATE_PARTIAL_PROVIDER_DETAILS"}}\n\n'),
  );
  await assert.rejects(transport.complete(input()), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.outcome, 'unknown');
    assert.doesNotMatch(error.message, /PRIVATE_PARTIAL_PROVIDER_DETAILS/);
    return true;
  });
});
