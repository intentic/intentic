// The web editor's layers (_editor/web/src), lowest first: a module may import its own layer and any layer below it,
// never one above (editor-boundaries.mjs, through lib/layers.mjs). Every top-level directory sits in exactly one; a new
// directory fails the check until it is placed here. Root files (main.ts, App.vue) wire them all together and belong to
// none: where a lower layer needs something only a higher one knows (the built-in views, the signed-in account, the
// transcript mirror a new build drops, the daemon a diagnostic is posted to), main.ts hands it in at startup, or the
// higher side registers into a registry the lower one exposes.
//
// The client is the editor's clients of what it talks to: the platform account and the sandbox daemon (session,
// endpoint, typed RPC, queries). Everything above it reads the daemon through it, and it reads only the foundation. The
// workbench is the services and registries features are written against: window layout, commands, notifications,
// presence, the hub, the side panel's tabs, push, workspace events and the view registries. A module that names
// features one by one (a jump list, a notification source, a floating panel's contents) is composition and lives in
// shell/ beside the chrome that mounts it, even where it shares a name with a workbench directory (shell/commands,
// shell/notifications, shell/window).
//
// 2026-10-06: drawn from the import graph as it stood, where all 24 subsystems formed one import cycle, with the
// workbench drawn through shell/ and core-views/ (146 upward import sites in 57 edges, 86 same-layer cycle edges).
// The same day the workbench and the client became directories of their own and the foundation and components stopped
// importing features, which left 18 upward sites in 10 edges, all of them features reaching composition: the router
// instance, the extension host, and the frames that host an extension's view. They are baselines/editor-layers.json,
// which may only shrink.
// A shelf is a directory whose every subdirectory is a unit of its own: each feature, and each workbench service.
export const EDITOR_SHELVES = ["features", "workbench"];

export const EDITOR_LAYERS = [
    {
        name: "foundation",
        about: "the app's own plumbing and generic helpers: the API client, query keys, markdown, environments, analytics",
        units: ["lib", "app", "skins", "styles", "assets", "design-system"],
    },
    {
        name: "client",
        about: "the editor's clients of what it talks to: the platform account and the sandbox daemon's session, endpoint, RPC and queries",
        units: ["client"],
    },
    {
        name: "components",
        about: "UI parts shared by several features that know no feature",
        units: ["components"],
    },
    {
        name: "workbench",
        about: "the services and registries features are written against, one unit per workbench/<x>",
        units: ["workbench"],
    },
    {
        name: "features",
        about: "one directory per product area; a feature may use another, but no two may form a cycle",
        units: ["features"],
    },
    {
        name: "composition",
        about: "what puts the features on screen: the shell, the router, built-in views, the extension host, local windows",
        units: ["core-views", "extension-host", "shell", "local", "router", "testing"],
    },
];
