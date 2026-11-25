# Полное ревью архитектуры Buro и агентной системы

Дата: 21 ноября 2026. Проверенная база: `a4f7e23`; производственный код в ходе ревью не менялся. Это аудит текущей реализации и выбранный план, а не описание уже готовых пакетов или новой политики исполнения.

## Вывод

У Buro хорошая основа модульного монолита: независимый core, явные порты, общий application API, отдельные адаптеры, настоящая композиция и lifecycle через Cordis. Сохраняем её. Однако плагинность пока сильнее в интерфейсах и подключении сервисов, чем в настройке продукта: реальные backend/provider создаются закрытой фабрикой, схемы знают имена клиентов, а агентный workflow содержит фиксированную последовательность и несколько независимых ограничителей.

[Private-project evaluation details removed.]

Пользовательские решения: старую совместимость не поддерживаем; Codex — равноправный адаптер; общих бюджетов по умолчанию нет; плановая область файлов рекомендательная, строгий режим включается явно; искусственные остановки должны исчезнуть либо стать понятными настройками и восстанавливаемыми состояниями.

## Что проверено

Пять делегированных направлений: агентная система/корректность; Cordis и модульность; внешние SDK и reuse; хранение/политики/восстановление; UI/CLI/API и тестовая поверхность. Дополнительно сведён предыдущий реестр 79 групп ограничений с185 ссылками на49 файлов. Это обзор подсистем с целевыми воспроизведениями, а не доказательство отсутствия всех ошибок во всех возможных окружениях.

Свежая проверка текущего проекта:

- `npm test`: **605/605**, без пропусков. Первый запуск упёрся в запрет loopback-listen песочницы; полный повтор с разрешёнными локальными тестовыми серверами прошёл.
- `npm run build`: typecheck сервера/UI и production build прошли. Есть предупреждения Rollup об аннотациях стороннего Zod, сборку они не останавливают.
- `npm run format:check`: прошёл.
- `npm run check:production`: desktop/mobile smoke собранного UI в offline drafts, ошибок страницы/консоли нет. Это не полный browser E2E живой coding goal.
- Отдельный воспроизводящий скрипт подтвердил три проблемных поведения. Его три PASS означают **воспроизведение дефектов**, а не успешную проверку правильности.

Модели, DeepSeek, локальная Ollama и отключённая RTX в этом аудите не вызывались. Исходные проекты пользователя не изменялись. [Квитанция проверок](../output/research/full-review-validation-2026-11-21.json).

## Сильные стороны и реальные границы

| Область | Текущее состояние | Решение |
| --- | --- | --- |
| Core | Нет прямых импортов Node/Cordis/React/адаптеров; существенные решения уже вынесены в чистые функции | Сохранить; убрать из универсальных интерфейсов понятия Project/Run/Git |
| Cordis | `inject`, сервисы, effect-scoped команды, cleanup, остановка активной работы действительно используются | Оставить как DI/composition/lifecycle; durable workflow не переносить в `emit()` |
| Адаптеры | Managed Ollama/DeepSeek и native Codex используют общий host runtime port | Сделать нейтральный AgentBackend, убрать именные исключения и одиночный зарезервированный Codex |
| Команды и клиенты | UI/CLI используют общий клиент, схемы, receipts и reconnect | Сохранить общий API; добавить durable command status и effective policy |
| Хранение | FileProjectStore уже атомарно сохраняет private ledger, Run, event и command receipt | Не терять эту атомарность; заменить полную перезапись на инкрементальные транзакции |
| Качество | Независимый reviewer, service-owned checks, отдельные worktree, сравнения с oracle уже есть | Сохранить; связать доказательства с точной принятой ревизией и возвращать repair исходному writer |
| Пакеты | Один private npm package, `noEmit`, нет проверенных standalone exports | Четыре пакета — цель рефакторинга, пока не готовый SDK |

## Подтверждённые проблемы и приоритет

