# Default-none и удаление старого execution-кода

Дата: 23 ноября 2026. Исходный коммит `189502a`. Пользователь явно потребовал убрать ограничения по умолчанию и проверить похожие недоделки во всём проекте. Пять агентских ролей работали волнами: usage/worker resolution, managed runtime/checkpoints, delegation/continuation, evaluation и независимое ревью. Это исправление текущего продукта до первого релиза; совместимость и миграции прототипных состояний не добавлялись.

## Текущее поведение

Новый managed Run сохраняет policy `{version:1}`: стандартного общего лимита requests, reserved output или tools нет. Учёт остаётся обязательным: reservations, фактический и неизвестный usage, владельцы, immutable receipts, idempotence, rollback и нарушения учёта сохраняются. Отсутствие лимита выражено отсутствующим полем, а не большим числом или Infinity. Явные пользовательские квоты и review reserve продолжают проверяться. Ошибки учёта не показываются как вымышленный встроенный бюджет.

В managed runtime отсутствуют стандартные ограничения requests per turn, tools per turn, session requests и двух feedback-исправлений. Сегменты контекста не ограничены стандартным количеством окон; явно заданные segment/tool/request/session/feedback ограничения сохраняются при resume и не могут сбрасываться. Конечные окна context/output, фактические capabilities провайдера, права на файлы, таймаут отдельной операции и отмена остаются отдельными контрактами.

`maxWorkers` необязателен. Новая конфигурация проекта не ограничивает команду двумя специалистами. При явном значении ограничение действует, при отсутствии состав команды выбирает координатор. Это отдельный параметр от физической concurrency модели: Buro не начинает параллельный inference только потому, что разрешено больше ролей.

В evaluation также нет стандартных 24 запросов, 65 536 reserved output, двух diagnostics или общего deadline в пять минут. Явные ограничения задаются через `--max-requests`, `--max-reserved-output-tokens`, `--max-diagnostic-requests`, `--overall-time-ms`. Физические настройки доступны через `--context-tokens`, `--max-output-tokens`, `--request-timeout-ms` и provider context override. Старый особый Ollama 16K и team allowance 1 из свежих сравниваемых профилей убраны. Прежние реальные отчёты не переписаны и не выдаются за результаты нового режима.

Убраны общие пределы размера material library 1000 и 64 активных материалов, 32 выбранных вложения цели и каталоговые ceilings connections/runtimes/profiles/worker pool. Уникальность, immutable identity, ссылки, canonical reactivation и атомарность batch сохраняются. Размер одного файла/import request, число записей страницы и границы изоляции остаются ограничениями конкретного IO-запроса.

## Что удалено

Старого обязательного planning graph больше нет: `PlanningPolicy`, `TeamPlan`, `RunPlan`, `acceptPlan`, read-only planner handoff, plan ancestry, `planSavedAt`/`planningSession`, прежние plan events и SQL-таблицы удалены. Делегирование использует самостоятельные `WorkerProposalSchema`, `resolveWorkerRole` и immutable grants; текущий контекст — `RunDelegationContext`. AI-план `Run.plan` и событие `plan.updated` сохранены. Координатору не требуется read-only/tools-free capability старого планировщика; reviewer по-прежнему требует реальной независимой проверки immutable view.

Удалена закрытая экспериментальная ветка из 10 файлов со своим фиксированным plan→test-author→executor→review и maxRepairs. Она не имела production-потребителя. Исторические результаты и исследовательские документы сохранены с пометкой об удалённом исполнении. Неиспользуемый генератор planning prompt, его отдельный input ceiling и тесты ушедшего pipeline удалены; действующие проверки перенесены на реальные delegation/attempt команды.

Цель обязана хранить выданную revision. Подстановки отсутствующей revision как 1 убраны из Core, SQL, UI и replay. `goal.create` выдаёт 1 самостоятельно; невалидное сохранённое состояние не превращается в свежую цель.

Managed checkpoint обязан хранить непустую, последовательную историю выданных scope revisions, согласованную с текущим scope. Использованная сессия обязана хранить настоящий turn journal. Восстановления из первого system-сообщения и подстановки первой ревизии нет. Чистый старт без использованных turn остаётся допустимым; `purpose` не сделан обязательным для общего API.

Полная текущая цель при отсутствии compact task называется `full-goal`: это действующая семантика задания, а не старый формат. Native child activity хранится как недоверенные `activityHints` и не выдаёт grants. Активный File aggregate/projection bridge сохранён как текущий источник данных; его нельзя удалять под видом совместимости.

Environment preparation больше не прекращает исправление после трёх предложений. Исправимы только ошибки полученного рецепта; configuration/transport/unknown outcome сохраняют свой тип и не превращаются в новый model call. Повторный фактически проверенный setup failure, неопределённый исход команды и явно заданный рецепт остаются конкретными результатами подготовки, а не общим бюджетом качества.

## Доказательства и границы

Проверяются настоящий Managed/Pi/File путь с 262 генерациями и 260 tools, более 16 context windows, пять failed-check исправлений; File/SQL reopening после 80 requests и 163 840 reserved output, 1000 tool charges; сохранность явных квот, unknown outcomes, receipts и невозможность reset. Новые negative cases покрывают отсутствующую Goal revision, forged delegation context, отсутствующие scope/turn authorities и противоречивый current scope.

Production остаётся на File. Самостоятельный SQL adapter имеет свежий формат v10 без миграций; это не production SQL cutover. Полный File aggregate продолжает расти: paged persistence и полная effect/session journal migration не объявлены выполненными. Default-none означает отсутствие стандартных накопительных квот, а не бесконечные память, диск или контекст одного запроса.

Новых реальных модельных/RTX запросов этим этапом не выполнялось. Ранее Qwen 4B несколько раз исправила синтетический код с public/holdout 8/8, но автономная приёмка через checks/review осталась недоказанной. RTX по сохранённому адресу не была доступна. DeepSeek/Codex не перепроверены на этом коде. Чистая установка, adverse crash recovery и более широкое реальное качество остаются первыми release gates. Сокращённый scope беты и публикация не утверждены. Оригинальные проекты и `output/ux/` сохранены.

Финальные проверки: **1379/1379 tests**, 0 skips, **81 280.548875 ms**; build/typecheck, форматирование и diff-check прошли. Production browser: **17 project scenarios**, **7 autonomy/recovery assertions**, **5 localization scenarios**, ошибок нет, модельные запросы UI отсутствуют. Независимые 161/161 и 43/43 probes пересекаются с полным suite и не суммируются. [Validation receipt](../output/research/default-none-cleanup-validation-2026-11-23.json) содержит provenance, hashes кода и подтверждение сохранности всех прежних реальных trials.
