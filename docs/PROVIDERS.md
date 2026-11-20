# First provider integrations

Status: implementation contract for the next milestone. The current production runtime is Codex CLI; Ollama, DeepSeek and the managed runtime described here are not shipped yet. [Product vision](../VISION.md), [architecture](../ARCHITECTURE.md) and [roadmap](../ROADMAP.md) share this scope.

## Supported routes in the first milestone

| Route | Agent loop owner | Model connection | Requirement |
| --- | --- | --- | --- |
| Codex | Codex through the existing runtime adapter | Configured Codex client | Preserve existing supported execution and verification. |
| Managed agent with Ollama | Buro | Ollama native API | Complete supported goals without Codex installed. |
| Managed agent with DeepSeek | Buro | DeepSeek model API | Complete supported goals without another coding CLI. |
| Hybrid team | Buro coordinates independent sessions | Allowed combination of these routes | Delegate and verify across providers with one saved execution history; expand bounded delegation into a general task graph later. |

DeepSeek means its model API in this milestone. DeepSeek Harness is a reference and possible later client adapter. A DeepSeek model installed in Ollama is an Ollama model selection, not a request to the DeepSeek cloud API.

The managed runtime owns messages, tool dispatch, limits, cancellation and checkpoints. Provider adapters own HTTP, authentication, response decoding and provider-native continuation. Sharing an OpenAI-like request shape does not make those transports identical.

## Connection and resource profiles

A private machine connection contains an adapter kind, endpoint, credential reference where needed, available model IDs and a configuration revision. A project refers to resource profiles and constraints; it does not contain API keys. A session records the requested and reported model IDs, provider/client revisions, capability result and context manifest.

