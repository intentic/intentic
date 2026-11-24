import { createHash, type Hash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { execBounded } from "@intentic/base/process";
import { agentHome } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    type CopyFile,
    type CopyFileResult,
    type CopyKind,
    FILE_COPY_CHUNK_BYTES,
    FILE_COPY_MAX_BYTES,
    FILE_COPY_TAR_TIMEOUT_MS,
} from "@intentic/sandbox-contract/schemas/device-files";
import { assertHoldsNoProtected, assertPath, assertScope } from "../../policy.js";

// A FILE OR A FOLDER COPIED TO OR FROM A PATH THE SANDBOX NAMES (schemas/device-files.ts, `devices copy`). 2026-11-17, the
// shinobi-society audit: agents moved tarballs and binaries with `docker cp` through run_command, which only worked where
// their own container ran on that machine. The same rules as files.ts, asked again on every chunk so a switch turned off
// or a folder taken off the list mid-copy stops it there: both ways stay inside the folders this device allows, and a
// copy onto it needs "Create and change files". A put is written beside where it lands and renamed into place once size
// and hash match, so nothing ever reads half a copy; a taken path needs `overwrite`, as write_file needs a revision.

// A copy nobody touched in this long was given up on (the sandbox restarted, the link dropped): its handle and bytes go.
const STALE_COPY_MS = 30 * 60 * 1000;

interface Put {
    readonly way: "put";
    readonly path: string;
    readonly part: string;
    readonly handle: FileHandle;
    readonly hash: Hash;
    readonly kind: CopyKind;
    readonly size: number;
    readonly overwrite: boolean;
    readonly executable: boolean;
    received: number;
    touched: number;
}

interface Get {
    readonly way: "get";
    readonly path: string;
    readonly handle: FileHandle;
    // The tar a folder was packed into, deleted with the copy; undefined for a file, read where it is.
    readonly packed: string | undefined;
    readonly hash: Hash;
    readonly size: number;
    served: number;
    touched: number;
}

const copies = new Map<string, Put | Get>();

const statOf = async (path: string): Promise<Stats | undefined> => await stat(path).catch(undefinedIfMissing);

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

const tooBig = (path: string, bytes: number): Error =>
    new Error(`"${path}" is ${megabytes(bytes)}, more than one copy carries (${megabytes(FILE_COPY_MAX_BYTES)}). Split it, or move it with a command on the computer.`);

const drop = async (id: string): Promise<void> => {
    const copy = copies.get(id);
    if (copy === undefined) {
        return;
    }
    copies.delete(id);
    // allow(silent-catch): a copy being thrown away has nothing left to say if its handle is already closed
    await copy.handle.close().catch(() => undefined);
    const leftover = copy.way === "put" ? copy.part : copy.packed;
    if (leftover !== undefined) {
        await rm(leftover, { force: true });
    }
};

const sweep = async (now: number): Promise<void> => {
    for (const [id, copy] of copies) {
        if (now - copy.touched > STALE_COPY_MS) {
            await drop(id);
        }
    }
};

const held = <W extends "put" | "get">(id: string, way: W): Extract<Put | Get, { way: W }> => {
    const copy = copies.get(id);
    if (copy?.way !== way) {
        throw new Error(`copy ${id} is not open here (the agent restarted mid-copy, or it sat idle too long): copy again`);
    }
    // SAFETY: `way` is the discriminant just compared.
    return copy as Extract<Put | Get, { way: W }>;
};

// The rules again, for a copy already open: refused now means the copy is thrown away, not left waiting.
const stillAllowed = async (id: string, copy: Put | Get, scopes: DeviceScopes): Promise<void> => {
    try {
        if (copy.way === "put") {
            assertScope(scopes, "write");
        }
        await assertPath(copy.path, scopes, copy.way === "put" ? "copy onto" : "copy from");
    } catch (error) {
        await drop(id);
        throw error;
    }
};

// Where a put lands: the path itself, or inside it when it is a folder that exists, as `cp` does.
const landing = async (op: Extract<CopyFile, { op: "put-open" }>, scopes: DeviceScopes): Promise<string> => {
    const asked = await assertPath(op.path, scopes, "copy onto");
    return (await statOf(asked))?.isDirectory() === true ? await assertPath(join(asked, op.name), scopes, "copy onto") : asked;
};

