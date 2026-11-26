import { copyFile, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { homeDir } from "@intentic/local-agent";
import { civilDayIn, localZone, type Zone } from "@intentic/sandbox-contract/time/zone";

/* `memory=` IN A HAND-KEPT `.wslconfig` (2026-11-26): read for the WSL VM's size (wsl-memory-fit.ts), and rewritten at
   the owner's yes on the sandbox's `wsl-memory` card. rog's file is the owner's own notebook: every change in it is
   dated, says why, and names the backup it left (`.wslconfig.bak.2026-10-30`). So a change here touches nothing but
   the one `memory=` line of `[wsl2]` (one is added where there is none), puts a dated line above it in the owner's own
   words' shape, saying who changed it and why, and first copies the file as it was to `.wslconfig.bak.<date>` beside it,
   never over a backup already there. Line endings, a byte-order mark and UTF-16 (which some Windows editors save) are
   kept as found. Nothing restarts WSL: the VM takes the new size at its next start. */

const GIB = 1024 ** 3;

export const wslconfigPath = (): string => join(homeDir(), ".wslconfig");

const SECTION = /^\s*\[([^\]]*)\]\s*$/;
const MEMORY = /^(\s*)memory\s*=\s*(.*?)\s*$/i;
const SIZE = /^(\d+(?:\.\d+)?)\s*([KMGT]?B?)$/i;
const UNIT_BYTES = new Map<string, number>([
    ["", 1],
    ["B", 1],
    ["K", 1024],
    ["KB", 1024],
    ["M", 1024 ** 2],
    ["MB", 1024 ** 2],
    ["G", GIB],
    ["GB", GIB],
    ["T", 1024 ** 4],
    ["TB", 1024 ** 4],
]);

/** A `.wslconfig` size (`22GB`, `16384MB`) in GB as WSL reads it, which is GiB; undefined for anything else. Pure. */
export const sizeGb = (value: string): number | undefined => {
    const match = SIZE.exec(value.trim());
    const bytes = UNIT_BYTES.get((match?.[2] ?? "").toUpperCase());
    return match === null || bytes === undefined ? undefined : (Number(match[1]) * bytes) / GIB;
};

interface MemoryLine {
    readonly at: number;
    readonly indent: string;
    readonly value: string;
}

interface Located {
    // The `[wsl2]` header's index, -1 without one.
    readonly header: number;
    // The `memory=` line WSL reads there: the last.
    readonly memory: MemoryLine | undefined;
}

// Where `[wsl2]` and its `memory=` are among the lines. Pure.
const locate = (lines: readonly string[]): Located => {
    let section: string | undefined;
    let header = -1;
    let memory: MemoryLine | undefined;
    for (const [at, line] of lines.entries()) {
        const named = SECTION.exec(line);
        if (named !== null) {
            section = named[1]?.trim().toLowerCase();
            if (section === "wsl2" && header === -1) {
                header = at;
            }
            continue;
        }
        const set = section === "wsl2" ? MEMORY.exec(line) : null;
        if (set !== null) {
            memory = { at, indent: set[1] ?? "", value: set[2] ?? "" };
        }
    }
    return { header, memory };
};

const linesOf = (text: string): string[] => text.split(/\r?\n/);

/** `memory=` as the `[wsl2]` section sets it, as written (`22GB`); undefined where it sets none. Pure. */
export const memoryValue = (text: string): string | undefined => locate(linesOf(text)).memory?.value;

/** `memory=` in GB, undefined where it is not set or not a size WSL reads. Pure. */
export const configuredGb = (text: string): number | undefined => {
    const value = memoryValue(text);
    return value === undefined ? undefined : sizeGb(value);
};

