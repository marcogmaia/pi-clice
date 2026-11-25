# Plan: `clice_modularize`

Status: **planned, not implemented.** Only this document and the audit reports have been
written; no code has changed.

## 1. Why this exists

An agent asked to reorganise a C++ project has no way to see the shape of it. It can read a
file, or search for a name, but it cannot answer "should this folder be one unit or three?",
"what breaks if I move this header?", or "is this project even worth restructuring?".

The information exists. `clice analyze modules` computes it from the compiler index. But it
arrives as raw JSON: the overview alone is 69,565 characters on this project, and the answer
shapes differ per question - five return an object, three return a bare array.

The other half of the problem is judgement. Grouping code by folder *sounds* like tidying. On
this project it takes rebuild work from 14,984 to 58,480 units - about four times worse. An
agent that cannot see that number will happily recommend it.

So the tool's job is narrow: turn this data into a short answer an agent can act on, make a
proposed structure measurable before anyone edits a file, and say plainly what the restructuring
cannot carry.

## 2. Who it is for

- **The agent**, planning inside a clice workspace. It gets a dozen short answers per session.
- **The person** who reads the plan afterwards, and who alone runs the destructive step.

## 3. What exists today

Two tools ship in this extension, `clice_query` and `clice_impact`:

- Both resolve the clice binary (`resolveBinary`), find the workspace root
  (`findWorkspaceRoot`), spawn one process, parse JSON, and render text with shared helpers
  (`isExternalPath`, `capItems`, `fitBody`, `relativeToRoot`, `listTail`).
- Both are removed from the active tool set at `session_start` when the working directory is not
  a clice workspace.
- `clice_query` offers `fresh: auto | always | off`, which can re-read changed files before
  answering. `clice_impact` answers rebuild surface per file.

This plan adds a third tool on the same plumbing. It does not change the existing two.

## 4. What we will build

One tool, `clice_modularize`, with a `view` choice. It runs `clice analyze modules`, reads the
answer, and prints a short, fixed layout. It never writes, never deletes, never reindexes except
when asked, and never runs `clice modularize`.

## 5. Non-goals

- **Not a writer.** `clice modularize` generates module files into a directory, rewrites program
  sources in place, and deletes the headers it replaces. That stays a human step.
- **Not a replacement for `clice_query` or `clice_impact`.** Those answer per symbol and per
  file; this answers per module and per proposed structure.
- **No index building.** Bulk indexing is a separate, pre-planned command.
- **No build timing.** Every fact comes from the index, not from compiling.
- **No function-level complexity, cyclomatic or cognitive.** That number belongs to a function,
  not to a boundary between files: no arrangement of modules changes a function's branch count,
  and `analyze modules` reports none of it. This project already enables
  `readability-function-cognitive-complexity` in `.clang-tidy`, so `clice lint --json` is where
  that answer lives, not here. What this tool measures in the same spirit is load from
  boundaries: how many edges cross between parts, how many entities cross each of them, how deep
  dependencies must be followed, how many cycles exist and which edge cuts each, and how far one
  file's attention spreads.

## 6. Success criteria

1. On this project, an agent asked "should `src/` be grouped by folder?" reads one `overview`
   answer and rejects it, quoting both cost numbers.
2. Every answer stays under 24,000 characters, and the overview's first ten lines contain the
   crossings, the cycles and both cost numbers. A golden-file test asserts both.
3. No answer ever tells the caller to pass a parameter the tool does not accept.
4. The implementation outline can be executed by someone who read only this document, without
   inventing a product or structure decision.

## 7. Decisions

Each row records what was chosen, what was rejected, and what would reverse it.

| # | Decision | Rejected alternative | Reverses if |
| --- | --- | --- | --- |
| D1 | Analysis only; never writes | A gated write mode for `clice modularize` | The CLI gains a dry run that writes nothing |
| D2 | One tool with a `view` enum | One tool per view | More than 10 views, or a view needs a parameter set that clashes |
| D3 | `partition` and `annotations` accept a path or an inline JSON object | Path only, caller writes the file | Temp files prove observable or leaky in practice |
| D4 | Cost means comprehension first; rebuild work is printed as the consequence. `dirDepth` stays 0, and both cost numbers are always printed | Default to `dirDepth: 1`; or a second spawn to compare two depths | Evidence that per-folder grouping is not a natural starting point |
| D5 | `fresh: "off"` by default; `"always"` re-reads changed files in one extra process first | Always re-read; never re-read | Plans go wrong often enough because the saved copy was old |
| D6 | External paths are counted, not listed; `includeExternal` lists them | List everything, let the caller filter | External noise proves harmless in practice |
| D7 | All eight views in v1, each tied to a step of the loop | Three views first | A view goes unused across real sessions |

