import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { exportsDir, isReadyExport, listExports, openExport, removeExport, startExport, sweepStaleExports } from "./exports.js";

/* AN EXPORT OUTLIVES THE CLICK THAT ASKED FOR IT.
 *
 * These cover the property the first cut did not have: the export is a file, so its state is readable by anyone
 * who asks later — a second tab, a reload, the same tab after ten minutes elsewhere. Every assertion below is
 * about what the DIRECTORY says, because that is the only thing the UI is allowed to believe.
 */

const roots: string[] = [];
const makeRoots = async (): Promise<{ work: string; history: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-exports-"));
    roots.push(dir);
    const work = join(dir, "work");
    const history = join(dir, "history");
    await mkdir(work, { recursive: true });
    await mkdir(history, { recursive: true });
    return { work, history };
};
const cleanup = async (): Promise<void> => {
    for (const dir of roots.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
};

const exportServices = (work: string, history: string): Services =>
    services({
        workspace: workspacePaths(work),
        config: { ...testConfig, workspaceRoot: work, historyRoot: history, sandbox: { ...testConfig.sandbox, name: "intentic-sandbox-demo" } },
        capabilities: memoryCapabilitiesStore(),
        files: fakeFiles({ read: async (absPath) => readFile(absPath, "utf8").catch(() => undefined) }),
    } as Parameters<typeof services>[0]);

/* The pack is detached by design, so a test waits for the DIRECTORY to settle rather than awaiting a promise —
 * exactly the position the browser is in, and the reason the list is the only source of truth.
 *
 * Asserted on the NAMED export rather than over the whole list, because "no export is packing" is trivially
 * true of an empty directory: the first version of this helper settled before the `.part` file had even been
 * created, and every test using it then read a half-packed export as a finished one. */
const settled = async (history: string, name: string): Promise<void> => {
    await vi.waitFor(async () => {
        const found = (await listExports(history)).find((entry) => entry.name === name);
        expect(found?.status ?? "packing").not.toBe("packing");
    });
};

test("an export survives the request that started it — it is named at once and finishes on its own", async () => {
    const source = await makeRoots();
    await writeFile(join(source.work, "file.txt"), "content");

    const name = await startExport(exportServices(source.work, source.history), { secrets: false, now: 1_700_000_000_000 });
    // Named immediately: the row can render before a single byte is packed, which is what the card needs to
    // show "packing" instead of a button that looks untouched.
    expect(name).toMatch(/^intentic-demo-.*\.tar\.gz$/);

    await settled(source.history, name);
    const [entry] = await listExports(source.history);
    expect(entry?.name).toBe(name);
    expect(entry?.status).toBe("ready");
    expect(entry?.bytes).toBeGreaterThan(0);
    expect(await isReadyExport(source.history, name)).toBe(true);
    await cleanup();
});

test("status is the filename, so any reader derives the same answer without being told", async () => {
    const source = await makeRoots();
    const dir = exportsDir(source.history);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-a-2026-01-01-00-00-00.tar.gz"), "done");
    await writeFile(join(dir, "intentic-b-2026-01-02-00-00-00.tar.gz.part"), "half");
    await writeFile(join(dir, "intentic-c-2026-01-03-00-00-00.tar.gz.failed"), "the disk filled up\n");

    const byName = new Map((await listExports(source.history)).map((entry) => [entry.name, entry]));
    expect(byName.get("intentic-a-2026-01-01-00-00-00.tar.gz")?.status).toBe("ready");
    expect(byName.get("intentic-b-2026-01-02-00-00-00.tar.gz")?.status).toBe("packing");
    const failed = byName.get("intentic-c-2026-01-03-00-00-00.tar.gz");
    expect(failed?.status).toBe("failed");
    // The reason travels with the marker, so the card explains itself rather than just going red.
    expect(failed?.error).toContain("the disk filled up");
    await cleanup();
});

test("a bundle carrying secrets says so in its own filename, on any machine it ends up on", async () => {
    const source = await makeRoots();
    const name = await startExport(exportServices(source.work, source.history), { secrets: true, now: 1_700_000_000_000 });
    expect(name).toContain("-with-secrets");
    await settled(source.history, name);
    expect((await listExports(source.history))[0]?.secrets).toBe(true);
    await cleanup();
});

test("a second export is refused while one is packing rather than racing it", async () => {
    const source = await makeRoots();
    const dir = exportsDir(source.history);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-busy-2026-01-01-00-00-00.tar.gz.part"), "half");
    await expect(startExport(exportServices(source.work, source.history), { secrets: false, now: 1 })).rejects.toThrow(
        "an export is already being packed",
    );
    await cleanup();
});

test("a .part left by a daemon that died is swept to failed, not left packing forever", async () => {
    // The one state the filename cannot express on its own: only a LIVE process can be writing a `.part`, so
    // one that outlived a restart would otherwise render as a progress bar that never moves again.
    const source = await makeRoots();
    const dir = exportsDir(source.history);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-x-2026-01-01-00-00-00.tar.gz.part"), "half");

    await sweepStaleExports(source.history);
    const [entry] = await listExports(source.history);
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toContain("restarted");
    await cleanup();
});

test("download resolves through the listing, so a name cannot walk onto another file", async () => {
    const source = await makeRoots();
    await writeFile(join(source.history, "session-secret"), "signing-key");
    const name = await startExport(exportServices(source.work, source.history), { secrets: false, now: 1_700_000_000_000 });
    await settled(source.history, name);

    expect(await openExport(source.history, name)).toBeDefined();
    // Neither a traversal nor a real file outside the export directory is reachable by naming it.
    expect(await openExport(source.history, "../session-secret")).toBeUndefined();
    expect(await openExport(source.history, "session-secret")).toBeUndefined();
    expect(await isReadyExport(source.history, "../session-secret")).toBe(false);
    await cleanup();
});

test("deleting an export takes every trace of it, whatever state it was in", async () => {
    const source = await makeRoots();
    const dir = exportsDir(source.history);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-a-2026-01-01-00-00-00.tar.gz.failed"), "nope\n");
    expect(await removeExport(source.history, "intentic-a-2026-01-01-00-00-00.tar.gz")).toBe(true);
    expect(await listExports(source.history)).toEqual([]);
    // A name that is not there answers false, so the route can 404 instead of pretending it deleted something.
    expect(await removeExport(source.history, "intentic-a-2026-01-01-00-00-00.tar.gz")).toBe(false);
    await cleanup();
});

test("a finished bundle is a real bundle — the restore side reads what the export side wrote", async () => {
    // The end-to-end shape: pack to a file, then open that file and check it is the gzipped tar the restorer
    // expects, rather than trusting that a stream that ended was a stream that worked.
    const source = await makeRoots();
    await writeFile(join(source.work, "file.txt"), "content");
    const name = await startExport(exportServices(source.work, source.history), { secrets: false, now: 1_700_000_000_000 });
    await settled(source.history, name);

    const opened = await openExport(source.history, name);
    expect(opened?.size).toBeGreaterThan(0);
    const first = await opened?.body.getReader().read();
    // gzip's magic bytes: what the browser will be handed, and what restoreBundle gunzips on the way back in.
    expect(first?.value?.[0]).toBe(0x1f);
    expect(first?.value?.[1]).toBe(0x8b);
    await cleanup();
});
