// WHAT A SANDBOX MAY PUT IN THE CI FLEET'S TURBO CACHE: logs, and nothing that becomes a file in a build.
//
// A turbo cache entry is a zstd-compressed tar of a task's outputs plus its log (`<pkg>/.turbo/turbo-<task>.log`). For a
// task whose turbo.json `outputs` is empty (typecheck, test) the log is all there is, so an entry vouches for a result and
// carries no bytes anything else consumes. That is the only kind a sandbox may write: a sandbox runs an agent's code, and
// an entry holding a `dist` would be a way into a published image (ci.yml's fork-boundary comment names the same edge).
//
// So every sandbox upload goes through canonicalArtifact twice: in the cache server as it arrives, and again in CI's
// import step before it reaches the fleet's own cache directory. It does not pass the bytes it was given along. It reads
// them, keeps only regular files at a `.turbo/turbo-*.log` path, and writes a fresh tar of those, so whatever else a
// crafted tar holds (a link, a PAX override, a header our reader and turbo's would disagree about) never reaches turbo's
// reader at all. A log is also refused when a line opens a GitHub workflow command, since CI prints a replayed log to the
// job's stdout, where `::add-mask::` and the like are instructions to the runner.
//
// Node builtins only: CI's import runs this before or without an install.
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const BLOCK = 512;
// The most a log-only entry may unpack to. Real ones are kilobytes; a test log is the largest, at a few hundred.
export const MAX_TAR_BYTES = 8 * 1024 * 1024;

// `<any dirs>/.turbo/turbo-<task>.log`: where turbo puts a task's log, relative to the repository root.
const LOG_PATH = /^(?:[^/]+\/)*\.turbo\/turbo-[^/]+\.log$/;
// A line GitHub's runner would read as a command to itself rather than as output.
const WORKFLOW_COMMAND = /^\s*(?:::[A-Za-z-]+|##\[)/;

const field = (header, start, length) => {
    const bytes = header.subarray(start, start + length);
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end === -1 ? length : end).toString("utf8");
};

const octal = (header, start, length) => {
    // Base-256 sizes are for entries past 8 GiB, which no log is.
    if ((header[start] & 0x80) !== 0) {
        throw new Error("a base-256 size field");
    }
    const digits = field(header, start, length).trim();
    if (!/^[0-7]*$/.test(digits)) {
        throw new Error(`a size field that is not octal (${JSON.stringify(digits)})`);
    }
    return digits === "" ? 0 : Number.parseInt(digits, 8);
};

const checksumOf = (header) => {
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) {
        sum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    return sum;
};

// PAX extended header records: `<length> <key>=<value>\n`. Only `path` matters here, and only for the next entry.
const paxPath = (data) => {
    let path;
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
        if (space === -1 || !Number.isInteger(length) || length <= 0 || offset + length > data.length) {
            throw new Error("a malformed PAX header");
        }
        const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        if (equals !== -1 && record.slice(0, equals) === "path") {
            path = record.slice(equals + 1);
        }
        offset += length;
    }
    return path;
};

// One header and the data after it, checked: `{ header, type, data, next }`, or undefined at the end-of-archive block.
const blockAt = (tar, offset) => {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
        return undefined;
    }
    if (octal(header, 148, 8) !== checksumOf(header)) {
        throw new Error(`a header with a bad checksum at byte ${offset}`);
    }
    const size = octal(header, 124, 12);
    const start = offset + BLOCK;
    if (start + size > tar.length) {
        throw new Error(`an entry that runs past the end of the archive at byte ${offset}`);
    }
    const type = String.fromCharCode(header[156] || 0x30);
    return { header, type, data: tar.subarray(start, start + size), next: start + Math.ceil(size / BLOCK) * BLOCK };
};

// The path a header names. POSIX ustar splits a long one into prefix + name; GNU's magic ("ustar  ") uses the prefix's
// bytes for other things, so only a POSIX header's prefix counts.
const headerName = (header) => {
    const name = field(header, 0, 100);
    const posix = field(header, 257, 6) === "ustar" && header[262] === 0;
    const prefix = posix ? field(header, 345, 155) : "";
    return prefix === "" ? name : `${prefix}/${name}`;
};

// An entry as this module keeps it, or a throw for every type a log-only entry has no use for.
const entryOf = (type, path, data) => {
    if (type === "0" || type === "7") {
        return { path, type: "file", data };
    }
    if (type === "5") {
        return { path: path.replace(/\/+$/, ""), type: "dir", data };
    }
    throw new Error(`an entry of type '${type}' (${path}), where only files and directories may be`);
};

/** The entries of an uncompressed tar, as `{ path, type: "file" | "dir", data }`. Throws on anything else: a link, a
 *  device, a global PAX header, a bad checksum, or an entry running past the end. */
