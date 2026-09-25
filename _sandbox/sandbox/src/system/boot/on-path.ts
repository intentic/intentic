import { access, constants } from "node:fs/promises";
import { join } from "node:path";

// Whether a binary is present in this image: core vs. standard packs (environment/packs.ts) put codex, opencode and
// cli-proxy-api on some images and not others. Read straight off PATH rather than spawning `command -v`, and cached for
// the daemon's life since PATH is fixed at container start.
const pathCache = new Map<string, Promise<string | undefined>>();

// Resolves `binary` to its absolute path on PATH, or undefined if this image doesn't carry it; for callers that need
// the path itself, such as the Codex adapter spawning the pack's app-server binary.
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
            }
        }
        return undefined;
    })();
    pathCache.set(binary, probe);
    return probe;
};

// Yes/no form of resolveOnPath, for callers that only need to know whether to spawn a helper.
export const onPath = async (binary: string): Promise<boolean> => (await resolveOnPath(binary)) !== undefined;
