import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

/* The source-first workspace alias map, shared by vite.config.ts AND vitest.config.ts so app and test
 * resolution can never fork. Libs resolve to their .ts/.vue source, mirroring the tsconfig paths, so an edit
 * in _libs reflects with no rebuild (and Vue-SFC HMR works across the package boundary). Every first-party
 * extension resolves to its true source for two reasons: (1) the app and the extension's lazily-imported .vue
 * view must share ONE host.ts instance, pnpm materializes injected node_modules copies of some ext packages,
 * Vite's dep optimizer pre-bundles them, and the singleton forks: activate() binds one copy while the view
 * reads another -> "host() called before activate()"; (2) an injected copy is a pack-time snapshot, a
 * files:["dist"] dep inside it (extension-api) has no src and only the dist that existed at `pnpm install`,
 * which on a fresh CI checkout is nothing, so resolving through the injected copies breaks before the first
 * build. Skips daemon-only packages (no web src entry). */

// Every entry below names a path from the monorepo root, which is FOUND rather than counted, this file used
// to spell `../../` twenty-three times, each copy silently wrong the moment the file moved a level.
const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);

/* EVERY ENTRY POINT AN EXTENSION PUBLISHES, not just its barrel, read off each package's own `exports` map, so
 * an extension that grows a second entry does not have to be remembered here.
 *
 * Subpaths are emitted BEFORE barrels for the reason the hand-written entries below state: a string alias also
 * matches `<key>/…`, so `@intentic/ext-knowledge` would swallow `@intentic/ext-knowledge/notes` and resolve it
 * to `src/index.ts/notes`, a path that cannot exist. That failure is a dev server (and only a dev server) that
 * cannot start, invisible to a typecheck, invisible to the tests, and confusing out of all proportion to its
 * cause. */
const extensionEntries = readdirSync(fromRoot(`_extensions`), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(fromRoot(`_extensions/${entry.name}/src/index.ts`)))
    .flatMap((entry): [string, string, boolean][] => {
        const manifest = JSON.parse(readFileSync(fromRoot(`_extensions/${entry.name}/package.json`), `utf8`)) as {
            name: string;
            exports?: Record<string, { default?: string } | string>;
        };
        return Object.entries(manifest.exports ?? { ".": `./src/index.ts` }).map(([subpath, target]) => {
            const file = typeof target === `string` ? target : (target.default ?? `./src/index.ts`);
            const specifier = subpath === `.` ? manifest.name : `${manifest.name}/${subpath.replace(/^\.\//, ``)}`;
            return [specifier, fromRoot(`_extensions/${entry.name}/${file.replace(/^\.\//, ``)}`), subpath === `.`];
        });
    });

const extensionAliases = Object.fromEntries([
    ...extensionEntries.filter(([, , isBarrel]) => !isBarrel).map(([specifier, file]) => [specifier, file] as const),
    ...extensionEntries.filter(([, , isBarrel]) => isBarrel).map(([specifier, file]) => [specifier, file] as const),
]);

