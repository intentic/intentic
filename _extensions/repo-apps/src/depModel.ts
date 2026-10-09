import type { WorkspaceComponent, WorkspaceDepEdge, WorkspaceDepUsage, WorkspacePackage } from "@intentic/sandbox-contract";

// What the Dependencies view computes from the daemon's package graph, kept out of the components so it is testable:
// which edges a longer path already implies, which packages so many others use that they are better shown as chips than
// as lines, the areas packages group into and the order they stack in, and the findings the declared edges and their
// usage add up to. All of it is derived, none of it is configured.

export type Grouping = `component` | `folder`;

export interface Area {
    readonly id: string;
    readonly label: string;
    // A CSS colour for the area's stripe and legend dot.
    readonly color: string;
    readonly packages: readonly string[];
}

export const edgeKey = (edge: Pick<WorkspaceDepEdge, `from` | `to` | `type`>): string => `${edge.from}>${edge.to}:${edge.type}`;
export const isRuntime = (edge: WorkspaceDepEdge): boolean => edge.type !== `dev`;

// Packages without a component when the map exists sit in one area of their own.
export const UNMAPPED = `(unmapped)`;
const SLOTS = 5;
const slotColor = (slot: string | undefined): string =>
    slot === undefined || slot === `neutral` ? `var(--color-series-other)` : `var(--color-series-${slot})`;

/** Every edge `from -> to` some longer path between the same two packages already implies. */
export const impliedEdges = (edges: readonly WorkspaceDepEdge[]): Set<string> => {
    const out = new Map<string, Set<string>>();
    for (const { from, to } of edges) {
        (out.get(from) ?? out.set(from, new Set()).get(from)!).add(to);
    }
    const reach = new Map<string, Set<string>>();
    // Iterative, so a deep chain cannot overflow the stack; a cycle stops at a node already on the way.
    const reachOf = (start: string): Set<string> => {
        const held = reach.get(start);
        if (held !== undefined) {
            return held;
        }
        const seen = new Set<string>();
        const stack = [...(out.get(start) ?? [])];
        while (stack.length > 0) {
            const next = stack.pop()!;
            if (seen.has(next)) {
                continue;
            }
            seen.add(next);
            const known = reach.get(next);
            if (known !== undefined) {
                for (const node of known) {
                    seen.add(node);
                }
                continue;
            }
            stack.push(...(out.get(next) ?? []));
        }
        reach.set(start, seen);
        return seen;
    };
    const implied = new Set<string>();
    for (const edge of edges) {
        const siblings = out.get(edge.from) ?? new Set<string>();
        if ([...siblings].some((other) => other !== edge.to && other !== edge.from && reachOf(other).has(edge.to))) {
            implied.add(edgeKey(edge));
        }
    }
    return implied;
};

/** How many distinct packages declare a runtime dependency on each package. */
export const dependentCounts = (edges: readonly WorkspaceDepEdge[]): Map<string, number> => {
    const dependents = new Map<string, Set<string>>();
    for (const edge of edges.filter(isRuntime)) {
        (dependents.get(edge.to) ?? dependents.set(edge.to, new Set()).get(edge.to)!).add(edge.from);
    }
    return new Map([...dependents].map(([name, from]) => [name, from.size]));
};

/**
 * The packages so many others use at runtime that a line to each would cross the whole picture: at least 12% of the
 * workspace and never fewer than eight dependents, most used first. A small workspace has none.
 */
export const hubsOf = (packages: readonly WorkspacePackage[], edges: readonly WorkspaceDepEdge[]): string[] => {
    const threshold = Math.max(8, Math.ceil(packages.length * 0.12));
    return [...dependentCounts(edges)]
        .filter(([, count]) => count >= threshold)
        .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .map(([name]) => name);
};

/** A hub's mark on a card: the initials of its unscoped name's words, two letters when one word. */
export const monogramsOf = (hubs: readonly string[]): Map<string, string> => {
    const taken = new Set<string>();
    const marks = new Map<string, string>();
    for (const hub of hubs) {
        const words = (hub.split(`/`).at(-1) ?? hub).split(/[-_.]/).filter((word) => word !== ``);
        const candidates = [words.map((word) => word[0]).join(``), (words[0] ?? hub).slice(0, 2), hub.split(`/`).at(-1) ?? hub];
        const mark = candidates.find((candidate) => !taken.has(candidate)) ?? hub;
        taken.add(mark);
        marks.set(hub, mark);
    }
    return marks;
};

/** Which area a package sits in, by its component or by its top-level folder. */
export const areaIdOf = (pkg: WorkspacePackage, grouping: Grouping): string => (grouping === `component` ? (pkg.component ?? UNMAPPED) : pkg.group);

