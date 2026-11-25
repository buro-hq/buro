# Folder conventions

These conventions record the completed folder quiz. The first migration moved the shared UI components to `src/shared/ui`, introduced the `@/` browser alias, and added shared review contracts under root `shared/contracts`. Existing feature pages, server filenames and test locations remain to be migrated incrementally.

## Runtime boundaries

`modules/` contains server features. `src/` contains the browser UI. `agent/` remains a portable SDK with no dependency on either application implementation. Root `shared/` contains contracts and utilities used by multiple runtimes; browser-only infrastructure belongs to `src/shared/`.

Shared is organized by purpose, rather than becoming a second application module. Public data shapes and API request/response types belong in `shared/contracts/`. Storage interfaces, process handles, credential records and other implementation details stay with their owners. Universal utilities can enter shared immediately; business rules remain feature-owned.

## UI

Use [Feature-Sliced Design](https://feature-sliced.design/docs/reference/layers): app, pages, widgets, features, entities and shared. Create only layers and slices with actual responsibilities. Pages may own their page-specific logic; extracting a feature should identify a reusable user action. Slices depend on lower layers through public entry points.

Shared UI uses Atomic Design categories: `src/shared/ui/atoms/`, `molecules/` and further categories when needed. These describe component composition inside shared UI; business actions and domain-specific widgets retain their FSD owners.

```text
src/
  app/
  pages/
    models/
      index.ts
      ui/page.tsx
  features/
    edit-model/
      index.ts
      ui/editor.tsx
  widgets/
    run-detail/
  shared/
    api/
    i18n/
    lib/
    theme/
    ui/
      atoms/
      molecules/
```

## Server and imports

Small server modules remain flat. Filenames are short within their folder: `models/catalog.ts`, `registry.ts`, `configuration.ts`. Keep distinctions such as different engine backends when shortening would make names ambiguous. Every module has an `index.ts` with explicit public exports; other modules use that entry point.

All filenames use kebab-case, including React components. Component and class symbols retain PascalCase. Use aliases across modules and relative paths inside one module. The UI alias is `@/`; server aliases use Node's native package imports, `#modules/` and `#shared/`, so direct TypeScript execution does not require another loader. Keep SDK-internal imports portable.

The initial native entry point is `#shared/contracts`, backed by an explicit export list. Other server aliases and public module entry points are still planned. Shared UI consumers use `@/shared/ui`; its internal file paths are not a second public API.

## Tests

All tests belong under `tests/`: unit, integration and e2e. Fixtures remain under `tests/fixtures/`. Classify by what a test exercises: browser/launcher flows are e2e, real module and provider interactions are integration, isolated transformations are unit. Update discovery scripts and fixture paths when moving files.

These are organization conventions, not new execution phases or admission checks for agent work.
