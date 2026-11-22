# Execution resources

Buro supports the native Codex client and managed sessions through Ollama or the DeepSeek model API. Managed sessions use Buro's repository tools, checkpoints, worker dispatch and independent acceptance. They do not require Codex to be installed.

The self-hosted GPU route uses the Ollama HTTP API directly on a Windows RTX host, with an explicitly trusted private-network endpoint; Buro does not manage or require SSH tunnels. The Mac retains repositories, tools and checks. See [remote Ollama setup and measured evidence](REMOTE-OLLAMA.md). The local machine has optional `rtx-local` / `rtx-hybrid` profiles; model connections and runtimes load at daemon startup. The original machine default is preserved.

The default remains Codex until a resource profile is selected. Connections and model settings live in the daemon's private data directory, normally `.buro/local/resources.json`. A connected project's shared profile can contain `resourceProfile`, referencing one of those private profiles. It never contains an API key.

Managed model calls within a goal also share a durable budget, independent of per-session caps. The default reserves 64 generations, 131,072 output tokens and 256 tool calls, including a protected review allowance of 8 generations / 16,384 output tokens / 32 tools. `profile.managedBudget` can configure these values for new runs. Existing runs keep their original policy and charges when continued, even with current project settings. Budget accounting covers managed APIs, not native clients' hidden requests or currency costs. A blocked usage record requires a new run; low/missing usage never refunds reservations.

## Configure a connection

In **Settings → Execution resources → Models and connections**, use **Add API connection** or **Edit**. Installed provider descriptors supply the available choices. Ollama and DeepSeek have dedicated editors; other installed providers use a bounded advanced JSON configuration editor. The service validates every provider configuration. DeepSeek takes an environment-variable reference, not the API key itself. Existing connection IDs and provider registrations are fixed in the form; add another connection to represent a different provider.

API endpoints must use HTTP(S), with no embedded credentials, query or fragment. DeepSeek requires HTTPS except for exact `localhost`, `127.0.0.1` or `[::1]` development endpoints. Ollama trust is explicit:

- `auto` (the compatible default): only loopback endpoints are local; a LAN endpoint remains remote.
- `private-network`: the user declares a self-hosted service at a literal RFC1918/loopback IPv4 or IPv6 ULA/loopback address. DNS names and public IPs are rejected. This permits the service in `local-only` profiles.
- `external`: treat the endpoint as remote, including a loopback address.

Trust describes the configured service boundary. It does not download a model, test connectivity or authorize cloud-backed Ollama models.

Saving a connection requires a Buro service restart to apply it. The interface shows the saved address, active API address and **Restart required** badge. New work using a changed connection, model discovery and diagnostics are blocked until restart; work already owned by the current service retains its active provider. Saving never silently replaces a provider under a running conversation. After restart, an old run whose frozen resource revision no longer matches stops with a configuration error rather than moving to the new endpoint.

Every saved connection has its own revision. Edits must submit that revision; creating an ID requires a null revision. A stale edit asks the user to reload settings, and repeated command IDs reuse their saved receipt. External changes to the private configuration are rejected until the service reloads them. Adding a connection configures only its API settings: installed models, runtimes and execution profiles are separate steps.

## Add a model and team through the interface

For an active connection, choose **Available models → Use in team**. The form creates a new execution profile and, if needed, its managed model runtime without editing JSON. Review the profile name/ID, coordinator, primary worker, independent reviewer and allowed alternative workers. The primary worker is always included in its pool. Local-only rejects resources outside the trusted local boundary; Hybrid explicitly permits only the selected configured routes. The form starts from the actual current profile, never invents a cloud coordinator or changes the default by itself.

Existing model configurations are reused. New model configurations use the installed backend’s server-authored defaults unless an existing configured instance supplies its saved settings; advanced limits are editable. No model is downloaded, generated or probed when opening/saving the form. Discovery is explicit, and its displayed model list is tied to the connection revision so results from an old endpoint do not reappear after reconnect.

