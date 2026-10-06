// A package's layers, read by daemon-boundaries.mjs and editor-boundaries.mjs. A table lists them lowest first, each
// with the path prefixes it holds; a file belongs to the layer whose prefix matches it longest, so a directory can sit
// in one layer while one of its subdirectories (or one module, named without its extension) sits in another.
//
// Together the two rules a boundary check applies keep the import graph acyclic once their baselines are empty: a value
// import that reaches a HIGHER layer than its own is refused (`upward`), and a cycle is looked for only among imports
// that stay in ONE layer (`same`). A downward import is always allowed, because no cycle can pass through one without
// also passing through an upward import or a same-layer cycle, and each of those is already somebody's finding.

/**
 * `layers` is `[{ name, units }]`, lowest first, where each unit is a path prefix relative to the package's `src`.
 * Returns `placeOf(path)`: `{ layer, name, unit }` for the longest unit that is the path itself, a directory above it,
 * or the module it names (`views/registry` for `views/registry.ts`), or undefined when no unit claims it.
 */
export const layering = (layers) => {
    const units = layers
        .flatMap(({ name, units: prefixes }, layer) => prefixes.map((unit) => ({ unit, layer, name })))
        .toSorted((a, b) => b.unit.length - a.unit.length);
    const placeOf = (path) => units.find(({ unit }) => path === unit || path.startsWith(`${unit}/`) || path.startsWith(`${unit}.`));
    return { placeOf, top: layers.length };
};

/** Which way an import from layer `from` to layer `to` points. */
export const directionOf = (from, to) => (to > from ? "up" : to === from ? "same" : "down");

/** Adds one `site` under `key`, counting sites per key: the ratchet's unit for upward imports. */
export const countSite = (counts, sites, key, site) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    (sites.get(key) ?? sites.set(key, []).get(key)).push(site);
};

/**
 * A sink for one package's imports: `record(from, to, site)` files an import between two placed modules (each
 * `{ unit, layer, top, kind? }`, `layer` undefined for a directory no layer places) as an upward site, a same-layer edge
 * between two subsystems, an unplaced directory, or nothing (a downward import, or one inside a unit).
 */
export const layeredSink = (addEdge) => {
    const sameLayer = new Map();
    const upward = new Map();
    const upwardSites = new Map();
    const unplaced = new Set();
    const record = (from, to, site) => {
        const missing = [from, to].filter((end) => end.layer === undefined);
        if (missing.length > 0) {
            for (const end of missing) {
                unplaced.add(end.top);
            }
            return;
        }
        if (to.unit === from.unit) {
            return;
        }
        const direction = directionOf(from.layer, to.layer);
        const betweenSubsystems = from.kind !== "surface" && to.kind !== "surface";
        if (direction === "up") {
            countSite(upward, upwardSites, `${from.unit} -> ${to.unit}`, site);
        } else if (direction === "same" && betweenSubsystems) {
            addEdge(sameLayer, from.unit, to.unit, site);
        }
    };
    return { record, sameLayer, upward, upwardSites, unplaced };
};
