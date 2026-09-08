import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CursorSdk from "@cursor/sdk";
import { engineDescriptor } from "../../engines/engine-descriptors.js";
import { type EngineInstallOutcome, installEngine } from "../../engines/engine-install.js";
import { forgetEngineResolution, resolveEngine } from "../../engines/engine-resolve.js";

// Cursor's SDK is a proprietary npm module (no redistribution), so it's pruned from every published image and reachable
// only dynamically, never a static import that would fail every image to boot. Tried in order: the engine store, the
// pack's prefix (/opt/cursor-sdk), then this package's own dependency (a dev checkout).

// "rebuild" is load-bearing: the UI routes on this word; the rest of the sentence can be reworded freely.
export const CURSOR_SDK_MISSING =
    "This sandbox's image doesn't include the Cursor agent yet: rebuild it from the Environment card in Sandbox ▸ Environment to run Cursor here.";

// Where the Dockerfile installs it; overridable so a test can point at a fixture tree with no pack.
const packRoot = (): string => process.env["INTENTIC_CURSOR_SDK_DIR"] ?? "/opt/cursor-sdk";

// Reads the ESM entry off the manifest, not require.resolve: that honors require and hands back a CJS bundle whose
// webpack exports Node can't see, failing as a TypeError deep in a turn, not "no pack". No declared entry means no
// copy.
const entryUnder = async (root: string): Promise<string | undefined> => {
    const manifestPath = join(root, "node_modules", "@cursor", "sdk", "package.json");
    const manifest = await readFile(manifestPath, "utf8")
        .then((raw) => JSON.parse(raw) as { module?: unknown; exports?: { "."?: { import?: unknown } } })
        .catch(() => undefined);
    const declared = manifest?.exports?.["."]?.import ?? manifest?.module;
    if (typeof declared !== "string" || declared === "") {
        return undefined;
    }
    return isAbsolute(declared) ? declared : resolve(dirname(manifestPath), declared);
};

// Cached by resolved entry, not for the process's life: the engine store can move under a running daemon.
let loaded: { readonly entry: string | undefined; readonly module: Promise<typeof CursorSdk | undefined> } | undefined;

const entryNow = async (): Promise<string | undefined> => (await resolveEngine("cursor")).paths.jsEntry ?? entryUnder(packRoot());

// undefined on neither a store copy nor a pack; every caller reads it as CURSOR_SDK_MISSING, an ordinary state, not an
// error.
export const cursorSdk = async (): Promise<typeof CursorSdk | undefined> => {
    const entry = await entryNow();
    const cached = loaded;
    if (cached !== undefined && cached.entry === entry) {
        return cached.module;
    }
    const module = (async () => {
        if (entry !== undefined) {
            return (await import(pathToFileURL(entry).href)) as typeof CursorSdk;
        }
        try {
            return await import("@cursor/sdk");
        } catch {
            return undefined;
        }
    })();
    loaded = { entry, module };
    return module;
};

// Process-wide, so two tabs' Connect calls share one install; cleared on failure so Retry actually retries.
let installing: Promise<typeof CursorSdk> | undefined;

// Defaults to the engine store's install; parameterized so a suite can exercise miss/install/reload/retry without a
// real npm install.
export type EngineInstall = (id: "cursor", version: string) => Promise<EngineInstallOutcome>;

export const ensureCursorSdk = async (install: EngineInstall = installEngine): Promise<typeof CursorSdk> => {
    const available = await cursorSdk().catch(() => {
        // A half-written prefix is repairable below; clear its rejected promise first, or Retry just replays it.
        forgetCursorSdk();
        return undefined;
    });
    if (available !== undefined) {
        return available;
    }
    installing ??= (async () => {
        const version = await engineDescriptor("cursor").baked();
        if (version === undefined) {
            throw new Error("The Cursor feature pack does not name exactly one SDK version.");
        }
        const outcome = await install("cursor", version);
        if (!outcome.ok) {
            throw new Error(`The Cursor SDK could not be installed: ${outcome.reason}`);
        }
        forgetCursorSdk();
        const installed = await cursorSdk();
        if (installed === undefined) {
            throw new Error("The Cursor SDK installation completed, but its runtime could not be loaded.");
        }
        return installed;
    })().finally(() => {
        installing = undefined;
    });
    return installing;
};

// Clears the resolution after an install, or between fixture trees in a suite; also clears the engine resolver's cache,
// one answer.
export const forgetCursorSdk = (): void => {
    loaded = undefined;
    forgetEngineResolution("cursor");
};
