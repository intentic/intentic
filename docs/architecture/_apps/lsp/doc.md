# @intentic/lsp

Safe renames and real type errors, from the command line — or an honest refusal.

```stats
{ "items": [
    {"label": "Lines", "value": "1.2k"},
    {"label": "Files", "value": "12"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Renaming a symbol with find-and-replace breaks things quietly. The TypeScript language service knows the right answer; this hands it to an agent — as a CLI, and as a resident daemon the sandbox asks after every edit.

The surprising rule is that **it would rather say nothing than guess**. When a project's tsconfig chain or type foundations cannot be loaded — the common case is an isolated worktree whose installed dependencies are mounted where the checker cannot see them — TypeScript silently falls back to ES5-era defaults and reports healthy code as broken (`Map` unknown, `node:path` unresolvable). Every surface here treats that as *unanswerable*: the daemon marks the file `unavailable` with the reason, the CLI exits 2, rename declines rather than renaming only the usages a half-loaded program can find. A week of session logs where ~74% of injected diagnostics were exactly this phantom noise is why the refusal is load-bearing.

Two smaller choices follow the same honesty: the daemon socket is keyed on the root directory's identity rather than its path, so two mount namespaces that name different trees identically each get a daemon that sees their own tree; and `.vue` imports resolve through a built-in shim as unchecked instead of falsely missing (checking them is vue-tsc's job).

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/lsp", "label": "lsp", "note": "this package", "accent": "4"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"}
  ],
  "edges": [
    {"from": "_apps/lsp", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/sandbox", "to": "_apps/lsp"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Code search",
  "items": [
    {"label": "iq-engine", "value": 6799, "display": "6.8k", "accent": "4"},
    {"label": "iq-bench", "value": 1940, "display": "1.9k", "accent": "4"},
    {"label": "iq-recall", "value": 1892, "display": "1.9k", "accent": "4"},
    {"label": "iq", "value": 1888, "display": "1.9k", "accent": "4"},
    {"label": "lsp (this one)", "value": 1187, "display": "1.2k", "accent": "4"}
  ] }
```

## Where it is used

Run by agents when editing TypeScript, and imported (client only, no compiler) by the sandbox daemon to feed compile errors back after every edit.
