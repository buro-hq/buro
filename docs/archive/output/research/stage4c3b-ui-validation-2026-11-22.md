# 4C3b empty setup and first-profile UI validation

Parent: `2d8c03b`. This records the UI/browser slice; the full-stage test/build receipt is separate.

An unconfigured service now explains its next step. A repository can be connected and goals/materials saved without a model. ProjectPicker enables automatic research only when the service returns a selected resource snapshot and an eligible research operation; after connecting it rechecks the project's own selection before dispatch. Research history remains visible without model setup. Empty offices link directly to model configuration or missing checks.

The first setup exposes installed provider/backend choices without selecting the first brand. API connection, exact model name, runtime and team profile can all be saved before one service restart. The managed editor supports manual model names without requiring active-provider discovery. The form explains that one model can serve coordinator, writer and independent reviewer through separate sessions. Locality comes from server metadata. Saving, activation and explicit profile selection are distinct steps; saving does not run a diagnostic or model.

## Passed checks

- Client TypeScript: `npx tsc -p tsconfig.json` passed.
- Localization: 3/3 tests passed, including complete static message coverage and matching English/Russian parameters.
- `scripts/check-first-profile.cjs` / `npm run check:first-profile`: six complete scenarios passed, zero browser errors and zero Codex starts. It uses the production application, real WebSocket RPC, file configuration, provider adapter, Pi scheduler, repository tools, immutable checks and fresh reviewer lifecycle.
- Scoped formatting and `git diff --check`: passed.

The browser proves clean startup has no projects, connections, runtimes or profiles and `defaultProfile: null`; connection without models has no research or process side effect. It saves the first API/model/profile entirely through UI with zero transport calls, restarts once, observes the still-unselected profile, then selects it explicitly. Only then does it request optional research and run a goal. That goal performs a real bounded `edit_file`, passes immutable service checks and receives a fresh reviewer thread using the same configured model. The original temporary repository branch and source file remain unchanged. The settings fit 1512, 390 and 320 px widths.

The 26 provider HTTP requests were served by a deterministic in-process fake fetch, including Ollama capability inspection. Real model requests: zero. No RTX endpoint, credential or original user project was accessed. This is integration evidence, not model-quality or speed evidence.

Log: `/private/tmp/buro-stage4c3b-first-profile-browser.log`. Visually inspected screenshots: `artifacts/first-profile-pending.png` and `artifacts/first-profile-goal.png`; structured result: `artifacts/first-profile-verification.json`.

## Scope notes

Eligibility rows indicate available choices. Existing roles with an invalid fixed model preference can still require server-side resolution/error handling; this UI does not silently replace their pins. Explicit discovery and diagnostics remain available independently of profile selection. Runtime activation still requires a service restart.

The accepted-goal rail now shows real immutable service acceptance (`1 / 1`) without an invented “Project tests: Not run yet” row. Recorded agent test commands have their own explicitly named row only when such commands exist. The browser asserts the accepted result has no misleading project-test, unrun-agent-test or “Not run yet” row; service checks are unchanged.
