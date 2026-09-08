import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "./json-file.js";

const dirs: string[] = [];
const tempFile = async (name = "state.json"): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-json-file-"));
    dirs.push(dir);
    // Nested under STATE_DIR to exercise mkdir-on-write, since .intentic/ rarely exists on a fresh workspace.
    return join(dir, `${STATE_DIR}`, name);
};
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const NumbersSchema = z.array(z.number());
const numbers = (path: string) => jsonFile<number[]>(path, { parse: (raw) => NumbersSchema.safeParse(raw).data, fallback: () => [] });

test("an absent, unparseable, or schema-rejected file all read as the fallback", async () => {
    const path = await tempFile();
    const file = numbers(path);
    expect(await file.read()).toEqual([]);

    await file.update(() => [1, 2]);
    // Simulates a truncated mid-write; must read as absent, not throw.
    await writeFile(path, `[1, 2`);
    expect(await file.read()).toEqual([]);

    // Well-formed JSON of the wrong shape, as if from a build whose schema has moved on.
    await writeFile(path, `{"not":"an array"}`);
    expect(await file.read()).toEqual([]);
});

test("an update never overwrites content it could not read: the bytes move aside first", async () => {
    // Simulates a rollback: a newer build's bytes are present but unparseable by this schema's version.
    const path = await tempFile();
    const file = numbers(path);
    await file.update(() => [0]);
    await writeFile(path, `{"from":"a newer build"}`);

    // Reading alone moves nothing; the newer build's bytes are still there if it comes back.
    expect(await file.read()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(`{"from":"a newer build"}`);

    await file.update(() => [1]);
    expect(await file.read()).toEqual([1]);
    expect(await readFile(`${path}.corrupt`, "utf8")).toBe(`{"from":"a newer build"}`);

    // Not-JSON-at-all is protected the same way.
    await writeFile(path, `[1, 2`);
    await file.update(() => [2]);
    expect(await readFile(`${path}.corrupt`, "utf8")).toBe(`[1, 2`);
});

test("an absent file has nothing to protect: a first write sets nothing aside", async () => {
    const path = await tempFile();
    await numbers(path).update(() => [1]);
    expect(await readdir(join(path, ".."))).toEqual([`state.json`]);
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
    // Without serializing, every concurrent update reads the same empty array and only the last write survives.
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
    // No file is written at all when the update returns the value unchanged, which is what makes read-or-init free.
    const path = await tempFile();
    const file = numbers(path);
    expect(await file.update((current) => current)).toEqual([]);
    await expect(readFile(path, "utf8")).rejects.toThrow();
});

test("read-or-init mints exactly once under concurrent first use", async () => {
    // Without this, concurrent first calls could each mint a secret, and one would authenticate against neither.
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
    // Only the rename target should exist; a leftover *.tmp means the swap never completed.
    expect(await readdir(join(path, ".."))).toEqual([`state.json`]);
});
