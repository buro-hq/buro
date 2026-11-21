# Этап 3: нейтральные transport-пакеты и последующее подключение SDK loop

Дата: 22.11.2026. Основание — чтение текущего production-кода Buro, установленного Pi 1.6.0 в `/private/tmp/buro-sdk-spike-JVi17H` и сохранённого fake spike. Это план интеграции, не отчёт о production adoption SDK.

## Принятое разделение этапов

Stage3A сначала извлекает переиспользуемый transport-пакет Ollama/DeepSeek с нейтральными model contracts, явными outcomes ошибок и настоящими потоковыми событиями. Существующий Buro host journal и managed loop остаются на месте. SDK loop переключается позднее, после выделения host seams и доказательства fatal/crash/restart-инвариантов на настоящем FileManagedSessions.

Codex остаётся самостоятельным непрозрачным backend-адаптером с таким же capability-based admission, как другие backend. Для него нельзя придумывать host-owned tool lifecycle, измеренный usage или пошаговую управляемость. Извлечение transport не требует наличия Codex, Cordis, проектов Buro или UI у внешнего consumer.

`agent/contracts/model.ts` уже не зависит от Buro. Однако текущие `adapters/models/http.ts`, `ollama.ts`, `deepseek.ts` импортируют `core/ports.ts` и/или `core/run-reconciliation.ts`; Ollama также импортирует project-owned endpoint trust. Именно эти связи требуется устранить в transport-пакете. Преобразование нейтрального ProviderError в Buro DomainError/observed-or-unknown остаётся на стороне host adapter.

## Что проверено в установленном Pi

Проверенные файлы находятся в `node_modules/@earendil-works/pi-agent-core/dist` и `node_modules/@earendil-works/pi-ai/dist` указанного временного каталога. Пакеты версии 1.6.0. Во время этого чтения не выполнялись установка, сеть, модели или изменения production-зависимостей.

