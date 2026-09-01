import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CursorSdk from "@cursor/sdk";
import { engineDescriptor } from "../engines/engine-descriptors.js";
import { type EngineInstallOutcome, installEngine } from "../engines/engine-install.js";
import { forgetEngineResolution, resolveEngine } from "../engines/engine-resolve.js";

/* WHERE `@cursor/sdk` COMES FROM AT RUNTIME, and why the daemon cannot simply `import` it at the top of a file.
 *
 * Every other agent runtime in this image is an OSS binary a pack global-installs, so "is it here" is a PATH
 * question (platform/on-path.ts). Cursor's runtime is an npm MODULE, and one whose licence reads "all rights
 * reserved, use subject to Cursor's Terms of Service". That grants no redistribution, and a published Docker
 * image containing it would be redistributing it — to everyone who pulls the image, whether or not they have a
 * Cursor account. So it is pruned out of the deployed tree (prepare-image-trees.sh, the @openai/codex
 * precedent) and packs/cursor.Dockerfile installs the same pin back on the OWNER'S machine.
 *
 * Which makes the import dynamic by necessity rather than by taste: a static one would make the daemon fail to
 * BOOT on every image that does not carry the pack, which is every published image. The types are still
 * static (`import type` erases), so nothing here is loosely typed, only lazily loaded.
 *
 * THREE PLACES IT CAN LIVE, tried in that order:
 *   1. the ENGINE STORE (/history/engines/cursor/<version>), which is where the first Connect installs it and
 *      where an owner picks its version — the same store, channels and revert every other engine has;
 *   2. the pack's prefix (/opt/cursor-sdk), the copy an image rebuild bakes onto the owner's machine;
 *   3. this package's own dependency, which is what a dev checkout has after `pnpm install`.
 * A dev run therefore needs no pack and no store. A published sandbox installs into the store the moment its
 * owner asks to connect Cursor, which is also what makes the version they end up on visible and revertable
 * rather than a fact buried in an image layer. */

// The rebuild-fixable state, in the user's terms. "rebuild" is load-bearing: the UI routes a state to the
// Environment card by that word, so it survives any rewording of the rest of this sentence.
export const CURSOR_SDK_MISSING =
    "This sandbox's image doesn't include the Cursor agent yet: rebuild it from the Environment card in Sandbox ▸ Environment to run Cursor here.";

// Where packs/cursor.Dockerfile installs it. Overridable so a test can point at a fixture tree without a pack,
// and so a dev container can put it somewhere else; the packs test holds the default and the Dockerfile in step.
const packRoot = (): string => process.env["INTENTIC_CURSOR_SDK_DIR"] ?? "/opt/cursor-sdk";

/* The ESM entry of a copy installed under `root`, read off the package's OWN manifest rather than assembled
 * from a path we happen to know today.
 *
 * WHY NOT `require.resolve`, the obvious tool, and it fails twice over. Asked for the package itself it
 * honours the `require` condition and hands back the CJS bundle — webpack output whose exports are installed
 * with `Object.defineProperty`, which Node's CJS named-export detection cannot see through, so `Agent` and
 * `Cursor` would both come back undefined and the failure would surface as a TypeError deep inside a turn
 * rather than as "the pack is missing". Asked for the MANIFEST instead (`@cursor/sdk/package.json`) it throws:
 * an `exports` map that does not list that subpath blocks it, and this package's does not.
 *
 * So the manifest is read from the layout the pack itself creates, which is the one thing here we do control
 * (packs/cursor.Dockerfile installs into `<root>/node_modules/@cursor/sdk`), and the entry is taken from its
 * two published fields. A copy that declares no ESM entry is treated as no copy at all: answering "found it"
 * there would turn a missing pack into an import that throws at turn time. */
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

/* Loaded once per resolved ENTRY, and cached even when absent. The engine store can move under a running
 * daemon (an owner takes a newer version from the card), so the cache is keyed by the path that was loaded
 * rather than being a single process-lifetime answer the way it was when only a pack could provide this. */
let loaded: { readonly entry: string | undefined; readonly module: Promise<typeof CursorSdk | undefined> } | undefined;

const entryNow = async (): Promise<string | undefined> => (await resolveEngine("cursor")).paths.jsEntry ?? entryUnder(packRoot());

/* The module, or undefined on a sandbox that has neither a store copy nor a Cursor pack. Every caller reads
 * undefined as CURSOR_SDK_MISSING rather than as an error: an image without the pack is an ordinary state of a
 * sandbox, the same way a missing `codex` binary is. */
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

/* Make the runtime available because the OWNER explicitly asked to connect Cursor. This is deliberately not
 * part of cursorSdk(): health probes and a picker merely looking at Cursor must stay read-only and must never
 * download software. Only the sign-in route calls this stronger operation.
 *
 * IT INSTALLS THROUGH THE ENGINE STORE, at the version the pack pins. That pin is the floor every other engine
 * treats as the image's copy, so a first Connect lands on a known-good version, and everything after it — a
 * newer blessed release, upstream's latest, a revert — is the ordinary engine lifecycle on the Environment
 * card rather than a second, private update path that only Cursor has.
 *
 * The process-wide promise serializes two tabs pressing Connect together. A failed install clears it, so Retry
 * really retries rather than inheriting a rejected promise forever. */
let installing: Promise<typeof CursorSdk> | undefined;

/* The install itself is a parameter, defaulting to the engine store's. Not for taste: the seam is what lets a
 * suite exercise this whole path — miss, install, reload, retry after a failure — without a real `npm install`
 * into the machine's own store, which is a download the test would then be trusting to have worked. */
export type EngineInstall = (id: "cursor", version: string) => Promise<EngineInstallOutcome>;

export const ensureCursorSdk = async (install: EngineInstall = installEngine): Promise<typeof CursorSdk> => {
    const available = await cursorSdk().catch(() => {
        // A half-written / stale prefix is repairable by the same explicit install below. Clear its rejected
        // loader promise first, or Retry would only replay that rejection without asking npm to repair it.
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

// Forget the resolution: after an install (the store's pointer has moved) and, in a suite, between fixture
// trees. Clears the engine resolver's own cache too, since the two answers are one answer.
export const forgetCursorSdk = (): void => {
    loaded = undefined;
    forgetEngineResolution("cursor");
};
