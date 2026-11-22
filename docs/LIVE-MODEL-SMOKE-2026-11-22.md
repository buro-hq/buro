# Реальная проверка текущего Buro

Дата: 22 ноября 2026. Исходный код продукта: `5a09e30` (после реализации `233bcc8` и предварительного ревью). Пользователь разрешил реальные испытания. RTX не использовалась; передавались только заново сгенерированные синтетические файлы. Исходные проекты и `output/ux/` сохранены. Каждый маршрут запускался последовательно на отдельном новом Git-проекте.

## Задача и критерий успеха

Одна одинаковая небольшая задача: исправить выбор готовых элементов очереди, приоритет 0, проверку всех зависимостей, стабильную сортировку и сохранность входных данных. Разрешены два исходных файла. Три открытых и пять скрытых случаев проверяет контроллер вне модели; expectations и исходные inputs защищены. В Buro требуется настоящий отдельный worker, сервисные проверки, новый независимый reviewer и acceptance commit. Правильный кандидат без завершённого review остаётся непринятым.

Зафиксированы модели `gpt-6.1-sol` с high reasoning, `deepseek-flash`, локальная `qwen3:4b-instruct-2507-q4_K_M`. Planning выбирается по реальным capabilities. На coding — пять минут; managed pilot ограничен 24 генерациями вместе с двумя diagnostics и 65 536 зарезервированными output tokens. Эти лимиты не поднимались. Внутренние запросы и context/output ceilings native Codex имеют другое покрытие, поэтому данные не дают честного рейтинга скорости, цены или эффективности токенов.

## Исходная матрица

| Маршрут  | Public / holdout | Результат Buro                                                                                                                                              | Время с setup/diagnostics |
| -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Codex    | 3/3, 5/5         | Worker исправил код; review заблокирован ошибкой подключения verification view в стенде. Acceptance отсутствует.                                            | 102.848 с                 |
| DeepSeek | 3/3, 5/5         | Принято: отдельный успешный worker, свежий reviewer approved, все сервисные проверки и commit.                                                              | 37.139 с                  |
| Mac Qwen | 0/3, 3/5         | Не принято: первый план выбрал роль вне каталога, ответ на коррекцию оборвался (`length`, сохранённый stop `MODEL_INCOMPLETE`). Плана, worker и правок нет. | 57.909 с                  |

У DeepSeek было 19 HTTP-генераций: две diagnostics и 17 coding; observed input/output — 50 320 / 3 051. У Qwen — четыре генерации, включая две diagnostics. Три пройденных Qwen holdout-case — поведение неизменённого исходника, а не полезное частичное исправление. У Codex наблюдалось 139 162 / 2 999 input/output tokens; количество внутренних запросов неизвестно. Billing cost не измерялся.

[Исходные raw results](../output/evaluation-2026-11-22/current-synthetic.json), [manifest](../output/evaluation-2026-11-22/current-live-manifest.json), [typed stops из сохранённого состояния](../output/evaluation-2026-11-22/initial-run-stops.json), [хеши исходных отчётов](../output/evaluation-2026-11-22/initial-report-hashes.json). Первый неуспех Codex не перезаписывается последующим результатом. Collector ошибочно назвал его quality failure; фактическая причина — `VERIFICATION_VIEW_CHANGED`, «The verification view is not registered». Отсутствующий native reported-model field также не является доказательством запуска другой модели.

## Исправление стенда

Custom check adapter синтетического fixture игнорировал общий executor и переданный `verificationView`. Обычный production `ProjectChecks` регистрирует view правильно. Поэтому первый прогон не доказал такую же ошибку продуктового пути и не доказал плохое качество Codex.

Изменён только `scripts/lib/model-comparison.cjs`: checks теперь используют настоящий `ProjectChecks` с общим executor и правильным release. Независимый oracle сохранён дополнительно к защищённой public-команде и проверяет issued immutable readRoot через `launchVerification`; служебные каталоги в снимке не создаются. Native guard, Core, production adapters, profile, fixture/task/oracle hashes и лимиты не менялись. Реальный service-check path стал полнее, поэтому отдельный follow-up не равен повторению измерения с полностью прежним стендом.

