import { access, constants } from "node:fs/promises";
import { join } from "node:path";

/* IS THIS BINARY IN THE IMAGE, the question a split image makes every helper's caller ask.
 *
 * The sandbox image is a minimal CORE plus feature packs (environment/packs.ts): `codex`, `opencode` and
 * `cli-proxy-api` are each a pack's global install, present on a STANDARD image and absent on a core one until
 * the owner approves the rebuild that adds it. So "is it installed" stopped being a build-time constant and
 * became a runtime fact, and the daemon must boot cleanly either way.
 *
 * Read straight off the filesystem rather than by spawning `command -v`: no shell, no per-call process. Cached
 * for the daemon's life. PATH is fixed at container start, and an environment rebuild recreates the container,
 * so nothing can add a binary underneath a running daemon. */
const pathCache = new Map<string, Promise<string | undefined>>();

// WHERE `binary` resolves to, or undefined when this image doesn't carry it. The absolute path is the answer
// with more in it, and one caller needs it: the Codex adapter directly spawns the pack's app-server binary;
// a missing pack may then fall back to the SDK-pinned development wrapper in codex-path.ts.
export const resolveOnPath = (binary: string): Promise<string | undefined> => {
    const cached = pathCache.get(binary);
    if (cached !== undefined) {
        return cached;
    }
    const probe = (async (): Promise<string | undefined> => {
        for (const dir of (process.env["PATH"] ?? "").split(":")) {
            if (dir === "") {
                continue;
            }
            const candidate = join(dir, binary);
            try {
                await access(candidate, constants.X_OK);
                return candidate;
            } catch {
                // next PATH entry
            }
        }
        return undefined;
    })();
    pathCache.set(binary, probe);
    return probe;
};

// The same probe asked as the yes/no most callers want, a gate deciding whether to spawn a helper has no use
// for the path, and `(await resolveOnPath(x)) !== undefined` at every one of those sites reads as noise.
export const onPath = async (binary: string): Promise<boolean> => (await resolveOnPath(binary)) !== undefined;
