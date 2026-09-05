import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";
import { assertPath, assertScope } from "../policy.js";

/* Files on somebody's device. Reads are bounded by the roots; writes are bounded by the roots AND the write
 * switch, which is off by default, "connect my device" does not imply "edit my documents".
 *
 * THERE IS NO DELETE TOOL. Deleting is the one operation with no undo and no partial recovery, and an agent
 * that can delete is one bad inference away from a support ticket nobody can fix. `trash_file` moves the file
 * into a dated folder under ~/.intentic/host/trash instead, so "undo that" is a real instruction rather than a
 * apology. Emptying that folder is the user's business, on their own schedule.
 *
 * A rename, not a copy: within a filesystem it is atomic and instant even for a large file, and the fallback
 * (copy + unlink) is deliberately absent, a trash that spans filesystems would silently turn "moved" into
 * "duplicated and then really deleted", which is exactly the operation this tool exists to avoid. */

// Anything larger is almost certainly not something a model should be reading whole (a database file, a video),
// and a 200 MB string is a memory incident on a laptop rather than a useful answer.
const MAX_READ_BYTES = 2_000_000;

export const readTextFile = async (path: string, scopes: HostScopes): Promise<string> => {
    const target = assertPath(path, scopes, "read");
    const info = await stat(target);
    if (info.isDirectory()) {
        throw new Error(`"${path}" is a directory: use list_dir for it.`);
    }
    if (info.size > MAX_READ_BYTES) {
        throw new Error(`"${path}" is ${Math.round(info.size / 1_000_000)} MB, too large to read whole. Read part of it with a command instead.`);
    }
    return await readFile(target, "utf8");
};

export const writeTextFile = async (path: string, content: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "write");
    const target = assertPath(path, scopes, "write");
    await mkdir(dirname(target), { recursive: true });
    const existed = await stat(target).then(
        () => true,
        () => false,
    );
    await writeFile(target, content, "utf8");
    // Say which it was. "Wrote 40 lines to config.json" reads identically whether it created a file or replaced
    // somebody's working configuration, and only one of those is worth mentioning to the user.
    return existed ? `Overwrote ${target} (${content.length} characters).` : `Created ${target} (${content.length} characters).`;
};

export interface DirEntry {
    readonly name: string;
    readonly kind: "file" | "directory" | "other";
    readonly size?: number;
    readonly modified?: string;
}

export const listDirectory = async (path: string, scopes: HostScopes): Promise<DirEntry[]> => {
    const target = assertPath(path, scopes, "list");
    const entries = await readdir(target, { withFileTypes: true });
    return await Promise.all(
        entries.map(async (entry) => {
            const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
            if (kind !== "file") {
                return { name: entry.name, kind };
            }
            // A stat per entry is affordable for a directory listing and turns "here are 400 names" into
            // something the agent can reason about (which file is the recent one, which is the big one).
            const info = await stat(join(target, entry.name)).catch(() => undefined);
            return info === undefined ? { name: entry.name, kind } : { name: entry.name, kind, size: info.size, modified: info.mtime.toISOString() };
        }),
    );
};

const trashDir = (): string => join(homedir(), ".intentic", "host", "trash");

export const trashFile = async (path: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "write");
    const target = assertPath(path, scopes, "trash");
    await stat(target);
    // Timestamped folder per removal, so two files of the same name never collide and the order of events is
    // readable straight from the directory listing.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(trashDir(), stamp);
    await mkdir(destination, { recursive: true });
    const moved = join(destination, basename(target));
    try {
        await rename(target, moved);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EXDEV") {
            throw new Error(
                `"${path}" is on a different drive from the trash folder (${trashDir()}), so it cannot be moved there safely. Ask the user to remove it themselves.`,
                { cause: error },
            );
        }
        throw error;
    }
    return `Moved ${target} to ${moved}. It is recoverable from there until the user empties that folder.`;
};