Saving atomically adds new IDs only and shows the profile as pending. Restart Buro, explicitly choose the new default or project override, then optionally run the model diagnostic. Existing project overrides, role preferences, defaults and frozen sessions stay intact. After selecting the profile for a project, **Team → Specialist model** offers its authorized pool. A completely new endpoint currently needs a restart before discovery and another after creating its model/profile; there is no hidden hot replacement of an executing client.

The same shared API is `resources.setup.save` with `{ expectedRevision, runtimes, profile }`. `expectedRevision` is `configurationRevision` from `resources list`; it covers semantic settings and excludes command receipts/private credentials. `runtimes` contains zero to eight new registered backend definitions; `profile` names existing/new runtime IDs. Existing IDs cannot be overwritten, and failures leave no partial model/profile. Active `profiles`/`runtimes` remain separate from `configured` pending definitions. Server guards reject selecting/probing pending definitions before cached receipts or provider lookup, including concurrent queued edits. CLI: `npm run cli -- resources setup-save /path/to/setup.json`.

## Installed contributions

Connections use `{id, provider, config}` and runtimes use `{id, backend, config}`. Provider and backend IDs name trusted installed service registrations, not executable code or an import path. The service validates configuration with the registered parser; the CLI only validates this generic envelope. A third installed contribution uses the same configuration path as the builtins. Unregistered IDs fail validation.

The factory catalog is sealed at service startup. Installing, updating or removing a contribution requires a restart; running sessions retain their frozen backend/provider revisions and grants. Configuration and model output cannot register code or claim capabilities. Plugin disposal and partial-startup cleanup remain service-owned.

Use **Add execution backend** for a registered backend without a model-discovery flow. Its advanced editor accepts only a JSON object, and saving creates a separate execution profile. Settings do not execute a model or diagnostic. Providers without model listing show that limitation instead of an unusable discovery button.

## Native instances and capabilities

Runtime IDs identify configured instances. Several definitions can use `backend: "codex"` with different IDs and optional `config.model` and `config.reasoningEffort`; their sessions and external thread IDs remain separate. A managed runtime can also use the ID `codex`. Its `backend` registration still selects the managed adapter; instance names never choose execution mechanics. Native instances share the host-configured executable/launcher and may override its model/reasoning defaults. Leaving the model unspecified records no guessed model identity.

The service publishes each registered backend's explicit, versioned capabilities with its resource metadata. Saved sessions must match that trusted descriptor and configuration before another operation. Metadata supplied by a model cannot enable tools-free turns, immutable review or cancellation. Native tools-free turns, host-owned tool hooks and strict planned-write prevention remain unavailable. The managed broker supports strict writes through its bounded source tools; strict sessions cannot execute agent commands or intermediate checks against mutable source. Final isolated acceptance checks and fresh review still run.

Planning uses tools-free structured turns when supported, otherwise a read-only inspection session. After an inspection plan is accepted, a separate writable session receives the full goal and accepted plan. A backend without thread resumption can continue through a fresh session in the saved workspace with the frozen role instructions; this does not replay an unknown operation. An unresolved operation from another run of the same goal also blocks new/continued execution.

Stop and cleanup retain the original owned session even after its execution permission is revoked. A released session needs explicit resume before another turn. Missing historical routes never manufacture a Codex session. This record format requires capabilities and admission requirements; the controlled archive/cutover for older prototype execution state is tracked in [implementation progress](IMPLEMENTATION-PROGRESS-2026-11-21.md).

Project profiles store file policy in `scope`, with `mode`, `plannedPaths` and `protectedPaths`. New projects start with advisory mode and no required advance file list. The strict checkbox requires a nonempty selection and an eligible backend, including the coordinator when it implements work. A file selection cannot expand from an exact file to a whole directory through a slash alias. Service metadata, protected paths and check-configuration integrity remain separate from this planning preference. Explicit continuation can adopt a revised user profile after prior operations settle; it cannot erase an unknown action.

For CLI setup, inspect or create the private configuration:

```sh
npm run cli -- resources init
npm run cli -- resources list
npm run cli -- resources models ollama
```