On D4, in plain terms: the first question a person asks is not "how long does the build take" but
"how many places do I have to look to change this?". So the answer leads with what it costs to
understand the code - boundaries crossed, cycles, chain depth, how far a file's attention is
spread - and then prints the two rebuild numbers as the consequence. Both numbers are always
printed, side by side, so the bad grouping cannot be adopted by accident.

## 8. The loop this tool teaches

```
1. overview      how hard is this code to work with, and what does a rebuild cost
2. hypothesis    try a structure: partition, moves, merges, entityMoves  (measured, not applied)
3. overview      did the cost fall, and did the cycles shrink
4. drill         edge    the few entities that cut a cycle
                 module  the groups are the lines this folder splits along
                 file    what this file uses, and who uses it
5. obstacles     what a mechanical rewrite cannot carry; clear it or accept a manual port
6. (human)       run clice modularize; it writes files, rewrites sources, deletes headers
```

Each view belongs to a step. `overview`, `edge`, `module`, `file` and `obstacles` are steps 1-5.
`interface` answers "what would the generated unit for this module need", used when reading a
step 5 outcome. `impact` answers "which headers get cheaper or dearer to edit", used to weigh a
step 3 result. `macros` answers "which macros cross a boundary and must stay behind", which is
step 5 material.

## 9. Parameters

