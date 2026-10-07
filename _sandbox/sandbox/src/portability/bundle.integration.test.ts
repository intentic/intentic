import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract, pack, type Pack } from "tar-stream";
import { packFile } from "./bundle.js";

// An export runs while agents keep writing: the money ledger, a transcript, a git object. A file that grows under the
// walk is packed as the prefix it had when it was opened, never failing the export for having grown.

let dir = "";

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bundle-pack-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const drain = async (packer: Pack): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of packer) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
};

// Every file entry of a finished tar, by name.
const entriesOf = async (tar: Buffer): Promise<Map<string, Buffer>> => {
    const reader = extract();
    reader.end(tar);
    const entries = new Map<string, Buffer>();
    for await (const entry of reader) {
        const chunks: Buffer[] = [];
        for await (const chunk of entry) {
            chunks.push(chunk as Buffer);
        }
        entries.set(entry.header.name, Buffer.concat(chunks));
    }
    return entries;
};

test("a file that grows while it is packed lands as the prefix it had when it was opened", async () => {
    const path = join(dir, "usage.jsonl");
    // Far more than the buffers between the file and the tar hold, so its read is still under way when it grows.
    const opened = Buffer.alloc(1024 * 1024, "a");
    await writeFile(path, opened);
    const packer = pack();
    const packed = packFile(packer, "history/usage.jsonl", path);
    // The entry's header is out once the file was opened and measured; nothing reads the tar yet, so its bytes wait.
    await new Promise<void>((resolve) => packer.once("readable", () => resolve()));
    await appendFile(path, "b".repeat(64 * 1024));

    const tar = drain(packer);
    expect(await packed).toBe(opened.byteLength);
    packer.finalize();
    expect((await entriesOf(await tar)).get("history/usage.jsonl")).toEqual(opened);
});

test("an empty file packs as an empty entry, and one gone before it was opened packs nothing", async () => {
    await writeFile(join(dir, "empty"), "");
    const packer = pack();
    const tar = drain(packer);
    expect(await packFile(packer, "empty", join(dir, "empty"))).toBe(0);
    expect(await packFile(packer, "gone", join(dir, "gone"))).toBeUndefined();
    packer.finalize();
    expect([...(await entriesOf(await tar))]).toEqual([["empty", Buffer.alloc(0)]]);
});
