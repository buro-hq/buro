# Pi SDK: проверка опубликованных пакетов и изолированный fake spike

Дата: 21.11.2026. Это подготовка к этапу3, не завершённая интеграция с Buro. Production dependencies, package.json/lock проекта, модели, RTX, `.buro` и исходные проекты пользователя не затрагивались.

## Проверенная доступность

Оба пакета **действительно опубликованы** в npm public registry, версия не восстановлена по README или имени ветки:

| Пакет | Версия | Engine | Registry integrity |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai` | `1.6.0` | Node `>=22.19.0` | `sha512-9hL+eygFDEiFp//cydeUfmFsKmEqpmvsNPb10Y1W8+m5K9O+sx1hMStfu6nukrBD5sl6mP4RykCYBBNEgsVLfw==` |
| `@earendil-works/pi-agent-core` | `1.6.0` | Node `>=22.19.0` | `sha512-IU/x+2XtE4KIdIkEndZssdLPbIUR38Btj+Q7vjIIXIK7GSamLtDH5jOw/dzBWAvWFAgZ2dslF5sPc6GcGOnS+w==` |

Первичный источник — `npm view` и затем `resolved`/`integrity` установленного package-lock. Tarballs: [pi-ai](https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.6.0.tgz), [pi-agent-core](https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-1.6.0.tgz). Установленные package manifests указывают MIT; это не транзитивный license audit.

Создан отдельный каталог `/private/tmp/buro-sdk-spike-JVi17H` с собственным package.json и package-lock. Установка:

```sh
npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --save-exact @earendil-works/pi-ai@1.6.0 @earendil-works/pi-agent-core@1.6.0
```

Установлены88 пакетов; lifecycle scripts отключены. Runtime проверки — Node24.9.0. Пакеты импортировались из установленных dist exports, без source aliases и без GitHub checkout.

## Что реально выполнено

Восемь Node tests с реальным установленным `runAgentLoop` и `AssistantMessageEventStream`, но **fake streamFn/tools/journal**. Процесс запускался с очищенным environment. Перед dynamic import отключены fetch/http/https/net; финальная проверка подтвердила0 попыток networking. Учёт usage/cost в fake сообщениях синтетический и не является измерением provider billing.

| Сценарий | Наблюдение |
| --- | --- |
| Streaming + два tools | `text_delta` дошёл до agent events; при явном sequential каждый `grant -> effect -> receipt` завершился до следующего эффекта |
| Обычный throw из tool.execute | SDK превратил ошибку в model-visible tool error и сделал **ещё один** запрос |
| Host grant failure | Wrapper сохранил fatal state, abort и finishTurn=end:0 эффектов,1 исходный fake model request, без продолжения |
| Receipt failure после эффекта | Fake journal оставил `unknown`;1 эффект, второй не исполнялся, следующий model request отсутствовал |
| Canonical context | transform исключил ненужное application message из model packet и сохранил исходные сообщения host context |
| prepareRequest throws | До streamFn не дошло; promise rejected, нормального agent_end нет — нужен внешний error boundary |
| Abort | Signal дошёл в streamFn; aborted response завершил loop без tools |
| Больше20 запросов |25 последовательных fake requests и24 effects завершились без встроенного20-step ceiling этого loop |

Итог: **8/8 passed**, примерно0.1сек. Это проверка API механики; ни одного настоящего HTTP provider запроса или файлового tool эффекта в тесте нет. Fake Map journal не доказывает crash durability, exactly-once или restart в Buro.

Исходник собственных проверок сохранён: [sdk-spike-pi-fake-2026-11-21.mjs](sdk-spike-pi-fake-2026-11-21.mjs). Он намеренно не входит в обычный `npm test` Buro и требует отдельной установки указанных SDK. Для повторения скопировать этот файл в отдельный npm-каталог с указанными зависимостями и выполнить `node --test sdk-spike-pi-fake-2026-11-21.mjs`; запускать с пустым environment и без provider credentials. Текущие script/lock/log также оставлены в указанном временном каталоге. Транзитивный lock для production adoption нужно зафиксировать уже в соответствующем implementation-коммите.

## Следствия для архитектуры

**Pi пригоден для следующего узкого integration spike.** Не требуется fallback из-за отсутствия пакета или неподходящего Node engine. Существуют отдельные generic loop/transport exports, injectable streamFn и hooks, JSON-schema tools, explicit sequential mode и streaming. AI SDK transport остаётся контрольным вариантом, но не устанавливался в этой подготовке, поскольку Pi доступен и проверка его базовой механики прошла.

При этом простая замена нашего цикла на SDK **не сохраняет гарантии автоматически**:

1. Failure host admission/journal нельзя передавать только как throw из tool.execute: SDK может считать это обычной исправимой tool error. Нужен внешний fatal/reconciliation state с отменой текущего batch и явным окончанием cooperative unit.
2. `tool_execution_start` виден даже когда grant не состоялся. UI event не является подтверждением effect или committed receipt.
3. `prepareRequest`/context failures требуют outer error boundary. Нельзя ждать agent_end как единственного способа сохранить interrupted state.
4. SDK transcript/context и сообщения со значениями Usage — проекция. Buro сохраняет canonical versions, dispatch IDs, observed/unknown coverage и private continuation в своей authority. Синтетические/заполненные нулём поля SDK не становятся measured cost.
5. В spike выбран sequential. Parallel defaults нельзя переносить на несколько writers или actions без явной модели ownership.
6.25 fake requests доказывают только отсутствие двадцатишаговой отсечки выбранного loop. Provider retries/timeouts/context limits, telemetry, неизвестные исходы и поведение Ollama/DeepSeek здесь не проверялись.

## Следующий проверяемый шаг

Встроить Pi за нейтральным AgentBackend/ModelProvider wrapper, не экспортируя SDK types как public domain Buro. Host-wrapped streamFn делает admission до реальной попытки, tool wrapper проверяет committed grant непосредственно перед эффектом, outer runner фиксирует fatal/unknown state. Затем нужны crash/restart tests с настоящим store, provider protocol fixtures для native Ollama/DeepSeek, stale-policy checks и независимый consumer собранных пакетов. Только после этого решать о production замене managed loop.

В этой подготовке не было изменений production кода/зависимостей, копирования upstream source, live model оценки, исполнения bash модели или обращения к выключенной RTX. Дополнительный повтор redirected metadata fetch остановился из-за timeout автоматической проверки разрешения; это не помешало работе: исходный npm view и integrity установленного lock уже дали проверяемые metadata. Небезопасность пакета из этого timeout не выводится.