| Parameter | Type | Meaning |
| --- | --- | --- |
| `view` | enum, optional | `overview` (default) `edge` `module` `file` `interface` `obstacles` `macros` `impact` |
| `target` | string, optional | `edge` = the module whose files name the other's entities. `module` = module name. `file` = file path. `interface` = optional module name. Ignored-and-rejected for other views. |
| `to` | string, optional | `edge` only, required there: the module named. |
| `scope` | string[] | Globs, relative to the project root; only matching files are analysed. Default: the whole project. |
| `dirDepth` | integer >= 0 | Directory segments that name a default module. Default 0 (a file's own directory). |
| `partition` | string or object | A path, or an inline `{"modules": [...]}` written to a temp file. |
| `std` | string | libc++ module sources directory. |
| `moves` | string[] | `<path>=<module>`, evaluated not applied. |
| `merges` | string[] | `<module>+<module>[+...]`. |
| `entityMoves` | string[] | `<locator>=<header>`. |
| `annotations` | (string or object)[] | A path, or an inline annotation object written to a temp file. |
| `churnSince` | string | `git log --since` value, e.g. `1.year`; empty disables churn. |
| `limit` | integer >= 0 | Overview caps, default 20. |
| `configuration` | string | Build configuration tag. |
| `includeExternal` | boolean | Default false: project paths only, external ones counted. |
| `fresh` | enum, optional | `off` (default), `auto`, `always`. See section 12. |

### 9.1 Which views accept which flags

Probed against the binary. A `-` means the CLI rejects the flag with exit 2 and
`{"error":"unknown option '--flag'"}`; the tool refuses the combination itself rather than
forwarding it.

| CLI flag | overview | edge | module | file | interface | obstacles | macros | impact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `--scope` | yes | yes | yes | yes | yes | yes | yes | yes |
| `--dir-depth` | yes | yes | yes | yes | yes | yes | yes | yes |
| `--partition` | yes | yes | yes | yes | yes | yes | yes | yes |
| `--std` | yes | yes | yes | yes | yes | yes | yes | yes |
| `--move` / `--merge` / `--move-entity` | yes | yes | yes | yes | yes | yes | yes | yes |
| `--configuration` | yes | yes | yes | yes | yes | yes | yes | yes |
| `--limit` | yes | - | - | - | - | - | - | - |
| `--annotation` | yes | - | - | yes | - | - | - | yes |
| `--churn-since` | yes | - | - | yes | - | - | - | yes |

`limit` maps to the CLI only for `overview`. For every other view it is a tool-side cap and is
not forwarded.

### 9.2 Required parameters per view

| view | required | rejected |
| --- | --- | --- |
| `overview` | - | `target`, `to` |
| `edge` | `target`, `to` | - |
| `module` | `target` | `to` |
| `file` | `target` | `to` |
| `interface` | - | `to` |
| `obstacles` | - | `target`, `to` |
| `macros` | - | `target`, `to` |
| `impact` | - | `target`, `to` |

A rejected parameter is an error, not a silent no-op: passing `target` to `overview` yields
whole-project numbers the caller believes are scoped, which is worse than failing. A value
starting with `-` is rejected for every positional and every flag value.

## 10. Answer shapes

Field tables below come from the captured answers in `docs/evidence/clice-probe-results.md`.
"Unverified" means no sample was captured; the renderer must not assume a shape.

### 10.1 `overview` (no view word)

| key | type | notes |
| --- | --- | --- |
| `annotations` | string[] | e.g. `["churn"]` |
| `files` | number | files in scope |
| `modules` | object[] | `{name, headers, sources, lines, layer}` |
| `edges` | object[] | `{from, to, interfaceEntities, implementationEntities, sample[]}` |
| `cycles` | object[] | `{modules[], cut:[{from, to, entities, sample[], files[]}]}` |
| `cyclicModules` | number | modules in a cycle |
| `partitionCycles` | object[] | cycles inside one module (a list, not a count) |
| `internalHeaders` | number | headers only their own module uses |
| `deepestChain` | string[] | module names, `+` inside an entry means a sibling branch |
| `totals` | object | `{baseline, partitioned}` rebuild units |
| `hotspots` | object[] | `{path, baseline, partitioned, churn, internal}` |
| `moves` | object[] | `{path, from, to, with[], entities, cyclicAfter}` |
| `splits` | object[] | `{path, module, parts:[{entities[], count, consumers[]}]}` |
| `obstacles` | object | counts only, see 10.5 |

### 10.2 `edge`, `module`, `file`

- `edge`: `{from, to, entities:[{id, entity, owner, users[], interface}]}` where `users` are
  `file:line` strings.
- `module`: `{name, files:[{path, source, uses:[{module, entities}], usedBy:[{module,
  entities}]}], groups:[{consumers[], headers[], dependsOn[]}], internalHeaders[]}`.
- `file`: `{path, module, source, annotations:[{name, unit, value}], uses:[{module, entities[]}],
  usedBy:[{module, entities[]}], affinity:[{module, entities}]}`.

### 10.3 `impact`, `interface`

- `impact` is a bare array of `{path, baseline, partitioned, churn, internal}`.
- `interface` is a bare array of `{module, imports[], entries:[{file, names[], include,
  because}], exports:[{name, file, used, form}], aliases[], textual:[{file, names[], include,
  because}], keptExports[], locals[], textualUses[], sharedLocals[], macros[], reads[]}`.

### 10.4 `macros`

Bare array, **unverified element shape**. The renderer prints the count, then for at most five
entries a one-line summary of the entry's own keys and values, and never assumes field names.

### 10.5 `obstacles`

The `obstacles` view returns items; the `overview` returns the same keys as counts. Verified
element shapes: `internalUses:[{entity, owner, reason, users[], exposedInOwner}]`,
`implicitProviders:[{path, specializes[]}]`. Other keys' item shapes are unverified and are
printed as counts only. The key set:

`variantHeaders`, `contextMacros`, `borrowedMacros`, `internalUses`,
`crossModuleRedeclarations`, `foreignDeclarations`, `splitDefinitions`, `duplicateDefinitions`,
`configuringMacros`, `implicitProviders`, `specializations`.

## 11. What each view prints

Shared rules, applying to every view:

- Paths are printed relative to the workspace root.
- External paths (build output, `vcpkg_installed`, dot directories) are excluded from lists and
  counted instead: `(+N outside the project)`.
- Any list cut for length ends with `(+N hidden)`; a list is never cut without saying so.
- Per-section caps are fixed and stated in this section. The whole answer is then fitted to
  24,000 characters; if it still does not fit, sections are dropped from the bottom in this
  order - `splits`, `moves`, `hotspots` - and the answer ends with
  `(sections omitted to fit; narrow with scope or a lower limit)`.

### 11.1 `overview`, section order

```
modules 57  (12 in-project, 45 outside the project)  files 590  edges 171
crossings   171 edges, 2,140 interface entities
cycles      4 modules in a cycle, 2 inside a single module
            src/zwiz/gui <-> src/zwiz/gui/hud        cut gui/hud -> gui (12 entities)
chain       6 deep: gui > gui/hud > bot + bot/bt > entt/signal > entt/core
shape       27 internal headers, 17 split candidates, 20 move candidates
cost        rebuild units 14984 today -> 58480 if grouped by folder   (x3.9 worse)
---------------------------------------------------------------------
layer 5  src/zwiz/gui        h2  s4    935 lines
layer 4  src/zwiz/gui/hud   h19 s18  8122 lines
hotspots (limit 20)
  src/zwiz/bot/bot_controller.h   17 -> 87 rebuild units   69 commits
moves (20)
  src/zwiz_hook/tests/gtest.h  from ... to src/zwiz_hook/tests  +0 files, 16 entities
splits (17)
  SDL_video.h  3 groups (4 / 1 / 4 entities by consumer)
obstacles
  1111 duplicate definitions, 444 cross-module redeclarations, 27 internal uses, 10 variant headers, ...
```

Definitions the layout depends on:

- `h` = headers, `s` = sources, from the module entry.
- Cycles: at most 5 rows, in answer order. Each row shows the cut edge and its entity count.
  The header counts are unfiltered; a row that was filtered away contributes to
  `(+N outside the project)` on the cycle block.
- `chain`: `deepestChain` joined with ` > `, kept as returned. `+` means a sibling branch of one
  chain step.
- `shape`: `internalHeaders`, then the `splits` and `moves` list lengths.
- `cost`: `baseline -> partitioned` plus a ratio. `xN worse` when partitioned is larger,
  `xN cheaper` when smaller, computed as `partitioned / baseline` to one decimal.
- Layers: in-project modules only, at most 12, sorted by `layer` descending then `lines`
  descending.
- Hotspots: at most `limit`, as returned; sorted by `churn x partitioned` descending.
- Moves and splits: at most `limit`, as returned.
- Obstacles: one line, counts descending, names as the CLI spells them.

### 11.2 `edge`

`from -> to  (from names to's entities)`, then up to 40 entities sorted by use count descending:
`entity  owner  N uses  first 2 sites`. Cut at 40 with `(+N hidden)`.

### 11.3 `module`

First the split lines: each `groups[]` entry becomes one line -
`N consumers: header, header, ...` with at most 8 headers, and the consumer set name-joined. Then
`internal headers: ...`. Then up to 40 files: `path  uses: m(3), m(2)  used by: m(1)`.

### 11.4 `file`

Then, first, the two directions, kept apart and labelled:

```
src/zwiz/bot/bot_controller.h   in src/zwiz/bot   (header)
uses          src/zwiz/bot 170 (61%), src/zwiz/gui/hud 95 (34%), ... (11 modules)
used by       src/zwiz, src/zwiz/bot, src/zwiz/bot/tests, src/zwiz/gui, src/zwiz/gui/hud
affinity      src/zwiz/bot 170 (54%), src/zwiz/gui/hud 95 (30%), ...
affinity      170 of 317 entities coupled with this file belong to its own module
annotations  churn 69 commits
```

`affinity` ranks modules by total coupling with this file, in both directions: the
entities of that module this file names, plus the entities of this file that module
names. The share is that module's `affinity.entities` divided by the sum of all
`affinity.entities`, rounded to an integer percent. On the sampled header,
`src/zwiz/bot` is 140 uses + 30 used-by = 170 (54%), and `src/zwiz/gui/hud` is
95 used-by with no uses (30%).
Top 5 modules, then `(+N modules)`.

### 11.5 `impact`

Up to 40 rows sorted by `partitioned - baseline` descending, so the biggest regressions come
first: `path  baseline -> partitioned  (+N)`, with `[internal]` appended when `internal` is true.

### 11.6 `interface`

Per module, at most 12 modules: `module`, `imports (N): a, b, c` (5), `entries (N)` as
`name  <include spelling>` (15), `exports N`, `textual (N)`, `shared locals (N)`, `macros (N)`,
`reads (N)`. Modules with no entries and no imports are summarised in one line with their count.

### 11.7 `obstacles`

Per non-empty blocker, one line: `name (N)`, then at most `limit` items where the shape is
verified, printed as `entity  owner  reason` or `path  specializes: a, b`. Counts only for the
unverified keys. Blockers sorted by count descending, then by name.

### 11.8 `macros`

`N crossing macro(s)`, then at most `limit` one-line summaries from the entry's own keys.

## 12. Freshness

`clice analyze` has **no** `--fresh` flag, and its successful answers carry no `stale` field. So
the analysis itself cannot report that the saved index is old. `clice query` does accept
`--fresh`, on every query.

| `fresh` | behaviour |
| --- | --- |
| `off` (default) | One process. The answer comes from the saved copy, with no freshness claim. |
| `auto` | Same as `off`. Present so callers can pass the existing vocabulary. |
| `always` | One extra process first: `clice query project-files --fresh --workspace <root>`, which re-reads the files that changed. Then the analysis process. If the re-read fails, the analysis still runs and the answer ends with a warning naming the failure. |

Rules that follow:

- Nothing in the answer ever says "refresh first" or names a parameter the tool rejects.
- `staleNote` from the existing tools is **not** reused verbatim: its text tells the caller to
  pass `fresh: "always"`, which is only correct because this tool now has that parameter, and it
  can only fire on an error answer, where the CLI does attach `stale`.
- When the analysis fails, `stale` is always echoed: those are index units missing from the
  build, and they are the likely cause.

## 13. Errors and exit codes

| Situation | CLI | Tool result |
| --- | --- | --- |
| The question cannot be answered (unknown module or file, bad glob) | exit 1 + `{"error"}` | Answered, not an error: `clice: <error>`, plus an actionable hint per view, plus `stale` if present |
| Arguments or project unreadable (no index, bad configuration) | exit 2 + `{"error"}` | Tool error: the message, plus guidance naming `clice index` and the binary path |
| Output is empty or not JSON | - | Tool error: `unreadable clice output`, with the first 300 characters |
| The binary is older than this feature | exit 2, unknown subcommand | Tool error naming the resolved version and saying the binary is too old for `analyze` |

Hint text by view, for exit 1: `module`, `edge`, `interface` -> "module names come from view:
overview"; `file` -> "pass a path relative to the project root"; anything else -> no hint.

## 14. Implementation outline

One file changes for behaviour (`src/extension.ts`), one for tests
(`test/clice.test.cjs`), one for docs (`README.md`). Nothing else.

### 14.1 Order and dependencies

Step 3 must come before step 4 (the args builder needs to know the resolved paths). Step 5 must
come before step 6 (the parser decides the renderer input type). Step 9 must come before step 8
(the tool registration takes the prompt text). Step 8 must come before step 7's final wiring.

### 14.2 Phase 1 - plumbing

Checkpoint: `npm test` green with the new argv tests, and the existing seven tests unchanged.

1. `kModuleViews` const and `ModuleView` type.
2. `AnalysisRequest` interface, extending the parameter table in section 9.
3. `writeJsonInput(value: string | object): string` - writes a temp file under `os.tmpdir()`
   with a `.json` suffix when given an object, returns the path, and **never deletes**. Returns
   the input unchanged when given a string.
4. `resolveInputs(request)`: maps `partition` and every `annotations` entry through
   `writeJsonInput`, returning `{request, paths}` - one temp file per object, so N entries mean N
   files.
5. `buildAnalysisArgs(request, root): string[]` - positional per view (`edge` takes `target`
   then `to`), then the flags the view accepts per 9.1, then `--workspace <root>`.
6. `checkAnalysisRequest(request)`: enforces 9.2 and the leading-dash rule for `target`, `to`,
   and every value inside `moves`, `merges`, `entityMoves`, `scope`. Returns a message or null.
7. `parseAnalysis(result: ProcessResult): AnalysisAnswer`, where
   `AnalysisAnswer = { data?: unknown; error?: string; stale?: string[]; parseFailed?: boolean }`.
   `data` is the object or the bare array. `parseFailed` is true for empty, non-JSON, or a
   non-object/non-array value. Exit 2 with an `error` string is a tool error; exit 1 with an
   `error` string is an answered negative.
8. `runAnalysis(bin, args, root, signal): Promise<ProcessResult>` - exactly one `safeRun` call,
   never `--fresh`, never a retry.
9. `cliceModularizeFresh(bin, root, fresh, signal)` - the optional proxy re-read from section 12.

### 14.3 Phase 2 - overview renderer

Checkpoint: a golden test on the captured overview fixture, asserting under 24,000 characters and
that the first ten lines carry crossings, cycles and both cost numbers.

10. `renderOverview(root, data, request)` plus helpers: `pct(part, whole)`, `ratio(partitioned,
    baseline)`, `moduleLine(entry)`.
11. The section drop order from section 11, as a function of the rendered body length.

### 14.4 Phase 3 - the other seven renderers

Checkpoint: one golden test per view from the captured fixtures.

12. `renderModuleView`, `renderFileView`, `renderEdgeView`, `renderInterface`, `renderObstacles`,
    `renderMacros`, `renderModuleImpact`.
    Note: `renderImpact` already exists for `clice_impact`; the new one must be named
    `renderModuleImpact`, and the existing one must not change.

### 14.5 Phase 4 - registration

Checkpoint: the `session_start` test asserts four tool names in a workspace and one outside.

13. `executeModularize(cwd, request, signal)`: validate, resolve binary and root, resolve inputs,
    `try { run } finally { remove every temp path }`.
14. `pi.registerTool` for `clice_modularize`, with the text from 14.6.
15. Add `clice_modularize` to the `session_start` exclusion predicate, which today compares
    against the two existing names.

### 14.6 Prompt text

`promptSnippet`:

> Survey a C++ project's module shape: crossings, cycles, split and move candidates, rebuild cost

`promptGuidelines`:

1. "Start with clice_modularize view overview: it prints what it costs to understand the project
   and what a rebuild costs today versus grouped by folder. If the second number is higher, do
   not propose that grouping."
2. "Test a structure before editing anything: pass partition, moves, merges or entityMoves and the
   answer measures the hypothetical. No file changes."
3. "Drill with view module (each group is a line the folder splits along), view file (affinity
   ranks modules by total coupling with the file, in both directions) and view edge (the entities
   that cut a cycle)."
