import type { PackageModules } from "@intentic/sandbox-contract";
import { cyclesAmong, stackOf, unitLinks } from "./layerModel";

const link = (from: string, to: string, imports = 1) => ({ from, to, imports, sites: [`${from}/x.ts:1`] });

describe(`cyclesAmong`, () => {
    it(`finds each strongly connected group of more than one unit`, () => {
        expect(
            cyclesAmong([`a`, `b`, `c`, `d`, `e`], [link(`a`, `b`), link(`b`, `c`), link(`c`, `a`), link(`c`, `d`), link(`d`, `e`), link(`e`, `d`)]),
        ).toEqual([
            [`a`, `b`, `c`],
            [`d`, `e`],
        ]);
    });
});

describe(`stackOf with declared layers`, () => {
    const modules: PackageModules = {
        package: `@s/web`,
        root: `web/src`,
        layers: [{ name: `base` }, { name: `features`, about: `one per area` }],
        units: [
            { id: `(root)`, modules: 2 },
            { id: `lib`, modules: 4, layer: 0 },
            { id: `(surface)`, modules: 1, surface: true },
            { id: `features/a`, modules: 3, layer: 1 },
            { id: `features/b`, modules: 3, layer: 1 },
            { id: `stray`, modules: 1 },
        ],
        edges: [
            link(`(root)`, `features/a`),
            link(`features/a`, `lib`),
            link(`lib`, `features/b`, 2),
            link(`lib`, `(surface)`),
            link(`features/a`, `features/b`),
            link(`features/b`, `features/a`),
            link(`(surface)`, `features/a`),
        ],
    };

    it(`draws the layers highest first, with the root files, the surface and what no layer places around them`, () => {
        const stack = stackOf(modules);
        expect(stack.rows.map(({ name, units }) => [name, units.map(({ id }) => id)])).toEqual([
            [`(root)`, [`(root)`]],
            [`surface`, [`(surface)`]],
            [`features`, [`features/a`, `features/b`]],
            [`base`, [`lib`]],
            [`unplaced`, [`stray`]],
        ]);
        expect(stack.unplaced).toEqual([`stray`]);
    });

    it(`calls an import into a higher layer or a surface upward, and finds cycles within one layer only`, () => {
        const stack = stackOf(modules);
        expect(stack.upward.map(({ from, to }) => `${from}>${to}`)).toEqual([`lib>features/b`, `lib>(surface)`]);
        expect(stack.cycles.map(({ units }) => units)).toEqual([[`features/a`, `features/b`]]);
    });
});

describe(`stackOf without layers`, () => {
    it(`stacks units in the tiers their imports imply, a cycle sharing one tier`, () => {
        const stack = stackOf({
            package: `@s/lib`,
            root: `lib/src`,
            units: [`(root)`, `a`, `b`, `c`, `d`].map((id) => ({ id, modules: 1 })),
            edges: [link(`(root)`, `a`), link(`a`, `b`), link(`b`, `c`), link(`c`, `b`), link(`c`, `d`)],
        });
        expect(stack.declared).toBe(false);
        expect(stack.rows.map(({ name, units }) => [name, units.map(({ id }) => id)])).toEqual([
            [`(root)`, [`(root)`]],
            [`2`, [`a`]],
            [`1`, [`b`, `c`]],
            [`0`, [`d`]],
        ]);
        expect(stack.cycles.map(({ units }) => units)).toEqual([[`b`, `c`]]);
    });
});

describe(`unitLinks`, () => {
    it(`lists a unit's imports out and in, heaviest first`, () => {
        const links = unitLinks({ package: `x`, root: `x`, units: [], edges: [link(`a`, `b`), link(`a`, `c`, 3), link(`d`, `a`)] }, `a`);
        expect(links.out.map(({ to }) => to)).toEqual([`c`, `b`]);
        expect(links.in.map(({ from }) => from)).toEqual([`d`]);
    });
});
