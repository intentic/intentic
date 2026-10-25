import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./repo.mjs";

// Reads _editor/web/layers.json for checks and the Dependencies view: modules import their own layer or lower ones only.
// Every top-level directory belongs to a layer; root composition files wire dependencies or higher-side registrations into lower layers.
// client owns platform/daemon access; workbench owns services/registries; shell composes concrete features and chrome.
// Subunits are immediate directories plus root files; new upward imports and value-import cycles must not grow the baselines.
const declared = JSON.parse(readFileSync(join(root, "_editor/web/layers.json"), "utf8"));

// A shelf is a directory whose every subdirectory is a unit of its own: each feature, and each workbench service.
export const EDITOR_SHELVES = declared.shelves ?? [];

// Units whose immediate subdirectories (and root files, as one more) are subunits a cycle is looked for between.
export const EDITOR_SUBUNITS = declared.subunits ?? [];

export const EDITOR_LAYERS = declared.layers;
