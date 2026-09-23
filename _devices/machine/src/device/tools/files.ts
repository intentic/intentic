import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentHome, writeFileAtomic } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { assertPath, assertScope } from "../policy.js";

// Files on somebody's device. Reads are bounded by the roots; writes need the roots AND the write switch, off by
// default, and changing a file that exists needs the revision a read answered with. There is no delete tool:
// `trash_file` moves the file under this agent's own trash instead.

// The most text one read answers with. A whole read of a longer file is refused rather than cut, and read in parts.
const MAX_READ_CHARS = 2_000_000;
// The largest file these tools open at all. A bigger one is a log or a dump, which a command reads better, and holding
// it whole is a memory incident on a laptop rather than a useful answer.
const MAX_FILE_BYTES = 10_000_000;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

// What a file is written back in. `undefined` is text in none of these (a legacy code page, most likely): it is read
// with its bad bytes replaced and never written, which would make the replacement permanent.
type Encoding = "utf8" | "utf8-bom" | "utf16le-bom" | undefined;

interface TextFile {
    // LF whatever the file uses; `crlf` puts its own line endings back on the way out.
    readonly text: string;
    readonly encoding: Encoding;
    readonly crlf: boolean;
    // What a write must present to change the file; any byte of it changing changes this.
    readonly revision: string;
}

const revisionOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// Git's own test for binary: a NUL in the first 8000 bytes, which no text has except UTF-16, behind its BOM.
const decode = (bytes: Buffer, path: string): TextFile => {
    const utf16 = bytes.subarray(0, 2).equals(UTF16LE_BOM);
    if (!utf16 && bytes.subarray(0, 8000).includes(0)) {
        throw new Error(`"${path}" is not a text file: it has NUL bytes, which text does not.`);
    }
    const bom = !utf16 && bytes.subarray(0, 3).equals(UTF8_BOM);
    const body = bytes.subarray(utf16 ? 2 : bom ? 3 : 0);
    const encoding: Encoding = utf16 ? "utf16le-bom" : !isUtf8(body) ? undefined : bom ? "utf8-bom" : "utf8";
    const raw = body.toString(utf16 ? "utf16le" : "utf8");
    const text = raw.replaceAll("\r\n", "\n");
    const crlfs = raw.length - text.length;
    return { text, encoding, crlf: crlfs > text.split("\n").length - 1 - crlfs, revision: revisionOf(bytes) };
};

// The bytes `text` becomes in `file`'s encoding and line endings; a new file (`file` undefined) is the text as sent.
const encode = (text: string, file: TextFile | undefined): Buffer => {
    if (file === undefined) {
        return Buffer.from(text, "utf8");
    }
    // Whether there is a BOM is the file's to say, not the text's.
    const lf = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
    const body = file.crlf ? lf.replaceAll("\n", "\r\n") : lf;
    if (file.encoding === "utf16le-bom") {
        return Buffer.concat([UTF16LE_BOM, Buffer.from(body, "utf16le")]);
    }
    return file.encoding === "utf8-bom" ? Buffer.concat([UTF8_BOM, Buffer.from(body, "utf8")]) : Buffer.from(body, "utf8");
};

// How the file is saved, in words, when that is anything but plain UTF-8 with LF line endings.
const formatOf = (file: TextFile): string =>
    [
        file.encoding === "utf8-bom" ? "as UTF-8 with BOM" : file.encoding === "utf16le-bom" ? "as UTF-16LE with BOM" : "",
        file.crlf ? "with CRLF line endings" : "",
    ]
        .filter((part) => part !== "")
        .join(" and ");

// What rides beside the text: where it stands in the file, its revision, and what a write keeps.
const noteOf = (file: TextFile, position: string): string =>
    [
        position,
        `Revision ${file.revision}: write_file and edit_file need it to change this file.`,
        file.encoding === undefined
            ? "Not UTF-8 or UTF-16 text (a legacy code page, most likely): bytes that did not decode show as �, and write_file and edit_file will not change this file."
            : formatOf(file) === ""
              ? ""
              : `Saved ${formatOf(file)}${file.crlf ? " (shown here as LF)" : ""}, which a write keeps.`,
    ]
        .filter((part) => part !== "")
        .join(" ");

