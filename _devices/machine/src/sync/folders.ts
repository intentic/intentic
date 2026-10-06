import { realpath } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { type Pairing, pairingKey } from "./config.js";

// ONE FOLDER, ONE SYNC. Two pairings over the same folder, or one inside the other, are two synchronizers writing the
// same files on behalf of two sandboxes: each carries the other's writes to its own sandbox as edits, and a workspace
// folder holding a project folder puts one sandbox's /work inside the other's project. Nothing refused it while every
// folder was `~/intentic/<id>`; a project folder is picked anywhere on disk.

// The deepest existing ancestor's real path with the rest of `path` put back, so a folder `setup` has not created yet
// still resolves through whatever link its parent is.
const realOrAncestor = async (path: string, rest: readonly string[]): Promise<string> => {
    // allow(silent-catch): a folder that is not there yet, or cannot be read, is named by its nearest ancestor that resolves.
    const real = await realpath(path).catch(() => undefined);
    if (real !== undefined) {
        return join(real, ...rest);
    }
    const parent = dirname(path);
    return parent === path ? join(path, ...rest) : await realOrAncestor(parent, [basename(path), ...rest]);
};

// A folder as the filesystem resolves it, links followed, so `~/code` and a link pointing at it are one folder.
export const canonicalFolder = async (dir: string): Promise<string> => await realOrAncestor(resolve(dir), []);

// Where the platform's own volumes compare names without case (NTFS, APFS): `~/Code/app` and `~/code/app` are one
// folder there and two elsewhere.
const foldsCase = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";

// A folder spelled the one way the platform compares it: resolved, and lower-cased where names ignore case.
const folded = (dir: string, platform: NodeJS.Platform): string => {
    const resolved = (platform === "win32" ? win32 : posix).resolve(dir);
    return foldsCase(platform) ? resolved.toLowerCase() : resolved;
};

