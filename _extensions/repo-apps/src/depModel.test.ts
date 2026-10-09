import type { WorkspaceDepEdge, WorkspacePackage } from "@intentic/sandbox-contract";
import { areaMatrix, areasOf, closureOf, edgeKey, findingsOf, flowOrder, heightsOf, hubsOf, impliedEdges, monogramsOf } from "./depModel";

const pkg = (name: string, group: string, component?: string): WorkspacePackage => ({
    name,
    dir: `${group}/${name}`,
    group,
    ...(component !== undefined ? { component } : {}),
});
const edge = (from: string, to: string, type: WorkspaceDepEdge[`type`] = `prod`, usage: WorkspaceDepEdge[`usage`] = `code`): WorkspaceDepEdge => ({
    from,
    to,
    type,
    usage,
});

describe(`impliedEdges`, () => {
    it(`marks an edge a longer path already implies, and keeps the rest`, () => {
        const edges = [edge(`app`, `lib`), edge(`lib`, `base`), edge(`app`, `base`), edge(`app`, `other`)];
        expect([...impliedEdges(edges)]).toEqual([edgeKey(edge(`app`, `base`))]);
    });

    it(`survives a cycle without implying either half of it`, () => {
        expect(impliedEdges([edge(`a`, `b`), edge(`b`, `a`)]).size).toBe(0);
    });

    it(`keeps a direct edge declared twice, once per block, rather than letting one imply the other`, () => {
        expect(impliedEdges([edge(`a`, `b`), edge(`a`, `b`, `dev`)]).size).toBe(0);
    });
});

describe(`hubsOf`, () => {
    it(`names the packages at least 12% of the workspace and eight dependents use at runtime, most used first`, () => {
        const packages = Array.from({ length: 20 }, (_, at) => pkg(`p${at}`, `_libs`));
        const edges = [
            ...packages.slice(1, 10).map(({ name }) => edge(name, `p0`)),
            ...packages.slice(2, 12).map(({ name }) => edge(name, `p1`)),
            ...packages.slice(3, 10).map(({ name }) => edge(name, `p2`)),
            // Dev edges never make a hub.
            ...packages.slice(3, 19).map(({ name }) => edge(name, `p19`, `dev`)),
        ];
        expect(hubsOf(packages, edges)).toEqual([`p1`, `p0`]);
    });

    it(`gives each hub a distinct mark`, () => {
        expect([...monogramsOf([`@x/sandbox-contract`, `@x/base`, `@x/build`, `@x/sdk-core`])]).toEqual([
            [`@x/sandbox-contract`, `sc`],
            [`@x/base`, `b`],
            [`@x/build`, `bu`],
            // Its initials are taken, so it falls to its first word's first two letters.
            [`@x/sdk-core`, `sd`],
        ]);
    });
});

describe(`areasOf`, () => {
    const packages = [pkg(`app`, `_apps`, `front`), pkg(`ui`, `_libs`, `front`), pkg(`base`, `_tools`, `core`), pkg(`stray`, `_tools`)];
    const edges = [edge(`app`, `ui`), edge(`ui`, `base`), edge(`stray`, `base`)];

    it(`orders areas foundation first, by how high their packages sit on average`, () => {
        expect(heightsOf(packages, edges)).toEqual(
            new Map([
                [`app`, 2],
                [`ui`, 1],
                [`base`, 0],
                [`stray`, 1],
            ]),
        );
        expect(areasOf(packages, edges, `folder`).map(({ id }) => id)).toEqual([`_tools`, `_libs`, `_apps`]);
    });

    it(`groups by the map's components, with its accents, and puts what it does not list in one area`, () => {
        const areas = areasOf(packages, edges, `component`, [
            { id: `front`, name: `Storefront`, accent: `2` },
            { id: `core`, name: `Core` },
        ]);
        expect(areas.map(({ id, label, color }) => [id, label, color])).toEqual([
            [`core`, `Core`, `var(--color-series-other)`],
            [`(unmapped)`, `(unmapped)`, `var(--color-series-other)`],
            [`front`, `Storefront`, `var(--color-series-2)`],
        ]);
    });
});

describe(`flowOrder`, () => {
    const weights: Record<string, number> = { "app>lib": 5, "lib>base": 4, "base>lib": 1, "app>base": 2 };
    const weight = (from: string, to: string): number => weights[`${from}>${to}`] ?? 0;

    it(`orders dependencies before dependents, leaving the lighter half of a two-way pair pointing up`, () => {
        expect(flowOrder([`app`, `lib`, `base`], weight)).toEqual([`base`, `lib`, `app`]);
    });

    it(`agrees with the exact order when there are too many areas for it, on a chain`, () => {
        const ids = Array.from({ length: 16 }, (_, at) => `a${String(at).padStart(2, `0`)}`);
        // Each area depends on the one after it in `ids`, so the foundation is the last.
        const chain = (from: string, to: string): number => (ids.indexOf(to) === ids.indexOf(from) + 1 ? 1 : 0);
        expect(flowOrder(ids, chain)).toEqual(ids.toReversed());
    });
});

describe(`findingsOf`, () => {
    it(`lists unused and tooling-only runtime edges, then each pair of areas using each other with its lighter direction`, () => {
        const areaOf = new Map([
            [`a1`, `A`],
            [`a2`, `A`],
            [`b1`, `B`],
            [`b2`, `B`],
        ]);
        const edges = [
            edge(`b1`, `a1`),
            edge(`b2`, `a1`),
            edge(`a2`, `b1`),
            edge(`b1`, `a2`, `prod`, `none`),
            edge(`b2`, `a2`, `peer`, `tooling`),
            // A dev edge is never a finding, whatever it is used for.
            edge(`a1`, `b2`, `dev`, `none`),
        ];
        expect(findingsOf(edges, areaOf)).toEqual([
            { kind: `unused`, edges: [edge(`b1`, `a2`, `prod`, `none`)] },
            { kind: `toolingOnly`, edges: [edge(`b2`, `a2`, `peer`, `tooling`)] },
            { kind: `mutual`, edges: [edge(`a2`, `b1`)], areas: [`A`, `B`], against: 4 },
        ]);
        expect(areaMatrix(edges, areaOf).get(`B>A`)).toHaveLength(4);
    });
});

describe(`closureOf`, () => {
    it(`walks dependencies and dependents apart`, () => {
        const closure = closureOf(`mid`, [edge(`top`, `mid`), edge(`mid`, `low`), edge(`low`, `floor`), edge(`side`, `low`)]);
        expect([...closure.uses].toSorted()).toEqual([`floor`, `low`]);
        expect([...closure.usedBy]).toEqual([`top`]);
    });
});
