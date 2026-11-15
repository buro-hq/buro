# Project setup and result delivery

## Project setup

The default flow is directory selection → read-only research → editable proposal → saved profile. Research inspects source/configuration and suggests component types, paths, startup commands, checks and missing infrastructure. It does not install dependencies, run servers/migrations, mutate Git or deploy. The user can disable research and configure manually.

Component types are web, API, worker, CLI, library and other. A component may expose HTTP or use instructions/checks without a server. Startup commands must accept `PORT`/`HOST` or `{port}`; the service allocates private free ports. Component URLs are passed as `PROJECT_COMPONENT_<UPPERCASE_ID>_URL`. Order components by dependency and configure any required frontend/API bindings explicitly.

Saved research is a proposal rather than verified runtime configuration. Manual settings and protected scope survive quick application; stale proposals require new research. Environment verification runs configured checks in a separate worktree without a model call.

## Accepted results

Implementation completion and delivery are different states. A goal defaults to draft PR intent, while actual PR/delivery still requires enabled project configuration. A completed parent can supply the starting commit; otherwise goals use the base branch.

The project includes operational role templates for local preview, PR preparation and production delivery. Local preview is available when configured. Environment delivery remains disabled until explicitly enabled. Users can create/edit a production delivery role and select it in environment settings. These roles run after independent acceptance; they are excluded from the implementation worker team.

Preparation is read-only and returns a concrete commit, blockers and summary. The service, rather than the preparation agent, executes startup, Git push/PR or deployment commands.

## Local preview

Preview starts accepted workspace components, checks readiness and returns their URLs, logs and instructions. HTTP readiness is bounded to 60 seconds. Stop/restart controls manage process groups. Non-HTTP components can be inspected through their instructions/checks.

Environment precedence for preview:

1. Source repository `.env`, then `.env.local`.
2. Source component directory `.env`, then `.env.local`.
3. `.buro/local/environment.env`, then `.buro/local/<component-id>.env`.
4. Managed PORT/HOST/component URLs override file values.

Source env files are read privately and passed to the process; they are not copied into the workspace or profile. Logs redact secret values, encoded forms and URL credentials. Live logs are bounded and do not create a durable event per output chunk. A missing workspace `.env` does not imply missing runtime variables.

## Draft PR

Enable pull requests, set the remote/base branch, and authenticate `gh` for GitHub. The service pushes the accepted commit to an isolated result branch and creates a draft PR with checks/limitations. Repeated requests reuse an existing matching open PR. Closed/mismatched PRs require inspection. The source checkout branch is not changed. Other PR providers are future work.

## Environment deployment

An environment has an ID/name, enabled flag, role, delivery command, verification URL and confirmation policy. Access/machine variables belong in `.buro/local/`, not the shared profile. Deployment uses private env files and does not inherit source development dotenv values. Commands execute from the accepted workspace with a 15-minute command timeout; the accepted commit is available as `PROJECT_DELIVERY_COMMIT`.

Preparation cannot invent credentials, URLs or commands and must not run migrations. Confirmation is tied to the prepared commit. A successful shell exit without a successful configured availability check is not deployment success.

Redeploy preserves the previous delivery record, prepares the same accepted implementation using current enabled environment settings and obtains fresh confirmation when required. Restart does not repeat delivery. Inspect external state before retrying an ambiguous result.

## Local paths and materials

Repository, component and scope fields share a filesystem picker while preserving manual entry. Connected project pickers enforce repository boundaries. Material imports may select external files/directories or use a native browser file upload dialog.

Project material additions/removals save immediately and apply to future goals. Goal selections save with that goal; saving waits for pending uploads. Copies are content-addressed under `.buro/local/context/`, with metadata in private state rather than the shared profile. Imported content is not embedded in durable state/events or idempotency receipts.

UTF-8 text/code, supported images, PDF and DOCX are accepted. Limits: 8 MiB/file, 64 files/48 MiB per filesystem import, 64 active project materials and 32 selected goal attachments. Folder import skips hidden entries, dependencies, build output, symlinks and env/key files. PDF/DOCX extraction preserves originals and reports when text is unavailable. OCR and cross-platform DOCX extraction are future work.

Runs freeze manifests and verify/stage read-only copies in `.buro/context/` inside their worktree. Coordinator/reviewer receive exact paths; relevant references go to workers. Removing a source attachment does not remove past run evidence. Repair can select new goal attachments while retaining the old attempt manifest. Unreferenced blob retention/cleanup is tracked in the roadmap.
