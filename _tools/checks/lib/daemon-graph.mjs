// The sandbox daemon's subsystem graph (daemon-boundaries.mjs), read by pattern since the checks run pre-install: each
// value import between modules of _sandbox/sandbox/src, placed by lib/daemon-layers.mjs and judged by lib/layers.mjs.
import { join, relative, resolve, sep } from "node:path";
import { addEdge, cyclesOf } from "./cycle-edges.mjs";
import { DAEMON_LAYERS } from "./daemon-layers.mjs";
import { importsOf } from "./imports.mjs";
import { layeredSink, layering } from "./layers.mjs";

// runtimes/ is a shelf, not a subsystem: its adapters know nothing of each other, so each is its own subsystem.
const SHELVES = new Set(["runtimes"]);
// The surface the router mounts and the suites import: a route or testing module belongs to no subsystem, as a root
// file does not, so the directory it sits in is not charged with everything it wires together.
const SURFACE_MODULE = /\.(?:routes|testing)\.ts$/;

const { placeOf, top } = layering(DAEMON_LAYERS);

/** `path` relative to src: undefined for a root file, `surface` for a route or testing module, else its subsystem. */
export const placeInDaemon = (path) => {
    const parts = path.split("/");
    if (parts.length === 1) {
        return undefined;
    }
    if (SURFACE_MODULE.test(path)) {
        return { kind: "surface", unit: `${parts[0]} surface`, layer: top };
    }
    const subsystem = SHELVES.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    const placed = placeOf(parts[0]);
    return { kind: "subsystem", unit: subsystem, layer: placed?.layer, top: parts[0] };
};

/**
 * `sources` is `[{ file, text }]` with absolute paths under `src`. Returns the same-layer cycles (`cyclesOf` over the
 * imports that stay in one layer), the upward imports counted per `from -> to` with their sites, the top-level
 * directories no layer places, and the totals for the report line.
 */
export const daemonGraphs = (src, sources) => {
    const relPath = (file) => relative(src, file).split(sep).join("/");
    const sink = layeredSink(addEdge);
    let valueEdges = 0;
    for (const { file, text } of sources) {
        const fromPath = relPath(file);
        const from = placeInDaemon(fromPath);
        const targets = from === undefined ? [] : importsOf(text).filter(({ specifier, typeOnly }) => !typeOnly && specifier.startsWith("."));
        for (const { specifier, line } of targets) {
            const target = resolve(join(file, ".."), specifier);
            const to = target.startsWith(src + sep) ? placeInDaemon(relPath(target).replace(/\.js$/, ".ts")) : undefined;
            if (to !== undefined) {
                valueEdges += to.unit === from.unit ? 0 : 1;
                sink.record(from, to, `${fromPath}:${line}`);
            }
        }
    }
    return { cycles: cyclesOf(sink.sameLayer), upward: sink.upward, upwardSites: sink.upwardSites, unplaced: sink.unplaced, valueEdges };
};