| Реализация                                              | Наблюдение                                                                                           | Следствие для Buro                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent-loop.js`: `runAgentLoop`, `runAgentLoopContinue` | Возвращают Promise и ожидают event sink/hooks                                                        | Использовать await и внешний try/catch/finally                                                        |
| `agent-loop.js`: `agentLoop`, `agentLoopContinue`       | Запускают Promise через `.then()` без rejection-path закрытия stream                                 | Не использовать эти stream wrappers как границу надёжности                                            |
| `types.d.ts`: `StreamFn`                                | Ошибки request/model должны возвращаться в terminal stream, не как rejected promise                  | Bridge сохраняет исходную typed error отдельно; SDK error message не становится нашим outcome         |
| `agent-loop.js`: preparation/execution/finalization     | Ошибки before/execute/after превращаются в `isError` tool result                                     | Простой throw не останавливает следующий запрос                                                       |
| `agent-loop.js`: `executeToolCallsSequential`           | Следующий tool может получить lifecycle events после abort; actual execute не вызывается после abort | SDK events не являются evidence dispatch/receipt                                                      |
| `types.d.ts`: tool execution                            | Default — parallel                                                                                   | Указывать sequential на loop и host-owned tools                                                       |
| `pi-ai/utils/validation.js`                             | Используется schema compilation с `coerce: true`; execute получает потенциально изменённые аргументы | Эффект исполняется по сохранённому canonical call, не по SDK args                                     |
| `types.d.ts`: `AgentTool.replay`                        | Есть `never`/`safe`; в `agent-loop.js` эта metadata не читается                                      | No-replay гарантирует только Buro journal                                                             |
| `agent-loop.js`: truncated response                     | `length` с tool calls превращается в errors без effects, после чего loop может запросить исправление | Существующий MODEL_INCOMPLETE должен обрабатываться host до выдачи calls scheduler                    |
| `prepareRequest`, `prepareNextTurn`                     | Могут заменить context перед очередным запросом                                                      | Сначала atomic host checkpoint, затем новая SDK projection                                            |
| `runLoop`: `newMessages`                                | Накапливает сообщения даже при замене активного context                                              | Не сохранять SDK history как checkpoint; не обещать ограничение общей памяти через context compaction |
| `DEFAULT_AGENT_IDENTITY`                                | По умолчанию Pi attribution                                                                          | Задать identity явно; в первом bridge не использовать SDK transport/credential resolution             |
| `stream-fn.js`                                          | Default stream отсутствует, пока его не установят                                                    | Передавать streamFn явно, без process-global настройки                                                |

Сохранённый fake spike доказал механические свойства callback API и отсутствие встроенной 20-request отсечки выбранного loop. Он не доказывает crash durability, restart, HTTP retry accounting, корректность моделей или production safety.

## Stage3A: независимо проверяемый transport

Нейтральный ProviderError должен нести outcome, а не ссылаться на Buro run/session. Минимально различимы: generation не отправлялась; endpoint вернул определённый отрицательный ответ; generation была отправлена, но полного нормализованного результата нет. Частичная генерация, malformed terminal/tool arguments, потерянный terminal marker и разрыв чтения остаются unknown. Discovery `/api/show` не является generation; его отказ не должен ошибочно означать неизвестное выполнение `/api/chat`.

Stream events должны содержать только нейтральные наблюдения. Text delta — фактически полученный фрагмент текста, а не полный accumulated answer и не timer heartbeat. Reasoning/private continuation не отправляется как публичный text delta. Tool-call deltas не дают разрешения на исполнение: только complete normalized response проходит host batch admission. Usage отсутствует, если его не сообщил provider; нулевые SDK поля не становятся измерением.

Точные имена ProviderError/outcome/events согласуются владельцами contracts и providers до написания тестов. Эта записка не вводит конкурирующую схему.

## Последующий SDK этап: один scheduler, прежняя authority

Предлагаемая карта файлов после прохождения transport-этапа:

| Файл/область                              | Ответственность                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `agent/contracts/loop.ts`                 | Нейтральный runner/host-callback contract без SDK, Project, Cordis и filesystem                            |
| `core/managed-session-authority.ts`       | Buro start/resume/review authority, scope/project/run binding                                              |
| `core/managed-host-effects.ts`            | Generation/action admission, batch intents, receipts, quota settlement и known/unknown cleanup             |
| `core/managed-coding-context.ts`          | Segments, Git fingerprints, check feedback и compact checkpoint transitions                                |
| `core/managed-runtime.ts`                 | Session lifecycle и host turn authority; после принятия SDK старый собственный request/tool loop удаляется |
| `adapters/agents/pi-loop.ts`              | Единственный Pi scheduler; ephemeral message projection, fatal state и явный sequential mode               |
| `adapters/resources/runtime-resources.ts` | Явная сборка runner и host dependencies                                                                    |
| `adapters/files/managed-sessions.ts`      | Прежние persisted invariants; SDK session/history store не добавляется                                     |

ModelProvider остаётся нижним нейтральным transport-портом. SDK types нельзя экспортировать через public domain/neutral contracts. В первом loop bridge запросы идут через уже проверенный ModelProvider; SDK catalog, SDK credentials и SDK HTTP retries не включаются автоматически. Переход на SDK transport — отдельное решение с повторной проверкой outcomes и counting.

SDK driver получает opaque authority reference и prepared request/generate/execute-batch/after-assistant callbacks, а не ToolScope, Run или Git API. FileManagedSessions и ProjectRunBudgets остаются двумя существующими host stores: это не заявление об общей SQLite-транзакции и не повод добавлять третью SDK ledger.

### Generation и batch admission

Сохраняется текущий порядок из `core/managed-runtime.ts`:

1. Проверка актуальной authority, scope и context; generation reservation, если она явно настроена.
2. Durable generation intent до реального запроса.
3. Provider complete; полный нормализованный ответ сохраняется до usage settlement.
4. Проверяется весь assistant tool batch: finish reason, все IDs уникальны за жизнь сессии, все names рекламировались в данном запросе, noTools/final/closing authority, strict policy и aggregate tool allowance.
5. Резервирование batch, если требуется; durable assistant response и ВСЕ tool intents до первого effect.
6. Только после этого ответ передаётся Pi scheduler. Wrapper получает действие по canonical action ID и исполняет сохранённые name/arguments через ToolBroker.
7. Receipt и canonical tool result сохраняются до объявления host tool.completed и следующего эффекта.

Per-tool `beforeToolCall` недостаточен: иначе первый корректный tool успеет изменить файлы до обнаружения недопустимого второго. Private normalized generation response, action IDs, usage coverage и continuation остаются у Buro.

SDK собственная validation требует явного решения до production: она может преобразовать arguments либо отклонить call до execute, оставив host intent pending. Допустимы scheduler-only permissive declarations при сохранении реальных host schemas в provider packet либо точная фиксация каждого SDK-known-not-dispatched результата в соответствующем host receipt. Нельзя молча использовать coercion для эффекта или оставлять неисполненный intent неопределённым. Нужны отдельные adversarial tests на оба случая.

### Fatal boundary

На каждый запуск runner создаётся собственный fatal carrier и AbortController. Host admission, неизвестный эффект, ошибка durable receipt или нарушенный bridge contract сохраняют исходную typed error, отменяют batch и запрещают следующий provider request. `finishTurn` возвращает end, а внешний runner повторно выбрасывает исходную ошибку после cleanup. Ошибка не классифицируется по SDK error text.

Обычный ToolBroker result с `isError: true`, например отклонённый безопасно неисполненный edit, остаётся model-visible результатом и допускает самостоятельное исправление. Неизвестный write/process outcome или journal failure не превращается в такую исправимую ошибку.

Во внешнем finally остаются timer/cancellation cleanup. Отсутствие agent_end не освобождает от сохранения interrupted/unknown состояния. `tool_execution_start` не подтверждает grant, а `tool_execution_end` не подтверждает host receipt.

### Compaction и restart

Host сохраняет archive, observation/evidence, settled receipts, scope revision, исходную цель и новый anchor одной разрешённой checkpoint transition. После успешного сохранения `prepareNextTurn` получает новую projection. При ошибке записи SDK не продолжает запрос со сжатым контекстом. SDK newMessages не является ни канонической историей, ни compact checkpoint.

Restart читает FileManagedSessions и owner-run reconciliation. Нельзя восстанавливать действия из SDK transcript, делать replay по toolCallId либо считать полный model stream доказательством сохранённого receipt. Все unresolved generation/action/check markers сохраняют текущую fail-closed семантику.

## Независимые приёмочные тесты

Transport stage3A:

- Чистый внешний consumer импортирует contracts/provider из подготовленного build/package без Codex, Cordis, React и исходников Buro.
- Реальные NDJSON/SSE парсеры получают fake fetch ReadableStream с разрезанным UTF-8, границами строк/event, text и private reasoning. Text deltas приходят до завершения complete, без reasoning и дублей.
- Pre-abort, queued abort и credential failure не вызывают generation fetch; discovery failure не становится неизвестной generation.
- Определённый отрицательный HTTP ответ, ошибка чтения после отправки, частичный текст с потерянным terminal marker и malformed tool arguments имеют ожидаемые разные outcomes.
- Terminal finish и usage, включая unknown usage, одинаковы при complete и stream наблюдениях; ни один tool не исполняется parser.

SDK switch после выделения host seam:

- Второй запрещённый/duplicate tool в одном batch блокирует первый effect.
- Grant failure до эффекта: ноль эффектов и последующих HTTP requests.
- Потеря receipt после первого эффекта: ровно один эффект, второй не запущен; reopen сохраняет unknown и запрещает replay.
- Потерянная generation response: durable intent остаётся unknown; новый runner не повторяет запрос.
- SDK coercion и SDK validation rejection не меняют journaled arguments и не оставляют ложный pending/complete.
- Ошибка prepareRequest/compaction не приводит к agent success; durable context и полный goal сохраняются.
- Length/abort не dispatch tools, не создают неразрешённый следующий запрос и не дают false complete.
- Текущие 16K same-thread correction, independent critic, immutable checks и strict/advisory scope tests проходят без ослабления границ.

Только после этих проверок и architecture review имеет смысл убрать прежний request/tool loop. Извлечение packages и streaming само по себе не означает принятие SDK scheduler.