/**
 * The longest chain of runtime dependencies below each package: 0 for one that uses no sibling. A cycle (which pnpm
 * allows) counts each package once on the way.
 */
export const heightsOf = (packages: readonly WorkspacePackage[], edges: readonly WorkspaceDepEdge[]): Map<string, number> => {
    const out = new Map<string, string[]>();
    for (const edge of edges.filter(isRuntime)) {
        (out.get(edge.from) ?? out.set(edge.from, []).get(edge.from)!).push(edge.to);
    }
    const heights = new Map<string, number>();
    const onPath = new Set<string>();
    const heightOf = (name: string): number => {
        const known = heights.get(name);
        if (known !== undefined) {
            return known;
        }
        if (onPath.has(name)) {
            return 0;
        }
        onPath.add(name);
        const height = Math.max(-1, ...(out.get(name) ?? []).map(heightOf)) + 1;
        onPath.delete(name);
        heights.set(name, height);
        return height;
    };
    for (const { name } of packages) {
        heightOf(name);
    }
    return heights;
};

// Exact ordering up to this many areas (a subset DP, 2^n states); a greedy one past it.
const EXACT_UP_TO = 14;

/**
 * The order of `ids` that leaves the fewest runtime edges pointing from an area to one after it, so that reading left
 * to right (or bottom to top) is reading foundation first and every edge that remains against the order is one the
 * structure itself puts there, not the ordering. `weight(a, b)` counts the edges by which a depends on b. Ties keep
 * `ids`' own order.
 */
export const flowOrder = (ids: readonly string[], weight: (from: string, to: string) => number): string[] => {
    const n = ids.length;
    if (n <= 1) {
        return [...ids];
    }
    if (n > EXACT_UP_TO) {
        // Greedy: place next the area whose remaining dependencies are fewest, dependencies before dependents.
        const left = [...ids];
        const order: string[] = [];
        while (left.length > 0) {
            const cost = (id: string): number => left.reduce((sum, other) => sum + (other === id ? 0 : weight(id, other)), 0);
            const next = left.reduce((best, id) => (cost(id) < cost(best) ? id : best));
            order.push(next);
            left.splice(left.indexOf(next), 1);
        }
        return order;
    }
    // best[set]: the fewest upward edges among the areas in `set` placed first, in some order; `last` rebuilds it.
    const best = Array.from<number>({ length: 1 << n }).fill(Number.POSITIVE_INFINITY);
    const last = Array.from<number>({ length: 1 << n }).fill(-1);
    best[0] = 0;
    for (let set = 0; set < 1 << n; set++) {
        if (best[set] === Number.POSITIVE_INFINITY) {
            continue;
        }
        for (let next = 0; next < n; next++) {
            if ((set & (1 << next)) !== 0) {
                continue;
            }
            // Placing `next` after `set`: every member of `set` that depends on it now points to its right.
            let added = 0;
            for (let placed = 0; placed < n; placed++) {
                if ((set & (1 << placed)) !== 0) {
                    added += weight(ids[placed]!, ids[next]!);
                }
            }
            const grown = set | (1 << next);
            if (best[set]! + added < best[grown]!) {
                best[grown] = best[set]! + added;
                last[grown] = next;
            }
        }
    }
    const order: string[] = [];
    for (let set = (1 << n) - 1; set !== 0; set &= ~(1 << last[set]!)) {
        order.push(ids[last[set]!]!);
    }
    return order.toReversed();
};

/**
 * The areas, foundation first: in the order that leaves the fewest edges pointing up it (`flowOrder`), starting from
 * how far up the dependency chains their packages sit on average. Colours come from the map's own accents when
 * grouping by component, and otherwise go to the five largest folders in order, the rest neutral.
 */
export const areasOf = (
    packages: readonly WorkspacePackage[],
    edges: readonly WorkspaceDepEdge[],
    grouping: Grouping,
    components: readonly WorkspaceComponent[] = [],
): Area[] => {
    const heights = heightsOf(packages, edges);
    const members = new Map<string, WorkspacePackage[]>();
    for (const pkg of packages) {
        const id = areaIdOf(pkg, grouping);
        (members.get(id) ?? members.set(id, []).get(id)!).push(pkg);
    }
    const mean = (list: readonly WorkspacePackage[]): number => list.reduce((sum, pkg) => sum + (heights.get(pkg.name) ?? 0), 0) / list.length;
    const areaOf = new Map(packages.map((pkg) => [pkg.name, areaIdOf(pkg, grouping)]));
    const cells = areaMatrix(edges.filter(isRuntime), areaOf);
    const start = [...members].toSorted(([a, x], [b, y]) => mean(x) - mean(y) || a.localeCompare(b)).map(([id]) => id);
    const ordered = flowOrder(start, (from, to) => (from === to ? 0 : (cells.get(`${from}>${to}`)?.length ?? 0)));
    const named = new Map(components.map((component) => [component.id, component]));
    const bySize = [...members].toSorted(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b)).map(([id]) => id);
    return ordered.map((id) => {
        const component = named.get(id);
        const rank = bySize.indexOf(id);
        const color = grouping === `component` ? slotColor(component?.accent) : slotColor(rank < SLOTS ? String(rank + 1) : undefined);
        return { id, label: component?.name ?? id, color, packages: (members.get(id) ?? []).map((pkg) => pkg.name).toSorted() };
    });
};

