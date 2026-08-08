import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/* Permanent browser retirement for an account-owned sandbox. Session rotation alone is insufficient during
 * account deletion: another device may still hold a fresh Google proof and the connect token, and could mint
 * a new session immediately. This daemon-private marker makes every future browser authorization fail while
 * leaving local/control-plane recovery available to the machine that still owns the container. */
export interface BrowserAccess {
    readonly enabled: () => Promise<boolean>;
    readonly disable: () => Promise<void>;
}

export const fileBrowserAccess = (path: string): BrowserAccess => ({
    enabled: async () => {
        try {
            // Presence is the marker. A truncated value after a host crash must still retire access.
            await readFile(path);
            return false;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return true;
            }
            // Permissions/I/O failures are not evidence that retirement is absent: fail closed.
            throw error;
        }
    },
    disable: async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "disabled", { mode: 0o600 });
    },
});
