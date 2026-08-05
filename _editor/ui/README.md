# @intentic/ui

Shared **Vue UI primitives + theme** for the platform web app. A small, reusable layer on top of PrimeVue + Tailwind 4 that [`@intentic-app/web`](../../_editor/web) composes — layout containers, a code/markdown primitive, the dark/light theme composable, and the design tokens.

## Responsibilities

- Provide primitives: `Page` (centered, width-constrained shell), `Card`, `Code` (Shiki-highlighted block), and `InfoHint` (hover/focus info card).
- Own theming: `useTheme` (dark/light `ColorScheme`, persisted) + `installUi(app)` (the single design-system plugin: PrimeVue preset + cssLayer order + tooltip directive) + the `Theme` preset.
- Provide `vTw` (the `v-tw` Tailwind class-merge directive) and `useHighlighter` (the shared Shiki highlighter).
- It is **presentational/shared only** — no app state or data fetching.

## Key files / exports

- [src/index.ts](src/index.ts) — public surface: `Card`, `Page`, `Code`, `InfoHint`, `installUi`, `vTw`, `useTheme`/`ColorScheme`, `useHighlighter`, `Theme`.
- [src/components/](src/components) — `Card.vue`, `Page.vue`, `Code.vue`, `InfoHint.vue`.
- [src/plugin.ts](src/plugin.ts) (`installUi`) and [src/composables](src/composables) — `useTheme` (theme ref + persistence), `vTw`, `useHighlighter` (lazy Shiki core).
- [src/styles/](src/styles) — design tokens + `theme.ts` (the `Theme` preset that bridges Tailwind vars ↔ PrimeVue `--p-*`), PrimeVue overrides (`@layer primeng`), semantic colors.

## How it fits

Consumed by the web app: `installUi(app)` runs once in `main.ts`; components import `Card`/`Page`/`Code`/`InfoHint` and use `useTheme` for the scheme toggle, `useHighlighter` for code, `v-tw` for conditional classes.

## Conventions & gotchas

- `<script setup lang="ts">` SFCs + composables (module-level `ref` singletons), same as the web app; keep it free of app-specific logic so it stays reusable.
- The CSS cascade layer is named `primeng` (`installUi`'s `cssLayer.name` + `styles/shared/primeng.css`) — keep that name so `utilities` stays last and Tailwind utilities beat PrimeVue component styles.
- Semantic CSS variables (`--color-*`, `--radius-*`) are the styling contract — prefer them over hard-coded values. Consumed directly from source (no build step); `pnpm --filter @intentic/ui typecheck` runs `vue-tsc`.
