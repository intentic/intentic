import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { moduleGroups, moduleOf, moduleView } from "./changeModules";

const MODULES: readonly WorkspaceModule[] = [
    { dir: `_editor/web`, name: `@shop/web` },
    { dir: `_editor/web/operator`, name: `@shop/web-operator` },
    { dir: `_editor/ui`, name: `@shop/ui` },
];

describe(`moduleOf`, () => {
    it(`takes the longest matching module dir`, () => {
        expect(moduleOf(`_editor/web/src/main.ts`, MODULES)?.name).toBe(`@shop/web`);
        expect(moduleOf(`_editor/web/operator/index.html`, MODULES)?.name).toBe(`@shop/web-operator`);
    });

    it(`matches whole segments only`, () => {
        expect(moduleOf(`_apps/webhooks/send.ts`, MODULES)).toBeUndefined();
        expect(moduleOf(`ARCHITECTURE.md`, MODULES)).toBeUndefined();
    });

    it(`lets a repo that is one package claim everything`, () => {
        const single: readonly WorkspaceModule[] = [{ dir: ``, name: `@shop/cli` }];
        expect(moduleOf(`src/index.ts`, single)?.name).toBe(`@shop/cli`);
        expect(moduleOf(`README.md`, single)?.name).toBe(`@shop/cli`);
    });
});

describe(`moduleGroups`, () => {
    const paths = [`_editor/web/src/main.ts`, `ARCHITECTURE.md`, `_editor/web/package.json`, `_editor/ui/src/Row.vue`, `tsconfig.json`];
    const groups = moduleGroups(paths, (path) => path, MODULES, `shop`);

    it(`groups by module in first-appearance order`, () => {
        expect(groups.map((group) => group.name)).toEqual([`@shop/web`, `shop`, `@shop/ui`]);
        expect(groups[0]?.rows).toEqual([`_editor/web/src/main.ts`, `_editor/web/package.json`]);
    });

    it(`gathers unclaimed paths under the repo, marked as no package`, () => {
        const fallback = groups[1]!;
        expect(fallback.rows).toEqual([`ARCHITECTURE.md`, `tsconfig.json`]);
        expect(fallback.packaged).toBe(false);
        expect(groups[0]?.packaged).toBe(true);
    });

    // Grouping is ON by default (useChangeGrouping), so this is what a Rust/Python/Go tree — or any repo with no
    // package manifests at all — reads as: one unclaimed bucket the panels leave unnamed, which is the path list.
    it(`puts a manifest-less repo's every path in one unnamed bucket, in order`, () => {
        const bare = moduleGroups([`src/main.rs`, `Cargo.toml`, `docs/design.md`], (path) => path, [], `engine`);
        expect(bare).toHaveLength(1);
        expect(bare[0]?.rows).toEqual([`src/main.rs`, `Cargo.toml`, `docs/design.md`]);
        expect(bare[0]?.packaged).toBe(false);
    });

    it(`keeps a repo-wide module distinct from the fallback bucket`, () => {
        const single = moduleGroups([`src/index.ts`], (path) => path, [{ dir: ``, name: `@shop/cli` }], `cli`);
        expect(single.map((group) => group.name)).toEqual([`@shop/cli`]);
        expect(single[0]?.packaged).toBe(true);
    });
});

/* The rule both review lists draw from. It is tested HERE rather than through either panel because that is the
 * point of it existing: the two used to answer these questions separately, and separately is how they came to
 * disagree. */
describe(`moduleView`, () => {
    const paths = [`_editor/web/src/main.ts`, `ARCHITECTURE.md`, `_editor/ui/src/Row.vue`];

    it(`heads the buckets when a repo's changes span more than one`, () => {
        const view = moduleView(paths, (path) => path, MODULES, `shop`, true);
        expect(view.named).toBe(true);
        expect(view.buckets.map((bucket) => bucket.name)).toEqual([`@shop/web`, `shop`, `@shop/ui`]);
    });

    // The case the whole `named` flag exists for: one bucket of files no package claims would print the repo's
    // own name directly under the repo's own heading, saying nothing — so it says nothing, and its rows keep
    // their paths.
    it(`leaves a lone unclaimed bucket unnamed`, () => {
        const view = moduleView([`src/main.rs`, `Cargo.toml`], (path) => path, [], `engine`, true);
        expect(view.named).toBe(false);
        expect(view.buckets).toHaveLength(1);
    });

    // A repo that IS one package still earns its heading: the name is the package's, not the repo's, so it
    // tells the reader something the heading above it did not.
    it(`heads a lone bucket that is a real package`, () => {
        const view = moduleView([`src/index.ts`], (path) => path, [{ dir: ``, name: `@shop/cli` }], `cli`, true);
        expect(view.named).toBe(true);
        expect(view.buckets[0]?.name).toBe(`@shop/cli`);
    });

    it(`collapses to one unnamed bucket — the plain path list — with grouping off`, () => {
        const view = moduleView(paths, (path) => path, MODULES, `shop`, false);
        expect(view.named).toBe(false);
        expect(view.buckets).toHaveLength(1);
        expect(view.buckets[0]?.rows).toEqual(paths);
    });
});
