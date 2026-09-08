import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

// Source-first alias map shared by vite.config.ts and vitest.config.ts so app and test resolution can't fork. Libs
// and first-party extensions resolve to true source, not an injected node_modules copy, so a lazily-loaded
// extension view and the app share one host.ts singleton; daemon-only packages are skipped.

// Resolves every alias path from the monorepo root rather than counting `../` segments by hand.
const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);

// Reads every entry point an extension publishes off its own package.json `exports` map, so a new entry doesn't
// need remembering here. Subpaths are emitted before barrels: a string alias also matches `<key>/…`, so a barrel
// would otherwise swallow a subpath and break the dev server in a way no typecheck catches.
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
    // Alias order matters: a string alias also matches `<key>/…`, so a subpath must precede its own barrel, and a
    // prefix-sharing pair (`markdown-document` before `markdown`) must keep that order too, or the import resolves
    // into a directory and fails with ENOTDIR.
    "@intentic/ui/markdown-document": fromRoot("_editor/ui/src/components/markdown/markdownDocument.ts"),
    "@intentic/ui/markdown": fromRoot("_editor/ui/src/markdown/index.ts"),
    // `@intentic/ui/icon` and `@intentic/ui/dag`: the two components the shared transcript page needs without the rest
    // of the barrel. The DAG layout is plain TypeScript with its own unit tests, which must not boot the component
    // graph to reach it.
    "@intentic/ui/icon": fromRoot("_editor/ui/src/components/primitives/Icon.vue"),
    "@intentic/ui/glyph": fromRoot("_editor/ui/src/icons/glyph.ts"),
    // Icon is registered globally by installUi, so component tests need a stand-in for it; one shared fixture here
    // instead of one per suite.
    "@intentic/ui/testing": fromRoot("_editor/ui/src/testing.ts"),
    "@intentic/ui/markdown-view": fromRoot("_editor/ui/src/components/markdown/Markdown.vue"),
    "@intentic/ui/dag": fromRoot("_editor/ui/src/components/charts/dagLayout.ts"),
    // Pure path-splitting helper used by unit-tested modules (fileType.ts, explorerPaste.ts) that must not boot the
    // component graph to reach it.
    "@intentic/ui/path": fromRoot("_editor/ui/src/lib/path.ts"),
    // Plain map of dynamic-import thunks; fileType.ts type-checks its extension-to-language mapping against this
    // without loading shiki/core itself.
    "@intentic/code-read/langs": fromRoot("_tools/code-read/src/langs.ts"),
    // The code-reading walk (comment strip, code-only counts) shared with the daemon so a row's numbers and the pane's
    // diff cannot disagree; no Vue in it.
    "@intentic/code-read": fromRoot("_tools/code-read/src/index.ts"),
    // The syntax highlighter; the review analyzer runs inside a worker, where the UI barrel's Vue components and
    // browser composables are invalid.
    "@intentic/ui/highlighter": fromRoot("_editor/ui/src/composables/useHighlighter.ts"),
    // Chart palette's slot-to-colour lookup, called by pure usage/savings projections; through the barrel it would
    // boot Picker.vue and want a DOM.
    "@intentic/ui/series": fromRoot("_editor/ui/src/components/charts/seriesAccent.ts"),
    // Failure shape, severity order and duplicate-collapsing as plain data, used by non-rendering composables and
    // their tests; <Notice>/<NoticeStack> still come from the barrel.
    "@intentic/ui/notice": fromRoot("_editor/ui/src/components/feedback/notice.ts"),
    // The 1h/24h/7d/All window vocabulary, pure arithmetic over a timestamp used by feed projections and their unit
    // tests.
    "@intentic/ui/time": fromRoot("_editor/ui/src/lib/timeWindow.ts"),
    // Date/byte/token formatting used by pure projections (history day labels, usage window resets) whose unit tests
    // run without a DOM.
    "@intentic/ui/format": fromRoot("_editor/ui/src/lib/format.ts"),
    // Busy-flag and wall-clock composables, plain state over Vue reactivity, reached by node-tested composables that
    // must not boot the component graph (its theme reader touches `document` at module scope).
    "@intentic/ui/async": fromRoot("_editor/ui/src/lib/async.ts"),
    // Gate deciding whether a wait indicator is shown; its test drives fake timers over plain reactivity and must not
    // boot the component graph to ask a question about a clock.
    "@intentic/ui/loading-reveal": fromRoot("_editor/ui/src/composables/loadingReveal.ts"),
    // Press-state machine (a clock and two booleans) shared by <Button> and the `v-action` directive, so the app has
    // one answer for how a press feels.
    "@intentic/ui/press": fromRoot("_editor/ui/src/lib/pressLock.ts"),
    // Icon name vocabulary, not the <Icon> component; tests that check an extension's icon names against real glyphs
    // read this as JSON, no DOM.
    "@intentic/ui/icons": fromRoot("_editor/ui/src/icons/iconSets.ts"),
    // Contrast arithmetic checking whether brand hexes clear the separation bar in both color schemes; tested without
    // a DOM or <BrandMark>.
    "@intentic/ui/brand-color": fromRoot("_editor/ui/src/lib/brandColor.ts"),
    // Gate deciding what an extension's own artwork may paint into a registry row; tested without a DOM, network, or
    // <BrandMark>.
    "@intentic/ui/brand-mark": fromRoot("_editor/ui/src/components/brand/brandMark.ts"),
    // Preference primitive (Vue state plus localStorage) used by every `ui-*` key in web/composables; through the
    // barrel, reading one would cost loading mermaid.
    "@intentic/ui/preference": fromRoot("_editor/ui/src/composables/preference.ts"),
    // Base text-size knob that column widths, editor font sizes and the terminal grid convert against; loaded on every
    // boot, so it must not drag in Picker.vue via the barrel.
    "@intentic/ui/text-size": fromRoot("_editor/ui/src/composables/useTextSize.ts"),
    // Scheme-and-accent singleton answering a two-attribute question on <html>; through the barrel that question would
    // also cost mermaid, shiki and vue-flow.
    "@intentic/ui/theme": fromRoot("_editor/ui/src/composables/useTheme.ts"),
    // Folds a machine's flat folder/port lists into one block per sandbox; drawn by <DeviceDetail>, and reasoned over
    // by deviceFacts.ts without rendering anything.
    "@intentic/ui/device": fromRoot("_editor/ui/src/components/sandbox/deviceDetail.ts"),
    // What a sandbox's resource share means (where the Resources form starts, what changed on Apply); its arithmetic
    // is unit-tested without booting the component graph.
    "@intentic/ui/sandbox-resources": fromRoot("_editor/ui/src/components/sandbox/sandboxResources.ts"),
    // Guard against a stylesheet being replaced by a no-op write; installed on Vite's own dev-style nodes before the
    // app mounts, so it must stay import-light.
    "@intentic/ui/style-stability": fromRoot("_editor/ui/src/lib/styleStability.ts"),
    "@intentic/ui": fromRoot("_editor/ui/src/index.ts"),
    // This one must resolve to source, not as a convenience: `@intentic/extension-ui`'s published dist/index.js is the
    // host bridge that hands back `globalThis.__intenticHost.modules[...]`, the object this app fills by importing the
    // kit. Resolving to the published artifact would make the app ask itself for components it hasn't provided yet.
    "@intentic/extension-ui/names": fromRoot("_shared/extension-ui/names.mjs"),
    "@intentic/extension-ui/format": fromRoot("_shared/extension-ui/src/format.ts"),
    "@intentic/extension-ui": fromRoot("_shared/extension-ui/src/index.ts"),
    "@intentic/api-contract": fromRoot("_shared/api-contract/src/index.ts"),
    // The "+" grid's card/category data; omitted from this map, the app would silently resolve a stale `dist` instead
    // of failing to build.
    "@intentic/capability-catalog": fromRoot("_shared/capability-catalog/src/index.ts"),
    // Dependency-free session-name leaf shared by daemon, app and extensions; off the barrel so a test wanting just
    // this doesn't resolve the whole wire contract.
    "@intentic/sandbox-contract/session-names": fromRoot("_shared/sandbox-contract/src/ids/session-names.ts"),
    // Chore-verdict logic used by the Maintenance surface, its rail badge and the codebase-health panel; off the
    // barrel since it derives from wire types without needing the whole contract.
    "@intentic/sandbox-contract/chores": fromRoot("_shared/sandbox-contract/src/chores/index.ts"),
    // Folds a turn's frames into the rows every reader draws; the daemon runs it, the chat applies its patches. Off
    // the barrel since it derives from wire types alone.
    "@intentic/sandbox-contract/transcript-fold": fromRoot("_shared/sandbox-contract/src/text/transcript-fold.ts"),
    // Derives a batch run's ids and manifest paths, shared by acceptance, documentation and maintenance so they can't
    // disagree on where a run lives.
    "@intentic/sandbox-contract/batch-runs": fromRoot("_shared/sandbox-contract/src/policy/batch-runs.ts"),
    "@intentic/sandbox-contract": fromRoot("_shared/sandbox-contract/src/index.ts"),
    // Extension-registry file format, imported by the wire contract's schemas.ts; without this alias the dev server
    // resolves to a `dist/` that may not exist yet.
    "@intentic/registry": fromRoot("_shared/registry/src/index.ts"),
    "@intentic/extension-api": fromRoot("_shared/extension-api/src/index.ts"),
    ...extensionAliases,
});
