# @intentic/ext-repo-apps

A repository's own apps and its workspace package graph, as the panel you open that repo from.

## Responsibilities

- Show a monorepo's apps: what they are, how to run each, and where its terminal went.
- Run and report that repo's vitest suites.
- Draw the workspace package graph — which package depends on which.
- Scaffold a new app into the repo.

## Key files

- [src/useApps.ts](src/useApps.ts) — the apps a repo has, and the shape it was recognised by.
- [src/useWorkspaceGraph.ts](src/useWorkspaceGraph.ts) — the package graph behind the Dependencies tab.
- [src/appTests.ts](src/appTests.ts) / [src/useVitest.ts](src/useVitest.ts) — finding suites and running them.
- [src/terminals.ts](src/terminals.ts) — the join from an app to the terminal it runs in.
- [src/extension.ts](src/extension.ts) — activation, and the two shapes a repo can qualify under.

## How it fits

Two directory views on two predicates. **Apps** claims a repo when it is a pnpm+turbo monorepo — except the
intent/infrastructure repo, which surfaces as Infrastructure instead. Any other repo with vitest evidence gets a
tests-only tile whose `repo` rides in props, so it stays auxiliary and never claims the repo away from the
preview fallback. **Dependencies** rides the same monorepo predicate and surfaces as the tab beside Apps.

## Conventions & gotchas

- Claiming a repo is consequential: a view that claims it displaces the preview fallback. That is why the
  tests-only shape is deliberately auxiliary rather than a second claimant.
