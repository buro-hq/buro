# Stage 2C independent tests and UI contract review

Reviewed on 2026-11-22 against `f7ad286` plus the current 2C working tree. Disposition: **clear within the reviewed scope**, with the cross-client machine-configuration limitation below retained explicitly. This review does not stand in for the owner's final full-suite, build or production smoke results.

## Independent evidence

- **41/41** focused tests passed across role routing, service-role dispatch, planning strategy, planning persistence, autonomy projection and architecture boundaries. These are synthetic contract tests and real project-store transactions, not live model evaluations.
- **12/12** planning integration tests passed after adding three independent regressions. A backend whose facade exposes `resume()` but whose frozen descriptor says `resumeSessions: false` repairs in a fresh session, receives frozen coordinator instructions and the complete saved task/plan, makes zero backend resume calls, and obtains fresh independent review. An unfinished planner similarly restarts with the complete brief. An older settled run cannot bypass another unresolved run of the same goal through repair; rejection leaves the project snapshot, session count and turn count unchanged.
- **12/12** independent WebSocket, transport and localization tests passed. The projection refresh test holds an actual service snapshot response while a later goal event arrives, then verifies that release cannot roll observed history back. Machine-profile selection refreshes the initiating client without inventing a project-domain mutation or delaying its mutation receipt. Busy/settled transitions on another run restore the earlier run's recovery actions, and goal deletion removes invalid actions.
- `node scripts/check-autonomy.cjs` passed independently with real React rendering, local Vite/WebSocket transport and Chromium. It verified the current finite managed allowance, optional empty repair clarification, saving a coordinator Fixed preference through RoleService, the selected model appearing in refreshed project policy, a readable unavailable-model reason, blocked conflicting actions for an unknown outcome, and an open recovery modal becoming disabled when another run starts. Reported model requests: **0**; page errors: **0**. Screenshot: `artifacts/autonomy-controls.png` (generated, ignored QA output).
- `git diff --check` passed after the reviewed changes. Focused counts overlap the owner's full suite and are not additive.

Independent command receipts were written to `/private/tmp/buro-stage2c-independent-planning.log`, `/private/tmp/buro-stage2c-independent-projections.log` and `/private/tmp/buro-stage2c-independent-ui.log`. These temporary logs are local validation aids, not durable project state.

## Finding resolved during review

The initial service guard blocked a new run when another run of the same goal had an unresolved operation, but a user could select an older settled run and request repair. The owner added the same-goal guard before continuation mutates the run or dispatches a session. Service action projection now removes conflicting execution actions for that older run while keeping its own stop reason and reconciliation identity intact. The independent regression exercises the real FileProjectStore and ExecutionService path, including the nonresumable-backend fallback, rather than only asserting UI button visibility.

The architecture reviewer separately identified the facade-versus-capability continuation problem. The new tests above verify both accepted-plan repair and unfinished-plan recovery after the owner's fix; callable facade methods cannot manufacture the selected backend's session-resume capability.

## Strength and limits of the evidence

The routing tests deliberately use arbitrary client labels and separately declared capabilities. They check the actual chosen fake adapter and durable route metadata, including fixed choices differing from profile defaults, role-version changes, unsupported choices rejecting before model dispatch and cleanup retaining the original lease. Production strict editing prevention and immutable source isolation have their own earlier adapter/sandbox regressions; these new metadata tests do not independently prove those physical mechanisms.

The UI fixture injects synthetic command handlers and public service projections. It proves renderer/transport consumption and actual RoleService preference persistence. It does not run production code generation, external delivery or provider authentication. Existing broader catalog tests cover server-computed eligibility, so the browser's injected catalog is not presented as a proof of adapter enforcement.

Projection refresh buffers events only during its read, reapplies newer sequences, rejects a snapshot that would discard observed history, and discards responses belonging to a replaced socket. Configuration invalidation requests a new service projection instead of reconstructing permissions in React. The tests cover a delayed snapshot plus later event, ordinary reconnect and mutation replay; they do not constitute exhaustive arbitrary connection-failure or high-volume backpressure coverage.

## Remaining bounded limitation

`resources.use` changes machine-level selection without a project-domain broadcast. The initiating SocketProjectClient refreshes its projection, but another already-connected client can retain its prior effective project policy until it refreshes or reconnects, while a subsequent server-side start uses the current selection. The current 2C single-client configuration proof must not be described as live machine-configuration synchronization across every UI/MCP client. A service invalidation signal shared across affected project subscriptions belongs with the contribution/application API work; no mutation should be replayed merely to refresh that display.

No live provider endpoint, offline RTX machine, original user project, secret file, external message, Git commit or delivery action was accessed by this reviewer. Default-none quotas, neutral AgentBackend/SDK adoption, reusable package installation, SQLite authority and parallel-goal scheduling remain later stages.
