# Execution resources

Buro supports the native Codex client and managed sessions through Ollama or the DeepSeek model API. Managed sessions use Buro's repository tools, checkpoints, worker dispatch and independent acceptance. They do not require Codex to be installed.

The default remains Codex until a resource profile is selected. Connections and model settings live in the daemon's private data directory, normally `.buro/local/resources.json`. A connected project's shared profile can contain `resourceProfile`, referencing one of those private profiles. It never contains an API key.

## Configure a connection

Start the service, then inspect or create its configuration:

```sh
npm run cli -- resources init
npm run cli -- resources list
npm run cli -- resources models ollama
```

`init` returns the actual configuration path and preserves an existing file. With a custom `PROJECT_DATA_DIR`, the file is under that directory's `local/` folder. Ollama discovery lists already installed models and does not download any.

For local execution, add a managed runtime and profile to that file. This complete example keeps the existing Codex route available while selecting a local model for new work:

```json
{
  "version": 1,
  "defaultProfile": "local",
  "connections": [
    {
      "id": "ollama",
      "kind": "ollama",
      "endpoint": "http://127.0.0.1:11434",
      "capacity": 1,
      "think": false
    },
    {
      "id": "deepseek",
      "kind": "deepseek",
      "endpoint": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "capacity": 2
    }
  ],
  "runtimes": [
    { "id": "codex", "client": "codex" },
    {
      "id": "local-coder",
      "client": "managed",
      "connectionId": "ollama",
      "model": "qwen3:4b",
      "limits": {
        "contextTokens": 16384,
        "maxOutputTokens": 4096,
        "maxRequestsPerTurn": 12,
        "maxToolCallsPerTurn": 24,
        "maxSessionRequests": 100
      }
    }
  ],
  "profiles": [
    {
      "id": "local",
      "name": "Local team",
      "policy": "local-only",
      "coordinator": "local-coder",
      "worker": "local-coder",
      "reviewer": "local-coder"
    },
    {
      "id": "codex",
      "name": "Codex",
      "policy": "hybrid",
      "coordinator": "codex",
      "worker": "codex",
      "reviewer": "codex"
    }
  ]
}
```

