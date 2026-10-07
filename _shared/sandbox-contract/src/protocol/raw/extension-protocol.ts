import { z } from "zod";
import { rawRouteUrl } from "./raw-routes.js";

// The wire between the daemon and an extension's own code, its backend in the shared host and its declared processes
// alike: the two routes every extension token reaches about itself (EXTENSION_OWN_ROUTES in extension-manifest), and
// the environment a process is started with. `@intentic/extension-api/runtime` reads both, so the daemon and the SDK
// compile against one declaration. A subpath of its own, since a gateway process loads no more of the contract than it
// needs (the root builds every schema there is).

// GET /extension/settings: the calling extension's own settings, secret values included, keyed by the declaration.
export const ExtensionOwnSettingsSchema = z.object({
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type ExtensionOwnSettings = z.infer<typeof ExtensionOwnSettingsSchema>;

// GET /extension/events: one ndjson frame per line, for as long as the caller holds the stream. A heartbeat every
// EXTENSION_EVENTS_HEARTBEAT_MS says the daemon is still there; the rest name what moved. `settings` carries only the
// calling extension's own keys whose value changed.
export const ExtensionEventSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("heartbeat") }),
    z.object({ kind: z.literal("files"), paths: z.array(z.string()) }),
    z.object({ kind: z.literal("refs"), repos: z.array(z.string()) }),
    z.object({ kind: z.literal("repos"), repos: z.array(z.string()) }),
    z.object({ kind: z.literal("settings"), keys: z.array(z.string()) }),
]);
export type ExtensionEvent = z.infer<typeof ExtensionEventSchema>;

export const EXTENSION_EVENTS_HEARTBEAT_MS = 15_000;

// The kinds a listener subscribes to, every frame but the heartbeat.
export const EXTENSION_EVENT_KINDS = ["files", "refs", "repos", "settings"] as const;
export type ExtensionEventKind = (typeof EXTENSION_EVENT_KINDS)[number];

// A backend's own account of itself (`ServerActivation.health` in @intentic/extension-api), as the host reads it from
// the extension's code and passes it on: a closed set of states and an optional sentence.
export const ExtensionHealthSchema = z.object({
    state: z.enum(["ok", "starting", "degraded", "failed"]),
    detail: z.string().optional(),
});

export const extensionSettingsUrl = (): string => rawRouteUrl("GET /extension/settings");
export const extensionEventsUrl = (): string => rawRouteUrl("GET /extension/events");

// What the daemon starts an extension's process with, and what `connectExtensionProcess` reads. The token is the same
// minted per-extension token its backend carries; the directories are the ones the backend api names.
export const EXTENSION_PROCESS_ENV = {
    daemon: "INTENTIC_DAEMON",
    token: "INTENTIC_EXTENSION_TOKEN",
    id: "INTENTIC_EXTENSION_ID",
    workspace: "INTENTIC_WORKSPACE",
    dir: "INTENTIC_EXTENSION_DIR",
    state: "INTENTIC_EXTENSION_STATE",
    cache: "INTENTIC_EXTENSION_CACHE",
    // The manifest's `permissions.daemon` as a JSON array, so a typed call outside it is refused before it is sent.
    permissions: "INTENTIC_EXTENSION_PERMISSIONS",
} as const;

// What the permissions variable holds.
export const ExtensionPermissionsSchema = z.array(z.string());
