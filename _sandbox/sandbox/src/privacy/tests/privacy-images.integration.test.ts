import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePrivacyImages } from "../privacy-images.js";

// The owner's peek at what a provider saw in place of a picture: each pair kept once, owner-only on disk, the oldest
// dropped past the cap, and an id that is not one never read as a path.

const before = { mediaType: "image/png", data: Buffer.from("before").toString("base64") };
const after = { mediaType: "image/png", data: Buffer.from("after").toString("base64") };
const id = (n: number): string => `image-id-${String(n).padStart(8, "0")}`;

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "privacy-images-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("a pair is kept once, readable by its id, and only by its owner on disk", async () => {
    const archive = filePrivacyImages(join(dir, "kept"), () => new Date("2026-10-11T10:00:00.000Z"));
    await archive.keep(id(1), before, after);
    await archive.keep(id(1), after, before);
    expect(await archive.read(id(1))).toEqual({ at: "2026-10-11T10:00:00.000Z", before, after });
    expect((await stat(join(dir, "kept", `${id(1)}.json`))).mode & 0o777).toBe(0o600);
    expect(await archive.read(id(2))).toBeUndefined();
});

test("past the cap the oldest pair goes", async () => {
    const archive = filePrivacyImages(dir, undefined, 2);
    for (const n of [1, 2, 3]) {
        await archive.keep(id(n), before, after);
        // Distinct write times, so which is oldest is never a tie.
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect((await readdir(dir)).toSorted()).toEqual([`${id(2)}.json`, `${id(3)}.json`]);
    expect(await archive.read(id(1))).toBeUndefined();
});

test("an id that is not one is neither kept nor read", async () => {
    const archive = filePrivacyImages(dir);
    await archive.keep("../escape-the-archive", before, after);
    expect(await readdir(dir)).toEqual([]);
    expect(await archive.read("../../etc/passwd")).toBeUndefined();
});
