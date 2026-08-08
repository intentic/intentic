import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The source-first workspace alias map, shared by vite.config.ts AND vitest.config.ts so app and test
 * resolution can never fork. Libs resolve to their .ts/.vue source, mirroring the tsconfig paths, so an edit
 * in _libs reflects with no rebuild (and Vue-SFC HMR works across the package boundary). Every first-party
 * extension resolves to its true source for two reasons: (1) the app and the extension's lazily-imported .vue
 * view must share ONE host.ts instance — pnpm materializes injected node_modules copies of some ext packages,
 * Vite's dep optimizer pre-bundles them, and the singleton forks: activate() binds one copy while the view
 * reads another -> "host() called before activate()"; (2) an injected copy is a pack-time snapshot — a
 * files:["dist"] dep inside it (extension-api) has no src and only the dist that existed at `pnpm install`,
 * which on a fresh CI checkout is nothing, so resolving through the injected copies breaks before the first
 * build. Skips daemon-only packages (no web src entry). */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const extensionAliases = Object.fromEntries(
    readdirSync(here(`../../_extensions`), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => existsSync(here(`../../_extensions/${entry.name}/src/index.ts`)))
        .map((entry): [string, string] => [
            JSON.parse(readFileSync(here(`../../_extensions/${entry.name}/package.json`), `utf8`)).name,
            here(`../../_extensions/${entry.name}/src/index.ts`),
        ]),
);

export const sourceAliases = (): Record<string, string> => ({
    // Listed before the barrel: a string alias also matches `<key>/…`, so the more specific subpath has to win
    // the lookup. It exists so plain .ts (and its unit tests) can reach the markdown engine without loading
    // the design system's component graph — see _editor/ui/src/markdown/index.ts.
    "@intentic/ui/markdown": here("../../_editor/ui/src/markdown/index.ts"),
    // Same reason and the same ordering requirement: the DAG layout is plain TypeScript that DagGraph and its
    // unit tests both call, and a test for a pure function must not have to boot the component graph (and a DOM
    // with it) to reach it.
    "@intentic/ui/dag": here("../../_editor/ui/src/components/dagLayout.ts"),
    // Same reason and the same ordering requirement again: splitting a path into name + directory is what every
    // file row in the app does, including the ones in unit-tested pure modules (fileType.ts, explorerPaste.ts).
    "@intentic/ui/path": here("../../_editor/ui/src/path.ts"),
    // And again, for the same module: fileType.ts maps every extension the app knows onto a `ShikiLang`, so the
    // grammar table is what that mapping is type-checked against. A plain map of dynamic-import thunks — nothing
    // from shiki/core is loaded by naming it.
    "@intentic/ui/langs": here("../../_editor/ui/src/composables/shikiLangs.ts"),
    // Same again: the chart palette's slot→colour lookup is called by the usage/savings PROJECTIONS, which are
    // pure functions with their own unit tests — reaching it through the barrel boots Picker.vue and wants a DOM.
    "@intentic/ui/series": here("../../_editor/ui/src/components/seriesAccent.ts"),
    // And once more: the 1h/24h/7d/All vocabulary is arithmetic over a timestamp, called by the feeds' pure
    // projections and pinned by their unit tests — none of which should need a DOM to ask how far back "7d" is.
    "@intentic/ui/time": here("../../_editor/ui/src/timeWindow.ts"),
    // And again, for the app's date/byte/token formatting: the history list's day label, the usage window's
    // reset and an extension's day dividers are all pure functions over a number, reached from composables and
    // pure projections whose unit tests run without a DOM.
    "@intentic/ui/format": here("../../_editor/ui/src/format.ts"),
    // And once more, for the icon VOCABULARY rather than the <Icon> that draws it: every icon name arriving
    // from a manifest is an open string, and the tests that check our own extensions name real glyphs read
    // JSON off disk — no components, no DOM, and nothing to gain from booting Picker.vue to get there.
    "@intentic/ui/icons": here("../../_editor/ui/src/icons/iconSets.ts"),
    // And again, for the arithmetic that makes a brand mark legible on our own plate: it is what decides whether
    // 24 official brand hexes clear 3:1 in both schemes, which is a claim only a test can hold — and one that
    // must not need a DOM (nor <BrandMark> itself) to be asked.
    "@intentic/ui/brand-color": here("../../_editor/ui/src/brandColor.ts"),
    // And again, for the app's base text size: it is the knob that column widths, editor font sizes and the
    // terminal's grid all convert against (uiScale.ts), so it is reached from plain modules the shell loads on
    // every boot — and through the barrel, asking a column how wide it should be would boot Picker.vue.
    "@intentic/ui/text-size": here("../../_editor/ui/src/composables/useTextSize.ts"),
    "@intentic/ui": here("../../_editor/ui/src/index.ts"),
    "@intentic-app/api-contract": here("../../_platform/api-contract/src/index.ts"),
    // The "+" grid's card and category data. It was the ONE first-party lib missing from this map, and the
    // cost was a silent wrong answer rather than a build error: the app resolved its `dist` instead, so a new
    // CAPABILITY_CATEGORIES entry did not exist as far as `contributionCard` was concerned and every card
    // declaring it fell through to the "extend" catch-all — a card in the wrong section, with nothing failing.
    "@intentic-app/capability-catalog": here("../../_platform/capability-catalog/src/index.ts"),
    // Same reason as the markdown subpath above, and the same ordering requirement: the session-name derivation
    // is a dependency-free leaf that the daemon, the app and an extension all reach for, so it is exported off
    // the barrel (a unit test that only wants a session name must not resolve the whole wire contract).
    "@intentic/sandbox-contract/session-names": here("../../_sandbox/sandbox-contract/src/session-names.ts"),
    // The chore book — what routine maintenance a repository is owed, and the verdict logic the Maintenance
    // surface, its rail badge and the codebase-health panel's refactor asks all run. Off the barrel for the same
    // reason as the two above: it is derivation over the wire types rather than the wire itself, and a caller
    // that only wants to compose an ask must not resolve every schema in the contract to get there.
    "@intentic/sandbox-contract/chores": here("../../_sandbox/sandbox-contract/src/chores/index.ts"),
    "@intentic/sandbox-contract": here("../../_sandbox/sandbox-contract/src/index.ts"),
    // The extension-registry file format — imported by the wire contract (schemas.ts), so without this line
    // the dev server resolves it to a dist/ that only exists once the lib has been built.
    "@intentic/registry": here("../../_sandbox/registry/src/index.ts"),
    "@intentic/extension-api": here("../../_sandbox/extension-api/src/index.ts"),
    ...extensionAliases,
});
