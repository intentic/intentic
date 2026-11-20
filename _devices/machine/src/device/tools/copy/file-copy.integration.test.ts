import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { type CopyKind, FILE_COPY_CHUNK_BYTES } from "@intentic/sandbox-contract/schemas/device-files";
import { ScopeError } from "../../policy.js";
import { copyFile } from "./file-copy.js";

// `devices copy` as the machine sees it, on a real temp tree with one allowed root: what the daemon would send, chunk by
// chunk, and what lands. A sibling outside the root is where the refusals try to reach.

const base = realpathSync(mkdtempSync(join(tmpdir(), "device-copy-")));
const root = join(base, "allowed");
const outside = join(base, "outside");
mkdirSync(root);
mkdirSync(outside);

const grant: DeviceScopes = { shell: "off", write: "on", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off", remoteView: "off", remoteControl: "off", remoteTerminal: "off", roots: root };
const readOnly: DeviceScopes = { ...grant, write: "off" };

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

let named = 0;
const fresh = (): string => {
    named += 1;
    const dir = join(root, `case-${named}`);
    mkdirSync(dir);
    return dir;
};

const id = (): string => randomBytes(16).toString("hex");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface PutAsk {
    readonly path: string;
    readonly bytes: Buffer;
    readonly name?: string;
    readonly kind?: CopyKind;
    readonly overwrite?: boolean;
    readonly executable?: boolean;
}

// One copy onto the machine, as the daemon drives it: open, every chunk in order, commit.
const put = async (ask: PutAsk, scopes: DeviceScopes = grant): Promise<string | undefined> => {
    const copy = id();
    const { bytes } = ask;
    await copyFile(
        { op: "put-open", copy, path: ask.path, name: ask.name ?? "x", kind: ask.kind ?? "file", size: bytes.byteLength, overwrite: ask.overwrite ?? false, executable: ask.executable ?? false },
        scopes,
    );
    for (let offset = 0; offset < bytes.byteLength; offset += FILE_COPY_CHUNK_BYTES) {
        await copyFile({ op: "put-chunk", copy, offset, data: bytes.subarray(offset, offset + FILE_COPY_CHUNK_BYTES).toString("base64") }, scopes);
    }
    return (await copyFile({ op: "put-commit", copy, sha256: sha(bytes) }, scopes)).path;
};

interface Got {
    readonly kind: CopyKind | undefined;
    readonly name: string | undefined;
    readonly executable: boolean | undefined;
    readonly bytes: Buffer;
}

// One copy off the machine: what get-open said, and the bytes its chunks carried, checked against the last chunk's hash.
const get = async (path: string, scopes: DeviceScopes = grant): Promise<Got> => {
    const copy = id();
    const opened = await copyFile({ op: "get-open", copy, path }, scopes);
    const pieces: Buffer[] = [];
    let offset = 0;
    let last: string | undefined;
    do {
        const chunk = await copyFile({ op: "get-chunk", copy, offset }, scopes);
        const piece = Buffer.from(chunk.data ?? "", "base64");
        pieces.push(piece);
        offset += piece.byteLength;
        last = chunk.sha256;
    } while (offset < (opened.size ?? 0));
    await copyFile({ op: "close", copy }, scopes);
    const bytes = Buffer.concat(pieces);
    expect(last).toBe(sha(bytes));
    return { kind: opened.kind, name: opened.name, executable: opened.executable, bytes };
};

// Bytes no text tool would carry: NULs and every other value, over more than two chunks.
const binary = randomBytes(FILE_COPY_CHUNK_BYTES * 2 + 4321);

test("a binary of several chunks lands at the path whole, and nothing half-written is left beside it", async () => {
    const dir = fresh();
    const target = join(dir, "sub", "tool.bin");
    expect(await put({ path: target, bytes: binary })).toBe(target);
    expect(readFileSync(target).equals(binary)).toBe(true);
    expect(readdirSync(join(dir, "sub"))).toEqual(["tool.bin"]);
});

test("a copy into a folder that exists lands under the source's own name, executable when it was in the sandbox", async () => {
    const dir = fresh();
    const landed = await put({ path: dir, name: "server", bytes: Buffer.from("#!/bin/sh\necho hi\n"), executable: true });
    expect(landed).toBe(join(dir, "server"));
    if (process.platform !== "win32") {
        expect(statSync(join(dir, "server")).mode & 0o100).toBe(0o100);
    }
});

test("a path that is taken is refused without overwrite, and replaced with it, keeping the old file's mode", async () => {
    const dir = fresh();
    const target = join(dir, "config.bin");
    writeFileSync(target, "old");
    chmodSync(target, 0o640);
    await expect(put({ path: target, bytes: Buffer.from("new") })).rejects.toThrow("already exists: copy again with --overwrite");
    expect(readFileSync(target, "utf8")).toBe("old");
    await put({ path: target, bytes: Buffer.from("new"), overwrite: true });
    expect(readFileSync(target, "utf8")).toBe("new");
    if (process.platform !== "win32") {
        expect(statSync(target).mode & 0o777).toBe(0o640);
    }
});

test("with Create and change files off a copy onto the machine is refused, and a copy off it still reads", async () => {
    const dir = fresh();
    const target = join(dir, "blocked.bin");
    await expect(put({ path: target, bytes: binary }, readOnly)).rejects.toBeInstanceOf(ScopeError);
    expect(existsSync(target)).toBe(false);
    writeFileSync(join(dir, "readable.bin"), binary);
    expect((await get(join(dir, "readable.bin"), readOnly)).bytes.equals(binary)).toBe(true);
});

test("a switch turned off mid-copy stops it at the next chunk, and its part file goes with it", async () => {
    const dir = fresh();
    const copy = id();
    await copyFile({ op: "put-open", copy, path: join(dir, "big.bin"), name: "big.bin", kind: "file", size: binary.byteLength, overwrite: false, executable: false }, grant);
    await copyFile({ op: "put-chunk", copy, offset: 0, data: binary.subarray(0, FILE_COPY_CHUNK_BYTES).toString("base64") }, grant);
    await expect(
        copyFile({ op: "put-chunk", copy, offset: FILE_COPY_CHUNK_BYTES, data: binary.subarray(FILE_COPY_CHUNK_BYTES, FILE_COPY_CHUNK_BYTES * 2).toString("base64") }, readOnly),
    ).rejects.toBeInstanceOf(ScopeError);
    expect(readdirSync(dir)).toEqual([]);
    await expect(copyFile({ op: "put-commit", copy, sha256: sha(binary) }, grant)).rejects.toThrow("is not open here");
});

test("outside the allowed folders both ways are refused", async () => {
    writeFileSync(join(outside, "secret.bin"), "no");
    await expect(put({ path: join(outside, "planted.bin"), bytes: Buffer.from("x") })).rejects.toBeInstanceOf(ScopeError);
    await expect(get(join(outside, "secret.bin"))).rejects.toBeInstanceOf(ScopeError);
    expect(existsSync(join(outside, "planted.bin"))).toBe(false);
});

test("bytes that are not what was announced are thrown away, and a gap is refused", async () => {
    const dir = fresh();
    const copy = id();
    const bytes = Buffer.from("abc");
    await copyFile({ op: "put-open", copy, path: join(dir, "bad.bin"), name: "bad.bin", kind: "file", size: 3, overwrite: false, executable: false }, grant);
    await copyFile({ op: "put-chunk", copy, offset: 0, data: bytes.toString("base64") }, grant);
    await expect(copyFile({ op: "put-commit", copy, sha256: "f".repeat(64) }, grant)).rejects.toThrow("is not what was sent");
    const gapped = id();
    await copyFile({ op: "put-open", copy: gapped, path: join(dir, "gap.bin"), name: "gap.bin", kind: "file", size: 10, overwrite: false, executable: false }, grant);
    await expect(copyFile({ op: "put-chunk", copy: gapped, offset: 5, data: bytes.toString("base64") }, grant)).rejects.toThrow("copy again");
    expect(readdirSync(dir)).toEqual([]);
});

test("a file comes off the machine in chunks with its name, and an empty one as one empty piece", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "dump.bin"), binary);
    const read = await get(join(dir, "dump.bin"));
    expect(read).toMatchObject({ kind: "file", name: "dump.bin" });
    expect(read.bytes.equals(binary)).toBe(true);
    writeFileSync(join(dir, "empty"), "");
    expect((await get(join(dir, "empty"))).bytes.byteLength).toBe(0);
});