Use an installed model ID returned by discovery. The model must support tool calling; its advertised context and thinking settings are checked. The Qwen3 example is an available tools/thinking model, not a guarantee of accepted coding quality. [Ollama model details](https://docs.ollama.com/api-reference/show-model-details), [Qwen3 4B](https://ollama.com/library/qwen3:4b).

Restart the daemon after changing connection or runtime definitions. This deliberately avoids replacing a client under an active session. Changing only the default through `resources use` takes effect for future runs without a restart:

```sh
npm run cli -- resources probe local-coder
npm run cli -- resources use local
```

The probe performs at most two small model generations with a diagnostic tool and no repository content. It checks tool/JSON mechanics, not coding quality. Retried command IDs reuse saved evidence; an interrupted probe is not silently repeated. Live probes are explicit and absent from `npm test`.

Qwen3 4B's initial live evaluation is not yet accepted for coding: one diagnostic passed, a planning response exhausted 2048 output tokens, and a later diagnostic produced duplicate tool requests. The 4096-token example is a configuration budget, not evidence that this model completes a verified goal. Buro reports these outcomes as failures and does not substitute a cloud model. See [implementation evidence](IMPLEMENTATION.md).

## Add DeepSeek and a mixed team

Provide the key through the daemon process environment named by `apiKeyEnv`, or the private `local/model-credentials.json` record under the daemon data directory. That file maps the same uppercase references to credentials, requires mode 0600 and must stay outside Git. Environment values take precedence. Restart the daemon after changing the file; credentials are loaded privately, without changing `process.env`. Shared configuration and resource DTOs contain only references/readiness, never keys. Inspect available model IDs:

```sh
npm run cli -- resources models deepseek
```

Add a managed runtime referencing `connectionId: "deepseek"` and a model ID returned by that command. Its `limits` use the same schema as the local runtime. A profile can then assign the DeepSeek runtime to coordinator/reviewer and `local-coder` to workers. For example, with a configured runtime ID `cloud-coder`:

```json
{
  "id": "hybrid",
  "name": "Local workers and DeepSeek review",
  "policy": "hybrid",
  "coordinator": "cloud-coder",
  "worker": "local-coder",
  "reviewer": "cloud-coder"
}
```

`local-only` rejects remote resources before starting a client. This Ollama adapter also rejects cloud-backed models; a failure never authorizes a remote fallback. `hybrid` explicitly permits the configured providers for that profile. DeepSeek uses its model API, not a separate harness. [DeepSeek API](https://api-docs.deepseek.com/), [tool/thinking continuation](https://api-docs.deepseek.com/guides/thinking_mode/).

## Automatic worker selection

A profile can authorize several configured runtimes for worker assignments through `workerPool`. For the hybrid example above, add:

```json
{
  "workerPool": ["local-coder", "cloud-coder"]
}
```

This is an additional field on the profile, not a separate configuration object. It must include the profile's default `worker`, contain unique configured runtime IDs, and have at most 16 entries. Local-only profiles reject remote entries before dispatch. Without `workerPool`, only the original default worker is authorized; upgrading does not silently give existing profiles a larger pool.

The coordinator sees this saved pool and can propose a runtime and short reason for each planned specialist. The service validates the proposal and the user's role preference before saving the plan. A global configured runtime is not automatically part of a project's pool. Adding or changing a runtime after a run starts does not expand that run's saved pool.

In **Team → Edit role → Specialist model**, choose:

- **Auto:** the coordinator can select from the pool; an omitted choice uses the profile worker.
- **Prefer:** use the selected runtime by default. Another permitted choice requires a reason. An unavailable preference uses the profile worker with an explicit saved explanation.
- **Only this model:** use exactly this runtime. A conflicting proposal or a pin outside the pool blocks the assignment; it does not cause fallback.

The preference is separate from persistent specialist instructions and creates a new role version. It applies to new plans. A choice made by the coordinator does not become a reusable role preference. The old free-form `Role.model` field remains historical metadata and is not interpreted as a runtime ID. Older clients omitting `runtimePreference` preserve an existing preference; explicit `auto` clears the pin.

Coordinator, reviewer and delivery roles continue to use the execution profile; worker preferences are not accepted for those service-owned roles. This increment chooses models for planned workers. Adaptive specialist creation during execution, automatic selection of the initial coordinator, measured quality/cost routing and goal-specific overrides remain future work.

Each accepted plan saves the canonical resource, configuration revision, role version, preference, selection source and reason. Worker dispatch saves its AgentSession before opening a client. Routing checks that recorded session against the saved decision and pool. The inspector shows the actual requested/reported model and the selection reason. Existing sessions continue on their recorded route; switching models requires another assignment rather than replacing provider state inside a conversation.

## Interface and inheritance

User settings show the default profile, its coordinator/worker/reviewer models, connection metadata, model discovery and explicit diagnostics. Project settings can pin a profile or inherit the machine default. The agent inspector displays the saved runtime/model identity rather than labelling every session Codex.

Each run freezes its profile, data policy and runtime configuration revisions. Buro handles identify sessions independently of native thread IDs. Restart or repair follows the saved route; changing the default does not move an existing session to another provider. If that runtime configuration has changed or disappeared, continuation stops with a configuration error. Restore it or start a new run. Historical Codex runs without resource snapshots require an explicitly remote-permitted profile for legacy continuation.

Environment discovery and result preparation reference their owning run explicitly, so they inherit its resources and material manifest. A manual managed repair saves a new scope revision for updated criteria/materials while retaining earlier evidence. Worker assignments cannot expand into the whole project during continuation.

## Supported execution boundary

Managed tools provide bounded text reads/search, exact edits in assigned paths, inspection of actual changes and exact configured check commands. Model-directed commands use native confinement, cannot read private Buro/client state and cannot use the network. Explicit environment setup/readiness recipes can use the network while retaining private-file restrictions. Acceptance checks remain service-owned.

Managed Docker execution currently fails closed because the existing native-client container does not provide the required private-data isolation. Native Codex Docker behavior remains available. Unsupported environments never fall back to an unconfined host command.

Checkpoints and routing references are private atomic records. Unknown tool/client-start outcomes remain stopped for reconciliation. Recovery does not promise automatic replay, exactly-once execution or transferable provider conversation state.
