# Buro UI architecture

The project is the entry point. Each project has an office, goals, runs, team, files and settings, including projects without a first run. Replay and live service use the same interface through `ProjectClient`.

## Product direction

[VISION.md](VISION.md) governs the agreed interaction model; [ARCHITECTURE.md](ARCHITECTURE.md) and [providers](docs/PROVIDERS.md) govern the next implementation milestone. The current production runtime is Codex-only. Resource selection for Ollama/DeepSeek and the reviewed UX prototype remain target behavior until backed by the service.

The target run overview combines a compact coordinator/agent map, timeline and an agent-focused feed on the right, with agent details below the map. Goals use dense navigation and concurrent runs keep visible context. Team cards describe role definitions and their concrete sessions; materials use a scope tree and list.

The primary flow asks for the desired outcome. Project research proposes contextual defaults, the coordinator recruits or creates specialists during work, and technical overrides open in place. Project rules own check configuration; run verification owns evidence and problems. A separate quality score is not the acceptance model.

Resource profiles distinguish local-only, configured hybrid and native client execution. Show actual client/model, capability readiness, queue state and data-policy blockers without implying that a selected provider has already passed a coding capability probe.

UI, CLI and external automation read the same saved task/session events. Provider reasoning/continuation payloads stay private; visible progress presents actions, decisions and evidence. Simulated prototype activity must not be presented as real execution.

## Boundaries

- `core/`: pure domain services and ports.
- `protocol/`: shared DTOs, schemas and storage contract.
- `clients/`: socket/replay implementations, with no backend imports.
- `src/data/`: connection, project selection, snapshots and subscriptions.
- `src/features/runs/`: run presentation/state derivation.
- `src/components/atoms/`: notices, icons and theme previews.
- `src/components/molecules/`: player, status, tabs, cards, reusable filesystem dialog and path inputs.
- `src/components/organisms/`: office, timeline, result actions, goal/project forms, context material editor and research/storage panels.
- `src/components/templates/`: consistent project layout.
- `src/pages/`: goals, files, project settings and user preferences.

UI imports only clients/protocol and frontend modules. Cordis, Node APIs, persistence and process management remain outside React. Boundary tests enforce this direction.

## Appearance

`AppearanceProvider` adapts the palettes in `theme/presets.ts` to Mantine and application CSS variables. Mantine controls and the office use the same theme tokens. The user selects a palette plus light/dark/system mode; preferences are browser-local and project-independent. Previews show the selected scheme.

## Localization

English is the default. `src/i18n/index.ts` exposes `t`, `useLocale`, `setLocale` and formatting locale helpers. The root subscribes to language changes, including cross-tab storage updates. Locale-sensitive memoized views include locale in their dependencies. Static label maps expose translated getters so they update without reloading modules.

English message IDs are keys in `locales/en.json` and `locales/ru.json`. Parameters use named placeholders such as `{p0}`. Local storage key: `buro.locale`. Document language changes immediately. User content and historical outputs retain their original text.

Only product messages are translated. Domain/CLI messages and runtime instructions are English; static notices can be translated by the frontend without making the service depend on React. Service protocol enums and role IDs are language-neutral.

## Paths and materials

`LocalPathDialog` accesses the filesystem through versioned service commands. It supports explicit navigation, search, hidden entries and multiple selection; connected project scope/component pickers cannot escape the repository. Manual paths remain available.

`ContextMaterialsEditor` imports filesystem selections or native browser uploads. Project materials save immediately. Goal selections save with the goal; saving is disabled while a goal upload is pending. The service owns all bytes, hashes and worktree staging. UI holds metadata and selection IDs only.

## Run presentation

Run status and current phase come from a shared view model. Playback uses active intervals, excluding human pauses between attempts. Parallel worker durations are not added together. Wall-clock event coordinates remain available for audit.

The same result panels support acceptance, repair/recheck, local preview, apply and delivery. Completion means implementation acceptance; preview/delivery statuses are separate. Empty projects retain the same navigation and layout as projects with history.
