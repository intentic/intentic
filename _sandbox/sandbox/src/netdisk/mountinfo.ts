import { readFile } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";

// The kernel's own answer to "what is mounted where": /proc/self/mountinfo, one line per mount. Read live on every
// probe, never remembered, so a disk unmounted from a shell and one unmounted from the UI read identically.

export interface MountEntry {
    readonly mountPoint: string;
    readonly fsType: string;
    // What was mounted: `//server/share` for cifs.
    readonly source: string;
    // Per-mount flags (field 6): `ro` here is what a bind remount flips.
    readonly mountOptions: readonly string[];
    // Superblock flags (after the fs type): `ro` here is what `mount -o remount,ro` flips.
    readonly superOptions: readonly string[];
}

// mountinfo escapes space, tab, newline and backslash in paths as octal; a path is compared unescaped.
const unescape = (field: string): string => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

// Field layout: id parent major:minor root mount-point mount-options [optional-fields…] - fs-type source super-options.
export const parseMountinfo = (text: string): MountEntry[] =>
    text.split("\n").flatMap((line) => {
        const separator = line.indexOf(" - ");
        if (separator === -1) {
            return [];
        }
        const before = line.slice(0, separator).split(" ");
        const after = line.slice(separator + 3).split(" ");
        const mountPoint = before[4];
        const mountOptions = before[5];
        const [fsType, source, superOptions] = after;
        if (mountPoint === undefined || mountOptions === undefined || fsType === undefined || source === undefined) {
            return [];
        }
        return [
            {
                mountPoint: unescape(mountPoint),
                fsType,
                source: unescape(source),
                mountOptions: mountOptions.split(","),
                superOptions: (superOptions ?? "").split(",").filter((option) => option !== ""),
            },
        ];
    });

// Read-only if EITHER layer says so: the kernel refuses a write when either flag is set.
export const isReadOnly = (entry: MountEntry): boolean => entry.mountOptions.includes("ro") || entry.superOptions.includes("ro");

// The last entry wins: a mount stacked over another at the same point is the one a path resolves to.
export const mountAt = (entries: readonly MountEntry[], mountPoint: string): MountEntry | undefined =>
    entries.findLast((entry) => entry.mountPoint === mountPoint);

// Only a /proc without mountinfo reads as "nothing mounted"; a failed read (EMFILE) would make `unmount` a silent no-op.
export const readMountinfo = async (): Promise<MountEntry[]> =>
    parseMountinfo((await readFile("/proc/self/mountinfo", "utf8").catch(undefinedIfMissing)) ?? "");
