# Что переиспользовать из TypeScript agent SDK в Buro

Дата проверки: 21.11.2026. Исследование первичных документов, интерфейсов и лицензий; зависимости не устанавливались, исходники в production не копировались, модели не запускались. Описанные свойства SDK не являются доказательством качества кода или скорости на Qwen.

## Выбор

Первый кандидат для небольшого проверяемого прототипа — **pi-ai + pi-agent-core как реализация managed backend**, с Buro-owned model/tool wrappers и журналом. Это уже разделённые TS библиотеки, а не терминальное приложение, которое пришлось бы разбирать на части. Сравнить с **AI SDK на уровне model transport**; принять один путь после проверки протоколов и восстановления. Не подключать одновременно два вложенных agent loop к одной сессии.

Это условный выбор для spike, не решение немедленно заменить рабочий runtime. Если обёртки для durable dispatch, canonical context и fail-closed cancellation оказываются сложнее собственного короткого цикла, взять только transport библиотеку; сохранить наш runtime для последовательности эффектов. Такой fallback по-прежнему убирает собственную поддержку streaming/API wire formats.

Отдельное сильное открытие: **AI SDK v7 уже разделяет model providers и native harness adapters**. Это подтверждает нашу границу ModelProvider/AgentBackend и предлагает готовые Codex/Pi/ACP adapters. Но конкретный Codex adapter пока требует другой среды исполнения и не является безопасной механической заменой текущего local app-server.

[Private-project evaluation details removed.]

## Сравнение конкретных механизмов

| Семейство | Что действительно можно взять зависимостью | Где оставить Buro | Решение |
| --- | --- | --- | --- |
| pi-ai / pi-agent-core | provider projection, text/thinking/tool streams, generic loop, custom messages, context/request hooks, tool hooks, abort | host authority, durable dispatch/results, role workflow, acceptance | Первый TS spike; без pi-coding-agent и встроенного bash |
| AI SDK Core | streamText или LanguageModel API, provider factories, JSON-schema tools, structured output и stream normalization | model-step ownership и выполнение scoped tools | Transport fallback/контрольный вариант; сначала без ToolLoopAgent autoexecute |
| AI SDK Harnesses | native Codex/Pi/ACP adapters, lifecycle/session/stream surface | policy validation, sandbox host, receipts/unknown effects, Buro orchestration | Отдельный native-backend spike; experimental API и sandbox цена |
| OpenAI Agents JS | generic Model/ModelProvider, streaming runner, tools, handoffs, serialized RunState | единая Buro orchestration/authority и data policy | Не добавлять ещё один orchestration слой; полезный interface/reference |
| LangGraph JS | checkpointed graph/task execution, interrupts, replay/pending writes | внешние effects остаются нашей ответственностью | Не вводить второй workflow/state owner; резерв, если решим заменить durable engine целиком |

## pi: наиболее близкие reusable units

