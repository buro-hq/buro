# Ревью сложности Buro перед первым релизом

Дата: 22 ноября 2026. База: `85ade5b` и текущие незакоммиченные исправления native startup, planning и RTX-стенда. После вопроса пользователя об избыточной сложности дальнейшие правки остановлены для отдельного ревью. Реализация заморожена: case v2 не применён, новые запросы к моделям/RTX не выполнялись, код не откатывался. Пять агентских ролей провели короткие read-only проверки workflow, хранения, evaluation и независимые проверки рекомендаций; отдельные новые агентские отчёты не создавались.

## Вывод

**Да, обязательный путь задачи и промежуточная миграция усложнены сильнее, чем оправдано текущими доказательствами полезной работы.** Основные проблемы — лишние модельные переходы, два представления Run в незавершённом storage-переходе и растущий стенд, который проверяет сложный командный режим раньше простого рабочего цикла. Модульный монолит и сами границы Core/adapters/protocol остаются подходящим основанием.

Я слишком долго продвигал полноту архитектурного плана до ранней проверки рабочих маршрутов. Наличие 1380 зелёных тестов не закрыло реальные ошибки запуска native review и противоречие в постановке smoke-задачи. Это ошибка приоритетов и состава проверок, а не основание удалить тесты и защитные инварианты.

Приоритеты ниже относятся к стоимости/надёжности первого полезного результата; они не являются оценками новых security vulnerabilities. Предложенные изменения ещё не реализованы и не утверждают сокращённый scope беты.

## Находки

### P1. Для простого исправления обязательна лишняя модельная церемония

В `core/execution.ts:1323` запускается planning, затем требуется полный TeamPlan и его приёмка (`:1403`, `:1508`). Даже при пустой команде следует отдельный writing/integration turn (`:1555`). С одним worker после его работы координатор всё равно получает ещё один запрос на интеграцию (`:1545–1563`). Для native read-only planning дополнительно создаётся отдельная writer session (`:1509–1539`).

Без исправлений и внутренних tool rounds это минимум три логических completed turns для пустой команды: plan → writer → critic. С worker — четыре: plan → worker → coordinator integration → critic. Это не точное количество HTTP/API requests: каждый turn может содержать несколько генераций.

**Поправка:** production не требует worker для каждой задачи — `team=[]` допустим. Отдельного работника принуждает comparison-стенд (`scripts/lib/model-comparison.cjs:748`, `scripts/lib/live-provider-runner.cjs:1113`). Подменять одно другим в выводах нельзя.

Рекомендуемое упрощение: обычная малая задача сразу поступает одному scoped writer; checks и свежий critic обязательны. Декомпозиция/команда включаются при полезной необходимости. Это соответствует уже выбранному дизайну (`docs/EXECUTION-DESIGN-DECISION-2026-11-21.md:7`). Реализовывать следует в существующем execution path с честным admission grant, без второго движка, фиктивного принятого плана или нового универсального framework.

### P1. Исправления передаются другому автору, а контекст приходится исследовать повторно

Checks и findings возвращаются в `root.threadId`, то есть координатору (`core/execution.ts:1777–1782`, `:1936–1943`), хотя исходный worker уже завершён/released (`core/worker-assignments.ts:288–289`). Для одного автора это лишняя передача задачи и расход контекста. Координатор оправдан для конфликтов нескольких назначений, но не для каждой локальной поправки.

Reviewer получает `changeContext`, состоящий из path и длин before/after (`core/agent-context.ts:30–35`), и должен отдельно читать actual diff/source (`core/execution.ts:1853–1862`). Проверенная ревизия уже есть, но её небольшой готовый diff не подаётся сразу.

Упрощение: findings возвращаются тому же writer; после изменения проходят новые checks и свежий review. Для небольшого изменения reviewer получает полный проверенный diff/source/check evidence из immutable view; большой ввод предоставляется частями с явной полнотой. Native read-only planner нельзя превращать в writer, стирая его permission boundary: если такой отдельный planner действительно выбран, нужен отдельный writer grant.

