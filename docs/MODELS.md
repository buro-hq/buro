# Model connections

Add connections in **Models**, or call `models.save` through the CLI/API. Connections are application-wide. A run can override the default model, and a session can select another model for its next request without losing shared history.

```json
{
  "configuration": {
    "name": "Local thinking model",
    "transport": "openai-compatible",
    "endpoint": "http://192.168.1.50:18081/v1",
    "model": "YOUR_MODEL_ID",
    "local": true,
    "thinking": true,
    "contextTokens": 32768,
    "outputTokens": 8192
  },
  "apiKey": "YOUR_PRIVATE_KEY",
  "default": true
}
```

Keep a real key in a private file and pass its path with `npm run cli -- models.save @connection.json`. It is not returned by `models.list`. Omit `apiKey` when updating a saved connection to retain its key; send `null` to remove it.

| Transport           | Endpoint and behavior                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `openai-compatible` | OpenAI style `/models` and `/chat/completions`; local endpoints receive chat template thinking settings      |
| `ollama`            | Native Ollama API and its `think` setting                                                                    |
| `deepseek`          | Chat completions with the explicit `thinking` field, enabled by default                                      |
| `codex`             | Installed native app-server, existing login or a configured key, portable Buro history and common host tools |

`models.discover` queries available IDs from a draft or saved connection without saving a placeholder or starting inference. A missing catalogue does not prevent entering an ID directly. Selecting a model does not trigger a readiness or coding test.

Thinking controls depend on the endpoint and model. `reasoningEffort` and `reasoningBudgetTokens` are explicit provider settings; a generic OpenAI style endpoint has no universal thinking switch. Local chat template flags, Ollama `think` and DeepSeek `thinking` use their own protocols. Check the requested model's actual behavior when comparing quality.

`capacity` controls concurrent requests to a connection. Defaults are conservative for a local model and allow parallel cloud/native requests. Context and output allowances are explicit; context must leave room for the requested output. Saved history is retained when its request view is reduced to fit context.

`ModelTransport` implementations register through application composition and appear in the interface through `models.transports`. Backends, sessions and tools do not route by role name, parameter count or a particular model family.

`retries` controls safe HTTP generation retries for interrupted streams or temporary endpoint failures; the default is two retries with short backoff. Set it to `0` to disable them. Authentication, billing and invalid requests are not retried. Tool effects run only after a complete validated response, and native backend tool execution is not replayed by this HTTP adapter. Pending retries stop immediately when the session is cancelled.
