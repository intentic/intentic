import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";
import { rename, retype } from "./evolution/conversions.js";
import { defineDocument, type DocumentSpec } from "./evolution/documents.js";
import { type JsonFile, jsonEntries, jsonFile, ManifestUnreadableError, writeJsonFile } from "./json-file.js";
import { clearNewestRun, recordNewestRun } from "./newest-run.js";

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

    // Not-JSON-at-all is protected the same way, and a second episode never replaces the first one's copy.
    await writeFile(path, `[1, 2`);
    await file.update(() => [2]);
    expect(await readFile(`${path}.corrupt`, "utf8")).toBe(`{"from":"a newer build"}`);
    const stamped = (await readdir(join(path, ".."))).filter((name) => name.startsWith("state.json.corrupt."));
    expect(stamped).toHaveLength(1);
    expect(await readFile(join(path, "..", stamped[0]!), "utf8")).toBe(`[1, 2`);
});

test("state says whether the fallback stands in for content that could not be read", async () => {
    const path = await tempFile();
    const file = numbers(path);
    expect(await file.state()).toEqual({ value: [], unreadable: false });
    await file.update(() => [0]);
    expect(await file.state()).toEqual({ value: [0], unreadable: false });
    await writeFile(path, `{"not":"an array"}`);
    expect(await file.state()).toEqual({ value: [], unreadable: true, detail: "the file does not match what this build expects" });
});

test("under onUnreadable refuse, an update over unreadable content throws and moves nothing", async () => {
    const path = await tempFile();
    const file = jsonFile<number[]>(path, { parse: (raw) => NumbersSchema.safeParse(raw).data, fallback: () => [], onUnreadable: "refuse" });
    await file.update(() => [0]);
    await writeFile(path, `[1, 2`);
    await expect(file.update(() => [1])).rejects.toBeInstanceOf(ManifestUnreadableError);
    expect(await readFile(path, "utf8")).toBe(`[1, 2`);
    expect(await readdir(join(path, ".."))).toEqual([`state.json`]);
    // The refusal settles the queue: once the content reads again, the next update runs.
    await writeFile(path, `[3]`);
    expect(await file.update((current) => [...current, 4])).toEqual([3, 4]);
});

