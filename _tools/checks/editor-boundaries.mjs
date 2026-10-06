#!/usr/bin/env node
// Web editor import drift in _editor/web/src, read by pattern since this runs pre-install (lib/editor-graph.mjs): a
// static value import closing a cycle between modules, held at zero, since a cycle hands whichever module the bundler
// evaluates first its partner's bindings uninitialised; a value import reaching a higher layer than its own
// (lib/editor-layers.mjs, baselined, may only shrink: baselines/editor-layers.json); and a value import between units of
// one layer (each features/<x>, each unit the table names) closing a cycle of any length, baselined, may only shrink:
// baselines/editor-cycles.json.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { editorGraphs, editorLayering } from "./lib/editor-graph.mjs";
import { ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, SKIP_DIRS, TEST_FILE } from "./lib/repo.mjs";

const SRC = "_editor/web/src";
const BASELINE_PATH = "_tools/checks/baselines/editor-cycles.json";
const LAYERS_BASELINE_PATH = "_tools/checks/baselines/editor-layers.json";

// Every module the app ships: suites import their subject and nothing imports them, so they close no cycle, and a
// declaration file holds only types.
const sources = new Map();
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                walk(path);
            }
        } else if (/\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !TEST_FILE.test(entry.name)) {
            sources.set(relative(join(root, SRC), path).split(sep).join("/"), readFileSync(path, "utf8"));
        }
    }
};
walk(join(root, SRC));

const { files, fileEdges, subsystemEdges } = editorGraphs(sources);
const { cycles: units, upward, upwardSites, unplaced } = editorLayering(sources);

// One loop per cycle of modules, through the first edge of it that closes one.
const moduleCycles = files.components.map((component) => {
    const members = new Set(component);
    const [first] = [...files.cycleEdges.values()]
        .filter(([from]) => members.has(from))
        .sort(([a, b], [c, d]) => `${a} ${b}`.localeCompare(`${c} ${d}`));
    return `${files.closes(first)} (${component.length} modules in this cycle)`;
});

// Each key is one standing `from -> to`, counted in import sites. Any editor source a land changed can lower one.
const { grown: grownUpward } = ratchet("editor-boundaries", "editor-layers", upward, {
    touchedBy: (_key, path) => path.startsWith(`${SRC}/`),
});
const addedUpward = grownUpward
    .map(({ key }) => key)
    .sort()
    .map((key) => `${key} (${(upwardSites.get(key) ?? []).slice(0, 3).join(", ")}${(upwardSites.get(key)?.length ?? 0) > 3 ? ", …" : ""})`);
const unplacedDirs = [...unplaced].sort().map((dir) => `src/${dir}/ is in no layer`);

// Each baseline key is one standing edge between units of one layer, its value the reason it stands ("" where none was
// recorded). An edge stops closing a cycle when any edge on its way back goes, so any editor source a land changed can
// lower one.
const { grown } = ratchet("editor-boundaries", "editor-cycles", new Map([...units.cycleEdges.keys()].map((edge) => [edge, 1])), {
    touchedBy: (_edge, path) => path.startsWith(`${SRC}/`),
});
const addedCycles = grown
    .map(({ key }) => key)
    .sort()
    .map((edge) => units.closes(units.cycleEdges.get(edge)));

const cycleUnits = new Set([...units.cycleEdges.values()].flat());
const upwardSiteCount = [...upward.values()].reduce((sum, count) => sum + count, 0);
finish(
    [
        [
            `A static value import closes a cycle between modules (paths under ${SRC}/), which leaves one of them reading the other's bindings before they are set. Move what both need into a third module, import one way as a type (\`import type\`), or load one side with \`import()\``,
            moduleCycles,
        ],
        [
            `An editor directory is in no layer (paths under ${SRC}/). Add it to the layer it belongs to in _tools/checks/lib/editor-layers.mjs`,
            unplacedDirs,
        ],
        [
            `A value import reaches a higher layer than its own more often than ${LAYERS_BASELINE_PATH} holds (paths under ${SRC}/; the layers are _tools/checks/lib/editor-layers.mjs). Move what both need down, let the higher side register into a lower registry, or move a module that names features one by one up into composition`,
            addedUpward,
        ],
        [
            `A value import between editor units of one layer closes a cycle ${BASELINE_PATH} does not hold (paths under ${SRC}/). Reach one way through a type-only import, a registry the lower side exposes, or a module above both`,
            addedCycles,
        ],
    ],
    [
        `editor-boundaries: ${sources.size} modules, ${fileEdges} static value imports between them and no cycle; ${upwardSiteCount} upward imports across ${upward.size} edges and ${units.cycleEdges.size} same-layer edges closing cycles among ${cycleUnits.size} units, none new (${units.nodes.length} units in cycles' reach, ${subsystemEdges} value edges between subsystems)`,
    ],
);