### P1: доказательства и сохранённый результат могут относиться к разным байтам

[ExecutionService.verify](../core/execution.ts) получает список изменений до запуска check, а checkpoint позже собирает текущие файлы без ожидаемого fingerprint. Во временном Git-репозитории check добавил README: запуск завершился успешно, список результата показывал только `src/code.mjs`, но commit содержал и README.

Сам дополнительный файл по новой политике допустим. Ошибка — устаревшие сведения о проверенном и принятом результате. Нужен общий immutable revision/manifest для checks, review и checkpoint, с проверкой ожидаемой ревизии непосредственно при сохранении. Строгий scope проверяется только если включён, достоверность результата — всегда.

### P1: replacement worker обходит неизвестный исход предыдущего действия

Восстановление managed checkpoint блокирует неизвестные действия внутри той же сессии, но явное продолжение запуска может создать новую worker-сессию. В контролируемом fake backend первый worker сохранил неизвестное состояние и отказал с `ACTION_RECONCILIATION_REQUIRED`; продолжение создало второго и завершило run, не выяснив исход первого.

Это доказательство отсутствия host gate, не демонстрация повторного реального API/tool эффекта. Нужен owning-run effect/reconciliation state перед repair/replan/replacement; смена сессии или модели не должна обходить его. Успешно законченные специалисты не должны запускаться заново вместе со всем сохранённым составом.

### P1 для применения результата: Git-эффект выполняется раньше durable receipt

[ProjectManager.apply](../adapters/files/project-manager.ts) делает fast-forward merge до сохранения результата команды. Если последующая запись не удалась, исходная ветка уже изменилась, а повтор со старым expectedHead получает `BRANCH_CHANGED`. Это подтверждённый порядок в исходниках; отдельная fault-injection этого merge в данном аудите не запускалась.

Нужны durable intent до Git и reconciliation по ожидаемым branch/base/target после сбоя. Не считать неизвестный результат ни гарантированным провалом, ни разрешением повторить merge.

### P2: несколько важных дефектов и ограничений

- Невалидный JSON проходит мимо planning correction: воспроизведён terminal failure после одного ответа и без `plan.rejected`. Парсинг и schema validation должны попадать в общий typed recovery.
- Импорт материалов может вернуть `active=true`, хотя параллельное удаление уже сохранило `active=false`. Гонка воспроизведена на реальных адаптерах во временном проекте; дедупликация должна решаться в транзакции.
- Два отдельных экземпляра конфигурации могут оба подтвердить несовместимые изменения, потеряв одну запись и receipt. Это воспроизведённый multi-writer пробел; обычный daemon частично защищён общей root writer lease. Нужна одна явная authority/lease, не обвинение single-instance queue.
- Устаревший takeover guard может блокировать последующее открытие после аварии. Apply/export/import и delivery preparation имеют отдельные recovery boundaries; Cordis notification не заменяет durable intent.
- Полные логи обещаны, но collector оставляет последние30K символов. Review context содержит имена и размеры файлов, а полную картину reviewer должен заново добывать инструментами с ограниченной выдачей.

Детали, источники, ограничения доказательств и тесты: [агентный аудит](../output/research/agent-system-audit-2026-11-21.md), [хранение и политика](../output/research/persistence-policy-audit-2026-11-21.md), [reproducer](../output/research/agent-audit-repro-2026-11-21.ts).

## Где архитектура пока недостаточно гибкая

**Закрытая production-композиция.** RuntimeCatalog принимает произвольный runtime, но нормальная фабрика знает только Ollama/DeepSeek и ветку Codex/managed. Добавление backend затрагивает фабрику, схемы и UI. Нужен trusted contribution registry с factory, конфигурационным parser, capabilities и lifecycle. Не требуется открывать произвольные невалидируемые RPC или исполнять предложенный моделью plugin-код.