test("a path that exists but cannot be read is unreadable, not absent, so an update sets it aside", async () => {
    const path = await tempFile();
    const file = numbers(path);
    // A directory where the file belongs: readFile fails with EISDIR, which is not "nothing written yet".
    await mkdir(join(path, "inside"), { recursive: true });
    expect(await file.state()).toEqual({ value: [], unreadable: true, detail: "the file could not be read (EISDIR)" });
    await file.update(() => [1]);
    expect(await file.read()).toEqual([1]);
    expect(await readdir(`${path}.corrupt`)).toEqual([`inside`]);
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

test("updates through separate handles on one file serialize against each other", async () => {
    // Stores that build a handle per call share nothing but the path, spelled here once absolute and once relative.
    const path = await tempFile();
    const handles: JsonFile<number[]>[] = [numbers(path), numbers(relative(process.cwd(), path))];
    await Promise.all(Array.from({ length: 20 }, (_, index) => handles[index % 2]?.update((current) => [...current, index])));
    expect(await numbers(path).read()).toEqual(Array.from({ length: 20 }, (_, index) => index));
});

test("concurrent writes to one file each land whole: the file is one of them, never a splice", async () => {
    const path = await tempFile();
    // Large enough to take several write calls each, so writes sharing one temp file would interleave inside it.
    const values = Array.from({ length: 8 }, (_, writer) => ({ writer, payload: String(writer).repeat(512 * 1024) }));
    await Promise.all(values.map((value) => writeJsonFile(path, value)));
    expect(values).toContainEqual(JSON.parse(await readFile(path, "utf8")));
    expect(await readdir(join(path, ".."))).toEqual([`state.json`]);
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
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

// Writes content where a test file lives; tempFile leaves the state dir uncreated on purpose.
const seed = async (path: string, value: unknown): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value));
};

describe("evolution", () => {
    const Settings = z.object({ theme: z.string().default("light"), agent: z.object({ model: z.string() }).optional() });
    type Settings = z.infer<typeof Settings>;
    const settingsFile = (path: string, document?: DocumentSpec): JsonFile<Settings> =>
        jsonFile<Settings>(path, {
            parse: (raw) => Settings.safeParse(raw).data,
            fallback: () => Settings.parse({}),
            ...(document === undefined ? {} : { document }),
        });

    afterEach(() => {
        clearNewestRun();
    });

    test("a save by this build keeps the keys a newer build wrote, at any depth", async () => {
        const path = await tempFile();
        await seed(path, { theme: "dark", agent: { model: "m", effort: "high" }, pins: [1] });
        await settingsFile(path).update((current) => ({ ...current, theme: "light" }));
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "light", agent: { model: "m", effort: "high" }, pins: [1] });
    });

    test("a document's conversions run on every read, and the next save writes today's shape", async () => {
        const path = await tempFile();
        const document = defineDocument({ path: "evolution/settings.json", schema: Settings, history: [rename("colour", "theme")] });
        await seed(path, { colour: "dark" });
        const file = settingsFile(path, document);
        expect(await file.read()).toEqual({ theme: "dark" });
        // Reading converts in memory only; the bytes change on the next save.
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ colour: "dark" });
        await file.update((current) => ({ ...current, agent: { model: "m" } }));
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark", agent: { model: "m" } });
    });

    test("a conversion that throws leaves the file unreadable, never half converted", async () => {
        const path = await tempFile();
        const failing = retype(
            "theme",
            (value): value is number => typeof value === "number",
            () => {
                throw new Error("no such theme");
            },
            "converts numbered themes",
        );
        await seed(path, { theme: 3 });
        expect(await settingsFile(path, defineDocument({ path: "evolution/failing.json", schema: Settings, history: [failing] })).state()).toEqual({
            value: { theme: "light" },
            unreadable: true,
            detail: 'a conversion to this build\'s shape failed (conversion "converts numbered themes" failed: no such theme)',
        });
    });

    test("after a newer build ran here, content this build cannot read is refused rather than set aside", async () => {
        const path = await tempFile();
        await recordNewestRun(join(path, "..", ".."), "9.0.0");
        await seed(path, { theme: { from: "a newer build" } });
        await expect(settingsFile(path).update(() => ({ theme: "light" }))).rejects.toThrow(
            "state.json could not be read by this build (the file does not match what this build expects; a newer intentic wrote it)",
        );
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: { from: "a newer build" } });
        expect(await readdir(join(path, ".."))).toEqual(["local", "state.json"]);
    });
});

describe("jsonEntries", () => {
    const Entry = z.object({ id: z.string(), kind: z.enum(["cron", "webhook"]) });
    type Entry = z.infer<typeof Entry>;
    const entries = (path: string): JsonFile<Entry[]> => jsonEntries<Entry>(path, { entry: (raw) => Entry.safeParse(raw).data });

    test("one entry this build cannot read no longer empties the file, and survives the next save", async () => {
        const path = await tempFile();
        await seed(path, [
            { id: "a", kind: "cron" },
            { id: "b", kind: "from-the-future" },
            { id: "c", kind: "webhook" },
        ]);
        const file = entries(path);
        expect(await file.read()).toEqual([
            { id: "a", kind: "cron" },
            { id: "c", kind: "webhook" },
        ]);
        await file.update((current) => current.filter((entry) => entry.id !== "c"));
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
            { id: "a", kind: "cron" },
            { id: "b", kind: "from-the-future" },
        ]);
    });

    test("an entry the save replaces by id takes the unreadable one's place", async () => {
        const path = await tempFile();
        await seed(path, [{ id: "b", kind: "from-the-future" }]);
        await entries(path).update((current) => [...current, { id: "b", kind: "cron" }]);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ id: "b", kind: "cron" }]);
    });

    test("a file that is not an array at all is still unreadable", async () => {
        const path = await tempFile();
        await seed(path, { id: "a" });
        expect(await entries(path).state()).toEqual({ value: [], unreadable: true, detail: "the file does not match what this build expects" });
    });
});
