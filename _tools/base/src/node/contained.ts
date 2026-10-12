import { realpath } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

// Whether a path is inside a root, asked one way. The copies this replaces each had a hole: a string prefix that let
// `/work/a-other` pass for `/work/a`, a `startsWith("..")` that refused `..notes`, a legal name, as a climb, and a
// relative() result read without noticing it was absolute (another Windows drive).

export interface InsideOptions {
    // Whose path rules: a Windows path's drive and backslashes, or POSIX's. This host's unless named, so a rule for
    // another platform is checkable from any host.
    readonly platform?: NodeJS.Platform;
    // Compare without case, for a volume whose names ignore it (NTFS, APFS) when the rules alone would not (macOS is
    // POSIX). Windows' own relative() already compares without case.
    readonly foldCase?: boolean;
}

const rulesOf = (platform: NodeJS.Platform): typeof posix => (platform === "win32" ? win32 : posix);

// Lexical: `path` is `root` itself or under it, both resolved against the working directory first. Only a whole `..`
// segment leaves, and a result relative() can only spell as an absolute path (another drive) is outside. Symbolic
// links are not followed: for a path on a disk where a link can lead anywhere, use realInside.
export const isInside = (root: string, path: string, options: InsideOptions = {}): boolean => {
    const rules = rulesOf(options.platform ?? process.platform);
    const fold = (value: string): string => (options.foldCase === true ? rules.resolve(value).toLowerCase() : value);
    const rel = rules.relative(fold(root), fold(path));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${rules.sep}`) && !rules.isAbsolute(rel));
};

// The path under `root` as forward-slash segments, "" for the root itself; undefined when it is not inside.
export const insideRel = (root: string, path: string, options: InsideOptions = {}): string | undefined => {
    if (!isInside(root, path, options)) {
        return undefined;
    }
    const rules = rulesOf(options.platform ?? process.platform);
    return rules.relative(root, path).split(rules.sep).join("/");
};

// The real path of `path`, every link on it followed; a path that does not exist yet resolves through its deepest
// existing ancestor with the missing names below it, the place a write would create it.
export const realPathThrough = async (path: string): Promise<string> => {
    const missing: string[] = [];
    for (let head = resolve(path); ; head = dirname(head)) {
        // allow(silent-catch): a name that does not resolve is the one this walk steps over.
        // oxlint-disable-next-line eslint/no-await-in-loop -- one ancestor at a time, nearest first
        const real = await realpath(head).catch(() => undefined);
        if (real !== undefined) {
            return join(real, ...missing.toReversed());
        }
        if (dirname(head) === head) {
            return resolve(path);
        }
        missing.push(basename(head));
    }
};

// The real path of `path` when it lands inside the real path of `root` (which may itself be a link), undefined when a
// link on the way leads out. What to check before opening a path on a disk where a folder can be a link elsewhere.
export const realInside = async (root: string, path: string, options: Omit<InsideOptions, "platform"> = {}): Promise<string | undefined> => {
    const [realRoot, real] = await Promise.all([realPathThrough(root), realPathThrough(path)]);
    return isInside(realRoot, real, options) ? real : undefined;
};

// (2026-10-06) Whether Windows can hold a name: none of `<>:"|?*` or a control character (a colon names an alternate
// data stream of another file), no trailing dot or space (which Windows drops), and no device name (`CON`, `NUL`,
// `COM1`…, with or without an extension). Measured on NTFS: `a.txt:ads` resolved to a hidden stream of `a.txt`,
// `notes:extra` left an empty `.notes` beside it, and a file made as `nul` could not be deleted by PowerShell. The
// machine agent's project files and the desktop folder server both refuse such a name before anything is made for it.
// oxlint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
export const windowsHolds = (name: string): boolean => !WINDOWS_FORBIDDEN.test(name) && !/[. ]$/.test(name) && !WINDOWS_DEVICE.test(name);
