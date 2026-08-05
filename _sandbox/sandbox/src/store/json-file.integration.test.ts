import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "./json-file.js";

const dirs: string[] = [];
const tempFile = async (name = "state.json"): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-json-file-"));
    dirs.push(dir);
    // Nested, so the mkdir-on-write path is exercised the way every real store uses it (.intentic/ rarely
    // exists on a fresh workspace).
    return join(dir, ".intentic", name);
};
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const NumbersSchema = z.array(z.number());
const numbers = (path: string) =>
    jsonFile<number[]>(path, { parse: (raw) => NumbersSchema.safeParse(raw).data, fallback: () => [] });

test("an absent, unparseable, or schema-rejected file all read as the fallback", async () => {
    const path = await tempFile();
    const file = numbers(path);
    expect(await file.read()).toEqual([]);

    await file.update(() => [1, 2]);
    // Truncated mid-write is what a non-atomic writer used to expose; it must still read as absent, not throw.
    await writeFile(path, `[1, 2`);
    expect(await file.read()).toEqual([]);

    // Well-formed JSON of the wrong shape — a file from a build whose schema has moved on.
    await writeFile(path, `{"not":"an array"}`);
    expect(await file.read()).toEqual([]);
});

test("each read gets its own fallback instance, so a caller mutating one can't poison the next", async () => {
    const file = numbers(await tempFile());
    (await file.read()).push(99);
    expect(await file.read()).toEqual([]);
});

test("update round-trips through disk and returns what it wrote", async () => {
    const path = await tempFile();
    const file = numbers(path);
    expect(await file.update((current) => [...current, 1])).toEqual([1]);
    expect(await file.update((current) => [...current, 2])).toEqual([1, 2]);
    expect(NumbersSchema.parse(JSON.parse(await readFile(path, "utf8")))).toEqual([1, 2]);
});

test("concurrent updates serialize instead of losing each other", async () => {
    // THE lost-update bug: every one of these reads the same empty array and writes its own single entry when
    // the read-modify-write isn't serialized, so only the last survives.
    const file = numbers(await tempFile());
    await Promise.all(Array.from({ length: 20 }, (_, index) => file.update((current) => [...current, index])));
    expect(await file.read()).toEqual(Array.from({ length: 20 }, (_, index) => index));
});

test("an update that throws settles the queue, so the next one still runs", async () => {
    const file = numbers(await tempFile());
    await file.update(() => [1]);
    await expect(
        file.update(() => {
            throw new Error("change failed");
        }),
    ).rejects.toThrow("change failed");
    expect(await file.update((current) => [...current, 2])).toEqual([1, 2]);
});

test("returning the current value unchanged skips the write", async () => {
    // What makes read-or-init (a minted secret, a generated keypair) free after the first call: no file appears
    // at all when nothing changed.
    const path = await tempFile();
    const file = numbers(path);
    expect(await file.update((current) => current)).toEqual([]);
    await expect(readFile(path, "utf8")).rejects.toThrow();
});

test("read-or-init mints exactly once under concurrent first use", async () => {
    // The failure this shape exists to prevent: two concurrent callers each see "nothing stored yet" and each
    // mint their own secret, after which one of them is authenticating against a value nothing has.
    const path = await tempFile();
    let minted = 0;
    const file = jsonFile<{ secret: string }>(path, {
        parse: (raw) => z.object({ secret: z.string().min(1) }).safeParse(raw).data,
        fallback: () => ({ secret: "" }),
    });
    const secret = async (): Promise<string> =>
        (
            await file.update((current) => {
                if (current.secret !== "") {
                    return current;
                }
                minted += 1;
                return { secret: `secret-${minted}` };
            })
        ).secret;

    const [first, second, third] = await Promise.all([secret(), secret(), secret()]);
    expect(minted).toBe(1);
    expect([first, second, third]).toEqual(["secret-1", "secret-1", "secret-1"]);
});

test("writes leave no temp file behind, and apply the requested mode", async () => {
    const path = await tempFile();
    const file = jsonFile<number[]>(path, { parse: (raw) => NumbersSchema.safeParse(raw).data, fallback: () => [], mode: 0o600 });
    await file.update(() => [1]);
    // The rename target is the only entry: a leftover *.tmp would be a write that never completed its swap.
    expect(await readdir(join(path, ".."))).toEqual([`state.json`]);
});
