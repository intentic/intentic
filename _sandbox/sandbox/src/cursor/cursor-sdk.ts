import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CursorSdk from "@cursor/sdk";

/* WHERE `@cursor/sdk` COMES FROM AT RUNTIME, and why the daemon cannot simply `import` it at the top of a file.
 *
 * Every other agent runtime in this image is an OSS binary a pack global-installs, so "is it here" is a PATH
 * question (platform/on-path.ts). Cursor's runtime is an npm MODULE, and one whose licence reads "all rights
 * reserved, use subject to Cursor's Terms of Service". That grants no redistribution, and a published Docker
 * image containing it would be redistributing it — to everyone who pulls the image, whether or not they have a
 * Cursor account. So it is pruned out of the deployed tree (prepare-image-trees.sh, the @openai/codex
 * precedent) and packs/cursor.Dockerfile installs the same pin back on the OWNER'S machine, into a prefix of
 * its own, when they connect a Cursor account.
 *
 * Which makes the import dynamic by necessity rather than by taste: a static one would make the daemon fail to
 * BOOT on every image that does not carry the pack, which is every published image. The types are still
 * static (`import type` erases), so nothing here is loosely typed, only lazily loaded.
 *
 * TWO PLACES IT CAN LIVE, tried in that order:
 *   1. the pack's prefix (/opt/cursor-sdk), which is the only copy in a real sandbox;
 *   2. this package's own dependency, which is what a dev checkout has after `pnpm install` and what the
 *      catalog pin exists for.
 * A dev run therefore needs no pack, and a sandbox never depends on one having been installed. */

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

// Loaded once per daemon and CACHED EVEN WHEN ABSENT: a pack cannot appear under a running daemon (installing
// one recreates the container), so a second miss would only re-pay the resolution to reach the same answer.
let loaded: Promise<typeof CursorSdk | undefined> | undefined;

/* The module, or undefined on an image that carries no Cursor pack. Every caller reads undefined as
 * CURSOR_SDK_MISSING rather than as an error: an image without the pack is an ordinary state of a sandbox, the
 * same way a missing `codex` binary is. */
export const cursorSdk = (): Promise<typeof CursorSdk | undefined> => {
    loaded ??= (async () => {
        const packed = await entryUnder(packRoot());
        if (packed !== undefined) {
            return (await import(pathToFileURL(packed).href)) as typeof CursorSdk;
        }
        try {
            return await import("@cursor/sdk");
        } catch {
            return undefined;
        }
    })();
    return loaded;
};

// Test seam only: forget the resolution so a suite can move INTENTIC_CURSOR_SDK_DIR between cases. Production
// never calls it, which is why the cache above needs no invalidation of its own.
export const forgetCursorSdk = (): void => {
    loaded = undefined;
};
