import type { Dirent, Stats } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { isControlPlanePath, isUnder } from "./workspace-files-paths.js";
import type { ZipEntry } from "./workspace-zip.js";

// What a download of several files and folders at once is: the selection resolved at mint time (the ticket carries it,
// so a selection of thousands never rides a URL), walked into ZIP entries when the browser comes for it.

/** One selected entry: where it is on disk, and the name it takes in the archive. */
export interface DownloadItem {
    readonly target: string;
    readonly name: string;
    // The tree it was read from (a conversation's checkout, or /work): nothing outside it is followed.
    readonly root: string;
}

export interface DownloadPlan {
    readonly items: readonly DownloadItem[];
    // What the browser saves the archive as.
    readonly filename: string;
}

// Formats that are already compressed: deflating them again spends CPU to save nothing, so they are stored as is.
const PACKED = new Set(
    (
        "7z aac apk avif br bz2 cab deb docx dmg epub flac gif gz heic heif ico jar jpeg jpg jxl lz lz4 lzma m4a m4v mkv mov mp3 mp4 mpeg mpg " +
        "odg odp ods odt ogg ogv opus pdf png pptx rar rpm tbz tgz txz webm webp whl woff woff2 xlsx xz zip zst"
    ).split(" "),
);
// Below this a deflate stream's own framing eats what it saves.
const WORTH_DEFLATING = 128;

export const methodFor = (name: string, size: number): 0 | 8 => (size < WORTH_DEFLATING || PACKED.has(extname(name).slice(1).toLowerCase()) ? 0 : 8);

// Stats run this many at a time: a folder of 100k files is walked in well under a second without flooding libuv.
const STAT_BATCH = 64;

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// A symlink is followed only to a FILE still inside the tree: one to a folder could loop or double the archive, and one
// leading out of the tree would hand out what the file API refuses to.
const followLink = async (realRoot: string, path: string): Promise<Stats | undefined> => {
    const real = await realpath(path).catch(() => undefined);
    if (real === undefined || isUnder(realRoot, real) === undefined) {
        return undefined;
    }
    const info = await stat(real).catch(() => undefined);
    return info?.isFile() === true ? info : undefined;
};

const fileEntry = (name: string, source: string, info: Stats): ZipEntry => ({
    name,
    kind: "file",
    size: info.size,
    mtimeMs: info.mtimeMs,
    mode: info.mode,
    method: methodFor(name, info.size),
    source,
});

const dirEntry = (name: string, info: Stats): ZipEntry => ({
    name: `${name}/`,
    kind: "dir",
    size: 0,
    mtimeMs: info.mtimeMs,
    mode: info.mode,
    method: 0,
});

/**
 * Every entry the plan's archive holds, depth first and sorted, so the same selection always zips the same way.
 * Throws when a selected entry is gone, which the route answers before a byte is sent. Inside a folder, the sandbox's own
 * state is left out as every listing leaves it out, unless the selection itself lives there (an archive's unpacked copy).
 */
export const planEntries = async (plan: DownloadPlan): Promise<ZipEntry[]> => {
    const entries: ZipEntry[] = [];
    const walk = async (root: string, realRoot: string, dir: string, name: string, hidesState: boolean): Promise<void> => {
        const children = (await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])).toSorted(byName);
        const visible = children.filter((child) => !(hidesState && isControlPlanePath(root, join(dir, child.name))));
        for (let at = 0; at < visible.length; at += STAT_BATCH) {
            const batch = visible.slice(at, at + STAT_BATCH);
            const infos = await Promise.all(
                batch.map(async (child): Promise<Stats | undefined> => {
                    const path = join(dir, child.name);
                    if (child.isSymbolicLink()) {
                        return followLink(realRoot, path);
                    }
                    return child.isFile() || child.isDirectory() ? lstat(path).catch(() => undefined) : undefined;
                }),
            );
            for (const [index, child] of batch.entries()) {
                const info = infos[index];
                const path = join(dir, child.name);
                const childName = `${name}/${child.name}`;
                if (info?.isFile() === true) {
                    entries.push(fileEntry(childName, path, info));
                } else if (info?.isDirectory() === true) {
                    entries.push(dirEntry(childName, info));
                    await walk(root, realRoot, path, childName, hidesState);
                }
            }
        }
    };
    for (const item of plan.items) {
        const info = await stat(item.target);
        if (info.isFile()) {
            entries.push(fileEntry(item.name, item.target, info));
        } else if (info.isDirectory()) {
            entries.push(dirEntry(item.name, info));
            const realRoot = await realpath(resolve(item.root)).catch(() => resolve(item.root));
            await walk(item.root, realRoot, item.target, item.name, !isControlPlanePath(item.root, item.target));
        }
    }
    return entries;
};

// The folder every selected path sits in: `a/b/x` and `a/c` share `a`.
const commonParent = (paths: readonly string[]): string[] => {
    const split = paths.map((path) => path.split("/").slice(0, -1));
    const first = split[0] ?? [];
    let depth = 0;
    while (depth < first.length && split.every((segments) => segments[depth] === first[depth])) {
        depth += 1;
    }
    return first.slice(0, depth);
};

const withoutSlashes = (path: string): string => path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");

/**
 * Names each selected path in the archive relative to the folder they all share, so siblings sit side by side and two
 * `index.ts` from different folders keep the folders that tell them apart. A path inside another selected folder is
 * dropped: the folder already carries it. The archive is named after the one thing selected, else after the folder.
 */
export const nameSelection = (
    paths: readonly string[],
    fallback: string,
): { readonly names: ReadonlyMap<string, string>; readonly filename: string } => {
    const clean = [...new Set(paths.map(withoutSlashes).filter((path) => path !== ""))];
    const kept = clean.filter((path) => !clean.some((other) => other !== path && path.startsWith(`${other}/`)));
    const parent = commonParent(kept);
    const names = new Map(kept.map((path) => [path, path.split("/").slice(parent.length).join("/")]));
    const only = kept.length === 1 ? kept[0] : undefined;
    const base = only === undefined ? (parent.at(-1) ?? fallback) : (only.split("/").at(-1) ?? fallback);
    return { names, filename: only === undefined ? `${base} (${kept.length} items).zip` : `${base}.zip` };
};

// A download ticket is redeemed the moment it is minted; the minutes only cover a slow page handing the URL over.
export const DOWNLOAD_TICKET_TTL_MS = 5 * 60 * 1000;
const BINDING_PREFIX = "download:";

// The plan as a media ticket's binding: namespaced, so no other kind of ticket can be replayed as a download.
export const downloadBinding = (plan: DownloadPlan): string => `${BINDING_PREFIX}${JSON.stringify(plan)}`;

export const planOfBinding = (binding: string | undefined): DownloadPlan | undefined => {
    if (binding === undefined || !binding.startsWith(BINDING_PREFIX)) {
        return undefined;
    }
    return JSON.parse(binding.slice(BINDING_PREFIX.length)) as DownloadPlan;
};

export const pathExists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );
