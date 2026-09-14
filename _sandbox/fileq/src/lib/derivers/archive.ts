import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { gunzipSync } from "fflate";
import { gzipHead, listWithTar, looksLikeTar, tarEntries, tarOnPath, zipEntries, type ArchiveEntry } from "../archives.js";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Archives: what is inside, not what it says. */

// Members listed before the table is more index than shadow; the count above it still states the whole truth.
const MAX_ENTRIES = 500;
// A gzip member worth inflating into memory during a background sweep; above it the trailer's facts are the shadow.
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
// Text of a single compressed file carried into the shadow; the rest stays one `zcat` away.
const MAX_MEMBER_TEXT_BYTES = 256 * 1024;

// What the container is, as a reader would name it; drives both the capsule's first line and which reader runs.
type Container = "zip" | "tar" | "gzip" | "xz" | "bzip2" | "zstd" | "7z" | "rar";

// Leading bytes that name a container. Checked before tar, whose own recognition is a checksum over the first block.
const MAGIC: readonly (readonly [Container, readonly number[]])[] = [
    ["zip", [0x50, 0x4b]],
    ["gzip", [0x1f, 0x8b]],
    ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a]],
    ["bzip2", [0x42, 0x5a, 0x68]],
    ["zstd", [0x28, 0xb5, 0x2f, 0xfd]],
    ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ["rar", [0x52, 0x61, 0x72, 0x21]],
];

const containerOf = (bytes: Uint8Array): Container | undefined => {
    const magic = MAGIC.find(([, signature]) => signature.every((byte, index) => bytes[index] === byte));
    return magic?.[0] ?? (looksLikeTar(bytes) ? "tar" : undefined);
};