export const readTar = (tar) => {
    const entries = [];
    // A GNU long-name ('L') or PAX ('x') header names the entry after it.
    let longName;
    const at = (offset) => (offset + BLOCK <= tar.length ? blockAt(tar, offset) : undefined);
    for (let block = at(0); block !== undefined; block = at(block.next)) {
        if (block.type === "L") {
            longName = field(block.data, 0, block.data.length);
        } else if (block.type === "x") {
            longName = paxPath(block.data) ?? longName;
        } else {
            entries.push(entryOf(block.type, longName ?? headerName(block.header), block.data));
            longName = undefined;
        }
    }
    return entries;
};

const writeOctal = (header, start, length, value) => {
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
};

// Splits a path for the ustar header: the name field holds 100 bytes, the prefix 155 more.
const ustarName = (path) => {
    if (Buffer.byteLength(path) <= 100) {
        return { name: path, prefix: "" };
    }
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
        const prefix = path.slice(0, slash);
        const name = path.slice(slash + 1);
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
            return { name, prefix };
        }
    }
    throw new Error(`a path too long for a ustar header (${path})`);
};

/** A POSIX ustar archive of regular files, every one 0644, owned by root and dated the epoch, as turbo writes its own. */
export const writeTar = (files) => {
    const blocks = [];
    for (const { path, data } of files) {
        const header = Buffer.alloc(BLOCK);
        const { name, prefix } = ustarName(path);
        header.write(name, 0, 100, "utf8");
        writeOctal(header, 100, 8, 0o644);
        writeOctal(header, 108, 8, 0);
        writeOctal(header, 116, 8, 0);
        writeOctal(header, 124, 12, data.length);
        writeOctal(header, 136, 12, 0);
        header[156] = 0x30;
        header.write("ustar\0", 257, 6, "ascii");
        header.write("00", 263, 2, "ascii");
        header.write(prefix, 345, 155, "utf8");
        header.write(`${checksumOf(header).toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
        blocks.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
    }
    blocks.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(blocks);
};

// Why a path is not one a log-only entry may hold, or undefined when it may.
const pathFault = (path) => {
    if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
        return `an entry at '${path}', which is not a plain relative path`;
    }
    if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        return `an entry at '${path}', which walks outside its own directory`;
    }
    return undefined;
};

/** The files of a log-only entry, or the reason it is not one. With `expect`, exactly that one log and nothing else. */
export const logOnlyFiles = (entries, expect) => {
    const files = [];
    for (const entry of entries) {
        const path = entry.path.replace(/^\.\//, "");
        const fault = pathFault(path);
        if (fault !== undefined) {
            return { ok: false, reason: fault };
        }
        if (entry.type === "dir") {
            // Turbo may list the `.turbo` directory itself; the canonical tar leaves it out, as turbo's own do.
            if (path === ".turbo" || path.endsWith("/.turbo")) {
                continue;
            }
            return { ok: false, reason: `a directory '${path}', where only task logs may be` };
        }
        if (!LOG_PATH.test(path)) {
            return { ok: false, reason: `a file '${path}', which is not a task log (only .turbo/turbo-<task>.log may be)` };
        }
        const line = entry.data
            .toString("utf8")
            .split(/\r\n|\r|\n/)
            .find((each) => WORKFLOW_COMMAND.test(each));
        if (line !== undefined) {
            return { ok: false, reason: `a log line CI would read as a workflow command (${JSON.stringify(line.trim().slice(0, 60))})` };
        }
        files.push({ path, data: entry.data });
    }
    if (files.length === 0) {
        return { ok: false, reason: "no task log at all" };
    }
    if (expect !== undefined && (files.length !== 1 || files[0].path !== expect)) {
        return { ok: false, reason: `${files.map((file) => file.path).join(", ")}, where only ${expect} belongs to this task` };
    }
    return { ok: true, files };
};

/** A sandbox upload as the entry the cache may keep: `{ ok: true, body, files }` with `body` a freshly written
 *  tar.zst of the logs alone, or `{ ok: false, reason }`. Never throws on bad input. */
export const canonicalArtifact = (compressed, { expect } = {}) => {
    let entries;
    try {
        entries = readTar(zstdDecompressSync(compressed, { maxOutputLength: MAX_TAR_BYTES }));
    } catch (error) {
        const message = error instanceof RangeError ? `it unpacks past ${MAX_TAR_BYTES} bytes` : String(error?.message ?? error);
        return { ok: false, reason: `not a readable turbo artifact: ${message}` };
    }
    const checked = logOnlyFiles(entries, expect);
    if (!checked.ok) {
        return checked;
    }
    return { ok: true, files: checked.files, body: zstdCompressSync(writeTar(checked.files)) };
};
