import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./repo.mjs";

// Reads _sandbox/sandbox/layers.json for checks and the Dependencies view: imports may stay within a layer or point down.
// Root composition files, routes and testing modules form the surface: they may import anything, but layers cannot import them.
// Pass higher-layer behavior through seams/deps wired by composition.ts. Every top-level directory must belong to a layer.
// Subunits are immediate directories plus root files; reject new value-import cycles between them against shrinking baselines.
const declared = JSON.parse(readFileSync(join(root, "_sandbox/sandbox/layers.json"), "utf8"));

export const DAEMON_LAYERS = declared.layers;
// A shelf is a directory whose every subdirectory is a unit of its own: each runtime adapter.
export const DAEMON_SHELVES = declared.shelves ?? [];
// Units whose immediate subdirectories (and root files, as one more) are subunits a cycle is looked for between.
export const DAEMON_SUBUNITS = declared.subunits ?? [];
// File-name patterns of the surface modules, `*` a wildcard.
export const DAEMON_SURFACE = declared.surface ?? [];