export const sourceAliases = (): Record<string, string> => ({
    // Listed before the barrel: a string alias also matches `<key>/…`, so the more specific subpath has to win
    // the lookup. It exists so plain .ts (and its unit tests) can reach the markdown engine without loading
    // the design system's component graph, see _editor/ui/src/markdown/index.ts.
    "@intentic/ui/markdown": fromRoot("_editor/ui/src/markdown/index.ts"),
    // Same reason and the same ordering requirement: the DAG layout is plain TypeScript that DagGraph and its
    // unit tests both call, and a test for a pure function must not have to boot the component graph (and a DOM
    // with it) to reach it.
    "@intentic/ui/dag": fromRoot("_editor/ui/src/components/dagLayout.ts"),
    // Same reason and the same ordering requirement again: splitting a path into name + directory is what every
    // file row in the app does, including the ones in unit-tested pure modules (fileType.ts, explorerPaste.ts).
    "@intentic/ui/path": fromRoot("_editor/ui/src/lib/path.ts"),
    // And again, for the same module: fileType.ts maps every extension the app knows onto a `ShikiLang`, so the
    // grammar table is what that mapping is type-checked against. A plain map of dynamic-import thunks, nothing
    // from shiki/core is loaded by naming it.
    "@intentic/ui/langs": fromRoot("_editor/ui/src/lib/shikiLangs.ts"),
    // And the highlighter itself: the review analyzer runs inside a dedicated worker, where pulling the UI
    // barrel's Vue components and browser-device composables would be both wasteful and invalid.
    "@intentic/ui/highlighter": fromRoot("_editor/ui/src/composables/useHighlighter.ts"),
    // Same again: the chart palette's slot→colour lookup is called by the usage/savings PROJECTIONS, which are
    // pure functions with their own unit tests, reaching it through the barrel boots Picker.vue and wants a DOM.
    "@intentic/ui/series": fromRoot("_editor/ui/src/components/seriesAccent.ts"),
    // And again: what a failure IS, the shape, the severity order, the duplicate collapsing, is plain data
    // reached by composables that never render (useAsyncAction builds one from a caught value) and by their
    // unit tests. <Notice> and <NoticeStack> come from the barrel like every other component.
    "@intentic/ui/notice": fromRoot("_editor/ui/src/components/notice.ts"),
    // And once more: the 1h/24h/7d/All vocabulary is arithmetic over a timestamp, called by the feeds' pure
    // projections and pinned by their unit tests, none of which should need a DOM to ask how far back "7d" is.
    "@intentic/ui/time": fromRoot("_editor/ui/src/lib/timeWindow.ts"),
    // And again, for the app's date/byte/token formatting: the history list's day label, the usage window's
    // reset and an extension's day dividers are all pure functions over a number, reached from composables and
    // pure projections whose unit tests run without a DOM.
    "@intentic/ui/format": fromRoot("_editor/ui/src/lib/format.ts"),
    // And again, for the busy-flag and wall-clock composables (moved into the kit when drafts became an
    // extension): plain state on vue's reactivity, reached from dozens of composables whose node tests must not
    // boot the component graph, the theme reader touches `document` at module scope, to build a notice.
    "@intentic/ui/async": fromRoot("_editor/ui/src/lib/async.ts"),
    // And again, for the gate that decides whether a wait is DRAWN. Its two thresholds are the whole of it, so
    // its test drives fake timers over plain reactivity, and reaching it through the barrel would boot the
    // component graph (whose theme reader touches `document` at module scope) to ask a question about a clock.
    "@intentic/ui/loading-reveal": fromRoot("_editor/ui/src/composables/loadingReveal.ts"),
    // And once more, for the icon VOCABULARY rather than the <Icon> that draws it: every icon name arriving
    // from a manifest is an open string, and the tests that check our own extensions name real glyphs read
    // JSON off disk, no components, no DOM, and nothing to gain from booting Picker.vue to get there.
    "@intentic/ui/icons": fromRoot("_editor/ui/src/icons/iconSets.ts"),
    // And again, for the arithmetic that makes a brand mark legible on our own plate: it is what decides whether
    // 24 official brand hexes clear the separation bar in both schemes, which is a claim only a test can hold,
    // and one that must not need a DOM (nor <BrandMark> itself) to be asked.
    "@intentic/ui/brand-color": fromRoot("_editor/ui/src/lib/brandColor.ts"),
    // And again, for the gate an extension's own artwork passes through on its way to an <img>: it decides what
    // a registry row is allowed to paint, which is a claim worth a test, and one that must not need a DOM, a
    // network, or <BrandMark> itself to be asked.
    "@intentic/ui/brand-mark": fromRoot("_editor/ui/src/components/brandMark.ts"),
    // And again, for the app's base text size: it is the knob that column widths, editor font sizes and the
    // terminal's grid all convert against (uiScale.ts), so it is reached from plain modules the shell loads on
    // every boot, and through the barrel, asking a column how wide it should be would boot Picker.vue.
    "@intentic/ui/text-size": fromRoot("_editor/ui/src/composables/useTextSize.ts"),
    "@intentic/ui": fromRoot("_editor/ui/src/index.ts"),
    /* THE EXTENSION KIT MUST RESOLVE TO SOURCE HERE, and unlike its neighbours above that is not a convenience
     *, it is the difference between an app and an infinite regress. `@intentic/extension-ui` is PUBLISHED, so
     * its default export condition points at `dist/index.js`, and that file is the host BRIDGE: it hands back
     * `globalThis.__intenticHost.modules["@intentic/extension-ui"]`, which is the object this app fills in by
     * importing the kit. Let the app resolve its own published artifact and it asks itself for the components
     * it was about to provide.
     *
     * Subpath before barrel, per the note at the top of this file. */
    "@intentic/extension-ui/names": fromRoot("_editor/extension-ui/names.mjs"),
    "@intentic/extension-ui/format": fromRoot("_editor/extension-ui/src/format.ts"),
    "@intentic/extension-ui": fromRoot("_editor/extension-ui/src/index.ts"),
    "@intentic-app/api-contract": fromRoot("_platform/api-contract/src/index.ts"),
    // The "+" grid's card and category data. It was the ONE first-party lib missing from this map, and the
    // cost was a silent wrong answer rather than a build error: the app resolved its `dist` instead, so a new
    // CAPABILITY_CATEGORIES entry did not exist as far as `contributionCard` was concerned and every card
    // declaring it fell through to the "extend" catch-all, a card in the wrong section, with nothing failing.
    "@intentic-app/capability-catalog": fromRoot("_platform/capability-catalog/src/index.ts"),
    // Same reason as the markdown subpath above, and the same ordering requirement: the session-name derivation
    // is a dependency-free leaf that the daemon, the app and an extension all reach for, so it is exported off
    // the barrel (a unit test that only wants a session name must not resolve the whole wire contract).
    "@intentic/sandbox-contract/session-names": fromRoot("_sandbox/sandbox-contract/src/session-names.ts"),
    // The chore book, what routine maintenance a repository is owed, and the verdict logic the Maintenance
    // surface, its rail badge and the codebase-health panel's refactor asks all run. Off the barrel for the same
    // reason as the two above: it is derivation over the wire types rather than the wire itself, and a caller
    // that only wants to compose an ask must not resolve every schema in the contract to get there.
    "@intentic/sandbox-contract/chores": fromRoot("_sandbox/sandbox-contract/src/chores/index.ts"),
    "@intentic/sandbox-contract": fromRoot("_sandbox/sandbox-contract/src/index.ts"),
    // The extension-registry file format, imported by the wire contract (schemas.ts), so without this line
    // the dev server resolves it to a dist/ that only exists once the lib has been built.
    "@intentic/registry": fromRoot("_sandbox/registry/src/index.ts"),
    "@intentic/extension-api": fromRoot("_sandbox/extension-api/src/index.ts"),
    ...extensionAliases,
});