4. "clice_modularize never writes. Turning code into importable modules is a separate, destructive
   step a person runs; clear view obstacles first."
5. "After editing sources, pass fresh: \"always\" - analyses read a saved copy of the project."

`description`: one sentence, ending "Reads a saved index; never writes and never runs
`clice modularize`."

## 15. Tests

New cases in `test/clice.test.cjs`:

- argv per view, including `edge` with two positionals and flags after them.
- flags are forwarded only where 9.1 allows: `annotations` with `view: module` is an error
  before any spawn; `limit` with `view: impact` caps locally and is absent from argv.
- rejected parameters per 9.2, and a `to` or `target` beginning with `-`.
- inline `partition` object: the temp path appears in argv, the file exists at spawn time, and it
  is gone after the call. Throws and aborts also remove it.
- bare-array answers (`impact`) render, and are not rejected as unparseable.
- exit 1 `{error}` is not an error result and carries the view hint; exit 2 is an error result;
  empty output is `unreadable clice output`.
- `fresh: "always"` spawns the proxy query first; `fresh: "off"` spawns once. No answer contains
  a parameter name the schema rejects.
- external modules are counted, not listed; `includeExternal: true` lists them.
- one golden-output test per view, from the captured fixtures, each under 24,000 characters.

Stub changes needed: the spawn mock must record whether each path argument existed at spawn time,
and the two exact-array assertions on the active tool list must expect four names.

