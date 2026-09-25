import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearNewestRun, isDowngrade, newerBuildRan, newestRunDigest, newestRunDocument, newestRunEngine, newestRunVersion, recordNewestRun } from "./newest-run.js";

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
    expect(JSON.parse(await readFile(join(root, newestRunDocument.path), "utf8"))).toEqual({ version: "1.200.0", engine: 0 });
});

test("the stamp only moves forward: a rollback must not erase the evidence it exists to explain", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.200.0");
    // The rolled-back daemon boots older; the stamp keeps naming the newer run.
    await recordNewestRun(root, "1.199.0");
    expect(newestRunVersion()).toBe("1.200.0");
    expect(JSON.parse(await readFile(join(root, newestRunDocument.path), "utf8"))).toEqual({ version: "1.200.0", engine: 0 });
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
    // The dev boot still LEARNS the stamp: it must read it to know not to lower it.
    expect(newestRunVersion()).toBe("1.200.0");
});

test("a mangled stamp reads as absent and re-establishes itself", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.200.0");
    await writeFile(join(root, newestRunDocument.path), "not json");
    await recordNewestRun(root, "1.199.0");
    expect(newestRunVersion()).toBe("1.199.0");
});

test("the engine epoch rides beside the version and only moves forward with it", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.300.0", { engine: 12 });
    expect(newestRunEngine()).toBe(12);
    expect(JSON.parse(await readFile(join(root, newestRunDocument.path), "utf8"))).toEqual({ version: "1.300.0", engine: 12 });
    // A rolled-back build knows fewer conversions; it learns the stamp and leaves it alone.
    await recordNewestRun(root, "1.299.0", { engine: 9 });
    expect(newestRunEngine()).toBe(12);
    expect(newerBuildRan("1.299.0")).toBe(true);
});

test("the conversion digest rides beside the version and is replaced, not kept, when a newer build stamps", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.300.0", { engine: 12, digest: "aaaa000011112222" });
    expect(newestRunDigest()).toBe("aaaa000011112222");
    expect(JSON.parse(await readFile(join(root, newestRunDocument.path), "utf8"))).toEqual({ version: "1.300.0", engine: 12, digest: "aaaa000011112222" });
    // A newer build that retired a document counts fewer conversions: the count stays up for older readers, the digest is its own.
    await recordNewestRun(root, "1.301.0", { engine: 11, digest: "bbbb000011112222" });
    expect(JSON.parse(await readFile(join(root, newestRunDocument.path), "utf8"))).toEqual({ version: "1.301.0", engine: 12, digest: "bbbb000011112222" });
});

test("a downgrade is a stamp naming a newer release than this build, whatever the conversion counts say", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.300.0", { engine: 12, digest: "aaaa000011112222" });
    expect(isDowngrade("1.300.0")).toBe(false);
    expect(isDowngrade("1.301.0")).toBe(false);
    expect(isDowngrade("1.299.0")).toBe(true);
    // A dev build names no release, so it is never the older one.
    expect(isDowngrade("0.0.0")).toBe(false);
});

test("a stamp from before the digest reads by its version, and its count carries forward", async () => {
    const root = await workspace();
    const path = join(root, newestRunDocument.path);
    await mkdir(dirname(path), { recursive: true });
    // An older build counted whatever it had loaded, often more than a newer one's registry holds.
    await writeFile(path, `${JSON.stringify({ version: "1.300.0", engine: 400 })}\n`);
    await recordNewestRun(root, "1.301.0", { write: false });
    expect(newestRunDigest()).toBeUndefined();
    expect(isDowngrade("1.301.0")).toBe(false);
    expect(isDowngrade("1.299.0")).toBe(true);
    await recordNewestRun(root, "1.301.0", { engine: 84, digest: "cccc000011112222" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: "1.301.0", engine: 400, digest: "cccc000011112222" });
});

test("a stamp holding only an engine count names no release: no downgrade, and the next release stamps over it", async () => {
    const root = await workspace();
    const path = join(root, newestRunDocument.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ engine: 400 })}\n`);
    await recordNewestRun(root, "1.301.0", { write: false });
    expect(newestRunVersion()).toBeUndefined();
    expect(newestRunEngine()).toBe(400);
    expect(isDowngrade("1.301.0")).toBe(false);
    await recordNewestRun(root, "1.301.0", { engine: 84 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: "1.301.0", engine: 400 });
});

test("a daemon that may not converge the workspace learns the stamp and writes nothing", async () => {
    const root = await workspace();
    await recordNewestRun(root, "1.300.0", { write: false });
    expect(newestRunVersion()).toBeUndefined();
    await expect(readFile(join(root, newestRunDocument.path), "utf8")).rejects.toThrow("ENOENT");
});
