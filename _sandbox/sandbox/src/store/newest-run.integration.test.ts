import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { clearNewestRun, newestRunVersion, recordNewestRun } from "./newest-run.js";

const roots: string[] = [];
const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "newest-run-"));
    roots.push(root);
    return root;
};

afterEach(async () => {
    clearNewestRun();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a release build stamps a fresh workspace, and the stamp survives on disk", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.200.0");
    expect(newestRunVersion()).toBe("1.200.0");
    expect(JSON.parse(await readFile(join(root, ".intentic/newest-run.json"), "utf8"))).toEqual({ version: "1.200.0" });
});

test("the stamp only moves forward — a rollback must not erase the evidence it exists to explain", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.200.0");
    // The rolled-back daemon boots older; the stamp keeps naming the newer run.
    await recordNewestRun(root, "1.199.0");
    expect(newestRunVersion()).toBe("1.200.0");
    expect(JSON.parse(await readFile(join(root, ".intentic/newest-run.json"), "utf8"))).toEqual({ version: "1.200.0" });
    // Rolling forward past it moves it again.
    await recordNewestRun(root, "1.201.0");
    expect(newestRunVersion()).toBe("1.201.0");
});

test("a dev build records nothing and reads what release builds left", async () => {
    const root = await workspace();
    await recordNewestRun(root, "0.0.0");
    expect(newestRunVersion()).toBeUndefined();
    await recordNewestRun(root, "1.200.0");
    await recordNewestRun(root, "0.0.0");
    // The dev boot still LEARNS the stamp — it must read it to know not to lower it.
    expect(newestRunVersion()).toBe("1.200.0");
});

test("a mangled stamp reads as absent and re-establishes itself", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.200.0");
    await writeFile(join(root, ".intentic/newest-run.json"), "not json");
    await recordNewestRun(root, "1.199.0");
    expect(newestRunVersion()).toBe("1.199.0");
});