Репозиторий `badlogic/pi-mono` теперь перенаправляется в **earendil-works/pi**. Проверенный HEAD `780bf31fcaeb252fa9b68df3964c735eae75bde3` от 21.11.2026; package agent-core — `1.6.0`, зависимости pi-ai/pi-schema той же версии; Node >=22.19.0. Старые примеры `@mariozechner/*` нельзя автоматически считать текущим контрактом. [Agent package](https://github.com/earendil-works/pi/blob/780bf31fcaeb252fa9b68df3964c735eae75bde3/packages/agent/package.json).

`pi-agent-core` отделяет application messages от LLM projection: `AgentMessage[] -> transformContext -> convertToLlm -> Message[]`. Есть `prepareRequest` непосредственно перед каждым conversational request, injected `streamFn`, `beforeToolCall` после валидации args, `afterToolCall`, `finishTurn`, events и abort. Это почти точные точки расширения для наших versioned context views, ModelProvider port и scoped tools. `finishTurn` позволяет завершить cooperative unit; безусловный continue, наоборот, создаёт бесконечный цикл. [Pinned README](https://github.com/earendil-works/pi/blob/780bf31fcaeb252fa9b68df3964c735eae75bde3/packages/agent/README.md), [types](https://github.com/earendil-works/pi/blob/780bf31fcaeb252fa9b68df3964c735eae75bde3/packages/agent/src/types.ts).

По умолчанию batch tool calls исполняется параллельно; для первого spike явно включить sequential. Событие tool_execution_start предшествует preflight и не означает, что эффект разрешён или произошёл. Уведомление callback не является ACID receipt. Commit grant/revalidate/execute/record должен жить внутри host-supplied tool execute wrapper. Один hook проверки prompt/tool args не защищает эффект от смены policy между проверкой и исполнением.

В pinned types `StreamFn` должен возвращать protocol error/aborted event, а не rejected promise; `convertToLlm`, transform и getApiKey также имеют ограничения на исключения. Поэтому failure журналирования нельзя просто бросить из случайного hook и ожидать корректного terminal event. Контрактный spike должен показать **fail-closed** outcome и отсутствие следующего запроса/эффекта, а не только happy path.

`pi-ai` поддерживает отдельный DeepSeek provider и OpenAI-compatible endpoints, включая Ollama. Есть explicit provider factories/subpaths, stream events, JSON-schema tools, cancellation и provider-specific continuation. Native `/api/chat` Ollama, model digest/local-only restrictions и нужные `num_ctx`/format параметры Buro не становятся автоматически сохранёнными гарантиями после перехода на совместимый `/v1` endpoint. Это обязательные migration fixtures. [Pinned AI README](https://github.com/earendil-works/pi/blob/780bf31fcaeb252fa9b68df3964c735eae75bde3/packages/ai/README.md).

Использовать explicit credentials/providers, не `builtinModels()` со всем каталогом и ambient auth. Локальный endpoint — inference; shell/workspace остаётся у host, никакого SSH для RTX не требуется. В pi-ai есть provider под названием OpenAI Codex через OAuth: это raw API integration, **не то же самое**, что запуск Codex app-server с его native tools/session.

## AI SDK: transport и native harness — разные способы reuse

`streamText` даёт text/tool streams, optional execute у tools, AbortSignal, provider-specific metadata и retries. **Если execute не передан, SDK не выполняет tool автоматически**: host может оставить durable dispatch у себя. ToolLoopAgent имеет другие lifecycle/defaults. Это позволяет сначала заменить transport код, не меняя владельца effects. [streamText API](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text).

В прямом `@ai-sdk/deepseek` настраиваются credentials/baseURL/fetch; строки model по умолчанию могут идти через AI Gateway. Для Buro передавать явно созданный provider object: пользовательский DeepSeek/Ollama endpoint не должен незаметно стать gateway route. DeepSeek direct и Gateway имеют разный набор возможностей. [DeepSeek provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek).

Для Ollama есть community providers и OpenAI-compatible путь. Наличие интерфейса tools/JSON в библиотеке не означает поддержку конкретной загруженной моделью. Выбор community adapter добавляет отдельного maintainer/dependency owner; предпочтение первичному transport кандидату подтверждаем нашими fixtures, не маркетинговым описанием «надёжного tool calling». [OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers), [Ollama adapters](https://ai-sdk.dev/providers/community-providers/ollama).

AI SDK Harnesses прямо описывает harness как полноценный agent runtime с workspace/tools/session/compaction/permissions, отдельно от model provider. Есть готовые Codex, Pi и ACP adapters и совместимые stream primitives. Native backend сохраняет собственную внутреннюю семантику; одинаковый stream shape не превращает его в управляемый Buro model call. [Harness overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview), [adapter catalogue](https://ai-sdk.dev/providers/ai-sdk-harnesses).

Проверен источник `@ai-sdk/harness-codex` **1.0.192**, commit `d55f3cfc456d1b7bc7db3a4b70fbf602ddc8647d`, Node >=22. Adapter поднимает bridge в sandbox и WebSocket к host; требует allow-all native permission mode, предоставляет tool filtering/structured output. Cold resume не восстанавливает raw events части tools; repository config app-server нельзя полностью отключить. При отсутствии hostDisconnectTimeout turn может работать после исчезновения host. Нельзя выдавать это за существующую Buro scope/recovery гарантию. [Codex guide](https://ai-sdk.dev/providers/ai-sdk-harnesses/codex), [pinned implementation](https://github.com/vercel/ai/blob/d55f3cfc456d1b7bc7db3a4b70fbf602ddc8647d/packages/harness-codex/src/codex-harness.ts), [package](https://github.com/vercel/ai/blob/d55f3cfc456d1b7bc7db3a4b70fbf602ddc8647d/packages/harness-codex/package.json).

Это не причина переписать собственный Codex bridge заранее: сначала проверить, можем ли дать наш local sandbox через их sandbox interface, получить нужные events/cancel/resume и изолировать credentials. Пока сохранение нашего узкого native adapter — обоснованный fallback. Нет требования переносить весь продукт в Vercel.

Pi harness исполняет код самого агента в **host Node process**, используя sandbox для filesystem/shell. Trusted extension factories тоже выполняются в host; fileToolPathPolicy не ограничивает bash. Это принципиально отличается от «всё внутри sandbox». Для простого managed backend предпочтительнее pi-agent-core с нашими tools, а не полный coding harness с расширениями. [Pi harness](https://ai-sdk.dev/providers/ai-sdk-harnesses/pi).

## OpenAI Agents JS и LangGraph: что полезно, что лишнее

У OpenAI Agents JS Model делает один запрос, ModelProvider разрешает имя модели. Есть custom providers, AI SDK integration, streaming/cancel, tools и handoffs. Подтверждает полезность маленьких interfaces; не требует, чтобы координатор Buro был Codex. Но adoption Runner поверх нашего orchestration добавит второго владельца handoffs/history. Нужен отдельный backend adapter, если выбираем именно этот SDK, а не импорт его Agent как новый доменный объект Buro. [Models](https://openai.github.io/openai-agents-js/guides/models/).

Текущая документация Runner: maxTurns=10, `null` отключает; signal принимает AbortSignal. Default tracing включён в поддерживаемых server runtimes. Следовательно, при эксперименте явно отключить экспорт/выбрать host telemetry и задать наш no-default-quota режим. Serialization/RunState не доказывает, что внешний tool exactly-once; восстановление контролируется host journal. [Running](https://openai.github.io/openai-agents-js/guides/running-agents/).

LangGraph полезен готовыми checkpoints/pending writes, tasks и interrupts. Официальные docs прямо отличают retry node от exactly-once side effect: stable idempotency key должен существовать до эффекта; потерянное подтверждение — unknown. Эти правила берём как acceptance criteria Buro. Но рядом с нашим store готовый SqliteSaver не даст автоматически одной транзакции для run/usage/events/receipts. [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance), [checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers).

Не добавлять LangGraph просто ради красивого графа агентов. Если выберем его durable engine, потребуется сознательная замена владельца workflow и интеграция host state/transactions. Это отдельный большой spike, не ещё одна библиотека в managed-runtime. При необходимости generic host может использовать свой persistence adapter; новый reusable package не должен владеть второй database authority.

## Не перенести скрытые ограничения в новый SDK

| Механизм | Проверенный default/нюанс | Требование Buro |
| --- | --- | --- |
| AI SDK ToolLoopAgent | 20 steps; streamText — 1 step | Не считать cooperative model-step завершением цели; loop/stop policy задавать явно |
| AI SDK streamText | maxRetries=2; streamRetries=0; отдельный timeout/abort | Один владелец retry, реальные попытки наблюдаемы; неизвестные effects не повторяются |
| AI SDK telemetry | Reference включает enabled/input/output defaults | Явная host data/export policy, не ambient global defaults |
| AI SDK native Codex | source default model gpt-5.5 с workaround; startup120s/reconnect30s/keepalive20s | Модель задаёт resource config; transport stall/lease не бюджет цели |
| pi-ai | maxRetryDelayMs=60s; underlying SDK timeout/retry defaults могут применяться | Передавать maxRetries/timeout/identity/auth явно; проверить каждый выбранный provider |
| pi-core | parallel tools default; no aggregate quota в прочитанных core interfaces | Начать sequential; не утверждать, что все provider-level limits изучены |
| OpenAI Agents JS | maxTurns10, отключается null; default model/provider/tracing | Явные model/provider/no-quota/telemetry options |
| LangGraph | Retry opt-in; настроенная пустая policy даёт maxAttempts3; durability async/sync/exit | Никаких повторов unknown effect; commit intent до dispatch |

AI SDK v7 `WorkflowAgent.stream()` и generate имеют разные default stop rules; это ещё одна причина не переносить всю цель на default SDK loop. [Loop control](https://ai-sdk.dev/docs/agents/loop-control). pi-ai types отдельно дают maxRetries/timeout/maxRetryDelayMs; это provider transport policy, не совокупный budget. [Pinned provider options](https://github.com/earendil-works/pi/blob/780bf31fcaeb252fa9b68df3964c735eae75bde3/packages/ai/src/types.ts).

Пользовательское требование: **нет default общего лимита цели по токенам/шагам/деньгам**. Разбиение на sessions — cooperative continuation с сохранённым состоянием. Capacity контекста, per-request output, cancellation, stall recovery и лимиты сервиса остаются честно видимыми техническими свойствами. Нельзя переименовать прежний hard cap в SDK maxTurns или умножить host retry на внутренний SDK retry.

## Узкий прототип, который разрешит выбор

[Private-project evaluation details removed.]

Выбираем библиотеку, которая реально уменьшает поддерживаемый нами код, сохраняет continuation/authority и проходит crash tests. Не выбираем по звёздам, длине README или benchmark чужой модели. Проверки качества writer/critic/checks остаются одинаковыми при сравнении; продолжительность, токены и accepted результат измеряем отдельно.

## Лицензии, provenance и ограничения аудита

- **pi:** MIT, copyright2025 Mario Zechner; LICENSE прочитан в текущем upstream. [License](https://github.com/earendil-works/pi/blob/780bf31fcaeb252fa9b68df3964c735eae75bde3/LICENSE).
- **AI SDK:** Apache-2.0, LICENSE прочитан также на pinned `d55f3cfc…`; harness-codex package подтверждает Apache-2.0. При включении кода/дистрибуции проверить применимые LICENSE/NOTICE и зависимости выбранного package. [License](https://github.com/vercel/ai/blob/d55f3cfc456d1b7bc7db3a4b70fbf602ddc8647d/LICENSE).
- **OpenAI Agents JS:** MIT, copyright2025 OpenAI; официальный LICENSE прочитан с default branch, точная версия для adoption ещё не выбрана. [License](https://github.com/openai/openai-agents-js/blob/main/LICENSE).
- **LangGraph JS:** MIT, copyright2024 LangChain; официальный LICENSE прочитан с default branch; runtime version не зафиксирована для adoption. [License](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE).

Здесь не было копирования кода. Это не транзитивный license/security audit. Перед зависимостью нужны точные версии/lockfile и review выбранных package exports, а перед копированием — pinned upstream files с сохранёнными notices.

Firecrawl skill применён первым: CLI scrape шести public URLs завершился read ETIMEDOUT, MCP также не дал ответа и был остановлен. После повторяющейся недоступности использованы purpose-built GitHub connector и web fallback, только первичные официальные сайты/репозитории. Точные pi README/types и Codex harness source сохранены в ignored `.firecrawl/framework-*-github.*`; библиотеки и страницы изменяются, поэтому документационный audit не заменяет проверку установленных lock versions.