**Хранилище нельзя заменить только plugin-ом.** createHost открывает конкретные FileProjectStore, а ProjectManager работает с конкретным registry и объединяет прикладные сценарии с filesystem/Git. Выносим сценарии проекта в application services и инжектируем store factory, catalog, repository/workspace/check ports.

**Демонстрационные данные встроены в продукт.** Daemon всегда создаёт `codex-panel`/`goal-poc`, demo checks и write policy. Production startup должен работать с пустым каталогом и подключёнными проектами; demo — явный отдельный режим. UI/CLI discovery тоже не должны требовать seeded ID. MCP Buro пока не реализован: будущий адаптер должен использовать тот же application API.

**Workflow зафиксирован в ExecutionService.** Обязательные planning/integration и repair через координатора сохраняют лишнюю стоимость и теряют контекст исполнителя. Нужен небольшой Buro-owned state machine с заменяемой стратегией writer → checks → fresh critic → same-writer repair; координатор добавляет декомпозицию, тест-автора и специалистов по необходимости. Не нужен новый универсальный DAG DSL до доказательства пользы.

**Равноправие клиентов пока неполное.** Planning, check isolation, часть UI/setup и default profile зависят от имени клиента. Заменяем на capability/effective-policy решения. Codex, managed runtime и внешний harness могут исполнять любые подходящие роли, но не объявляют несуществующие read-only/cancel/accounting возможности.

[Cordis/модульность](../output/research/cordis-modularity-audit-2026-11-21.md), [backend parity](../output/research/backend-parity-review-2026-11-21.md), [UI/API/тесты](../output/research/product-test-surface-audit-2026-11-21.md).

## Автономия вместо скрытых ограничителей

Слишком ограничивают полезную работу: независимые64/24/256 request ceilings, четыре окна и два feedback/repair, max2 роли при последовательном исполнении, `src/` как исходный обязательный scope, запрет второго run на проект, обязательное пояснение для repair в UI, terminal ошибки формата, неполный поиск/чтение и ожидание restart после настройки подключения.

У каждого ограничения разная замена: убрать default quota; yield вместо failure; advisory scope; incremental assignments; очередь capacity вместо project-wide lock; безопасный format recovery; страницы вместо потери данных; отдельная revision для будущих сессий вместо изменения активного endpoint. Простое удаление всех чисел не решает ни управление контекстом, ни сохранность действий.

Выбранная пользовательская модель: компактно показать «Модели / Команда / Файлы / Лимит расхода», фактическое значение и источник, а при остановке — причину, сохранённый прогресс и доступное действие. API возвращает effective policy и typed wait/stop, UI не вычисляет их по бренду клиента. Расход наблюдаем всегда; общий hard quota — только явно.

Полная матрица случаев и проверок: [AUTONOMY-POLICY](AUTONOMY-POLICY-2026-11-21.md). Она является актуальным решением для advisory/strict scope и прозрачного продолжения, даже если более ранний документ подразумевал обязательный planned scope.

## Переиспользование и пакеты

Не переписываем готовый transport/streaming/tool-loop только ради собственных имён. Но библиотека должна позволять Buro сохранить управление эффектами и проверкой результата. Конкретное сравнение SDK и backend — в [исследовании reuse](../output/research/agent-framework-reuse-2026-11-21.md); разбор mini на зафиксированном исходнике — в [mini-SWE fit](../output/research/mini-swe-buro-fit-2026-11-21.md).

**Первый выбранный кандидат — TS pi-ai + pi-agent-core**, через host-wrapped model/tool execution и canonical context; без полного pi-coding-agent и встроенного unrestricted shell. Сначала проверяем contract spike, а не заменяем рабочий runtime. Если fail-closed journal/cancel и continuation требуют слишком сложной обвязки, используем только model transport; контрольный вариант — AI SDK direct provider с tools без autoexecute. Не запускаем два вложенных agent loop.

