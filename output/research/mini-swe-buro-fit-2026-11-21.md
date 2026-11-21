# mini-SWE-agent: что действительно можно переиспользовать в Buro

Проверено 21.11.2026. Источники исходников зафиксированы на commit `04d809ceab9df28f9adaed044884180159172930`, версия в `src/minisweagent/__init__.py` — `2.4.6`. Это аудит кода и границ интеграции; запусков, установки зависимостей и сравнений качества в этой работе не было.

## Решение

Стоит сделать небольшой **настоящий Python backend на upstream mini-SWE-agent**, без форка и переписывания его цикла в TypeScript. Подключить через общий `AgentBackend`, рядом с Codex и Buro managed backend. Buro сохраняет оркестрацию, назначения ролей, проверку результата и приёмку. Продвижение из экспериментального backend в основной — после проверки границ, восстановления и сравнения на одинаковых задачах.

Это позволяет использовать готовые agent/model/environment компоненты, а не только повторять идеи. Но mini не заменяет Buro orchestration, scoped tools, durable effects или независимого reviewer. Экономия на самом цикле агента реальна; экономия на всей инфраструктуре Buro из размера цикла не следует.

## Почему Codex сейчас не в model-providers

В Buro `ModelProvider.complete()` возвращает предложение сообщения и tool calls; инструменты выполняет `ManagedAgentRuntime` через `ToolBroker`. Это видно в `core/model-ports.ts:26`, `core/managed-runtime.ts:526` и `core/managed-runtime.ts:638`.

`CodexRuntime` реализует `AgentRuntime`, запускает `codex app-server`, создаёт thread/turn и получает события уже работающего агента (`adapters/codex/runtime.ts:22`, `adapters/codex/runtime.ts:497`). Внутри Codex сам вызывает модель и инструменты. Перенести этот класс в пакет сырых моделей означало бы смешать два разных контракта.

Это не делает Codex особым координатором. Снаружи он равноправный исполнитель роли Buro. mini — тоже agent backend, а не сырой model provider. При этом отдельный сырой OpenAI API provider возможен и не равен интеграции установленного Codex.

Рекомендуемая граница пакетов:

```text
Buro host / другой host
  -> agent-contracts: ModelProvider + AgentBackend + capabilities + events
  -> agent-runtime: managed backend, generic context/effects mechanisms
  -> model-providers: Ollama / DeepSeek / другие raw API
  -> agent-adapters: /codex и опциональный /mini-swe

agent-runtime -> agent-contracts
model-providers -> agent-contracts
agent-adapters -> agent-contracts
```

Назначения writer/reviewer/coordinator и решение о качестве принадлежат Buro. Пакет adapters не импортирует Project/Goal/Run, Cordis или SQLite. Текущий `AgentRuntime` в `core/ports.ts:60` ещё содержит Buro IDs и workspace policy: его нельзя просто переименовать и экспортировать как готовый общий SDK.

## Что реально даёт upstream

| Компонент | Проверенное поведение | Как использовать |
| --- | --- | --- |
| `DefaultAgent` | `Model.query(messages)` → `Environment.execute(action)` → observations; hooks через методы класса | Запустить как зависимость в Python worker, тонко расширить hooks для событий и host IDs |
| Model protocol | query, formatting, observations, serialization | Сначала один явно выбранный upstream adapter; затем при необходимости Buro-controlled model proxy |
| Environment protocol | execute + template variables + serialization | Подставить отдельную контролируемую среду; не запускать стандартный LocalEnvironment на пользовательском host |
| Toolcall parser | проверяет JSON, имя `bash`, наличие `command`; привязывает tool call IDs | Использовать upstream со согласованным model/config, не писать заново парсер без причины |
| Trajectory | сообщения, raw response/output, config, exit status, usage/cost fields | Импортировать как диагностический артефакт; не превращать в authoritative Buro ledger |
| Config/templates | инструкции поиска, воспроизведения, правки, проверки и завершения | Зафиксировать конкретный профиль и версию; не смешивать text/bash и function-calling профили |

`DefaultAgent` в проверенном файле занимает около 190 строк. Это не весь исполняемый продукт: отдельно существуют модели, environments, parsing, retry, CLI, зависимости и конфигурация.

Текущий `LitellmModel` отправляет `tools=[BASH_TOOL]`. В проверенном `default.yaml` используется текстовый `mswea_bash_command`; registry также содержит `litellm_textbased`. Нельзя обещать, что произвольные model class и шаблон автоматически совместимы. Для первого spike явно выбрать одну согласованную связку. Код textbased-модели в этом аудите отдельно не проверялся.

## Что нельзя принять как готовую Buro гарантию

