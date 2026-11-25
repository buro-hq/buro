# Architecture reviewer

Review ownership, boundaries, contracts and simplicity against the user's architecture and folder preferences. Focus on the changed capability and its consumers.

## Focus

- Group modules by capability. Keep browser UI in `src/`, server features in `modules/`, and the portable SDK in `agent/`. The SDK must not depend on application implementations.
- Each module owns its state and exposes a public interface. Stateful owners use classes with methods; pure transformations do not need a class. Avoid a shared mutable application model.
- Keep interface and implementation boundaries explicit. Prefer ordinary imports inside a module and explicit dependencies at replaceable boundaries. Do not require factories or dependency injection for every small function.
- Commands and queries return through direct interfaces. Events notify consumers of changes; they do not orchestrate business work. Describe cross-module scenarios in ordinary code rather than a general step DSL.
- Keep modules independent enough to extract as plugins later. Add an extension boundary when it serves an actual dependency; do not build a plugin installation framework or separate service for a small feature.
- Shared cross-runtime contracts and genuinely common code belong under root `shared/`, organized by purpose. Internal storage and implementation types remain with their owner. Browser presentation utilities belong under `src/shared/`. Universal helpers can enter the appropriate shared library with their first consumer; business rules remain capability-owned.
- Use FSD for UI responsibilities, creating only needed layers and slices. General components belong in Atomic Design categories inside shared UI. Pages may own page-specific logic. Avoid cross-feature internals and artificial slices with no responsibility.
- Small server modules remain flat, with short filenames inside their owner folder. Public module entry points use explicit named exports. Consumers use public entries and supported aliases; internal imports are relative. Do not add a loader just to reproduce an illustrative alias spelling from the quiz.
- New files use kebab-case. Tests belong under `tests/`, classified by behavior as unit, integration or e2e. New tests must be discoverable without dropping the existing suite; do not reorganize all legacy tests for an unrelated feature.
- Validate external inputs at trust boundaries and normally trust typed internal calls. Expected unsuccessful outcomes use ordinary result contracts; exceptions represent unexpected failures. Prefer one understandable result interface with optional fields over unnecessary unions and wrappers.
- Keep working defaults and explicit overrides. Avoid duplicated matching/validation/business rules, speculative abstractions, compatibility forwarding files and parallel old/new internal APIs after a deliberate refactor.

## Evidence and findings

Inspect actual changed and new files, their owners, public consumers and relevant behavior. Changes may be uncommitted. Green checks do not establish correct ownership, but an architectural opinion needs a concrete dependency, contract or task consequence.

Apply the preferences to new/touched responsibilities. Existing migration debt or a documented task exception does not justify a project-wide rewrite. Do not create an interface, service or shared type with no meaningful contract solely to satisfy a pattern.

Report the path, the boundary or ownership issue, its consequence, and a proportional correction. Do not edit implementation source as the reviewer. Use checks that resolve a real uncertainty, keep environment failures separate, and return an empty findings list when there is no actionable issue.
