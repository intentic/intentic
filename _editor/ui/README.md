# @intentic/ui

Shared **Vue UI primitives + theme** for the platform web app. A small, reusable layer on top of PrimeVue + Tailwind 4 that [`@intentic-app/web`](../../_editor/web) composes — layout containers, a code/markdown primitive, the dark/light theme composable, and the design tokens.

## Responsibilities

- Provide primitives: `Page` (centered, width-constrained shell), `Card`, `Code` (Shiki-highlighted block), `CodeField` (the same colours with a caret in them — the editable source surface), and `InfoHint` (hover/focus info card).
- Own theming: `useTheme` (dark/light `ColorScheme` + the accent colour, both persisted) + `installUi(app)` (the single design-system plugin: PrimeVue preset + cssLayer order + tooltip directive) + the `Theme` preset.
- Own the app's colour: the reader picks ONE, with `ColorPicker`, and `themeColor.ts` expands it into the twelve-step brand and neutral ramps every surface, border, link and fill resolves through — written as inline custom properties on `<html>`, so the whole UI repaints without a rebuild. The step LIGHTNESSES are fixed (they are what the contrast promises in `semantic-colors.css` are made of); a picked colour sets hue everywhere and how much chroma the ladders carry.
- Own how large the app reads: `useTextSize` (persisted, `compact`/`default`/`large`). Because every size in the tokens is a rem, this one knob moves type, spacing, control heights and radii together — `default` is the 110% the interface is drawn at, so a fresh window needs no browser zoom. It also publishes `--ui-scale`, which anything that must NOT grow divides by (the web app's navigation rail) and anything that paints its own text multiplies by (Monaco, xterm).
- Own the one markdown surface: `Markdown` renders sanitized prose, Shiki-coloured fenced blocks, and the fences that are FIGURES rather than code — `dag`/`bars`/`stats`, whose bodies are JSON the app lays out, and `mermaid`, which mermaid itself draws (lazily imported, in the app's own palette). A fence the renderer cannot understand stays a code block, so a broken figure costs itself and not the page.
- Provide `vTw` (the `v-tw` Tailwind class-merge directive) and `useHighlighter` (the shared Shiki highlighter).
- It is **presentational/shared only** — no app state or data fetching.

## Key files / exports

- [src/index.ts](src/index.ts) — public surface: `Card`, `Page`, `Code`, `CodeField`, `InfoHint`, `ColorPicker`, `installUi`, `vTw`, `useTheme`/`ColorScheme`, `useTextSize`/`TextSize`, `useHighlighter`, `Theme`.
- [src/components/](src/components) — `Card.vue`, `Page.vue`, `Code.vue`, `CodeField.vue`, `InfoHint.vue`, and the markdown surface's own `Markdown.vue` / `MarkdownFigure.vue` / `MermaidDiagram.vue`.
- [src/markdown/](src/markdown) — the engine behind that surface, on the `@intentic/ui/markdown` subpath because it is plain TypeScript: `render.ts` (sanitize + the streaming split), `code.ts` (fenced blocks), `figures.ts` (which fences are figures).
- [src/oklch.ts](src/oklch.ts) and [src/themeColor.ts](src/themeColor.ts) — the colour maths: sRGB ⇄ OKLCH with CSS Color 4 gamut mapping, and one picked hex → the app's two ramps. Plain TypeScript, shared with `brandColor.ts` (a brand logo's own colour, made legible on our plate).
- [src/plugin.ts](src/plugin.ts) (`installUi`) and [src/composables](src/composables) — `useTheme` (scheme + accent refs, persistence, and the inline custom properties that carry the accent), `useTextSize` (base text size + persistence; also on the `@intentic/ui/text-size` subpath, so plain modules can ask how large the app is without booting the component graph), `vTw`, `useHighlighter` (lazy Shiki core; also on `@intentic/ui/highlighter` so worker and plain-TypeScript consumers do not load the component graph).
- [src/styles/](src/styles) — design tokens + `theme.ts` (the `Theme` preset that bridges Tailwind vars ↔ PrimeVue `--p-*`), PrimeVue overrides (`@layer primeng`), semantic colors.

## How it fits

Consumed by the web app: `installUi(app)` runs once in `main.ts`; components import `Card`/`Page`/`Code`/`InfoHint` and use `useTheme` for the scheme toggle, `useHighlighter` for code, `v-tw` for conditional classes.

## Conventions & gotchas

- `<script setup lang="ts">` SFCs + composables (module-level `ref` singletons), same as the web app; keep it free of app-specific logic so it stays reusable.
- The CSS cascade layer is named `primeng` (`installUi`'s `cssLayer.name` + `styles/shared/primeng.css`) — keep that name so `utilities` stays last and Tailwind utilities beat PrimeVue component styles.
- Semantic CSS variables (`--color-*`, `--radius-*`) are the styling contract — prefer them over hard-coded values. Consumed directly from source (no build step); `pnpm --filter @intentic/ui typecheck` runs `vue-tsc`.
- `CodeField` stacks a Shiki-highlighted `<pre>` and a transparent `<textarea>` in one grid cell, so every metric that can move a glyph is set once, in `styles/shared/code.css` (`ui-code-field-box`), and applied to both. Split those two class lists and the text drifts off its own colours — silently, and only on the lines that wrap.
