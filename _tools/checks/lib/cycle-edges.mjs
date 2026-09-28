// The edges of an import graph that close a cycle, and each one in words (daemon-boundaries.mjs, editor-boundaries.mjs).
import { stronglyConnected } from "./strongly-connected.mjs";

/**
 * `edges` maps from -> to -> the `file:line` sites that make the edge. An edge closes a cycle exactly when its two ends
 * share a strongly connected component, which is the target reaching back to the source. Returns the nodes, every
 * component of more than one node, the closing edges keyed `from -> to`, and `closes([from, to])`, the edge with its
 * shortest way back. Sorted throughout, so a component, a path back and every message come out the same on every run.
 */
export const cyclesOf = (edges) => {
    const targetsOf = (node) => [...(edges.get(node)?.keys() ?? [])].sort();
    const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flatMap((targets) => [...targets.keys()])])].sort();
    const components = stronglyConnected(nodes, targetsOf);
    const componentOf = new Map();
    for (const component of components) {
        for (const node of component) {
            componentOf.set(node, component);
        }
    }

    const cycleEdges = new Map();
    for (const [from, targets] of edges) {
        for (const to of targets.keys()) {
            if (componentOf.get(from) === componentOf.get(to)) {
                cycleEdges.set(`${from} -> ${to}`, [from, to]);
            }
        }
    }

    // The shortest way from `to` back to `from`, breadth first: [to, …, from].
    const wayBack = (from, to) => {
        const previous = new Map([[to, undefined]]);
        const queue = [to];
        while (queue.length > 0 && !previous.has(from)) {
            const node = queue.shift();
            for (const next of targetsOf(node).filter((candidate) => !previous.has(candidate))) {
                previous.set(next, node);
                queue.push(next);
            }
        }
        const path = [];
        for (let node = from; node !== undefined; node = previous.get(node)) {
            path.unshift(node);
        }
        return path;
    };

    const sitesOf = (from, to) => edges.get(from).get(to);
    // One `file:line` per importing file, the first import in it.
    const filesOf = (from, to) => [...new Map(sitesOf(from, to).map((site) => [site.replace(/:\d+$/, ""), site])).values()];
    const closes = ([from, to]) => {
        const back = wayBack(from, to);
        const hops = back.slice(1).map((node, at) => `${back[at]} -> ${node} (${sitesOf(back[at], node)[0]})`);
        const files = filesOf(from, to);
        const more = files.length > 3 ? ` and ${files.length - 3} more files` : "";
        return `${from} -> ${to} closes ${[from, ...back].join(" -> ")}: imported at ${files.slice(0, 3).join(", ")}${more}; the way back is ${hops.join(", ")}`;
    };

    return { nodes, components: components.filter((component) => component.length > 1), cycleEdges, closes };
};

/** Adds one `site` to the edge `from -> to`; an end outside the graph (undefined) or a loop onto itself adds nothing. */
export const addEdge = (edges, from, to, site) => {
    if (from === undefined || to === undefined || from === to) {
        return;
    }
    const targets = edges.get(from) ?? edges.set(from, new Map()).get(from);
    (targets.get(to) ?? targets.set(to, []).get(to)).push(site);
};