const refuseTaken = (op: Extract<CopyFile, { op: "put-open" }>, target: string, there: Stats): void => {
    if (!op.overwrite) {
        const folder = op.kind === "tar" ? " (into a folder: files of the same name are replaced, nothing else is removed)" : "";
        throw new Error(`"${target}" already exists: copy again with --overwrite to replace it${folder}.`);
    }
    if (op.kind === "file" && !there.isFile()) {
        throw new Error(`"${target}" is a folder or something else that is not a file, so a file cannot replace it.`);
    }
    if (op.kind === "tar" && !there.isDirectory()) {
        throw new Error(`"${target}" is not a folder, so a folder cannot be copied into it.`);
    }
    if (op.kind === "file" && (there.mode & 0o200) === 0) {
        throw new Error(`"${target}" is read-only, and copies leave it that way.`);
    }
};

const putOpen = async (op: Extract<CopyFile, { op: "put-open" }>, scopes: DeviceScopes, now: number): Promise<CopyFileResult> => {
    assertScope(scopes, "write");
    if (copies.has(op.copy)) {
        throw new Error(`copy ${op.copy} is already open here`);
    }
    const target = await landing(op, scopes);
    const there = await statOf(target);
    if (there !== undefined) {
        refuseTaken(op, target, there);
        // A folder copied onto one that exists merges into it, so whatever it carries lands in any protected place there.
        if (op.kind === "tar") {
            await assertHoldsNoProtected(target, op.path, scopes, "copy a folder onto");
        }
    }
    if (op.probe === true) {
        return { path: target };
    }
    await mkdir(dirname(target), { recursive: true });
    // Beside the target, so the rename into place stays on one drive; named so an owner who finds one knows whose it is.
    const part = join(dirname(target), `.${basename(target)}.${op.copy.slice(0, 8)}.intentic-part`);
    const handle = await open(part, "wx");
    const { kind, size, overwrite, executable } = op;
    copies.set(op.copy, { way: "put", path: target, part, handle, hash: createHash("sha256"), kind, size, overwrite, executable, received: 0, touched: now });
    return { path: target };
};

const putChunk = async (op: Extract<CopyFile, { op: "put-chunk" }>, scopes: DeviceScopes, now: number): Promise<CopyFileResult> => {
    const put = held(op.copy, "put");
    await stillAllowed(op.copy, put, scopes);
    const bytes = Buffer.from(op.data, "base64");
    if (op.offset !== put.received || put.received + bytes.byteLength > put.size) {
        await drop(op.copy);
        throw new Error(`a piece of ${bytes.byteLength} bytes at ${op.offset} arrived when ${put.received} of ${put.size} were held: copy again`);
    }
    await put.handle.write(bytes);
    put.hash.update(bytes);
    put.received += bytes.byteLength;
    put.touched = now;
    return { received: put.received };
};

const untar = async (archive: string, into: string): Promise<void> => {
    try {
        // bsdtar (Windows, macOS) and GNU tar both refuse `..` and strip a leading `/`, so every entry stays in `into`.
        await execBounded("tar", ["-xf", archive, "-C", into], { timeoutMs: FILE_COPY_TAR_TIMEOUT_MS, maxOutput: 64 * 1024 });
    } catch (error) {
        throw new Error(`could not unpack the folder: ${errorMessage(error)}`, { cause: error });
    }
};

// A new folder is unpacked aside and renamed into place whole; one that exists (with `overwrite`) takes the files in.
const placeFolder = async (put: Put, copy: string): Promise<void> => {
    if ((await statOf(put.path)) !== undefined) {
        await untar(put.part, put.path);
        return;
    }
    const staging = join(dirname(put.path), `.${basename(put.path)}.${copy.slice(0, 8)}.intentic-unpack`);
    await mkdir(staging);
    try {
        await untar(put.part, staging);
        await rename(staging, put.path);
    } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }
};

// A file replacing one keeps that one's mode; one the sandbox had executable is executable here too (POSIX only).
const placeFile = async (put: Put): Promise<void> => {
    const there = await statOf(put.path);
    if (there !== undefined && !put.overwrite) {
        throw new Error(`"${put.path}" appeared while it was being copied: copy again with --overwrite to replace it.`);
    }
    if (platform() !== "win32") {
        const mode = (there?.mode ?? (await stat(put.part)).mode) & 0o7777;
        await chmod(put.part, put.executable ? mode | ((mode & 0o444) >> 2) : mode);
    }
    await rename(put.part, put.path);
};

const putCommit = async (op: Extract<CopyFile, { op: "put-commit" }>, scopes: DeviceScopes): Promise<CopyFileResult> => {
    const put = held(op.copy, "put");
    await stillAllowed(op.copy, put, scopes);
    copies.delete(op.copy);
    try {
        await put.handle.close();
        const sha256 = put.hash.digest("hex");
        if (put.received !== put.size || sha256 !== op.sha256) {
            throw new Error(`what arrived (${put.received} bytes, sha256 ${sha256.slice(0, 12)}) is not what was sent (${put.size} bytes, ${op.sha256.slice(0, 12)})`);
        }
        await (put.kind === "file" ? placeFile(put) : placeFolder(put, op.copy));
        return { path: put.path };
    } finally {
        await rm(put.part, { force: true });
    }
};