**Tool authority.** `LocalEnvironment` выполняет произвольную shell-строку и наследует `os.environ`; `get_template_vars()` тоже включает переменные среды. Текущий Buro broker ограничивает пути, секреты, изменения и перечень команд. Универсальный bash не может быть честно объявлен эквивалентом этого broker. Работа в worktree сама по себе не ограничивает доступ к host.

Для первого backend нужен отдельный sandbox с только разрешённым worktree, ограниченной сетью и контролируемыми mount/env. Python controller с API credentials остаётся снаружи sandbox. Read-only reviewer требует реальной read-only среды, не инструкции в prompt. Возможность произвольного bash и отсутствие scoped tools должны отражаться в capabilities. Конкретные upstream Docker/Bubblewrap implementations здесь не проверялись: их наличие в документации не доказывает наши гарантии.

**Приёмка.** LocalEnvironment считает выполнение завершённым по специальной строке в успешном stdout. Это сигнал `submitted`, а не `accepted`. Обычная команда тоже способна вывести такую строку. Только Buro запускает проверки и отдельное ревью и фиксирует окончательное решение.

**Восстановление.** Сохранение всей trajectory через `Path.write_text()` происходит в `finally` каждого шага; это не атомарная транзакция и не write-ahead journal. Стандартный protocol не описывает resume, cancellation, idempotency или стриминг. Внутри одного шага может выполниться несколько действий, а crash наступить до save. Повторять их автоматически по trajectory нельзя.

**Контекст.** `query()` передаёт всю историю. Проверенный YAML обрезает только представление одного наблюдения до первых/последних 5000 символов, сохраняя raw output в `extra`. Это полезное отделение trace от view, но не управление общим контекстным окном. ContextWindowExceededError у LitellmModel прекращает retry. mini сам по себе не устраняет переполнение на Qwen и не вводит надёжную смену коротких сессий.

**Streaming/cancel.** Проверенный model protocol синхронный; `query()` возвращает готовое сообщение. JSONL bridge может отдавать события этапов, но нельзя обещать token streaming без дополнительной реализации. Отмена должна завершать worker и его sandbox/process tree; одного AbortSignal в TypeScript недостаточно. Проверенный LocalEnvironment убивает POSIX process group при timeout; Windows path вызывает `process.kill()`, без такой же гарантии дерева процессов.

## Скрытые ограничения и деньги

Нужно различать настройки класса, выбранный YAML, inherited environment и модельные параметры.

| Место | Проверенный предел | Решение для Buro |
| --- | --- | --- |
| `AgentConfig` | cost_limit=$3, step_limit=0, wall_time_limit_seconds=0 | Явно задавать настройки backend; `0` отключает соответствующую проверку |
| Проверенный `default.yaml` | cost_limit=0, step_limit=0 | Не утверждать, что у каждого запуска mini обязательно бюджет $3 |
| Agent format handling | 3 последовательные ошибки по умолчанию, 0 отключает | Видимая recovery policy; изменение модельного профиля, а не скрытая смена модели |
| `GlobalModelStats` | лимиты из `MSWEA_GLOBAL_COST_LIMIT`/`MSWEA_GLOBAL_CALL_LIMIT`, по умолчанию 0 | Не наследовать случайные глобальные настройки; использовать явный env allowlist |
| Model retry | 10 попыток, экспоненциальное ожидание 4–60 сек | Один владелец retry; явные события/причина/счётчик. Не умножать на внешние Buro retries |
| Local command | timeout=30 секунд | Отдельная execution/stall policy; не совокупный лимит работы над целью |
| Модель | переданные model_kwargs, provider/context/output capacity | Явные параметры и наблюдаемая причина остановки, не обещание бесконечного контекста |

Проверка стоимости в agent происходит до следующего query и может превысить порог последним запросом. Это не reservation/admission. Один `n_calls` у agent не обязательно равен фактическим API попыткам: retry живёт внутри `model.query()`.

LitellmModel по умолчанию требует положительную вычисленную стоимость; неизвестная/бесплатная локальная модель может вызвать RuntimeError после получения ответа. Для локального inference явно выбрать registry или `cost_tracking=ignore_errors`, сохранив отдельно `cost=unknown`, а не делая вывод «запрос бесплатный». Нулевое значение, которым upstream заменяет невычисленную стоимость, не является доказательством отсутствия затрат.

Пользовательская политика Buro: **по умолчанию нет общего hard quota на цель**. Если пользователь включил квоту, backend должен явно заявлять её coverage. Прямой LiteLLM вызов обходит Buro ModelProvider accounting; внешний счётчик завершённых шагов не обеспечивает строгую квоту на API attempts. Для строгой host-owned квоты понадобится контролируемый Model implementation/proxy с admission до каждой реальной попытки. В первом spike честнее capability `usage=observed`, `requestAdmission=false`, чем ложная гарантия.