/** The edges between each ordered pair of areas, keyed `from>to`, an area's own edges included. */
export const areaMatrix = (edges: readonly WorkspaceDepEdge[], areaOfPackage: ReadonlyMap<string, string>): Map<string, WorkspaceDepEdge[]> => {
    const cells = new Map<string, WorkspaceDepEdge[]>();
    for (const edge of edges) {
        const key = `${areaOfPackage.get(edge.from)}>${areaOfPackage.get(edge.to)}`;
        (cells.get(key) ?? cells.set(key, []).get(key)!).push(edge);
    }
    return cells;
};

export type FindingKind = `unused` | `toolingOnly` | `mutual`;

export interface Finding {
    readonly kind: FindingKind;
    readonly edges: readonly WorkspaceDepEdge[];
    // For `mutual`: the two areas, the lighter direction first, which is where the edges listed run.
    readonly areas?: readonly [string, string];
    // For `mutual`: how many edges run the other way.
    readonly against?: number;
}

/**
 * What the declared edges and their usage add up to, most actionable first: runtime dependencies nothing in the
 * dependent uses, runtime dependencies only its tests and tooling use, and pairs of areas that depend on each other
 * both ways, listing the lighter direction's edges since those are the ones out of step with the rest.
 */
export const findingsOf = (edges: readonly WorkspaceDepEdge[], areaOfPackage: ReadonlyMap<string, string>): Finding[] => {
    const runtime = edges.filter(isRuntime);
    const findings: Finding[] = [];
    const unused = runtime.filter((edge) => edge.usage === `none`);
    if (unused.length > 0) {
        findings.push({ kind: `unused`, edges: unused });
    }
    const toolingOnly = runtime.filter((edge) => edge.usage === `tooling`);
    if (toolingOnly.length > 0) {
        findings.push({ kind: `toolingOnly`, edges: toolingOnly });
    }
    const cells = areaMatrix(runtime, areaOfPackage);
    const seen = new Set<string>();
    const mutual: Finding[] = [];
    for (const [key, there] of cells) {
        const [a, b] = key.split(`>`) as [string, string];
        const back = cells.get(`${b}>${a}`);
        if (a === b || back === undefined || seen.has(`${b}>${a}`)) {
            continue;
        }
        seen.add(key);
        const [light, heavy, lightFrom, lightTo] = there.length <= back.length ? [there, back, a, b] : [back, there, b, a];
        mutual.push({ kind: `mutual`, edges: light, areas: [lightFrom, lightTo], against: heavy.length });
    }
    return [...findings, ...mutual.toSorted((x, y) => x.edges.length - y.edges.length)];
};

export interface Closure {
    readonly uses: ReadonlySet<string>;
    readonly usedBy: ReadonlySet<string>;
    readonly usesEdges: ReadonlySet<string>;
    readonly usedByEdges: ReadonlySet<string>;
}

/** What `start` reaches over `edges` both ways: its dependencies (`uses`) and its dependents (`usedBy`). */
export const closureOf = (start: string, edges: readonly WorkspaceDepEdge[]): Closure => {
    const walk = (follow: (edge: WorkspaceDepEdge, id: string) => string | undefined) => {
        const reached = new Set<string>();
        const crossed = new Set<string>();
        const queue = [start];
        while (queue.length > 0) {
            const current = queue.pop()!;
            for (const edge of edges) {
                const next = follow(edge, current);
                if (next === undefined) {
                    continue;
                }
                crossed.add(edgeKey(edge));
                if (next !== start && !reached.has(next)) {
                    reached.add(next);
                    queue.push(next);
                }
            }
        }
        return { reached, crossed };
    };
    const uses = walk((edge, id) => (edge.from === id ? edge.to : undefined));
    const usedBy = walk((edge, id) => (edge.to === id ? edge.from : undefined));
    return { uses: uses.reached, usedBy: usedBy.reached, usesEdges: uses.crossed, usedByEdges: usedBy.crossed };
};

/** The usage an edge without one (an older daemon) is read as: the declaration, taken at its word. */
export const usageOf = (edge: WorkspaceDepEdge): WorkspaceDepUsage => edge.usage ?? `code`;
