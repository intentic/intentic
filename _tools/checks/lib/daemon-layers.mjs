// The sandbox daemon's layers (_sandbox/sandbox/src), lowest first: a module may import its own layer and any layer
// below it, never one above (daemon-boundaries.mjs, through lib/layers.mjs). Every top-level directory sits in exactly
// one; a new directory fails the check until it is placed here. Above all of them sits the surface: the root files
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
export const DAEMON_LAYERS = [
    {
        name: "foundation",
        about: "storage, ports and primitives every other layer stands on; they know no subsystem",
        units: ["store", "seams", "http", "offload", "netd", "fences", "speech", "areas", "workload", "safety", "tunnel", "image"],
    },
    {
        name: "host",
        about: "what the box itself offers: identity, secrets, files, git, processes, engines, the OS and its network",
        units: [
            "auth",
            "personas",
            "secrets",
            "guard",
            "git",
            "workspace",
            "derived",
            "hashline",
            "engines",
            "terminal",
            "processes",
            "privacy",
            "environment",
            "peers",
            "push",
            "ports",
            "exit",
            "vpn",
            "netdisk",
            "usage",
            "logs",
            "rules",
            "endpoints",
            "trial",
            "system",
            "intentic",
            "activity",
        ],
    },
    {
        name: "connections",
        about: "what the owner connected: capabilities, browsers, devices, extensions, channels and published files",
        units: [
            "capabilities",
            "browser",
            "desktop",
            "webext",
            "phones",
            "hosts",
            "wallet",
            "sandboxes",
            "runners",
            "scaffold",
            "extensions",
            "panels",
            "public",
            "share",
            "webchat",
            "issues",
            "definition",
        ],
    },
    {
        name: "agent",
        about: "the turn engine, its runtimes, conversations, transcripts and the code a turn runs",
        units: ["agent", "runtimes", "conversations", "sessions", "execution"],
    },
    {
        name: "orchestration",
        about: "what starts and steers turns on its own: automations, loops, workflows, CI repair, chores, needs, settings",
        units: [
            "automations",
            "loops",
            "workflows",
            "ci",
            "chores",
            "needs",
            "approvals",
            "settings",
            "inventory",
            "portability",
            "migrations",
            "history",
        ],
    },
    {
        name: "composition",
        about: "boot wiring and whole-daemon self-checks, which import every layer and are imported by none",
        units: ["bootstrap", "invariants", "harness"],
    },
];
