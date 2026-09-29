import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalModelSource } from "./local-model.js";
import { ensureWeights, verifyWeights, weightsTrusted } from "./local-model-weights.js";

// A pinned download against a real loopback server and a real cache directory: the digest is checked on the bytes that
// reached the disk, a resumed transfer included, and bytes that do not match are never left where a start would serve
// them. The Hugging Face half is the same stream; what is pinned there is the revision it asks for.

const WEIGHTS = Buffer.from("GGUF".repeat(4096));
const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

let server: Server;
let base = "";

beforeAll(async () => {
    // Honours a Range the way a model host does, so a resume appends rather than starts over.
    server = createServer((request, response) => {
        const from = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
        const body = WEIGHTS.subarray(from);
        response.writeHead(from > 0 ? 206 : 200, { "content-length": String(body.length) });
        response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers address() with an AddressInfo, never a pipe name or null.
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

const cacheDir = async (): Promise<string> => {
    const dir = join(await mkdtemp(join(tmpdir(), "weights-")), "models");
    await mkdir(dir, { recursive: true });
    return dir;
};

const exists = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

const pinned = (sha256: string): LocalModelSource => ({ url: `${base}/m.gguf`, file: "m.gguf", sha256 });

test("bytes that hash to the pin land in the cache and are trusted from then on without another read", async () => {
    const destination = join(await cacheDir(), "m.gguf");
    await ensureWeights(pinned(sha256Of(WEIGHTS)), destination);
    expect(await readFile(destination)).toEqual(WEIGHTS);
    expect(await weightsTrusted(pinned(sha256Of(WEIGHTS)), destination)).toBe(true);
    // Another pin is another file, whatever the name on disk says.
    expect(await weightsTrusted(pinned("0".repeat(64)), destination)).toBe(false);
});

test("bytes that do not hash to the pin are deleted and the download fails, saying so", async () => {
    const destination = join(await cacheDir(), "m.gguf");
    await expect(ensureWeights(pinned("0".repeat(64)), destination)).rejects.toThrow(
        "m.gguf did not match the checksum published for it, so it was deleted rather than served; press Update to download it again.",
    );
    expect(await exists(destination)).toBe(false);
    // The part goes too: resuming from bytes already known to be wrong would fail the same way forever.
    expect(await exists(`${destination}.part`)).toBe(false);
});

test("a resumed download is checked over the whole file, the part already on disk included", async () => {
    const destination = join(await cacheDir(), "m.gguf");
    await writeFile(`${destination}.part`, WEIGHTS.subarray(0, 5000));
    await ensureWeights(pinned(sha256Of(WEIGHTS)), destination);
    expect(await readFile(destination)).toEqual(WEIGHTS);
    expect(await weightsTrusted(pinned(sha256Of(WEIGHTS)), destination)).toBe(true);
});

// A file fetched before the pin existed is read once, before its first start.
test("weights already on disk are held to the pin once: kept and recorded when they match, deleted when they do not", async () => {
    const dir = await cacheDir();
    const matching = join(dir, "m.gguf");
    await writeFile(matching, WEIGHTS);
    expect(await weightsTrusted(pinned(sha256Of(WEIGHTS)), matching)).toBe(false);
    await verifyWeights(pinned(sha256Of(WEIGHTS)), matching);
    expect(await weightsTrusted(pinned(sha256Of(WEIGHTS)), matching)).toBe(true);

    const other = join(await cacheDir(), "m.gguf");
    await writeFile(other, Buffer.from("not these weights"));
    await expect(verifyWeights(pinned(sha256Of(WEIGHTS)), other)).rejects.toThrow("did not match the checksum");
    expect(await exists(other)).toBe(false);
});

// A verdict is about bytes, not a name: a same-named file from somewhere else must be read again.
test("a verified file replaced under the same name is no longer trusted", async () => {
    const destination = join(await cacheDir(), "m.gguf");
    await ensureWeights(pinned(sha256Of(WEIGHTS)), destination);
    await writeFile(destination, Buffer.from("a custom GGUF that happens to share the name"));
    expect(await weightsTrusted(pinned(sha256Of(WEIGHTS)), destination)).toBe(false);
});

test("an unpinned source has nothing to be held to and is served as fetched", async () => {
    const destination = join(await cacheDir(), "m.gguf");
    const unpinned: LocalModelSource = { url: `${base}/m.gguf`, file: "m.gguf" };
    await ensureWeights(unpinned, destination);
    expect(await weightsTrusted(unpinned, destination)).toBe(true);
    await verifyWeights(unpinned, destination);
    expect(await readFile(destination)).toEqual(WEIGHTS);
});