// A folder's bytes before packing it, without following links (tar packs a link as a link); refused once past the cap.
const folderBytes = async (dir: string, path: string, total = 0): Promise<number> => {
    let sum = total;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const inside = join(dir, entry.name);
        sum = entry.isDirectory() ? await folderBytes(inside, path, sum) : sum + (entry.isFile() ? (await lstat(inside)).size : 0);
        if (sum > FILE_COPY_MAX_BYTES) {
            throw tooBig(path, sum);
        }
    }
    return sum;
};

const pack = async (target: string, path: string, copy: string): Promise<string> => {
    await folderBytes(target, path);
    const outgoing = join(agentHome("machine").dir, "outgoing");
    await mkdir(outgoing, { recursive: true });
    const archive = join(outgoing, `${copy}.tar`);
    try {
        await execBounded("tar", ["-cf", archive, "-C", target, "."], { timeoutMs: FILE_COPY_TAR_TIMEOUT_MS, maxOutput: 64 * 1024 });
    } catch (error) {
        await rm(archive, { force: true });
        throw new Error(`could not pack "${path}": ${errorMessage(error)}`, { cause: error });
    }
    return archive;
};

const getOpen = async (op: Extract<CopyFile, { op: "get-open" }>, scopes: DeviceScopes, now: number): Promise<CopyFileResult> => {
    if (copies.has(op.copy)) {
        throw new Error(`copy ${op.copy} is already open here`);
    }
    const target = await assertPath(op.path, scopes, "copy from");
    const info = await statOf(target);
    if (info === undefined) {
        throw new Error(`nothing at "${op.path}"`);
    }
    if (!info.isDirectory() && !info.isFile()) {
        throw new Error(`"${op.path}" is neither a file nor a folder, and only those are copied.`);
    }
    if (info.isFile() && info.size > FILE_COPY_MAX_BYTES) {
        throw tooBig(op.path, info.size);
    }
    // A folder is packed whole, so a protected place inside it would leave with it (../../protected-places.ts).
    if (info.isDirectory()) {
        await assertHoldsNoProtected(target, op.path, scopes, "copy from");
    }
    const packed = info.isDirectory() ? await pack(target, op.path, op.copy) : undefined;
    const size = packed === undefined ? info.size : (await stat(packed)).size;
    if (packed !== undefined && size > FILE_COPY_MAX_BYTES) {
        await rm(packed, { force: true });
        throw tooBig(op.path, size);
    }
    const handle = await open(packed ?? target, "r");
    copies.set(op.copy, { way: "get", path: target, handle, packed, hash: createHash("sha256"), size, served: 0, touched: now });
    const kind: CopyKind = packed === undefined ? "file" : "tar";
    const executable = kind === "file" && platform() !== "win32" && (info.mode & 0o111) !== 0;
    return { path: target, kind, size, name: basename(target), executable };
};

// The next piece, in order; the last one carries the hash of everything served. An empty file is one empty piece.
const getChunk = async (op: Extract<CopyFile, { op: "get-chunk" }>, scopes: DeviceScopes, now: number): Promise<CopyFileResult> => {
    const get = held(op.copy, "get");
    await stillAllowed(op.copy, get, scopes);
    if (op.offset !== get.served) {
        await drop(op.copy);
        throw new Error(`the piece at ${op.offset} was asked for when ${get.served} bytes were served: copy again`);
    }
    const want = Math.min(FILE_COPY_CHUNK_BYTES, get.size - get.served);
    const bytes = Buffer.alloc(want);
    const { bytesRead } = await get.handle.read(bytes, 0, want, get.served);
    if (bytesRead < want) {
        await drop(op.copy);
        throw new Error(`"${get.path}" got shorter while it was copied: copy it again once nothing is writing it.`);
    }
    get.hash.update(bytes);
    get.served += want;
    get.touched = now;
    const data = bytes.toString("base64");
    return get.served === get.size ? { data, sha256: get.hash.digest("hex") } : { data };
};

export const copyFile = async (op: CopyFile, scopes: DeviceScopes): Promise<CopyFileResult> => {
    const now = Date.now();
    await sweep(now);
    switch (op.op) {
        case "put-open":
            return await putOpen(op, scopes, now);
        case "put-chunk":
            return await putChunk(op, scopes, now);
        case "put-commit":
            return await putCommit(op, scopes);
        case "get-open":
            return await getOpen(op, scopes, now);
        case "get-chunk":
            return await getChunk(op, scopes, now);
        case "close":
            await drop(op.copy);
            return {};
    }
};
