// The web editor's import graphs (editor-boundaries.mjs), read by pattern (lib/imports.mjs) since the checks run
// pre-install: a TypeScript file's imports and a Vue component's `<script>` blocks, resolved the way the bundler
// resolves a relative specifier here, value imports only.
import { posix } from "node:path";
import { addEdge, cyclesOf } from "./cycle-edges.mjs";
import { EDITOR_LAYERS, EDITOR_SHELVES } from "./editor-layers.mjs";
import { importsOf } from "./imports.mjs";
import { layeredSink, layering } from "./layers.mjs";

// A Vue component's `<script>` blocks, with everything else blanked to its newlines, so a line stays the file's line.
export const scriptOf = (path, text) => {
    if (!path.endsWith(".vue")) {
        return text;
    }
    const blank = (part) => part.replace(/[^\n]/g, " ");
    let code = "";
    let at = 0;
    for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/dg)) {
        const [start, end] = match.indices[1];
        code += blank(text.slice(at, start)) + text.slice(start, end);
        at = end;
    }
    return code + blank(text.slice(at));
};

// The module a relative specifier names: the file itself (`./View.vue`), its compiled name's source (`./x.js` for
// x.ts), `./x` for x.ts, or a directory's index. Undefined for a package, an asset, or a file outside `modules`.
export const resolveIn = (modules, from, specifier) => {
    if (!specifier.startsWith(".")) {
        return undefined;
    }
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    return [base, base.replace(/\.[cm]?js$/, ".ts"), `${base}.ts`, `${base}/index.ts`].find((candidate) => modules.has(candidate));
};

// A shelf's subdirectory (`features/chat`, `workbench/window`) is its own unit; a module directly on the shelf is the
// shelf's.
const shelved = (parts, unit) => (EDITOR_SHELVES.includes(unit) && parts[0] === unit && parts.length > 2 ? `${unit}/${parts[1]}` : unit);

// A subsystem is a top-level directory of src, except a shelf (features/, workbench/), whose every subdirectory is its
// own. A root file (main.ts, App.vue) wires them all together and belongs to none.
export const subsystemOf = (path) => {
    const parts = path.split("/");
    if (parts.length === 1) {
        return undefined;
    }
    return shelved(parts, parts[0]);
};

/**
 * `sources` maps a path under src to its text. Two graphs of value imports, each edge with its `file:line` sites and
 * read by `cyclesOf`: `files`, of static imports only, since a cycle among them decides which module evaluates first
 * and a dynamic import loads after its importer has; and `subsystems`, of static and dynamic imports alike, since
 * either couples one subsystem to another. A type-only import erases at compile time and is in neither.
 */
export const editorGraphs = (sources) => {
    const files = new Map();
    const subsystems = new Map();
    for (const [from, text] of sources) {
        for (const { specifier, typeOnly, dynamic, line } of importsOf(scriptOf(from, text))) {
            const to = resolveIn(sources, from, specifier);
            if (typeOnly || to === undefined) {
                continue;
            }
            const site = `${from}:${line}`;
            if (!dynamic) {
                addEdge(files, from, to, site);
            }
            addEdge(subsystems, subsystemOf(from), subsystemOf(to), site);
        }
    }
    const count = (edges) => [...edges.values()].reduce((sum, targets) => sum + targets.size, 0);
    return { files: cyclesOf(files), subsystems: cyclesOf(subsystems), fileEdges: count(files), subsystemEdges: count(subsystems) };
};

const editorLayers = layering(EDITOR_LAYERS);

/**
 * Where a module sits in lib/editor-layers.mjs: its layer, and the unit cycles are counted between (the table's unit,
 * or `features/<x>` and `workbench/<x>` on a shelf, since each is its own). Undefined for a root file; `layer` undefined for a
 * directory no layer places.
 */
export const placeInEditor = (path) => {
    const parts = path.split("/");
    if (parts.length === 1) {
        return undefined;
    }
    const placed = editorLayers.placeOf(path);
    if (placed === undefined) {
        return { unit: parts[0], layer: undefined, top: parts[0] };
    }
    const unit = shelved(parts, placed.unit);
    return { unit, layer: placed.layer, top: parts[0] };
};

/**
 * The editor's layered view of the same imports `editorGraphs` reads, static and dynamic alike (either couples one unit
 * to another): upward imports counted per `from -> to` with their sites, the same-layer edges between units as a
 * `cyclesOf` graph, and the top-level directories no layer places.
 */
export const editorLayering = (sources) => {
    const sink = layeredSink(addEdge);
    for (const [from, text] of sources) {
        const source = placeInEditor(from);
        const imports = source === undefined ? [] : importsOf(scriptOf(from, text)).filter(({ typeOnly }) => !typeOnly);
        for (const { specifier, line } of imports) {
            const to = resolveIn(sources, from, specifier);
            const target = to === undefined ? undefined : placeInEditor(to);
            if (target !== undefined) {
                sink.record(source, target, `${from}:${line}`);
            }
        }
    }
    return { cycles: cyclesOf(sink.sameLayer), upward: sink.upward, upwardSites: sink.upwardSites, unplaced: sink.unplaced };
};