`init` returns the actual configuration path and preserves an existing file. With a custom `PROJECT_DATA_DIR`, the file is under that directory's `local/` folder. Ollama discovery lists already installed models and does not download any.

The CLI can save the same connection contract from a JSON file:

```sh
npm run cli -- resources connection-save /path/to/connection.json
npm run cli -- resources connection-save /path/to/connection.json REVISION_FROM_RESOURCES_LIST
```

Omit the revision only for a new ID; editing uses that connection's `revision` from `resources list`. The file contains one connection, not the entire configuration. For example, an RTX connection can use:

```json
{
  "id": "ollama-rtx",
  "provider": "ollama",
  "config": {
    "endpoint": "http://192.168.50.10:11434",
    "trust": "private-network",
    "capacity": 1,
    "think": false
  }
}
```

For local execution, add a managed runtime and profile to the private configuration file. This complete example keeps the existing Codex route available while selecting a local model for new work:

```json
{
  "version": 1,
  "defaultProfile": "local",
  "connections": [
    {
      "id": "ollama",
      "provider": "ollama",
      "config": {
        "endpoint": "http://127.0.0.1:11434",
        "trust": "auto",
        "capacity": 1,
        "think": false
      }
    },
    {
      "id": "deepseek",
      "provider": "deepseek",
      "config": {
        "endpoint": "https://api.deepseek.com",
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "capacity": 2
      }
    }
  ],
  "runtimes": [
    {
      "id": "codex",
      "backend": "codex",
      "config": {}
    },
    {
      "id": "local-coder",
      "backend": "managed",
      "config": {
        "connectionId": "ollama",
        "model": "qwen3:4b-instruct-2507-q4_K_M",
        "limits": {
          "contextTokens": 16384,
          "maxOutputTokens": 4096,
          "maxRequestsPerTurn": 12,
          "maxToolCallsPerTurn": 24,
          "maxSessionRequests": 100
        }
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

Use an installed model ID returned by discovery. The model must support tool calling; its advertised context and thinking settings are checked. The explicit 4B Instruct example avoids relying on the mutable `qwen3:4b` thinking-model alias. Its bounded mixed synthetic trial passed with DeepSeek coordination/review; this is not a guarantee of accepted project changes. [Ollama model details](https://docs.ollama.com/api-reference/show-model-details), [Qwen3 variants](https://ollama.com/library/qwen3/tags).

Restart the daemon after changing connection or runtime definitions. This deliberately avoids replacing a client under an active session. Changing only the default through `resources use` takes effect for future runs without a restart:

```sh
npm run cli -- resources probe local-coder
npm run cli -- resources use local
```

The probe performs at most two small model generations with a diagnostic tool and no repository content. It checks tool/JSON mechanics, not coding quality. Retried command IDs reuse saved evidence; an interrupted probe is not silently repeated. Live probes are explicit and absent from `npm test`.

[Private-project evaluation details removed.]

## Add DeepSeek and a mixed team

Provide the key through the daemon process environment named by `apiKeyEnv`, or the private `local/model-credentials.json` record under the daemon data directory. That file maps the same uppercase references to credentials, requires mode 0600 and must stay outside Git. Environment values take precedence. Restart the daemon after changing the file; credentials are loaded privately, without changing `process.env`. Shared configuration and resource DTOs contain only references/readiness, never keys. Inspect available model IDs:

```sh
npm run cli -- resources models deepseek
```

Add a `backend: "managed"` runtime whose config references `connectionId: "deepseek"` and a model ID returned by that command. Its `config.limits` use the same schema as the local runtime. A profile can then assign the DeepSeek runtime to coordinator/reviewer and `local-coder` to workers. For example, with a configured runtime ID `cloud-coder`:

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

## Role and assignment selection

A profile can authorize several configured runtimes for worker assignments through `workerPool`. For the hybrid example above, add:

```json
{
  "workerPool": ["local-coder", "cloud-coder"]
}
```

This is an additional field on the profile, not a separate configuration object. It must include the profile's default `worker`, contain unique configured runtime IDs, and have at most 16 entries. The authorized role pool is the unique union of the saved coordinator, worker, reviewer and these alternatives. Local-only rejects remote entries before dispatch. A role choice never adds another endpoint or an arbitrary globally configured runtime.

The coordinator sees this saved pool and can propose a runtime and short reason for each planned specialist. The service validates the proposal and the user's role preference before saving the plan. A global configured runtime is not automatically part of a project's pool. Adding or changing a runtime after a run starts does not expand that run's saved pool.

In **Team → Edit role → Specialist model**, choose:

- **Auto:** use the eligible profile default for the operation, or an eligible alternative with a saved explanation. The coordinator can propose a worker assignment from the same authorized pool.
- **Prefer:** use the selected eligible runtime by default. A coordinator deviation requires a reason. An unavailable preference permits an eligible profile/default alternative with an explicit saved explanation.
- **Only this model:** use exactly this runtime. A conflicting proposal or a pin outside the pool blocks the assignment; it does not cause fallback.

The preference is separate from persistent specialist instructions and creates a new role version. It applies to new plans. A choice made by the coordinator does not become a reusable role preference. The old free-form `Role.model` field remains historical metadata and is not interpreted as a runtime ID. Older clients omitting `runtimePreference` preserve an existing preference; explicit `auto` clears the pin.

The same preferences apply to coordinator, reviewer and operational roles. New runs save coordinator/reviewer role versions and decisions before the first session; operational preparation freezes its actual role/decision before dispatch. Eligibility follows operation capabilities rather than role kind or client name. Adaptive specialist creation during execution and measured quality/cost routing remain future work.

Each accepted plan saves the canonical resource, configuration revision, role version, preference, selection source and reason. Worker dispatch saves its AgentSession before opening a client. Routing checks that recorded session against the saved decision and pool. The inspector shows the actual requested/reported model and the selection reason. Existing sessions continue on their recorded route; switching models requires another assignment rather than replacing provider state inside a conversation.

## Interface and inheritance

User settings show the default profile, its coordinator/worker/reviewer models, editable API connections, restart state, model discovery and explicit diagnostics. Project settings can pin a profile or inherit the machine default. The agent inspector displays the saved runtime/model identity rather than labelling every session Codex.

Each run freezes its profile, data policy and runtime configuration revisions. Buro handles identify sessions independently of native thread IDs. Restart or repair follows the saved route; changing the default does not move an existing session to another provider. If that runtime configuration has changed or disappeared, continuation stops with a configuration error. Restore it or start a new run. Historical prototype runs without the required resource/planning/route bindings are not silently resumed; preserve/archive their records and start a fresh run after the controlled cutover.

Environment discovery and result preparation reference their owning run explicitly, so they inherit its resources and material manifest. A manual managed repair saves a new scope revision for updated criteria/materials while retaining earlier evidence. Strict assignments retain their planned-path containment during continuation; advisory work can make additional permitted edits, which are checked and reported.

## Supported execution boundary

Managed tools provide bounded text reads/search, exact edits in assigned paths, inspection of actual changes and exact configured check commands. Model-directed commands use native confinement, cannot read private Buro/client state and cannot use the network. Explicit environment setup/readiness recipes can use the network while retaining private-file restrictions. Acceptance checks remain service-owned.

Managed Docker execution currently fails closed because the existing native-client container does not provide the required private-data isolation. Native Codex Docker behavior remains available. Unsupported environments never fall back to an unconfined host command.

Checkpoints and routing references are private atomic records. Unknown tool/client-start outcomes remain stopped for reconciliation. Recovery does not promise automatic replay, exactly-once execution or transferable provider conversation state.

The service supplies an effective policy summary and stopped-run actions to the interface. Current finite managed limits remain visible, and unknown native usage is not zero. Machine-default changes refresh the initiating client; other connected clients currently need a refresh/reconnect. Read-only operational preparation still needs its separate durable unknown-outcome receipt; failed preparation never dispatches external delivery. Custom environment role IDs can require more specific operation eligibility than the current built-in catalog row; actual dispatch still validates the delivery operation. These remaining contribution/lifecycle boundaries are tracked in implementation progress.
