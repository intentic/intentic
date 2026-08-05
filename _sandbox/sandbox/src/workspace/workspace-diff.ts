import { resolveWithin, statWorkspaceSizeMtime } from "./workspace-files.js";

// One entry of the client's pre-upload manifest: a dropped file's destination path + its source size and mtime
// (ms, from File.lastModified). Backs /workspace/upload-diff so a re-drop only re-sends what actually changed.
export interface UploadManifestEntry {
    readonly path: string;
    readonly size: number;
    readonly mtime: number;
}

// A written file's mtime is stored at second granularity (the tar carries whole seconds; setWorkspaceMtime stamps
// the source mtime), so compare seconds — never raw ms — or every entry looks changed.
const sameSecond = (a: number, b: number): boolean => Math.floor(a / 1000) === Math.floor(b / 1000);

// Of the manifest, the paths already identical on disk (same size AND same whole-second mtime) — the client drops
// these so their bytes never re-upload. Escaping paths are never "skippable" (resolveWithin rejects them), so they
// fall through and re-upload as before. Stats run concurrently — a re-drop is thousands of cheap stats.
export const computeUploadSkip = async (root: string, files: readonly UploadManifestEntry[]): Promise<string[]> => {
    const results = await Promise.all(
        files.map(async (file): Promise<string | undefined> => {
            const target = resolveWithin(root, file.path);
            if (target === undefined) {
                return undefined;
            }
            const on = await statWorkspaceSizeMtime(target);
            if (on !== undefined && on.size === file.size && sameSecond(on.mtimeMs, file.mtime)) {
                return file.path;
            }
            return undefined;
        }),
    );
    return results.filter((path): path is string => path !== undefined);
};
