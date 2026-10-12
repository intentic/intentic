import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrMintKey } from "./minted-key.js";

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const keyPath = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-minted-key-"));
    dirs.push(dir);
    return join(dir, "nested", "signing.key");
};

test("a first load mints a root-only key and every later load returns the same bytes", async () => {
    const path = await keyPath();
    const first = await loadOrMintKey(path);
    expect(first.length).toBe(32);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadOrMintKey(path)).toEqual(first);
    expect((await readFile(path)).toString("hex")).toBe(first.toString("hex"));
});

test("concurrent first loads share one key", async () => {
    const path = await keyPath();
    const keys = await Promise.all([loadOrMintKey(path), loadOrMintKey(path), loadOrMintKey(path)]);
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
});

test("a base64url key is read as text and minted as text", async () => {
    const path = await keyPath();
    const key = await loadOrMintKey(path, { encoding: "base64url" });
    expect(Buffer.from((await readFile(path, "utf8")).trim(), "base64url").toString("hex")).toBe(key.toString("hex"));
});

test("a stored key keeps its bytes, and a mode an older build left open is closed", async () => {
    const path = await keyPath();
    const key = await loadOrMintKey(path);
    await chmod(path, 0o644);
    expect(await loadOrMintKey(path)).toEqual(key);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("content too short to be a key is replaced whole, and what is on the disk is what comes back", async () => {
    const path = await keyPath();
    await loadOrMintKey(path);
    await writeFile(path, Buffer.alloc(5));
    const replaced = await loadOrMintKey(path);
    expect(replaced.length).toBe(32);
    expect((await readFile(path)).toString("hex")).toBe(replaced.toString("hex"));
});
