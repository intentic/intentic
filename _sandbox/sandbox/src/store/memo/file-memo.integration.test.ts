import * as fsp from "node:fs/promises";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { confirmed, memoClock, memoOf, RACY_MS, type Sighting, standing } from "./file-memo.js";
import { jsonEntries, jsonFile } from "../json-file.js";
import { clearManifestProblems, recordedProblems, recordManifestProblems } from "../manifest/manifest-problems.js";

// The clock as the memo module loaded it; a test moves the memo's clock past the racy window from it.
const realNow = Date.now;
const dirs: string[] = [];
const tempFile = async (name = "state.json"): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-file-memo-"));
    dirs.push(dir);
    return join(dir, name);
};
// Every read from here on looks at the file long after its last change, so a memo made by one settles at once.
const lookLate = (): void => {
    memoClock.now = () => realNow() + 10 * RACY_MS;
};
afterEach(async () => {
    memoClock.now = realNow;
    jest.restoreAllMocks();
    clearManifestProblems();
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const Numbers = z.array(z.number());
// A store whose every parse is counted, and which reports a problem whenever the list holds a zero.
const counted = (path: string) => {
    const parses = { count: 0 };
    const file = jsonFile<number[]>(path, {
        parse: (raw, report) => {
            parses.count += 1;
            const parsed = Numbers.safeParse(raw).data;
            if (parsed?.includes(0) === true) {
                report({ kind: "unknownKey", detail: "a zero" });
            }
            return parsed;
        },
        fallback: () => [],
    });
    return { file, parses };
};
const readsOf = (spy: { mock: { calls: unknown[][] } }, path: string): number => spy.mock.calls.filter(([target]) => target === path).length;

describe("the memo of a jsonFile", () => {
    test("an unchanged file is read and parsed once, and every read still records its problems", async () => {
        const path = await tempFile();
        await writeFile(path, "[0, 1]");
        lookLate();
        const { file, parses } = counted(path);
        const reads = jest.spyOn(fsp, "readFile");
        expect(await file.read()).toEqual([0, 1]);
        recordManifestProblems(path, []);
        expect(await file.read()).toEqual([0, 1]);
        expect(await file.state()).toEqual({ value: [0, 1], unreadable: false });
        expect(parses.count).toBe(1);
        expect(readsOf(reads, path)).toBe(1);
        // Cleared by hand above, and put back by a read the memo answered.
        expect(recordedProblems(path)).toEqual([{ kind: "unknownKey", detail: "a zero" }]);
    });

    test("a rewrite from outside the process is seen, even one that keeps the size and restores the mtime", async () => {
        const path = await tempFile();
        await writeFile(path, "[1, 2]");
        const before = await stat(path);
        lookLate();
        const { file } = counted(path);
        expect(await file.read()).toEqual([1, 2]);
        // In place, same length, the old mtime put back: only the change time can tell, and it is in the identity.
        await writeFile(path, "[3, 4]");
        await utimes(path, before.atime, before.mtime);
        expect(await file.read()).toEqual([3, 4]);
        await rm(path);
        expect(await file.read()).toEqual([]);
    });

    test("inside the racy window a read compares the bytes: the parse is skipped only while they match", async () => {
        const path = await tempFile();
        await writeFile(path, "[1]");
        // The real clock: the file changed just now, so the memo cannot vouch for it alone.
        const { file, parses } = counted(path);
        const reads = jest.spyOn(fsp, "readFile");
        expect(await file.read()).toEqual([1]);
        expect(await file.read()).toEqual([1]);
        expect(readsOf(reads, path)).toBe(2);
        expect(parses.count).toBe(1);
    });

    test("its own write is held, so the next read neither reads nor parses; another handle's write is still seen", async () => {
        const path = await tempFile();
        lookLate();
        const { file, parses } = counted(path);
        const other = counted(path).file;
        await file.update(() => [5]);
        const afterWrite = parses.count;
        const reads = jest.spyOn(fsp, "readFile");
        expect(await file.read()).toEqual([5]);
        expect(parses.count).toBe(afterWrite);
        expect(readsOf(reads, path)).toBe(0);
        await other.update(() => [6]);
        expect(await file.read()).toEqual([6]);
    });

    test("what a read returns is frozen, so no reader can change it under the others", async () => {
        const path = await tempFile();
        await writeFile(path, "[1]");
        const { file } = counted(path);
        const value = await file.read();
        expect(Object.isFrozen(value)).toBe(true);
        expect(() => value.push(2)).toThrow(TypeError);
        expect(await file.read()).toEqual([1]);
    });

    test("an unreadable file stays unreadable from the memo, with a fresh fallback for every read", async () => {
        const path = await tempFile();
        await writeFile(path, `{"not":"a list"}`);
        lookLate();
        const { file, parses } = counted(path);
        const first = await file.state();
        const second = await file.state();
        expect(first).toMatchObject({ unreadable: true });
        expect(second).toMatchObject({ unreadable: true });
        expect(first.value).not.toBe(second.value);
        expect(parses.count).toBe(1);
        expect(recordedProblems(path)).toEqual([{ kind: "unreadable", reason: "rejected", detail: "the file does not match what this build expects" }]);
    });

    test("a strict list with an entry this build cannot read is unreadable on every read, memo or not", async () => {
        const path = await tempFile();
        await writeFile(path, `[{"id":"a"},{"id":7}]`);
        lookLate();
        const list = jsonEntries<{ id: string }>(path, { entry: (raw) => z.object({ id: z.string() }).safeParse(raw).data, strict: true });
        expect(await list.state()).toMatchObject({ unreadable: true, detail: "an entry in it is not one this build can read" });
        expect(await list.state()).toMatchObject({ unreadable: true, detail: "an entry in it is not one this build can read" });
    });
});

describe("whether a memo stands", () => {
    const sighting = (identity: string, changedMs: number, at: number): Sighting => ({ identity, changedMs, at });

    test("a memo made inside the racy window is confirmed only by the same bytes, and settles once a read is late enough", () => {
        const racy = memoOf(sighting("a", 1_000, 1_500), "[1]", "value");
        expect(racy.settled).toBe(false);
        expect(standing(racy, sighting("a", 1_000, 1_600))).toBe("confirm");
        // A rewrite inside one tick leaves every stat field equal; only the bytes tell.
        expect(confirmed(racy, sighting("a", 1_000, 1_600), "[2]")).toBeUndefined();
        const late = confirmed(racy, sighting("a", 1_000, 1_000 + RACY_MS + 1), "[1]");
        expect(late?.settled).toBe(true);
        expect(late?.bytes).toBeUndefined();
        expect(standing(late, sighting("a", 1_000, 99_000))).toBe("fresh");
        expect(standing(late, sighting("b", 1_000, 99_000))).toBe("stale");
    });

    test("a file stamped in the future never settles", () => {
        expect(memoOf(sighting("a", 50_000, 1_000), "[1]", "value").settled).toBe(false);
    });
});
