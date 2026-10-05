import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, readlink, rename } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

// The file moves the manifest's entries share: into this agent's trash, and the checks that come before one.

const exec = promisify(execFile);

// The stamp a trash entry's name begins with: an ISO time with `:` and `.` made safe for every file system, as
// `trash_file` names its folders (device/tools/files.ts).
export const trashStamp = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, "-");

// When a trash entry was put there, read off the stamp its name begins with; undefined for a name without one. Read off
// the NAME because a rename keeps a folder's own times: a folder last written in August and trashed today would read as
// two months in the trash. Pure.
export const trashedAt = (name: string): number | undefined => {
    const stamp = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
    if (stamp === null) {
        return undefined;
    }
    const at = Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`);
    return Number.isNaN(at) ? undefined : at;
};

export const trashDirOf = (base: string): string => join(base, "trash");

// Moves `path` into the trash as `<stamp>-<name>`, answering where it went. A rename only: a copy across drives would
// turn "moved" into "duplicated, then deleted", so a path on another drive is refused, and a file Windows holds open
// (a running binary inside a folder) fails here too, which is what keeps a live program's folder where it is.
export const moveToTrash = async (base: string, path: string, at: number): Promise<string> => {
    const trash = trashDirOf(base);
    await mkdir(trash, { recursive: true, mode: 0o700 });
    // Two things of one name moved in one pass (a timer and its `wants` link) must not land on each other.
    let destination = join(trash, `${trashStamp(at)}-${basename(path)}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one stat per name taken, almost always none
    for (let n = 2; await exists(destination); n += 1) {
        destination = join(trash, `${trashStamp(at)}-${basename(path)}-${n}`);
    }
    try {
        await rename(path, destination);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EXDEV") {
            throw new Error(`it is on another drive than ${trash}, so it cannot be moved there safely`, { cause: error });
        }
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
            throw new Error(`it is in use or not ours to move (${code})`, { cause: error });
        }
        throw error;
    }
    return destination;
};

// Whether `path` is `dir` or anything under it, as strings: a dangling link still says where it pointed. Pure.
export const isInside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}${sep}`);

// Where a symbolic link points, resolved against its own folder; undefined for anything that is not a link.
export const linkTarget = async (path: string): Promise<string | undefined> => {
    // allow(silent-catch): a path that is not there, or not a link, points nowhere
    const info = await lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink() !== true) {
        return undefined;
    }
    return resolve(dirname(path), await readlink(path));
};

export const exists = async (path: string): Promise<boolean> =>
    await lstat(path).then(
        () => true,
        () => false,
    );

// The processes whose program or first arguments live under `dir`; undefined where that cannot be asked (Windows, where
// moving the folder fails instead while one runs from it). Linux reads /proc, macOS asks `ps`.
export const processesFrom = async (dir: string, platform: NodeJS.Platform = process.platform): Promise<number[] | undefined> => {
    if (platform === "linux") {
        // allow(silent-catch): a /proc that cannot be listed cannot vouch for anything, which the caller reads as "can't tell"
        const pids = (await readdir("/proc").catch(() => undefined))?.filter((name) => /^\d+$/.test(name));
        if (pids === undefined) {
            return undefined;
        }
        const running = await Promise.all(
            pids.map(async (pid) => {
                // allow(silent-catch): a process that ended between the listing and the read runs nothing from anywhere
                const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
                // allow(silent-catch): as above
                const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").slice(0, 2);
                return [exe, ...argv].some((part) => part !== "" && isInside(part.replace(/ \(deleted\)$/, ""), dir)) ? Number(pid) : undefined;
            }),
        );
        return running.filter((pid) => pid !== undefined && pid !== process.pid) as number[];
    }
    if (platform === "darwin") {
        // allow(silent-catch): a `ps` that does not answer cannot vouch for anything
        const listed = await exec("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 }).catch(() => undefined);
        if (listed === undefined) {
            return undefined;
        }
        return listed.stdout
            .split("\n")
            .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
            .filter(
                (match): match is RegExpExecArray =>
                    match !== null &&
                    (match[2] ?? "")
                        .split(" ")
                        .slice(0, 2)
                        .some((part) => isInside(part, dir)),
            )
            .map((match) => Number(match[1]));
    }
    return undefined;
};
