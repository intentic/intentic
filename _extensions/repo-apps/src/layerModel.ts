import type { PackageModules, PackageUnit, PackageUnitEdge } from "@intentic/sandbox-contract";

// One package's insides as the view draws them: a stack of rows, lowest at the bottom. With a layers.json the rows are
// its layers, and the findings are what its boundary check would refuse: an import reaching a higher layer, a cycle
// between units of one layer, a unit no layer places. Without one the rows are tiers the imports themselves imply (a
// unit importing nothing sits at the bottom, each other one above everything it imports), and the findings are the
// cycles, which no order can put in a row of their own.

export const ROOT_UNIT = `(root)`;

export interface Row {
    readonly key: string;
    readonly name: string;
    readonly about?: string;
    readonly units: readonly PackageUnit[];
}

export interface Stack {
    // Highest first, the order they are drawn top to bottom.
    readonly rows: readonly Row[];
    readonly declared: boolean;
    readonly upward: readonly PackageUnitEdge[];
    // Each cycle's units, and the edges between them.
    readonly cycles: readonly { readonly units: readonly string[]; readonly edges: readonly PackageUnitEdge[] }[];
    readonly unplaced: readonly string[];
}

/** Strongly connected components of more than one node (Tarjan), each sorted, in a stable order. */
export const cyclesAmong = (nodes: readonly string[], edges: readonly PackageUnitEdge[]): string[][] => {
    const out = new Map<string, string[]>();
    for (const { from, to } of edges) {
        (out.get(from) ?? out.set(from, []).get(from)!).push(to);
    }
    let index = 0;
    const order = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const found: string[][] = [];
    // Iterative, so a long chain of units cannot overflow the stack.
    for (const root of nodes) {
        if (order.has(root)) {
            continue;
        }
        const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
        order.set(root, index);
        low.set(root, index++);
        stack.push(root);
        onStack.add(root);
        while (work.length > 0) {
            const frame = work.at(-1)!;
            const targets = out.get(frame.node) ?? [];
            if (frame.next < targets.length) {
                const target = targets[frame.next++]!;
                if (!order.has(target)) {
                    order.set(target, index);
                    low.set(target, index++);
                    stack.push(target);
                    onStack.add(target);
                    work.push({ node: target, next: 0 });
                } else if (onStack.has(target)) {
                    low.set(frame.node, Math.min(low.get(frame.node)!, order.get(target)!));
                }
                continue;
            }
            work.pop();
            const parent = work.at(-1);
            if (parent !== undefined) {
                low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
            }
            if (low.get(frame.node) === order.get(frame.node)) {
                const component: string[] = [];
                let member: string;
                do {
                    member = stack.pop()!;
                    onStack.delete(member);
                    component.push(member);
                } while (member !== frame.node);
                if (component.length > 1) {
                    found.push(component.toSorted());
                }
            }
        }
    }
    return found.toSorted((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
};

const judged = (unit: PackageUnit | undefined): unit is PackageUnit => unit !== undefined && unit.id !== ROOT_UNIT;

/** Whether an import between two units reaches higher than its source may: into a higher layer, or into a surface. */
export const isUpward = (from: PackageUnit | undefined, to: PackageUnit | undefined): boolean => {
    if (!judged(from) || !judged(to) || from.surface === true) {
        return false;
    }
    if (to.surface === true) {
        return true;
    }
    return from.layer !== undefined && to.layer !== undefined && to.layer > from.layer;
};

const withCycles = (edges: readonly PackageUnitEdge[], units: readonly string[]) =>
    cyclesAmong(units, edges).map((members) => {
        const inside = new Set(members);
        return { units: members, edges: edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to)) };
    });

/** The stack a package's modules make: its declared layers when it has them, the tiers its imports imply otherwise. */
export const stackOf = (modules: PackageModules): Stack => {
    const units = new Map(modules.units.map((unit) => [unit.id, unit]));
    const rootRow = (list: readonly PackageUnit[]): Row[] => (list.length > 0 ? [{ key: `root`, name: ROOT_UNIT, units: list }] : []);
    const roots = modules.units.filter((unit) => unit.id === ROOT_UNIT);

    if (modules.layers !== undefined) {
        const upward = modules.edges.filter((edge) => isUpward(units.get(edge.from), units.get(edge.to)));
        // A cycle is looked for only among imports that stay in one layer, as the boundary checks look for one.
        const sameLayer = modules.edges.filter((edge) => {
            const from = units.get(edge.from);
            const to = units.get(edge.to);
            return judged(from) && judged(to) && from.surface !== true && to.surface !== true && from.layer !== undefined && from.layer === to.layer;
        });
        const placed = modules.units.filter((unit) => unit.layer !== undefined);
        const unplaced = modules.units.filter((unit) => unit.layer === undefined && unit.surface !== true && unit.id !== ROOT_UNIT);
        const surface = modules.units.filter((unit) => unit.surface === true);
        const layerRows: Row[] = modules.layers.map((layer, at) => ({
            key: `layer-${at}`,
            name: layer.name,
            ...(layer.about !== undefined ? { about: layer.about } : {}),
            units: placed.filter((unit) => unit.layer === at),
        }));
        const rows: Row[] = [
            ...rootRow(roots),
            ...(surface.length > 0 ? [{ key: `surface`, name: `surface`, units: surface }] : []),
            ...layerRows.toReversed(),
            ...(unplaced.length > 0 ? [{ key: `unplaced`, name: `unplaced`, units: unplaced }] : []),
        ];
        return {
            rows,
            declared: true,
            upward,
            cycles: withCycles(sameLayer, [...units.keys()]),
            unplaced: unplaced.map((unit) => unit.id),
        };
    }

    // Tiers: collapse each cycle to one node, then a node's tier is the longest chain of imports below it.
    const inner = modules.units.filter((unit) => unit.id !== ROOT_UNIT);
    const innerEdges = modules.edges.filter((edge) => edge.from !== ROOT_UNIT && edge.to !== ROOT_UNIT);
    const cycles = withCycles(
        innerEdges,
        inner.map((unit) => unit.id),
    );
    const groupOf = new Map<string, string>();
    for (const cycle of cycles) {
        for (const unit of cycle.units) {
            groupOf.set(unit, cycle.units[0]!);
        }
    }
    const node = (id: string): string => groupOf.get(id) ?? id;
    const below = new Map<string, Set<string>>();
    for (const { from, to } of innerEdges) {
        if (node(from) !== node(to)) {
            (below.get(node(from)) ?? below.set(node(from), new Set()).get(node(from))!).add(node(to));
        }
    }
    const tiers = new Map<string, number>();
    const tierOf = (id: string): number => {
        const known = tiers.get(id);
        if (known !== undefined) {
            return known;
        }
        // The condensed graph has no cycle, so this recursion ends; its depth is the longest chain, a few dozen at most.
        const tier = Math.max(-1, ...[...(below.get(id) ?? [])].map(tierOf)) + 1;
        tiers.set(id, tier);
        return tier;
    };
    const byTier = new Map<number, PackageUnit[]>();
    for (const unit of inner) {
        const tier = tierOf(node(unit.id));
        (byTier.get(tier) ?? byTier.set(tier, []).get(tier)!).push(unit);
    }
    const tierRows: Row[] = [...byTier].toSorted(([a], [b]) => b - a).map(([tier, list]) => ({ key: `tier-${tier}`, name: `${tier}`, units: list }));
    return { rows: [...rootRow(roots), ...tierRows], declared: false, upward: [], cycles, unplaced: [] };
};

/** One unit's imports both ways, heaviest first. */
export const unitLinks = (modules: PackageModules, id: string): { readonly out: PackageUnitEdge[]; readonly in: PackageUnitEdge[] } => {
    const heaviest = (a: PackageUnitEdge, b: PackageUnitEdge): number =>
        b.imports - a.imports || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
    return {
        out: modules.edges.filter((edge) => edge.from === id).toSorted(heaviest),
        in: modules.edges.filter((edge) => edge.to === id).toSorted(heaviest),
    };
};