test("a folder goes off as one tar and back on as a folder, merging into one that exists only with overwrite", async () => {
    const dir = fresh();
    const source = join(dir, "site");
    mkdirSync(join(source, "assets"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(source, "assets", "app.bin"), binary);
    const read = await get(source);
    expect(read).toMatchObject({ kind: "tar", name: "site" });
    const copied = join(dir, "copied");
    expect(await put({ path: copied, name: "site", kind: "tar", bytes: read.bytes })).toBe(copied);
    expect(readFileSync(join(copied, "assets", "app.bin")).equals(binary)).toBe(true);
    expect(readdirSync(dir).toSorted()).toEqual(["copied", "site"]);
    writeFileSync(join(copied, "kept.txt"), "mine");
    writeFileSync(join(copied, "index.html"), "changed");
    // `copied` is a folder that exists, so the same copy lands inside it, as `cp -r` would.
    expect(await put({ path: copied, name: "site", kind: "tar", bytes: read.bytes })).toBe(join(copied, "site"));
    await expect(put({ path: dir, name: "copied", kind: "tar", bytes: read.bytes })).rejects.toThrow("already exists");
    await put({ path: dir, name: "copied", kind: "tar", bytes: read.bytes, overwrite: true });
    expect(readFileSync(join(copied, "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(readFileSync(join(copied, "kept.txt"), "utf8")).toBe("mine");
});
