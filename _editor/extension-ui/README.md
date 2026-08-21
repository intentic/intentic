# @intentic/extension-ui

The UI kit an extension renders with, so its views look like the app rather than like a website.

A curated slice of the app design system ([`@intentic/ui`](../ui)) plus the PrimeVue primitives extension views
actually use. One of the two packages an extension may depend on (with
[`@intentic/extension-api`](../../_sandbox/extension-api)).

## Host-provided at runtime

This package's [`src/index.ts`](src/index.ts) is its one public surface (the repo's re-export exception). The
kit is **host-provided**: the web app maps this module into its import map
([extension-host/hostModules.ts](../../_editor/web/src/extension-host/hostModules.ts)), so a third-party bundle
that marks it external resolves to the **shell's own** component instances and theming: one Vue, one
PrimeVue, one theme across the host and every extension. In-repo builtin extensions bundle this same module
and land on the same instances.

The scope reads oddly (an `@intentic/*` package depending on the app-side `@intentic/ui`) but it is
deliberate: the dependency is build-time-only (for in-repo builtins); at runtime the import map supplies the
shell's instances, so no second copy is shipped.

## Drift assertion

Export names are mirrored in [`names.mjs`](names.mjs), which drives shim generation and a drift assertion:
keep the two in sync when adding or removing an export. Publishing a typed npm artifact for out-of-repo
authors is a marketplace-phase task.

## Key files

- [src/index.ts](src/index.ts), the whole surface: which components and helpers an extension may render with.
- [src/format.ts](src/format.ts): the shared formatters, so two extensions render a duration the same way.

## The one control worth calling out

`AgentRunButton` and `useAgentRunPick` are re-exported because four extensions start an agent for the user:
pipelines, deployments, maintenance, acceptance: and each had reached its own answer about how you choose what
that costs. Press the primary half and the run opens on the sandbox's standing agent-run model; use the caret
and it opens on something else, for that run only.

`useAgentRunPick` takes `api.models` as an argument rather than importing it, which is what lets the control
live in a kit that knows nothing about the extension API. Pass the extension's own host handle:

```ts
const runModel = useAgentRunPick(() => host().models);
```
