# tsconfig

The shared TypeScript compiler settings every workspace package extends: a strict NodeNext base, a Vue variant for browser code, and an Astro variant for the site.

```mermaid
flowchart LR
    tsconfig(["@intentic/tsconfig"]) --> base["tsconfig.base.json"]
    base --> libs["Node packages<br/>built with tsc -b"]
    base --> vue["tsconfig.vue.json"]
    vue --> apps["web · ui · desktop app<br/>extensions · demo"]
    tsconfig --> astro["tsconfig.astro.json"]
    astro --> site["site · site-content"]
```

- A package's own `tsconfig.json` names one of these in `extends` (`@intentic/tsconfig/tsconfig.base.json`) and adds only its paths, `types` and emit choices.
- The base is strict beyond `strict`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` are on. It emits composite projects with declarations, which the root `tsconfig.libs.json` builds as one `tsc -b` graph.
- `customConditions` holds `@intentic/src`, the export condition that points a workspace package at its `src/` instead of `dist/`, so a typecheck reads current source without building dependencies first. `suites` runs tests under the same condition.
- The Vue variant switches to bundler resolution with DOM libraries, emits no declarations, and turns `exactOptionalPropertyTypes` off.
- Nothing to build or run; packages list it as a devDependency.

Native builds use TypeScript 7's `tsc`. Vue and Astro checkers keep TypeScript 6.0.3 through `catalog:typescript6`
until they support the native compiler. Scripts using the JavaScript compiler API import the official
`@typescript/typescript6` wrapper explicitly, which also keeps its `tsc6` binary from shadowing native `tsc`.
Cosmiconfig's TypeScript config loader uses that wrapper too, through the [compatibility patch](../patches/cosmiconfig@9.0.2.patch)
and its `packageExtensions` dependency; its optional peer otherwise selects root TypeScript 7, which lacks that API.

## Key files

- [tsconfig.base.json](tsconfig.base.json) — the strict base every Node package extends.
- [tsconfig.vue.json](tsconfig.vue.json) — the Vue apps, the UI library and the extensions.
- [tsconfig.astro.json](tsconfig.astro.json) — the Astro site packages.
