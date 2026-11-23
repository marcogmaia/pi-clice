# Pi Clice

Use Clice's saved C/C++ index in [Pi](https://pi.dev), without starting an editor or language server. The package does not bundle Clice or create indexes at startup.

## Install

```powershell
# From this checkout; omit --local to install for your user across projects.
pi install .
```

Install the Clice CLI or its editor extension separately. The package looks for `CLICE_BIN`, then `clice` on `PATH`, then Clice in common editor extension directories. In the C++ project's root, prepare its compilation database/config and index it with `clice index --workspace .` using the same binary.

Start Pi from the project, or run `/reload` in an open session. The tools are active by default in workspaces with a Clice config or a compilation database in the current or an ancestor directory. `/clice` is also available outside those workspaces; it shows the resolved binary, workspace, and index diagnostics. If migrating from a project-local copy, remove that copy to avoid duplicate tool names.

## Tools

- `clice_query`: find symbols, definitions, references, callers and callees, implementations, type hierarchies, source bodies, file outlines, and source/header counterparts.
- `clice_impact`: see direct and indirect dependents, traverse includes and includers, and list indexed project files.

Examples of arguments you can ask Pi to use:

```json
{"question":"definition","target":"app::Controller::Start","fresh":"off"}
```

```json
{"kind":"file-deps","target":"src/controller.h","direction":"includers","depth":1,"fresh":"off"}
```

Reuse bracketed locators from results to select exact overloads. `includeExternal: true` is available on `clice_query` when you need SDK or vendored hits. Impact results always omit external paths from the displayed lists.

The default `fresh: "auto"` retries once only for an empty or negative result with stale-file evidence. Use `fresh: "off"` for read-only reviews and `fresh: "always"` to request a refresh. An empty result can miss newly added code even without a stale warning; check the source directly. Bulk or initial indexing is better done with the separate CLI, outside the tool timeout.

## Subagents and development

A subagent with a strict tool allowlist must include `clice_query` and `clice_impact` and load this provider. Pi background subagents that inherit ambient extensions can use the user-installed package; a runner that disables those extensions needs its own explicit provider configuration. Keep document-only or narrower evidence reviews on their existing profiles.

Run `npm test` from this repository. The tests load the installed Pi SDK's jiti and TypeBox, then stub registration and CLI processes. Set `PI_INSTALL_ROOT` if Pi uses a release directory other than `~/.pi/agent/install`.