// Whether two absolute folders are the same one, or one holds the other. Pure, the platform passed in, so the Windows and
// macOS rules are checkable from any host.
export const foldersOverlap = (first: string, second: string, platform: NodeJS.Platform = process.platform): boolean => {
    const path = platform === "win32" ? win32 : posix;
    const within = (inner: string, outer: string): boolean => {
        const rel = path.relative(outer, inner);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
    const [a, b] = [folded(first, platform), folded(second, platform)];
    return within(a, b) || within(b, a);
};

// Whether two absolute folders are the same one, by the same rules.
export const sameFolder = (first: string, second: string, platform: NodeJS.Platform = process.platform): boolean =>
    folded(first, platform) === folded(second, platform);

// ANOTHER pairing whose folder this one would be, hold, or sit inside; undefined when none. The pairing filed under the
// same key is not a clash: setting it up (or attaching it) again, here or in a new folder, replaces it. Another folder
// attached to the same sandbox is one, since each is a sync of its own.
export const overlappingPairing = async (
    folder: string,
    key: string,
    pairings: readonly Pairing[],
    platform: NodeJS.Platform = process.platform,
): Promise<(Pairing & { readonly localDir: string }) | undefined> => {
    const wanted = await canonicalFolder(folder);
    const others = await Promise.all(
        pairings
            .flatMap((held) => (pairingKey(held) === key || held.localDir === undefined ? [] : [{ ...held, localDir: held.localDir }]))
            .map(async (held) => ({ held, folder: await canonicalFolder(held.localDir) })),
    );
    return others.find((other) => foldersOverlap(wanted, other.folder, platform))?.held;
};

// WHAT A FOLDER MAY NOT BE, attached to this machine's sandbox: a whole disk, the home folder itself or one holding it,
// everyone's homes or a whole one of them, or the system's own folders. The desktop app refuses the same folders before
// it asks (`refusal` in its project.rs), in the same words; this side refuses them again because the command is
// reachable without the app, and a folder copied into the sandbox and written into by delivery must be one project.
// Pure, home and platform passed in, so each rule is checkable from any host. Undefined when the folder may attach.
export const folderRefusal = (folder: string, home: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined => {
    const path = platform === "win32" ? win32 : posix;
    const resolved = path.resolve(folder);
    if (path.dirname(resolved) === resolved) {
        return `${folder} is a whole disk. Pick the folder of one project in it.`;
    }
    if (home !== undefined && sameFolder(resolved, home, platform)) {
        return `${folder} is your whole home folder. Pick the folder of one project in it.`;
    }
    if (home !== undefined && within(home, resolved, platform)) {
        return `${folder} holds your home folder. Pick the folder of one project in it.`;
    }
    // (2026-10-06) A WSL distro's folder as Windows reaches it is held to the distro's own rules below, with its homes
    // refused by shape: the Windows home says nothing of whose they are.
    const inDistro = platform === "win32" ? WSL_SHARE.exec(resolved)?.groups?.["inside"] : undefined;
    if (inDistro !== undefined) {
        return distroRefusal(folder, inDistro.replaceAll("\\", "/"));
    }
    // Fedora Atomic keeps the homes under `/var/home` (`/home` links to it): a folder in somebody's home there is theirs,
    // whatever the rule for `/var` below says.
    if (platform !== "win32" && within(resolved, "/var/home", platform)) {
        return homesRefusal(folder, resolved, "/var/home");
    }
    // (2026-10-06) The system's folders on whichever drive the folder is: a second disk can hold a Windows install too.
    const system = platform === "win32" ? WINDOWS_SYSTEM_FOLDERS.map((name) => `${resolved.slice(0, 2)}\\${name}`) : POSIX_SYSTEM_FOLDERS;
    return system.some((root) => within(resolved, root, platform)) ? `${folder} belongs to the system. Pick a folder of your own.` : undefined;
};

// A folder in a folder of homes (`homes`, which `resolved` is or is inside): the homes' own folder and a whole home in it
// are refused, a folder in somebody's home is theirs.
const homesRefusal = (folder: string, resolved: string, homes: string): string | undefined => {
    const depth = posix.relative(homes, resolved).split("/").filter((part) => part !== "").length;
    if (depth === 0) {
        return `${folder} holds everyone's home folders. Pick the folder of one project in yours.`;
    }
    return depth === 1 ? `${folder} is a whole home folder. Pick the folder of one project in it.` : undefined;
};

// `\\wsl.localhost\<distro>\…` (or `\\wsl$\…`), with the path inside the distro, its leading backslash kept.
const WSL_SHARE = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(?<inside>\\.*)$/i;

// A folder inside a distro, `inside` its Linux path: a whole mounted disk (`/mnt/c`), its homes and root's home, and its
// system's folders, as `folderRefusal` refuses them on Linux.
const distroRefusal = (folder: string, inside: string): string | undefined => {
    const resolved = posix.resolve(inside);
    for (const homes of ["/home", "/var/home"]) {
        if (within(resolved, homes, "linux")) {
            return homesRefusal(folder, resolved, homes);
        }
    }
    if (resolved === "/root") {
        return `${folder} is a whole home folder. Pick the folder of one project in it.`;
    }
    if (within(resolved, "/mnt", "linux") && posix.relative("/mnt", resolved).split("/").filter((part) => part !== "").length <= 1) {
        return `${folder} is a whole disk. Pick the folder of one project in it.`;
    }
    return POSIX_SYSTEM_FOLDERS.some((root) => within(resolved, root, "linux")) ? `${folder} belongs to the system. Pick a folder of your own.` : undefined;
};

// Whether `inner` is `outer` or inside it, by the platform's own comparison.
const within = (inner: string, outer: string, platform: NodeJS.Platform): boolean => {
    const path = platform === "win32" ? win32 : posix;
    const rel = path.relative(folded(outer, platform), folded(inner, platform));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

// The desktop app's own lists (project.rs), kept in step with it.
// Windows' by name, on the drive of the folder asked about.
const WINDOWS_SYSTEM_FOLDERS: readonly string[] = ["Windows", "Program Files", "Program Files (x86)", "ProgramData"];
const POSIX_SYSTEM_FOLDERS: readonly string[] = ["/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var", "/System", "/Library", "/Applications"];
