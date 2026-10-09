import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./repo.mjs";

// The sandbox daemon's layers (_sandbox/sandbox/src), declared in _sandbox/sandbox/layers.json, lowest first: a module
// may import its own layer and any layer below it, never one above (daemon-boundaries.mjs, through lib/layers.mjs).
// Every top-level directory sits in exactly one; a new directory fails the check until it is placed there. Above all of them sits the surface: the root files
// (app.ts, composition.ts, router.ts, main.ts and their helpers), every `*.routes.ts`, which the router mounts, and every
// `*.testing.ts`, which only suites import. The surface may import anything; nothing below it may import a surface
// module, so a helper a route defines and another subsystem needs moves out of the route file.
//
// Reaching up is the finding, not the fix. A lower module that needs something from above takes it as a port: a type in
// seams/ (or its own deps interface) that the higher layer fills when composition.ts wires them, as the turn starter
// (seams/turn-starter.ts) already does for everything that starts a turn.
//
// 2026-10-06: drawn from the import graph as it stood. Fifty-three subsystems formed one import cycle, and once the
// route modules stopped counting as part of the directory they sit in, all but 38 import sites already pointed down
// this order; moving constants, a store document and the card mechanics (guard/card-offers.ts) down left 21. Later the
// same day none was left: the environment's fragment sources became a port (seams/environment-sources.ts), the device
// gates take their cards, turn and judge as deps (hosts/host-guard-deps.ts), the sandbox definition moved out of
// portability/ into definition/, and the rest were a constant, a key function and a store moved down. A new upward
// import has no baseline to stand in (baselines/daemon-layers.json is absent while empty). The same pass took the
// same-layer cycles from 54 edges to 9: the runtime table is handed to the providers slice rather than imported by it,
// image/ and workload/ took the helpers system/ and environment/ lent the host layer, and the skill notes the
// capability handlers print moved in beside them. The 9 left (baselines/daemon-cycles.json) each say why they stand.
//
// The table lives beside the package rather than here so the editor's Dependencies view draws the same layers this
// check enforces (the daemon reads it for `workspace.packageModules`); this module is its reader for the checks.
const declared = JSON.parse(readFileSync(join(root, "_sandbox/sandbox/layers.json"), "utf8"));

export const DAEMON_LAYERS = declared.layers;
// A shelf is a directory whose every subdirectory is a unit of its own: each runtime adapter.
export const DAEMON_SHELVES = declared.shelves ?? [];
// File-name patterns of the surface modules, `*` a wildcard.
export const DAEMON_SURFACE = declared.surface ?? [];