## 16. Rollback

Revert `src/extension.ts`, `test/clice.test.cjs` and `README.md`. No other file is touched, no
state is written elsewhere, no migration exists. The existing two tools keep working throughout,
because nothing in their code path changes.

## 17. Assumptions and open items

- **Minimum binary.** Assumed `clice-io.clice-1.1.2026112310` or newer, the build probed here. No
  version gate is added; instead an unknown-subcommand failure from `analyze` is reported as "this
  clice binary is too old for analyze modules" with its version.
- **`macros` entry shape.** Unverified. The renderer prints keys it finds, never assumed names.
  One probe settles it if that output ever matters.
- **Partition fields.** Whether `analyze` accepts the `rewrite`, `primary`, `textual`, `external`
  and `provides` fields that `modularize` documents is unverified. The tool passes a partition
  through unchanged, so this only matters for someone later reading a plan made with them.
- **`dirDepth: 1`.** Not measured. If D4 proves wrong in practice, measure it before changing the
  default.

## Appendix - measured evidence

All figures from `docs/evidence/clice-probe-results.md`, captured on this project.

- Five sampled views answered in 1.45-1.69 s (warm cache). `edge`, `macros` and `interface` were
  not timed.
- The overview is 69,565 characters, with 57 modules, 171 edges and 4 cycles.
- `src/zwiz/bot` has 11 groups; `groups[0]` covers 16 headers seen by 5 modules, `groups[1]` 7
  headers seen by 4.
- `src/zwiz/bot/bot_controller.h` names 170 entities of its own module and 95 of `src/zwiz/gui/hud`.
- `totals` on the default partition: 14,984 rebuild units today, 58,480 grouped by folder.
