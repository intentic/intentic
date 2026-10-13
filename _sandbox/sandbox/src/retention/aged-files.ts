import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";

// Deletes every file under `root` last written before `before` (epoch ms), at any depth, and the folders that leaves
// empty; `root` itself stays, since its writers create files in it without creating it first. By write time rather
// than access time: the volume is mounted relatime, so an access time moves about once a day at best, and a copy kept
// because something keeps reading it is still a copy of personal data past its keeping. A cache entry deleted while in
// use is made again from its source on the next read. Symbolic links are removed as entries and never followed.
// Answers how many files it deleted.
export const removeAgedFiles = async (root: string, before: number): Promise<number> => {
    const walk = async (dir: string): Promise<{ removed: number; empty: boolean }> => {
        const entries = (await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
        let removed = 0;
        let left = entries.length;
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                const inner = await walk(path);
                removed += inner.removed;
                if (inner.empty && (await rmdir(path).then(() => true, () => false))) {
                    left -= 1;
                }
                continue;
            }
            const stats = await lstat(path).catch(undefinedIfMissing);
            if (stats !== undefined && stats.mtimeMs < before) {
                await rm(path, { force: true });
                removed += 1;
                left -= 1;
            }
        }
        return { removed, empty: left === 0 };
    };
    return (await walk(root)).removed;
};