// Lines as a reader counts them: a final newline ends the last line rather than starting another.
const linesOf = (text: string): string[] => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

const linesText = (count: number): string => (count === 1 ? "1 line" : `${count} lines`);

// A regular file's bytes and permission bits; a directory, a device or a pipe (which never ends) is refused.
const load = async (target: string, path: string): Promise<{ readonly bytes: Buffer; readonly mode: number }> => {
    const info = await stat(target);
    if (info.isDirectory()) {
        throw new Error(`"${path}" is a directory: use list_dir for it.`);
    }
    if (!info.isFile()) {
        throw new Error(`"${path}" is not a regular file, and these tools open only those.`);
    }
    if (info.size > MAX_FILE_BYTES) {
        throw new Error(`"${path}" is ${megabytes(info.size)}, more than these tools open. Read or change it with a command instead.`);
    }
    return { bytes: await readFile(target), mode: info.mode & 0o7777 };
};

export interface FileRead {
    readonly text: string;
    // The revision and the range, and whether more of the file remains, for the model to read beside the text.
    readonly note: string;
}

const wholeRead = (file: TextFile, lines: readonly string[], path: string): FileRead => {
    if (file.text.length > MAX_READ_CHARS) {
        throw new Error(`"${path}" is ${linesText(lines.length)}, more than one read answers with: read it in parts with offset and limit.`);
    }
    return { text: file.text, note: noteOf(file, lines.length === 0 ? "The file is empty." : `All ${linesText(lines.length)}.`) };
};

// From line `offset` (counting from 1), at most `limit` lines and no more than fit one answer, saying what remains.
const rangeRead = (file: TextFile, lines: readonly string[], offset: number, limit: number | undefined, path: string): FileRead => {
    if (offset > lines.length) {
        throw new Error(`"${path}" has ${linesText(lines.length)}, so there is nothing from line ${offset} on.`);
    }
    const wanted = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
    let size = 0;
    let shown = 0;
    for (const line of wanted) {
        size += line.length + 1;
        if (size > MAX_READ_CHARS) {
            break;
        }
        shown += 1;
    }
    if (shown === 0) {
        throw new Error(`Line ${offset} of "${path}" alone is longer than one read answers with: read it with a command.`);
    }
    const end = offset - 1 + shown;
    const rest = lines.length - end;
    const position = `Lines ${offset}-${end} of ${lines.length}.${rest === 0 ? "" : ` ${rest} more after these: continue with offset ${end + 1}.`}`;
    return { text: wanted.slice(0, shown).join("\n"), note: noteOf(file, position) };
};

// Without `offset` or `limit`, the whole file.
export const readTextFile = async (
    path: string,
    range: { readonly offset?: number | undefined; readonly limit?: number | undefined },
    scopes: DeviceScopes,
): Promise<FileRead> => {
    const target = await assertPath(path, scopes, "read");
    const file = decode((await load(target, path)).bytes, path);
    const lines = linesOf(file.text);
    return (range.offset === undefined && range.limit === undefined) || lines.length === 0
        ? wholeRead(file, lines, path)
        : rangeRead(file, lines, range.offset ?? 1, range.limit, path);
};

// The file as it stands, refused unless it is the revision the caller read and text these tools write back as it was.
const current = async (target: string, path: string, revision: string): Promise<{ readonly file: TextFile; readonly mode: number }> => {
    const { bytes, mode } = await load(target, path);
    const file = decode(bytes, path);
    if (file.revision !== revision) {
        throw new Error(
            `"${path}" has changed since you read it (you read revision ${revision}, it is now ${file.revision}): read it again and make your change to what is there now.`,
        );
    }
    if (file.encoding === undefined) {
        throw new Error(`"${path}" is not UTF-8 or UTF-16 text, so writing it back would corrupt every character that did not decode. Change it with a command instead.`);
    }
    if ((mode & 0o200) === 0) {
        throw new Error(`"${path}" is read-only, and these tools leave it that way.`);
    }
    return { file, mode };
};

