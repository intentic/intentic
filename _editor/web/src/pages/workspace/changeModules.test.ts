import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { moduleGroups, moduleOf, rowName } from "./changeModules";

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

    it(`names every row under a header by its file`, () => {
        expect(rowName(`_editor/web/src/main.ts`)).toBe(`main.ts`);
        expect(rowName(`ARCHITECTURE.md`)).toBe(`ARCHITECTURE.md`);
    });
});