### P1. Storage-переход долго платит за два представления, не заменяя production executor

Production использует одну File authority (`plugins/host.ts:185–187`); новые facets разделяют её же транзакцию (`adapters/files/project-store.ts:86–101`). Live JSON/SQL dual-write отсутствует. SQLite — отдельно проверенный kernel, не второй работающий executor.

Но внутри File рядом существуют старый Run и новые current/admission/attempt/workspace/plan maps (`adapters/files/project-runs.ts:38–81`). Commit/open guards нужны для их согласования (`adapters/files/project-run-attempts.ts:267–321`, `adapters/files/project-run-plans.ts:230–255`). При этом `ProjectStore` по-прежнему требует и узкие facets, и snapshot/generic transact (`core/ports.ts:39–51`); execution/results/apply всё ещё читают общий Run. Каждый дополнительный scalar переход прибавляет миграционную работу, пока основной путь остаётся прежним.

Рекомендация: прекратить расширять промежуточные представления до стабилизации простого execution path. Следующий storage milestone переносить вертикально вместе с реальным session/effect producer, reader и условием удаления старого writer. Существующие guards не удалять, пока обе формы остаются. Для согласованного default-none/full-history нормализованное хранение по-прежнему обосновано; пауза в расширении SQL не означает разрешение выпустить ограниченную File-бету.

### P2. Маленькая модель тратит бюджет на обслуживание нашего протокола

`core/managed-runtime.ts:236–251` дописывает JSON schema к каждому tools-free user turn. Текущий request отдельно несёт schema, а `core/request-policy.ts:23–48` оценивает все эти данные как UTF-8 bytes плюс overhead. В реальном Qwen correction estimate составил 15 595 при reported input 2813; из 16K осталось 789 output tokens. Полный отклонённый план и повторные schema заняли бюджет до coding. Недавнее уточнение reuse/create улучшает диагностику, но при том же старом плане даёт 783, а не устраняет squeeze.

Кроме того, worker может принудительно закрывать segment уже после трёх tool rounds, независимо от действительного заполнения контекста (`core/work-segments.ts:37–49`, `core/managed-coding-context.ts:97–128`). Несколько чтений/поисков могут привести к дополнительному closing/handoff до полезного edit.

Упрощать стоит host-owned request view, повторные служебные данные и ранние administrative turns. Обязательны корректная provider projection, сохранённая полная история и rotation на settled boundaries. Произвольное деление estimator, удаление пользовательских требований, сброс counters или бесконтрольное повышение лимитов не являются упрощением.

### P1. Стенд проверяет сложный маршрут и иногда создаёт собственные причины неуспеха

Основной comparison всегда включает forceWorker, хотя для двух файлов это не доказанная необходимость. TASK v1 одновременно запрещает process spawning (`scripts/lib/model-comparison.cjs:27`), а в последнем native trial worker сообщил, что доступное ему чтение файлов требует foreground shell, и остановился без edit; review в нём не был достигнут. [Сохранённая выписка состояния, oracle и reported blocker](../output/research/complexity-native-trial-evidence-2026-11-22.json) отделяет наблюдаемый отказ от недоказанного утверждения, что у всех native-клиентов отсутствует иной reader. Это не новое доказательство плохого кода или сломанного default permission fix. Версия case v2 ещё не создана.

Fake native fixture принимает произвольные argv и сам подтверждает profile (`tests/codex-verification.test.ts:19–33`); поэтому зелёные wire-тесты пропустили реальный startup requirement `default_permissions`. Дополнительные инструкции/варианты стенда после каждого сбоя растят обслуживаемую систему, но не обязательно приближают пользовательский результат.

Нужны один проверенный task contract, один bounded installed-client preflight и основной live baseline writer → checks → critic. Team mode — отдельный arm того же case/oracle. Противоречие процесса уточняется единожды с новым task hash и сохранением старых результатов. Полезность измеряется edit/checks/review/acceptance; unit/fault tests остаются самостоятельным слоем доказательств.