AI SDK Harnesses уже отдельно представляет native clients, включая Codex, но проверенный Codex adapter требует sandbox/bridge и имеет особенности permission/resume. Это отдельная возможность reuse после проверки окружения, а не готовая замена local app-server. OpenAI Agents JS полезен как interface/runner reference, LangGraph — как источник durable-execution практик; второй Runner/workflow engine рядом с Buro не добавляем.

Во всех вариантах явно задаём model/credentials/retry/stop/telemetry. Внешние SDK тоже содержат defaults: maxTurns/steps, внутренние retries, parallel tools и другие timeout/accounting assumptions. Нужные Buro guarantees не следуют из наличия callbacks; host commit grant и receipt оборачивают сам эффект. Совместимый API Ollama не должен незаметно потерять native context/digest/local-only свойства.

[Private-project evaluation details removed.]

Четыре целевых пакета: `agent-contracts`, `agent-runtime`, `model-providers`, `agent-adapters`. Их зависимости направлены к contracts; ни один универсальный пакет не импортирует Buro Project/Goal/Git/Cordis/UI. Buro сохраняет продуктовый workflow, команды, проверку и acceptance. Хост выдаёт authority и реализует journal; в Buro operation/usage/Run/event/receipt фиксируются одной транзакцией. Подробнее: [границы пакетов](REUSABLE-AGENT-PACKAGES-2026-11-21.md).

## Порядок реализации

1. **Корректность результата и продолжения.** Регрессии и исправления revision-bound acceptance, owning-run unknown gate и apply intent/reconciliation. Typed JSON recovery. Это до массового перемещения кода.
2. **Общие контракты и видимая автономия.** AgentBackend/ModelProvider/capabilities; advisory/strict policy; typed stops; убрать client-name привилегии. Сохранить простой production workflow и доказать работу без установленного Codex.
3. **Короткий reuse spike.** Сначала pi-ai/pi-agent-core с host journal, sequential tools и canonical context; контроль AI SDK transport. Проверить streaming/tools/cancel/context и fail-closed ошибки журнала. Отдельно optional mini backend без форка. Сравнить объём собственного кода и выполнение контрактов, затем выбрать основной путь. Codex Harness reuse — после sandbox parity, без привилегий клиента.
4. **Настоящая plugin-композиция.** Backend/provider/workflow/tool/context и project-analysis/check-recipe contributions через Cordis. Store factory, application services проекта, пустой startup; demo вынести отдельно. Закрытые first-party API схемы сохранять там, где открытое расширение не нужно.
5. **Долговременное исполнение.** Один SQLite authority, инкрементальный учёт, полные private artifacts и paged history/context. Чистый pre-release переход с архивом старого состояния, без legacy resume. Активировать default-none только после удаления всех lower-level lifetime stops.
6. **Качество и переносимость.** Same-writer repair, свежий critic на каждую изменённую ревизию, полные review packets. Выделять/устанавливать четыре пакета постепенно; независимый consumer без source aliases. Тестировать не только imports, но и реальное поведение exports.
7. **Масштабирование автономии.** Incremental team, несколько isolated run, capacity queues, точные session/attempt проекции и MCP через общий API. Качество небольших моделей подтверждать repeated held-out задачами с compute-matched baseline; RTX не трогать до сообщения пользователя о доступности.

После каждого этапа: соответствующие регрессии и contract tests, ревью архитектурных границ, отдельный коммит, отчёт; затем продолжать. Не обещать новую семантику по одному переименованному полю или зелёной сборке.

## Что не требуется сейчас

Микросервисы, совместимость со старыми prototype checkpoints, второй scheduler/ledger, marketplace с произвольным UI-кодом, общий DAG DSL и обязательный hot reload активных backend. Перенос файлов в packages сам по себе не исправляет acceptance/recovery и не делает API переносимым.

Новые live-прогоны и перенос библиотек ещё не выполнялись. Этот этап завершает ревью, фиксирует решения и план; проблемы, найденные в исходниках, остаются до следующих implementation-коммитов.