Локальная Ollama остаётся HTTP endpoint для inference. Удалённая GPU не становится shell/environment агента и не требует SSH. Нет оснований обещать, что другой harness улучшит качество Qwen без проверки на одинаковых задачах.

## Первый настоящий spike без форка

1. Зафиксировать upstream commit/package и lock Python dependencies в отдельном опциональном worker окружении. Не делать Python обязательной зависимостью обычного Buro startup.
2. Написать небольшой versioned JSONL bridge: `start`, `execute`, `cancel`, `close`; обратные `started`, этап/command events, `submitted`, `failed`, `cancelled`, usage и ссылки на trajectory. Это целевой протокол, а не уже имеющийся API mini.
3. Worker импортирует upstream DefaultAgent/Model и подставляет проверенную environment implementation. Buro выдаёт execution context и путь к разрешённой рабочей копии. Секреты конфигурации не сериализуются в public trajectory/events.
4. Adapter маппит Buro-owned operation/session IDs на worker. Отдельно объявляет capabilities: tools/readonly/isolation, structured output, usage, cancellation, resume, streaming. Неподдержанное не эмулируется пустым ответом.
5. На успешный submission Buro фиксирует артефакты, запускает существующие проверки и reviewer через любой совместимый backend. mini не получает права менять состояние приёмки и роли команды.

Стоимость spike — средняя: bridge, config pinning и mapping событий. Production стоимость выше: sandbox, interrupt/process ownership, unknown outcomes, наблюдаемость API attempts и context rollover. Замена managed runtime целиком до этих проверок увеличит риски и лишит нас текущих гарантий.

Не следует одновременно переписывать mini в TS, переносить orchestration в Python и менять Buro storage. Это уничтожит понятность сравнения. У Buro остаётся **один host transaction authority** для run/events/usage/receipts; trajectory mini — отдельный диагностический артефакт, не второй управляющий ledger.

## Условия принятия после spike

- Contract fixtures на события и capabilities; отсутствие секретов/лишних данных в stdout и trajectory; корректные JSONL frames при исключениях.
- Permission tests: выход за mount/allowed scope, запись read-only reviewer, попытки получить host env/сеть должны соответствовать заявленной sandbox policy.
- Crash/cancel тест в промежутке «действие выполнено, результат не сохранён»: состояние unknown без автоматического повторения внешнего эффекта.
- Задержка/обрыв модели, format errors, длинный command output, context overflow и повторный запуск дают наблюдаемое состояние без скрытого переключения backend.
- Сравнение managed vs mini на одинаковых frozen задачах: одна модель, окружение, visible checks, одинаковое правило остановки и одинаковые reviewer policy; измерить solved/accepted, число реальных вызовов, wall time, input/output tokens и repair cycles. Скрытые oracle checks — после выбора результата.

[Private-project evaluation details removed.]

## Лицензия и источники

На зафиксированном commit `LICENSE.md` — MIT, copyright 2025 Kilian A. Lieret and Carlos E. Jimenez. Можно использовать зависимость и модифицировать/распространять при сохранении copyright/license notice. Это не означает автоматическую проверку лицензий всех транзитивных зависимостей. Исходный код upstream в Buro в этой работе не копировался.

Python >=3.10; обычные зависимости уже включают LiteLLM, OpenAI SDK, datasets, textual, Jinja2, Pydantic и другие пакеты. Поэтому «190 строк agent» не равно «маленькая TS зависимость». Пакет исключает конкретные проблемные версии LiteLLM/OpenAI; pin одного mini без разрешённого dependency lock недостаточен для воспроизводимости.

Первичные источники, прочитанные через Firecrawl родительским агентом и сохранённые в `.firecrawl/mini-reuse-*-pinned.md`:

- [DefaultAgent](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py): цикл, ограничения, формат ошибок и save.
- [Protocols/init](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/__init__.py): protocol и загрузка global dotenv при import.
- [LocalEnvironment](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/environments/local.py): shell, env, submission и timeout.
- [LitellmModel](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/litellm_model.py): API вызов, full messages, cost и abort exceptions.
- [Model registry/global limits](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/__init__.py), [retry](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/utils/retry.py), [toolcall parser](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/utils/actions_toolcall.py).
- [Default config](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/config/default.yaml): текстовый action profile и наблюдения; это один профиль, не аудит всех launcher overrides.
- [pyproject](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/pyproject.toml), [MIT LICENSE](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/LICENSE.md).
- [Official cookbook](https://mini-swe-agent.com/latest/advanced/cookbook/): композиция model/environment/agent и подклассы; страница latest неприкреплена к commit, выводы о поведении выше основаны на pinned source.