// Sizes read by a person, not a machine: three significant figures at most, since an exact byte count of a member
// nobody has unpacked yet is noise.
const formatBytes = (bytes: number): string => {
    const units = ["B", "kB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// The capsule above the table: what the container is and how much is in it, so a reader knows the shape before the list.
const summaryOf = (container: Container, entries: readonly ArchiveEntry[]): string[] => {
    const files = entries.filter((entry) => !entry.directory);
    const unpacked = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    const packed = files.reduce((sum, entry) => sum + (entry.packed ?? 0), 0);
    const folders = entries.length - files.length;
    const lines = [`- Archive: ${container}`, `- Members: ${plural(files.length, "file")}${folders === 0 ? "" : `, ${plural(folders, "folder")}`}`];
    // Ratio only where the container records both sides; a tar header knows nothing about what compressed it.
    const ratio = packed > 0 && unpacked > 0 ? ` · packed ${formatBytes(packed)} (${Math.round((1 - packed / unpacked) * 100)}% smaller)` : "";
    if (unpacked > 0) {
        lines.push(`- Unpacked: ${formatBytes(unpacked)}${ratio}`);
    }
    return lines;
};

const tableRow = (cells: readonly string[]): string => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;

// Files only: a folder row carries no size and says nothing the paths beside it don't already.
const entryTable = (entries: readonly ArchiveEntry[]): string => {
    const files = entries.filter((entry) => !entry.directory).slice(0, MAX_ENTRIES);
    if (files.length === 0) {
        return "";
    }
    return [
        tableRow(["Path", "Size"]),
        tableRow(["---", "---"]),
        ...files.map((entry) => tableRow([entry.path, entry.size === undefined ? "" : formatBytes(entry.size)])),
    ].join("\n");
};

const listingDoc = (container: Container, entries: readonly ArchiveEntry[], notes: readonly string[]): DerivedDoc => {
    const files = entries.filter((entry) => !entry.directory).length;
    const table = entryTable(entries);
    return {
        markdown: [summaryOf(container, entries).join("\n"), table].filter((part) => part !== "").join("\n\n"),
        notes: [
            ...notes,
            ...(files > MAX_ENTRIES ? [`listing ${MAX_ENTRIES} of ${files} files: the rest are in the archive, not here`] : []),
            ...(entries.length === 0 ? ["this archive holds nothing"] : []),
            "member listing only: what the files inside SAY is not derived — unpack the archive to read them",
        ],
    };
};

// A NUL in the first pages is how every other surface here decides text from bytes; the same rule, so they agree.
const isText = (bytes: Uint8Array): boolean => !bytes.subarray(0, 8192).includes(0);

// One compressed file, where the archive is a wrapper rather than a container: the member's own text is the shadow.
const memberDoc = (name: string, unpacked: Uint8Array): DerivedDoc => {
    const facts = [`- Archive: gzip`, `- Member: ${name}`, `- Unpacked: ${formatBytes(unpacked.length)}`].join("\n");
    if (!isText(unpacked)) {
        return { markdown: facts, notes: [`${name} is not text: nothing inside this archive can be shown as prose`] };
    }
    const clipped = unpacked.length > MAX_MEMBER_TEXT_BYTES;
    const text = new TextDecoder().decode(unpacked.subarray(0, MAX_MEMBER_TEXT_BYTES));
    return {
        markdown: `${facts}\n\n## ${name}\n\n${clipped ? text.slice(0, text.lastIndexOf("\n") + 1) : text}`,
        notes: clipped ? [`showing the first ${formatBytes(MAX_MEMBER_TEXT_BYTES)} of ${formatBytes(unpacked.length)}: the rest is in the archive`] : [],
    };
};

const gzipDoc = (absPath: string, bytes: Uint8Array): DerivedDoc => {
    const head = gzipHead(bytes);
    const name = head?.name ?? basename(absPath).replace(/\.(gz|tgz)$/i, "");
    if (head !== undefined && head.unpackedBytes > MAX_UNPACKED_BYTES) {
        return {
            markdown: [`- Archive: gzip`, `- Member: ${name}`, `- Unpacked: ${formatBytes(head.unpackedBytes)}`].join("\n"),
            notes: [`too large to open in the background (${formatBytes(head.unpackedBytes)} unpacked): the header's facts are all this shadow carries`],
        };
    }
    const unpacked = gunzipSync(bytes);
    // A .tgz is a tar wearing gzip: its shadow is the manifest, the same one a plain .tar gets.
    return looksLikeTar(unpacked) ? listingDoc("gzip", tarEntries(unpacked), ["gzip-compressed tar"]) : memberDoc(name, unpacked);
};

// Codecs the image carries as binaries but node_modules cannot decompress; GNU tar reads all three on the way in.
const externalDoc = async (container: Container, absPath: string): Promise<DerivedDoc> => {
    if (!tarOnPath()) {
        return { markdown: `- Archive: ${container}`, notes: [`no listing: reading a ${container} archive needs tar, which is not on PATH here`] };
    }
    try {
        return listingDoc(container, await listWithTar(absPath), [`listed through tar`]);
    } catch {
        // tar refuses anything that is not a tar inside: a bare `notes.xz` is one compressed file, and this tier
        // has no decompressor for it.
        return {
            markdown: `- Archive: ${container}`,
            notes: [`no listing: this is a single ${container}-compressed file rather than an archive, and ${container} is not decompressed by this tier`],
        };
    }
};

// 7z and rar are the two containers nothing on the image opens; named rather than silently empty.
const UNREADABLE: ReadonlySet<Container> = new Set(["7z", "rar"]);

export const archiveDeriver: Deriver = {
    // The stamp names the listing capability for the same reason the pdf deriver's names OCR: a shadow written
    // without tar on PATH must read as stale once an image carries it.
    get name(): string {
        return tarOnPath() ? "archive+tar" : "archive";
    },
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const bytes = new Uint8Array(await readFile(absPath));
        const container = containerOf(bytes);
        if (container === undefined) {
            throw new Error("not an archive: no container signature in the first bytes");
        }
        if (UNREADABLE.has(container)) {
            return { markdown: `- Archive: ${container}`, notes: [`no listing: nothing in this image opens a ${container} archive`] };
        }
        if (container === "zip") {
            return listingDoc(container, zipEntries(bytes), []);
        }
        if (container === "tar") {
            return listingDoc(container, tarEntries(bytes), []);
        }
        return container === "gzip" ? gzipDoc(absPath, bytes) : externalDoc(container, absPath);
    },
};
