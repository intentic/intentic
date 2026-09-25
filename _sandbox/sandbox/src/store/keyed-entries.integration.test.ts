import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { jsonEntries } from "./json-file.js";
import { countResume, keyedEntries } from "./keyed-entries.js";

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const RunSchema = z.object({ runId: z.string(), state: z.string(), resumed: z.number() });
type Run = z.infer<typeof RunSchema>;

const ledger = async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-keyed-entries-"));
    dirs.push(dir);
    const path = join(dir, "runs.json");
    const file = jsonEntries<Run>(path, { entry: (raw) => RunSchema.safeParse(raw).data, idKeys: ["runId"] });
    return { path, file, runs: keyedEntries(file, "runId") };
};

test("create never overwrites and update never invents, each answering why it wrote nothing", async () => {
    const { runs, file } = await ledger();
    expect(await runs.save({ runId: "a", state: "running", resumed: 0 }, false)).toBe("missing");
    expect(await runs.save({ runId: "a", state: "running", resumed: 0 }, true)).toBe("saved");
    expect(await runs.save({ runId: "a", state: "done", resumed: 0 }, true)).toBe("conflict");
    expect(await runs.save({ runId: "a", state: "done", resumed: 0 }, false)).toBe("saved");
    expect(await file.read()).toEqual([{ runId: "a", state: "done", resumed: 0 }]);
});

test("an amend of an entry that is gone writes nothing, since a writer may outlive its record", async () => {
    const { runs, path } = await ledger();
    await runs.amend("gone", (run) => ({ ...run, state: "done" }));
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await runs.save({ runId: "a", state: "running", resumed: 0 }, true);
    await runs.amend("a", (run) => ({ ...run, state: "done" }));
    expect(await runs.get("a")).toEqual({ runId: "a", state: "done", resumed: 0 });
});

test("remove says whether there was anything to remove", async () => {
    const { runs } = await ledger();
    await runs.save({ runId: "a", state: "running", resumed: 0 }, true);
    expect(await runs.remove("b")).toBe(false);
    expect(await runs.remove("a")).toBe(true);
    expect(await runs.get("a")).toBeUndefined();
});

test("a counted resume answers the run as it now stands, and nothing once it is gone", async () => {
    const { runs } = await ledger();
    await runs.save({ runId: "a", state: "running", resumed: 1 }, true);
    expect(await countResume(runs, "a")).toEqual({ runId: "a", state: "running", resumed: 2 });
    expect(await countResume(runs, "b")).toBeUndefined();
});