### P2. В evaluation дублируются параметры, бюджеты и смысл ошибок

Обычный CLI ещё принимает legacy/bounded, которые runner отвергает (`scripts/check-model-comparison.cjs:10–26`, `scripts/lib/model-comparison.cjs:687`). Pending RTX CLI добавляет второй parser/путь валидации; `validateRtxComparison` временно подставляет loopback для общего validator, а `rtxEvaluationContract` повторяет часть проверок. Это новая сложность из текущего незакоммиченного этапа — её не следует сохранять только потому, что она уже написана.

`classifyEvaluationFailure` в основном опирается на message heuristics и сводит неизвестное к quality failure (`scripts/lib/live-provider-runner.cjs:712–797`), затем `summarizeProvider` теряет часть status (`scripts/lib/model-comparison.cjs:600–614`). Так native infrastructure failure ошибочно стал «качеством модели» и потребовал ручной расшифровки.

Transport pilot, session/turn и Run имеют разные allowance/reserve (`scripts/lib/live-provider-runner.cjs:10–17`, `:933–939`, `protocol/run-budget.ts:42–47`). Внешний pilot может закончиться, когда внутренний Run ещё считает review обеспеченным.

Упрощение: один небольшой validated evaluation target и общий CLI/runner, одна typed stop/result projection и один согласованный budget input для эксперимента. Сохраняются exact trusted endpoint, synthetic-source/live opt-ins, redirect rejection, реальные production usage receipts и честное unknown покрытие native. Это не разрешение доверять любой LAN-машине или объединять независимые реальные usage counters с фиктивным нулём.

## Что сохранять

Модульный монолит, существующие backend/provider ports и отсутствие UI/framework imports в Core полезны. Нужны отдельный worktree, scoped tools, неизменяемая ревизия для checks/review/checkpoint, независимый свежий critic, current owner/grant checks, private credentials, durable intent и запрет повторения неизвестных effects. Git apply сохраняет branch/HEAD/dirty checks и prepared/dispatch/settle. Эти механизмы уже закрывали воспроизведённые ошибки; их удаление создаст дефекты вместо простоты.

## Рекомендуемый порядок после этого ревью

1. Зафиксировать один минимальный пользовательский сценарий и критерий успеха: один writer исправляет маленькую реальную задачу, сервис проверяет точную ревизию, новый critic одобряет или возвращает конкретный defect тому же writer. Выполнить одинаковые public/holdout cases на рабочих backend без обязательной команды.
2. В существующем workflow убрать необязательные planning/integration/closing переходы из обычного малого пути. Сохранить команду для задач, где она полезна, и измерять её отдельно. Не добавлять параллельный execution framework.
3. Довести одно installed-client preflight и один evaluation entrypoint/status/budget. Pending native default fix остаётся небольшим отдельным кандидатом; pending RTX дублирование пересмотреть до merge. Имеющиеся незакоммиченные правки этим ревью не откатываются и не считаются автоматически принятыми.
4. После подтверждённого простого цикла вернуться к единой authority/context/history как целому milestone с критериями удаления временных мостов. Default-none и полная восстанавливаемая история остаются выбранными требованиями. Ограниченный первый релиз потребует отдельного решения, которое это ревью не принимает.

## Основание и границы ревью

Прочитаны реальные production paths, pending diff, выбранный execution design и результаты последних настоящих прогонов. Пять read-only проверок независимо подтвердили основные выводы и необходимые контраргументы. Новые тесты/модели/RTX не запускались ради этого документа. Последний полный gate **1380/1380**, build/typecheck относится к замороженным pending fixes, а не доказывает успех каждой live-задачи.

Для контекста роста: между baseline `601f26e` и committed `85ade5b` количество tracked файлов Core выросло 35→66, adapters 33→73, tests 79→211. Это не метрика качества само по себе. Существенны конкретные незавершённые зависимости и дополнительные обязательные переходы выше. SQL cutover, default-none, новый простой workflow, новый case и переработка стенда этим ревью не реализованы.
