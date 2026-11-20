import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../../state-paths.js";
import type { DownloadRecord } from "./download-tracker.js";

// Where a profile's downloads sit on the sandbox's disk, and how they are laid out so a fresh daemon can list them again
// with nothing written down but the files: `<dir>/.incoming/<id>` while Chromium writes one (it names it by its guid),
// then `<dir>/<id>/<name>` once it lands. The folder is the record's id and the one file in it is named as the site
// named it, so the name survives a restart without a sidecar to keep in step. Beside the profile, under
// `.intentic/local/browser/`, which the workspace's file routes never open.

export const downloadsDir = (root: string, profile: string): string => statePath(root, ".intentic/local/browser/", `${profile}.downloads`);

export const incomingDir = (dir: string): string => join(dir, ".incoming");

// A name the site suggested, made safe to be one file in one folder: no path separators, no control characters, no
// leading dots (a hidden file, or `..`), and short enough for any filesystem. Nothing left is a plain "download".
export const safeFileName = (suggested: string): string => {
    const cleaned = suggested
        .replace(/[\u0000-\u001f\u007f/\\]/gu, "_")
        .replace(/^[.\s]+/u, "")
        .trim();
    const short = cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
    return short === "" ? "download" : short;
};

// The ids Chromium and this daemon mint (a guid, a uuid): nothing else is ever a folder of the downloads dir.
const ID = /^[A-Za-z0-9-]{8,64}$/u;
const isDownloadId = (id: string): boolean => ID.test(id);

// Moves a finished file from where Chromium wrote it to where the list keeps it; answers where.
export const settleDownload = async (dir: string, id: string, name: string): Promise<string> => {
    const folder = join(dir, id);
    await mkdir(folder, { recursive: true });
    const target = join(folder, safeFileName(name));
    await rename(join(incomingDir(dir), id), target);
    return target;
};

// Deletes a download's file and folder, finished or not; one already gone is the outcome asked for.
export const deleteDownloadFiles = async (dir: string, id: string): Promise<void> => {
    if (!isDownloadId(id)) {
        return;
    }
    await rm(join(dir, id), { recursive: true, force: true });
    await rm(join(incomingDir(dir), id), { force: true });
};

// Every finished download a profile's folder holds, as records: what a fresh daemon starts the list from. The source
// address was never on disk, so it is empty; when it landed is its file's own time. Whatever Chromium left half-written
// in `.incoming` is a download that will never finish, and goes.
export const restoreDownloads = async (dir: string, profile: string): Promise<DownloadRecord[]> => {
    await rm(incomingDir(dir), { recursive: true, force: true });
    // allow(silent-catch): a profile that never downloaded anything has no folder yet, which is an empty list.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const records: DownloadRecord[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !isDownloadId(entry.name)) {
            continue;
        }
        const folder = join(dir, entry.name);
        // allow(silent-catch): a folder removed between the listing and the read has nothing to list.
        const [file] = await readdir(folder).catch((): string[] => []);
        if (file === undefined) {
            await rm(folder, { recursive: true, force: true });
            continue;
        }
        const path = join(folder, file);
        // allow(silent-catch): as above, a file gone between the two reads is not listed.
        const info = await stat(path).catch(() => undefined);
        if (info === undefined || !info.isFile()) {
            continue;
        }
        records.push({
            id: entry.name,
            profile,
            name: file,
            url: "",
            state: "done",
            receivedBytes: info.size,
            totalBytes: info.size,
            startedAt: info.mtimeMs,
            finishedAt: info.mtimeMs,
            file: path,
        });
    }
    return records;
};