// One line, however the reason came: a `.wslconfig` comment ends at the line's end.
const oneLine = (text: string, max: number): string => {
    const flat = text.replaceAll(/\s+/g, " ").trim().replace(/\.$/, "");
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The dated line a change leaves above `memory=`, in the shape of the owner's own (`# Changed <date> from … to …: why`). Pure. */
export const changeComment = (change: { readonly date: string; readonly from: string | undefined; readonly gb: number; readonly why: string; readonly backup: string | undefined }): string =>
    `# Changed ${change.date} ${change.from === undefined ? "(memory= was not set)" : `from ${change.from}`} to ${change.gb}GB by intentic-machine, at the owner's yes on a sandbox card: ${oneLine(change.why, 240)}.${change.backup === undefined ? "" : ` Previous file: ${change.backup}`}`;

/**
 * `text` with `memory=` in `[wsl2]` set to `gb` GB and `comment` on the line above it, every other line as it was: the
 * line WSL reads is rewritten in place (its indent kept), one is added under the `[wsl2]` header where it sets none,
 * and a `[wsl2]` section is added at the end where there is none. Line endings are kept: CRLF where the file has them. Pure.
 */
export const withMemory = (text: string, gb: number, comment: string): string => {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = linesOf(text);
    const { header, memory } = locate(lines);
    const setting = `memory=${gb}GB`;
    if (memory !== undefined) {
        lines.splice(memory.at, 1, `${memory.indent}${comment}`, `${memory.indent}${setting}`);
        return lines.join(eol);
    }
    if (header !== -1) {
        lines.splice(header + 1, 0, comment, setting);
        return lines.join(eol);
    }
    // No [wsl2] at all: added at the end, after a blank line, with the file's last line ending as it did.
    const ended = text === "" || text.endsWith("\n");
    const body = [...(text === "" ? [] : [""]), "[wsl2]", comment, setting].join(eol);
    return `${text}${ended || text === "" ? "" : eol}${body}${eol}`;
};

/** The backup's name for `date`: `.wslconfig.bak.<date>`, or `.2`, `.3`… after it when one of that day is there. Pure. */
export const backupName = (file: string, date: string, taken: (name: string) => boolean): string => {
    const first = `${file}.bak.${date}`;
    if (!taken(first)) {
        return first;
    }
    let count = 2;
    while (taken(`${first}.${count}`)) {
        count += 1;
    }
    return `${first}.${count}`;
};

/** The calendar day in `zone`, `YYYY-MM-DD`, the owner's own backups' and comments' format: the PC's own zone, where this runs. Pure. */
export const localDate = (at: number, zone: Zone): string => civilDayIn(at, zone);

type Encoding = "utf8" | "utf8-bom" | "utf16le";

// The text, and how to write it back as it came.
interface Decoded {
    readonly text: string;
    readonly encoding: Encoding;
}

const decode = (bytes: Buffer): Decoded => {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { text: bytes.subarray(2).toString("utf16le"), encoding: "utf16le" };
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { text: bytes.subarray(3).toString("utf8"), encoding: "utf8-bom" };
    }
    return { text: bytes.toString("utf8"), encoding: "utf8" };
};

const encode = (text: string, encoding: Encoding): Buffer => {
    switch (encoding) {
        case "utf16le":
            return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
        case "utf8-bom":
            return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
        case "utf8":
            return Buffer.from(text, "utf8");
    }
};

/** What `.wslconfig` says, read the way a change would read it; undefined where there is no file. */
export const readWslconfigText = async (path: string = wslconfigPath()): Promise<string | undefined> => {
    const bytes = await readFile(path).catch(undefinedIfMissing);
    return bytes === undefined ? undefined : decode(bytes).text;
};

// What a change does to the disk, as seams for the tests.
export interface WslconfigIo {
    // The file's bytes, undefined where there is none.
    readonly read: (path: string) => Promise<Buffer | undefined>;
    // The names in a folder, for a backup's name that is not taken.
    readonly names: (folder: string) => Promise<readonly string[]>;
    // Copies the file as it is, refusing to write over one that is there.
    readonly backup: (from: string, to: string) => Promise<void>;
    readonly write: (path: string, bytes: Buffer) => Promise<void>;
}

export const realWslconfigIo: WslconfigIo = {
    read: async (path) => await readFile(path).catch(undefinedIfMissing),
    names: async (folder) => await readdir(folder),
    // COPYFILE_EXCL: a backup of the same name, made by the owner or an earlier change, is never written over.
    backup: async (from, to) => await copyFile(from, to, 1),
    write: async (path, bytes) => await writeFileAtomic(path, bytes),
};

export interface MemoryChange {
    readonly path: string;
    // `memory=` as it was written before, undefined where it was not set.
    readonly from: string | undefined;
    readonly gb: number;
    // False when it already said `gb` GB: nothing was written.
    readonly changed: boolean;
    // Where the file as it was went; undefined where nothing was written or there was no file.
    readonly backupPath: string | undefined;
}

/**
 * Sets `memory=` in `[wsl2]` of the `.wslconfig` at `path` to `gb` GB: the file as it was is copied beside it first
 * (backupName), then the change is written whole, in place of the old file. `why` goes on the dated line above it.
 */
export const applyWslMemory = async (
    io: WslconfigIo,
    change: { readonly path: string; readonly gb: number; readonly why: string; readonly now: number; readonly zone?: Zone },
): Promise<MemoryChange> => {
    const bytes = await io.read(change.path);
    const { text, encoding }: Decoded = bytes === undefined ? { text: "", encoding: "utf8" } : decode(bytes);
    const from = memoryValue(text);
    if (from !== undefined && sizeGb(from) === change.gb) {
        return { path: change.path, from, gb: change.gb, changed: false, backupPath: undefined };
    }
    const date = localDate(change.now, change.zone ?? localZone());
    const folder = dirname(change.path);
    let backupPath: string | undefined;
    if (bytes !== undefined) {
        const names = new Set(await io.names(folder));
        backupPath = join(folder, backupName(basename(change.path), date, (name) => names.has(name)));
        await io.backup(change.path, backupPath);
    }
    const comment = changeComment({ date, from, gb: change.gb, why: change.why, backup: backupPath === undefined ? undefined : basename(backupPath) });
    await io.write(change.path, encode(withMemory(text, change.gb, comment), encoding));
    return { path: change.path, from, gb: change.gb, changed: true, backupPath };
};