Discover installed Ollama models and inspect their advertised capabilities. Verify a chosen model with a bounded read-only probe rather than treating endpoint reachability as coding readiness. Do not download a model automatically while testing a connection. Model details expose capabilities and metadata that can inform this probe. [Ollama model details](https://docs.ollama.com/api-reference/show-model-details).

DeepSeek uses its configured endpoint and a private API credential. Model IDs remain configurable and are checked against available API metadata or a bounded probe. Mutable provider aliases are recorded as requested/reported identities with timestamps; they are not described as immutable model versions. The official API documents OpenAI-compatible and Anthropic-compatible routes; the first Buro adapter should choose one explicit supported route, Chat Completions, and contract-test it. [DeepSeek API](https://api-docs.deepseek.com/).

Conceptual project profiles:

- **Local only:** managed sessions use installed Ollama models and local tools. Missing capability becomes a visible blocker or a smaller supported assignment.
- **Hybrid:** local workers and permitted DeepSeek or Codex sessions can cooperate. Routing follows the project's data scope and cost limits.
- **Codex:** keep the existing client behavior while using the same Buro task and evidence model.

These are design concepts, not current `.buro/project.json` fields or working connection commands. Select concrete defaults after connection probes. Do not silently add a remote provider as a local model's fallback.

## Shared managed execution

1. Load a validated TaskContract and permitted input references; assemble a brief within the selected model's token budget.
2. Submit the turn using that provider's supported tool and structured-output features.
3. Decode complete tool requests, including streamed argument fragments. Persist each request and its action ID before execution.
4. Validate tool name, arguments, worktree, allowed scope, resource lease and budget; execute through ToolBroker.
5. Persist tool output and provider continuation before making the next model request.
6. Produce a bounded result envelope or a typed failure. Return artifacts and observed actions to the scheduler, which decides the next assignment or verification.

A model-generated tool request does not execute itself. Buro validates and executes it; this also matches Ollama's documented follow-up pattern of submitting tool results back to the model. Support multiple requested tools without assuming that writes or dependent commands are safe to run concurrently. [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling).

The initial tools cover repository read/search, bounded edit/patch, scoped command execution and artifact access. Prefer these stable tools over exposing hundreds of provider-specific integrations. Coordinator delegation uses validated application decisions; arbitrary nested subagents are unnecessary.

## Provider specific behavior

Ollama has its own native message, tool and completion representation. Structured outputs and tool calling are separate capabilities; verify the actual combination needed by a role. Limit concurrent inference according to endpoint capacity and available memory, independently of the number of logical agent sessions. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [Ollama concurrency](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests).

For DeepSeek, reconstruct streamed function calls and correlate results with the correct call IDs. Thinking/tool conversations require preserving the provider's required continuation fields: current documentation requires returning prior `reasoning_content` when requests carry tools. Keep this as private provider state, not coordinator decisions, UI messages or ordinary event exports. Normalized visible progress should summarize actions and outcomes. [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).

DeepSeek documents strict tool schemas as a beta capability. Do not turn it on implicitly or confuse API shape validation with successful task execution. The initial supported schema subset and any strict-mode endpoint must be explicit and covered by fixtures. Domain validation remains mandatory. [DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/).

## Capabilities and limits

Probe the client/model/endpoint combination for role requirements: valid structured decisions, required tools, streaming completion, context budget, cancellation and continuation mode. A model that can summarize code may still be unsuitable as a coding executor or coordinator.

Resume has three explicit forms: native client resume, Buro checkpoint continuation, or a new session/attempt with saved artifacts. Ollama and direct DeepSeek calls initially use Buro-owned checkpoints. This does not imply that an in-flight remote generation can be reattached or that a conversation can be moved losslessly between providers.

Track provider-reported usage where available. Label estimates and unknown usage; do not display zero cost for an unmetered or interrupted request. Reserve bounded token/request budgets before dispatch and account for retries and routing changes. Exact price tables are provider metadata, not core invariants.

## Failure and cancellation

Provider failures are distinct from tool failures, implementation failures and unavailable verification environments. Return structured codes for unavailable endpoint/model, authentication, throttling, unsupported capability, malformed response, context exhaustion and interrupted/unknown outcome.

Retry transient transport errors only within policy and with backoff. A failed stream after a tool request may have executed an action already: reconcile the durable action record instead of sending the command again. A repeated invalid decision triggers correction or reassignment, not silent schema repair that changes its meaning.

Cancellation records intent, aborts HTTP generation, stops owned tool process groups and waits for observed local termination. A closed HTTP stream does not prove that remote compute stopped or was unbilled. Preserve unknown outcome and accounting limits honestly.

Private checkpoints contain only the provider state required for continuation, under the same access and retention rules as private session data. Keep credentials out of prompts, logs, shared profiles and exported evidence. Expiring a checkpoint must not remove the run's independent verification artifacts.

## Acceptance suite

Use fake providers and temporary repositories for deterministic checks, then explicitly configured opt-in live probes for each supported route. Never call a paid provider from the default unit suite.

Required cases:

- A real managed task reads a fixture repository, edits the allowed file, invokes a scoped check and returns independently verified evidence.
- Ollama and DeepSeek each complete that route without Codex installed; Codex's existing adapter scenarios still pass.
- Buro delegates a task between two selected providers, tracks their sessions independently and performs fresh review.
- Multiple tool calls, fragmented arguments, invalid schemas, unknown tools, duplicate call IDs and out-of-scope writes are handled deterministically.
- DeepSeek continuation survives more than one tool round; private provider fields stay out of domain event exports.
- Tool-request persistence, process completion and result persistence each have crash-boundary tests; restart does not duplicate a known side effect.
- Cancellation, throttling, absent model, exhausted context and provider loss produce honest non-success states and bounded retries.
- Endpoint limits queue independent sessions; local-only tests fail if any remote transport is invoked.
- Changing a profile affects future assignments under a new revision while preserving earlier session snapshots and evidence.

The release gate is a verified coding workflow through both providers and a mixed team, not a successful text response or a green connection indicator.