Регрессия воспроизводит missing registration после checks на старом стенде. Исправленный вариант проверяет регистрацию и отзыв native policy, отказ при подмене tree/workspace, отсутствие `.buro/environment` в readRoot и отклонение кандидата, который подменяет public assertions. Подробности: [исправление](../output/research/live-native-view-harness-fix-2026-11-22.md), [диагностика и независимые границы](../output/research/live-codex-diagnosis-2026-11-22.md), [ревью стенда](../output/research/live-harness-review-2026-11-22.md).

## Отдельный Codex follow-up

После исправления стенда и зелёных offline gates выполнен один новый Codex-прогон на новом fixture с прежними моделью, reasoning, задачей и лимитами. Он занял **120.941 с**. Worker снова дал корректный кандидат: **3/3 public и 5/5 holdout**, сервисные проверки **1/1**.

Workflow снова остался непринятым. Регистрация view исправлена, но настоящий native-клиент остановился на следующем шаге: **`ENVIRONMENT_UNAVAILABLE`**, «The native client could not establish the required immutable-review permission profile». Свежий reviewer не завершился, acceptance commit отсутствует. Это текущий блокер native review integration; по этому прогону нельзя объявить Codex end-to-end рабочим. Guard не ослаблялся и review не пропускался. Дополнительного live retry не было.

[Follow-up results](../output/evaluation-2026-11-22/codex-verification-followup.json), [manifest с SHA256 исправленного стенда](../output/evaluation-2026-11-22/codex-followup-manifest.json), [сохранённый typed stop](../output/evaluation-2026-11-22/codex-followup-stop.json). Исходные четыре raw report-файла сохранили прежние SHA256. Collector снова свёл infrastructure stop к quality failure; интерпретация основана на сохранённом typed stop, а не на этой эвристике.

Локальный network-denied probe установленного `codex-cli 0.171.0` затем воспроизвёл конкретную startup-ошибку: `config defines [permissions] profiles but does not set default_permissions`. В нём использовались только временные HOME/CODEX_HOME/config, без auth environment и model turns; сервер завершился до initialize. Buro передаёт `permissions.<id>`, но не задаёт обязательный default. Следующий кандидат исправления — `default_permissions`, указывающий на тот же выданный read-only профиль, с сохранением проверки acknowledgement. Этот production-фикс и новый live-прогон данным этапом не выполнены. Предыдущая offline-проверка `codex sandbox -P` выбирала профиль явно и не покрывала startup app-server; fake wire tests также этого не обнаруживали.

Практический итог этого case: **DeepSeek прошёл полный цикл; Codex исправляет код, но блокируется при immutable review; локальная Qwen не дошла до реализации.** Следующий продуктовый фикс — установка того же ограниченного default permission profile и проверка настоящего app-server, а для Qwen — валидный план и полный ответ в её текущем контексте. Продолжение SQL-рефакторинга само по себе эти результаты не исправит.

## Валидация изменения

После изменения стенда полный suite **1369/1369**, без skips, 80 952.941084 ms; build/typecheck и форматирование изменённых source/test прошли. Независимые focused gates **14/14** и **21/21**, implementation gate **40/40** пересекаются с полным набором и не суммируются. Реальные sandbox-проверки выполнялись с необходимыми host permissions; вложенный workspace sandbox давал ограничения окружения, ради которых проверки не ослаблялись.

Пять агентских ролей работали волнами: стенд/ограничения, case/oracle, runtime и исправление check adapter, диагностика native границ, независимое ревью результатов. [Ревью результатов](../output/research/live-result-review-2026-11-22.md) отдельно проверяет code correctness, service acceptance, сохранность raw reports и границы сравнений. Browser UI не менялся и заново этим этапом не проверялся; прежние 37 сценариев остаются историческим свидетельством предыдущего этапа.

## Границы вывода

Это один небольшой case на маршрут, с отдельным follow-up после исправления инфраструктуры. Проверка не устанавливает общую надёжность моделей или превосходство Buro над прямым запуском. Намеренные reviewer rejection/repair, public-check-passing negative acceptance, аварийный restart, result application и чистая установка в этом live-прогоне специально не проверялись. Синтетическая spoofing-регрессия стенда не заменяет такой настоящий отрицательный model-case.

Приёмка не ослаблялась ради зелёного результата. Новые runtime/storage/default-none возможности этим этапом не добавлены. Сокращение scope беты и публикация не утверждались.
