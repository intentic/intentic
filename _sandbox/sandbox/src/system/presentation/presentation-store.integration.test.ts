import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePresentationStore } from "./presentation-store.js";

// What GET /system/presentation answers and `ic` reads through `docker cp` for a sandbox's name and logo: kept in the
// shape `ic` parses, written once per change, and never guessed from a file that is not one.

const logo = "data:image/webp;base64,AA==";

test("the copy is written in the shape the host reads, and read back as written", async () => {
    const root = await mkdtemp(join(tmpdir(), "presentation-"));
    const store = filePresentationStore(root);
    expect(await store.read()).toBeUndefined();

    const copy = { name: "radarsu-intentic", image: logo, digest: "02b432befa9d920e3ee21b6ef5d0a5e6", at: "2026-11-09T12:00:00.000Z" };
    expect(await store.keep(copy)).toEqual(copy);
    expect(await store.read()).toEqual(copy);
    expect(JSON.parse(await readFile(join(root, "presentation.json"), "utf8"))).toEqual(copy);
    // The host reads it as someone other than the daemon's user: nothing in it is a secret.
    expect((await stat(join(root, "presentation.json"))).mode & 0o777).toBe(0o644);
});

test("a copy that says the same is not written again, and keeps the time it was first heard", async () => {
    const root = await mkdtemp(join(tmpdir(), "presentation-"));
    const store = filePresentationStore(root);
    const first = { name: "workspace", digest: "d2e9f563419699d12f7be092973f94a2", at: "2026-11-09T12:00:00.000Z" };
    await store.keep(first);
    const before = (await stat(join(root, "presentation.json"))).mtimeMs;

    expect(await store.keep({ ...first, at: "2026-11-09T13:00:00.000Z" })).toEqual(first);
    expect((await stat(join(root, "presentation.json"))).mtimeMs).toBe(before);

    // A new logo is a change, whatever the name.
    const renamed = { name: "workspace", image: logo, digest: "8f0e", at: "2026-11-09T14:00:00.000Z" };
    expect(await store.keep(renamed)).toEqual(renamed);
    expect(await store.read()).toEqual(renamed);
});

test("forgetting removes the copy, and forgetting none is no fault", async () => {
    const root = await mkdtemp(join(tmpdir(), "presentation-"));
    const store = filePresentationStore(root);
    await store.forget();
    await store.keep({ name: "workspace", at: "2026-11-09T12:00:00.000Z" });
    await store.forget();
    expect(await store.read()).toBeUndefined();
});

test("a file that is not a copy is no copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "presentation-"));
    const store = filePresentationStore(root);
    await writeFile(join(root, "presentation.json"), `{"image":"${logo}"}`);
    expect(await store.read()).toBeUndefined();
    await writeFile(join(root, "presentation.json"), "not json");
    expect(await store.read()).toBeUndefined();
});
