# Code style

The conventions follow the user's code, architecture and code-style quizzes. The complete answers remain in `buro-code-architecture-preferences.md` on the user's Desktop.

Repository documentation, comments, identifiers and figure labels use English. Other languages are intentional in localization resources and Unicode test fixtures.

## Formatting

EditorConfig defines UTF-8, LF, two-space indentation and a final newline. The editor's Tab key inserts spaces. Markdown retains intentional trailing spaces for line breaks.

ESLint Stylistic owns TS, TSX, JS and their module variants. Prettier owns CSS, JSON, Markdown, HTML and YAML. Source files are excluded from Prettier so the tools do not undo each other's changes. Generated state, private data, archived sources and branding assets are excluded from mass formatting.

- Put the body of an unbraced `if` on the next line; a single `return` does not require braces. Existing braced blocks remain valid.
- Separate successive checks and the following work with a blank line. Elsewhere, blank lines separate logical groups, rather than every statement.
- Use concise expression bodies for arrows that only return a value. Async generators retain function expressions because JavaScript has no generator arrows.
- Declare variables separately. Short arrays, method chains, positional arguments and returned objects can remain on one line.
- Give every property of a nonempty object argument its own line, including constructor arguments and objects wrapped in TypeScript assertions or `satisfies`. Other short object literals can remain inline.
- Keep spaces inside object, destructuring and import braces. Continued logical operators belong at the end of the previous line; type unions retain leading separators.
- Use inline `type` modifiers when a single import contains values and types. Duplicate imports are reported; type-only imports remain valid.

The object-argument distinction is implemented by one local whitespace rule in `tooling/eslint-rules/multiline-call-object.mjs`. Its tests cover nested values, comments, spread, optional calls, assertions, constructor calls and empty objects. Syntax/literal comparisons and a TSX render comparison check that formatting preserves behavior. A second pass must produce identical output.

The default `jsx-one-expression-per-line` rule is disabled: moving inline text across lines can remove significant spaces around expressions. A dedicated rendering regression covers separators such as `A · result.txt`; the browser test retains its exact text assertion.

The 100-column ruler is an editing guide. ESLint formatting preserves authored line breaks instead of computing a new layout for every expression. There is no hard line-length failure; keep long URLs and literal text intact. The formatter cannot infer meaningful groups or good names.

## Correctness and review

`eslint.config.mjs` adds correctness checks to the shared style configuration: ordinary JavaScript errors, unused values, duplicate imports, unobserved/misused promises in application code and the classic React Hooks rules. React dependency diagnostics are warnings. Existing TypeScript configurations remain responsible for type checking. Error-cause construction follows module contracts; `AggregateError` can already retain multiple failures without a mandated single cause.

Names should be short when their context is clear. Name the parts of a compound condition, then combine those variables in one `if`. Prefer arrow functions outside classes, concise expression bodies, `async/await`, named exports and explicit public contracts. Framework configuration files may require default exports. Comments inside functions explain nonobvious reasons. These semantic choices remain review guidance; formatting does not convert declarations to arrows, choose names, or rearrange execution. Promise tails that reserve serialized work before yielding remain explicit; changing them to a simple await can introduce races.

## Commands and editors

| Command                | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `npm run format`       | Apply source formatting and Prettier to other supported text files |
| `npm run format:check` | Check formatting without correctness lint or type analysis         |
| `npm run fix`          | Apply available source lint fixes and other-file formatting        |
| `npm run lint`         | Check source style and correctness                                 |
| `npm run check`        | Check source lint, other-file formatting and TypeScript types      |
| `npm run test:style`   | Exercise formatting examples, semantics and idempotence            |

VS Code uses ESLint fixes on an explicit save for source files and Prettier for other formats. Format Document uses the same per-language owner. Other editors can read EditorConfig and use the same ESLint/Prettier configurations. GitHub Actions runs `check` and `test:style` for pull requests and pushes to master; it does not run live model evaluations.
