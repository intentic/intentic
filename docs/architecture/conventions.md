# Conventions, so the layout is predictable

The rules the tree is held to: one concept per file, what a package group means, what may live in `_shared/`,
and how an import names its target.

## Conventions (so the layout is predictable)

- **One concept per file**, named for the concept (`reconcile-loop.ts`, `resolve.ts`,
  `forgejo-api.ts`). Tests are **co-located** next to their source.
- **Test naming:** `*.test.ts` = unit; `*.engine.test.ts` = integration driven through the real engine;
  `*.e2e.test.ts` = gated real run against live services. A gated suite does not hand-roll its gate: it
  declares the switch and the credentials it needs with `e2eTier` ([_tools/testing/src/e2e.ts](../../_tools/testing/src/e2e.ts))
  and stands down, saying which variable it wanted, when the environment is short of one. See
  [What each tier needs](#what-each-tier-needs).
- **Groups:** every `_`-prefixed root directory is a package group, and the group is the DOMAIN, not the
  kind: `_editor/` (the screen you look at), `_sandbox/` (the per-project box), `_shared/` (the contracts and
  SDKs more than one group is written against: the wire, the extension SDK, the file formats that cross a
  boundary), `_devices/` (runs on the user's own machine), `_search/` (code search), `_deploy/` (the bundled
  deploy tool: not product surface), `_platform/` (the hosted account plane), `_site/` (the public website),
  `_extensions/` (loadable units only), `_tools/` (plumbing + repo-wide maintainer scripts,
  `_tools/scripts/`). A package's directory name is its unscoped npm name; whether it is an app or a lib is
  its package.json's business. pnpm-workspace.yaml globs the groups explicitly, and `_tools/checks/layout.mjs`
  holds the layout to it: no ghost directory, no directory over thirty files, no twin sibling names, no
  package whose directory disagrees with its npm name.
- **What may live in `_shared/`** ([_shared/README.md](../../_shared/README.md)): a package imported by three or
  more groups, or by both hubs (`_editor` and `_sandbox`), or belonging to the SDK an extension author may
  depend on. Nothing in `_shared/` may import from another group — a shared package that reached back into
  the daemon would hand every consumer the part it was supposed to be free of. App-specific scripts live in
  that app's `scripts/` dir (e.g. `_sandbox/sandbox/scripts/`); the user-facing connect/sync/cleanup scripts
  are tracked site assets in `_site/site/public/scripts/`, served at intentic.dev vanity URLs by
  [worker.ts](../../_site/site/worker.ts).
- **Imports:** import from the true source (no re-exports/aliases). The `@intentic/src` package export
  condition resolves workspace imports straight to `src/`, so agents can edit across packages without
  building.
- The compiled shape of the example/fixture is pinned by
  [_deploy/sdk/src/deploy.config.test.ts](../../_deploy/sdk/src/deploy.config.test.ts) against
  [_deploy/sdk/src/__fixtures__/deploy.graph.ts](../../_deploy/sdk/src/__fixtures__/deploy.graph.ts).

See [AGENTS.md](../../AGENTS.md) for the code-style rules every change must follow.

## The layout rules, and the check that holds them

Every rule below is enforced by [`_tools/checks/layout.mjs`](../../_tools/checks/layout.mjs), which runs in
`pnpm checks`, the turn-ending check and the push gate. Each one is a cost that was measured across 1,862
agent conversations (`docs/audits/directory-structure-audit.md`), not a preference:

1. **No ghosts.** A directory at part, package or module level with zero tracked files fails, naming the
   command that removes it. Seventeen existed when this was written — build output of packages that had
   already moved — and every one of them still answered `ls` and still got guessed at.
2. **No directory over thirty files** under a package's `src/` (tests included, one level). A 159-file
   directory answers a listing with four thousand characters an agent has to read before it can act; 29
   listings came back that big in one month. Ratcheted through `_tools/checks/baselines/layout.json`: an entry
   may shrink or disappear, never grow, and an unlisted directory fails on its first offence.
3. **No twin siblings.** Two directories whose names differ by one character are told apart by nobody —
   `agent/` beside `agents/` was read by 84 sessions that wanted one of them. Allowed only when both names are
   wire groups, because then the pair is the product's own vocabulary and the contract already forces both.
4. **A package's directory is its npm name** without the scope (and without `ext-` under `_extensions/`).
5. **No two files in one package share a basename**, case-insensitively, outside the names whose job is to
   repeat (`index.ts`, `invariant.ts`, `*.routes.ts`, `*.contract.ts`, `*.handler.ts`, a test beside its
   subject). Ratcheted like rule 2. Case matters because TypeScript refuses a program that holds
   `ModelPicker.test.ts` and `modelPicker.test.ts` at all.
6. **No dead names.** A directory this repository removed may not be named inside it, because a name in the
   tree is where the next agent learns to type it: `_apps/` and `_libs/` went in August and were still being
   typed 89 times a month later.
7. **Every documentation link resolves** ([`md-links.mjs`](../../_tools/checks/md-links.mjs)) and **every
   resolver alias points at something** ([`alias-targets.mjs`](../../_tools/checks/alias-targets.mjs)). The
   second is the one that fails silently: an alias bypasses the exports map the type-checker reads, so a moved
   target type-checks green and dies at load in every suite of the package that owns the alias.

## Where a package lives

- `_shared/` holds what more than one part is written against: a package imported by three or more parts, or
  by both hubs (`_editor` and `_sandbox`), or belonging to the SDK an extension author may depend on. **Nothing
  in `_shared/` may import from another part** ([_shared/README.md](../../_shared/README.md)).
- Everything else lives in the part that owns it, and a package that grows a second owner is a candidate for
  `_shared/` rather than a reason to reach across.

## One name per concept, across the three tiers

A feature is called the same thing on the wire, in the daemon and in the app: the contract file
(`<group>.contract.ts`), the daemon directory (`src/<group>/`) and the web feature (`src/features/<group>/`)
all wear the wire group's name. The daemon already matched 36 of 41 groups when this was written; the web now
does too, with one documented exception — **`chat` is the UI's name for wire group `agent`**, because that is
what the surface is called and renaming the surface would be renaming the product.