// Beside the file and then renamed over it, so nothing ever reads half of it. The staged copy's mode was cut by the
// umask, so the file's own is put back exactly.
const replace = async (target: string, bytes: Buffer, mode: number): Promise<void> => {
    await writeFileAtomic(target, bytes, mode);
    await chmod(target, mode);
};

const exists = async (target: string): Promise<boolean> =>
    await stat(target).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return false;
            }
            throw error;
        },
    );

export const writeTextFile = async (path: string, content: string, revision: string | undefined, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "write");
    const target = await assertPath(path, scopes, "write");
    if (await exists(target)) {
        if (revision === undefined) {
            throw new Error(`"${path}" already exists. Read it first: replacing a file takes the revision read_file answered with, and creating one takes none.`);
        }
        const { file, mode } = await current(target, path, revision);
        const bytes = encode(content, file);
        await replace(target, bytes, mode);
        // Say which it was: "Wrote 40 lines to config.json" reads identically whether it created a file or replaced a
        // working configuration, and only one of those is worth mentioning.
        const kept = formatOf(file) === "" ? "" : `, saved ${formatOf(file)} as before`;
        return `Overwrote ${target} (${content.length} characters${kept}). Revision ${revisionOf(bytes)}.`;
    }
    if (revision !== undefined) {
        throw new Error(`"${path}" no longer exists: it was moved or deleted after you read it. Call write_file without a revision to create it again.`);
    }
    await mkdir(dirname(target), { recursive: true });
    const bytes = encode(content, undefined);
    // What any program's new file gets: the umask decides the rest.
    await writeFileAtomic(target, bytes, 0o666);
    return `Created ${target} (${content.length} characters). Revision ${revisionOf(bytes)}.`;
};

// One exact replacement, matched against the text as read_file shows it (LF line endings), and only where it is unique.
export const editTextFile = async (
    path: string,
    edit: { readonly oldString: string; readonly newString: string; readonly revision: string },
    scopes: DeviceScopes,
): Promise<string> => {
    assertScope(scopes, "write");
    const target = await assertPath(path, scopes, "edit");
    if (!(await exists(target))) {
        throw new Error(`"${path}" does not exist: create it with write_file.`);
    }
    const { file, mode } = await current(target, path, edit.revision);
    const before = edit.oldString.replaceAll("\r\n", "\n");
    const after = edit.newString.replaceAll("\r\n", "\n");
    if (before === after) {
        throw new Error("old_string and new_string are the same, so there is nothing to change.");
    }
    const at = file.text.indexOf(before);
    if (at === -1) {
        throw new Error(`old_string is not in "${path}". It has to match the text read_file shows exactly, whitespace and indentation included.`);
    }
    if (file.text.includes(before, at + 1)) {
        throw new Error(`old_string matches more than one place in "${path}": include more of the lines around it, so that it matches one.`);
    }
    const bytes = encode(`${file.text.slice(0, at)}${after}${file.text.slice(at + before.length)}`, file);
    await replace(target, bytes, mode);
    return `Edited ${target}. Revision ${revisionOf(bytes)}.`;
};

export interface DirEntry {
    readonly name: string;
    readonly kind: "file" | "directory" | "other";
    readonly size?: number;
    readonly modified?: string;
}

export const listDirectory = async (path: string, scopes: DeviceScopes): Promise<DirEntry[]> => {
    const target = await assertPath(path, scopes, "list");
    const entries = await readdir(target, { withFileTypes: true });
    return await Promise.all(
        entries.map(async (entry) => {
            const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
            if (kind !== "file") {
                return { name: entry.name, kind };
            }
            // A stat per entry is affordable for a directory listing and turns "here are 400 names" into something the
            // agent can reason about.
            const info = await stat(join(target, entry.name)).catch(() => undefined);
            return info === undefined ? { name: entry.name, kind } : { name: entry.name, kind, size: info.size, modified: info.mtime.toISOString() };
        }),
    );
};

const trashDir = (): string => join(agentHome("machine").dir, "trash");

// A rename, not a copy: the cross-filesystem fallback is deliberately absent, since it would silently turn "moved"
// into "duplicated and then really deleted".
export const trashFile = async (path: string, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "write");
    const target = await assertPath(path, scopes, "trash", { link: "itself" });
    await lstat(target);
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
