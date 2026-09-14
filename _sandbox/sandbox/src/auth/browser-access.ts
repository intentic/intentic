import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/* Permanent browser retirement for an account-owned sandbox. */
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
