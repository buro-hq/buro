# Stage 4C2: context loaders and project analysis

Status: read-only implementation proposal after inspection of the current import, material staging and research paths. No production files changed, models called or external projects opened.

## Boundaries to retain

`ContextMaterials` owns the user-selected paths/upload, directory traversal, secret/dependency exclusions, symlink checks, byte limits, immutable content-addressed copies, import receipts and material-library transaction. `goalMaterials` selects project/goal context; a run freezes that selection. `stageContextMaterials` verifies original/derived hashes and stages copies; issued verification views retain frozen materials. A contribution cannot select new paths or overwrite these receipts or hashes.

`ProjectResearchService` owns admission, the explicit read-only research operation, runtime/model routing, source HEAD and profile revision, cancellation, progress, durable research state and session cleanup. `ProjectApplication.configure/applyResearch` retains optimistic revision and source-head checks; `profileWithResearch` retains additive merging. Analysis output only proposes settings. It never starts commands, changes profiles or enables delivery.

## Context loader contract

Add `core/context-loaders.ts` with a sealed `ContextLoaderCatalog` and narrow trusted contributions:

```ts
type ContextInput = { name: string; bytes: Uint8Array };
type LoadedContext = {
  mimeType: string;
  representation: 'text' | 'reference';
  text?: string;
  note?: string;
};
type ContextLoader = {
  id: string;
  revision: string;
  fallback?: true;
  matches(input: ContextInput): boolean;
  load(input: ContextInput, signal: AbortSignal): Promise<LoadedContext>;
};
```

The catalog captures callbacks and metadata at registration; loading requires sealing. It supplies detached bytes per callback, validates/copied output and enforces a bounded extracted-text result before persistence. Callbacks receive no source path, project root, filesystem handle, model/provider or RPC dispatcher. This is trusted in-process composition, not a hostile-plugin sandbox.

Dispatch is explicit and deterministic: exactly one matching primary loader, otherwise the single UTF-8 fallback. Multiple primary matches fail with an actionable ambiguous-loader error; no silent override by plugin order. The text fallback handles code/text extensions without an exhaustive language list. No model selects a loader ID.

Move the actual builtins behind this contract:

- `adapters/context/loaders/text.ts`: fatal UTF-8 decoding, no NUL, Markdown/plain MIME.
- `adapters/context/loaders/images.ts`: preserve accepted image bytes as reference-only; no fabricated image transcription.
- `adapters/context/loaders/documents.ts`: PDF/DOCX extraction through an injected adapter helper. The helper writes a private temporary copy of authorized bytes, invokes the existing fixed PDFKit/pdftotext/textutil recipe and cleans it in `finally`. No callback receives the original path. Missing extraction tools retain the original with an explicit note, as today.

The host still hashes/persists raw bytes and any returned text itself; returned filenames, hashes, material IDs or storage locations are not accepted. New imports record loader ID/revision as extraction provenance, and `textHash` pins derived bytes. An explicit reimport after a loader revision may create a new material version; existing material records and frozen runs are never re-extracted on resume. Keep current import/library limits; do not add unrelated budgets.

`materialInstructions` must describe actual representation. Current `ModelMessage.content` is a string and portable Ollama/DeepSeek packets are text-only. Images can be saved/downloaded but are not vision input. Replace the current blanket instruction to “inspect images” with an honest reference-only note. OCR or multimodal messages would be a separate explicit contribution/capability change.

## Project analysis contract

Add `core/project-analysis.ts` with a sealed `ProjectAnalysisCatalog`, initially scoped to setup research rather than a generic workflow engine:

```ts
type ProjectAnalysisInput = {
  project: { id: string; name: string };
  sourceHead: string;
  profile: ProjectProfile;
  materials: readonly AuthorizedMaterialText[];
};
type ProjectAnalyzer = {
  id: string;
  revision: string;
  purpose: 'project-setup';
  build(input: ProjectAnalysisInput): {
    instructions: string;
    prompt: string;
    schema: Record<string, unknown>;
  };
  parse(text: string): unknown;
};
```

The catalog captures callbacks, clones/freezes detached input and validates the prompt/schema projection. `AuthorizedMaterialText` contains material ID/name/MIME/raw and text hashes plus explicitly authorized copied text or a reference-only note; no arbitrary URL/path resolver. A host adapter resolves only the already selected saved blobs, verifies hashes and bounds text before providing it. Plain-text file imports currently have no `textPath`, so the resolver must read verified raw UTF-8 bytes for those materials too. Loader/context code cannot dispatch model requests.

The first builtin `adapters/analysis/project-setup.ts` contains the current real setup instructions, structured response schema and JSON parser/duplicate-ID normalization. The catalog normalizes every parser result through the service-owned `ResearchResultSchema`; a third analyzer may produce a different wire format but must still return the same bounded proposal contract. It cannot return new runtime IDs, operation permissions, command executors or direct document edits.

Select the analyzer through trusted host configuration (`setupAnalyzerId`, default `project-setup`), not a model proposal or a new arbitrary-code RPC. Existing public research commands stay closed. Freeze analyzer ID/revision on the research record when admitted, before scheduling the session; the service resolves that same installed contribution for the job. Unknown/changed contribution must fail explicitly rather than silently substitute another parser. Setup analysis continues using the host's actual read-only operation and existing role/resource selection.

Existing source inspection remains a read-only runtime task with the current tool scope and secret exclusions. Contributions only customize prompt/schema/parser from the authorized input; they do not acquire a new filesystem root. This does not strengthen the native backend's general research filesystem sandbox by itself and must not be described as such.

## Cordis composition and affected files

Create a context/analysis contribution service before `local-files` startup. Register first-party loaders and analyzer as ordinary registrations, then run the trusted `createHost.configure` hook before each relevant catalog is sealed. `localFilesPlugin` injects the loader catalog into `ContextMaterials`; `projectOperationsPlugin` injects the analysis catalog plus authorized-material resolver into `ProjectResearchService`. Plugins register factories through Cordis; repository metadata and public commands provide data only.

Expected changes: new Core catalogs and adapter builtins; `adapters/files/context-materials.ts`, an adapter document extraction helper, an authorized material text reader; `core/project-research.ts`; `protocol/context.ts` and `protocol/operations.ts` provenance fields; `plugins/local-files.ts`, `plugins/project-operations.ts` and contribution service/composition wiring. Existing `core/context.ts`, run selection and staging semantics should change only if a concrete hash/scope regression requires it.

## Implementation order and proof

1. Land the typed loader catalog and move actual text/image/document dispatch behind it. Prove a third synthetic loader is invoked through real Cordis import and produces host-hashed frozen text.
2. Land authorized material text projection and the actual builtin analyzer extraction. Prove a third analyzer's prompt/schema/parser are used by the real research service through Cordis with a fake runtime; no model transport involved.
3. Run boundary reviews and focused tests, then the normal full suite/build before commit.

Required regressions: duplicate/late/ambiguous registrations; callback alias mutation; invalid/oversized loader output; missing extraction helper; private filenames and symlink rejection before callbacks; replayed import never rereads changed source; loader revision never changes an existing run's bytes; image-only input never becomes claimed text/vision analysis; analyzer malformed/duplicate IDs; no command/profile side effects; source-head/profile-revision stale apply rejection; cancellation/recovery/session release; unchanged role/resource grants and unknown-operation receipts. Verify standalone empty service startup still works without Codex/model calls.

Not included: arbitrary context URL fetching, embeddings/vector storage, OCR, vision messages, plugin hot replacement, another agent loop or a second receipt system.
