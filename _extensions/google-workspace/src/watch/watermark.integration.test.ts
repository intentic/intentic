import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readWatermark, watermarkPath, writeWatermark } from "./watermark.js";

/* THE RESUME MARK, ACROSS A REAL RESTART. An integration suite rather than a unit one because the failure it
 * guards only exists on disk: the gateway dies with the container, and what it reads back on the way up is
 * either the reason no mail is replayed or the reason some is lost. A fake filesystem would assert that the
 * code calls writeFile, which is not the thing that has ever gone wrong. */

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gw-watermark-"));
});

describe("watermarkPath", () => {
    it("puts a connection's state under the workspace's runtime tree, one directory per account", () => {
        expect(watermarkPath("/work", "work_gmail")).toBe("/work/.intentic/runtime/extensions/google-workspace/work_gmail/watch.json");
    });
});

describe("readWatermark", () => {
    it("reads back exactly what a running watcher wrote", async () => {
        const path = watermarkPath(root, "google");
        await writeWatermark(path, { historyId: "998877", announced: { evt1: "2026-08-09T12:00:00Z" } });
        expect(await readWatermark(path)).toEqual({ historyId: "998877", announced: { evt1: "2026-08-09T12:00:00Z" } });
    });

    /* A missing mark means "start from now", which dispatches nothing. That is the only safe reading of not
     * knowing where you were: the alternative is waking an agent for every message in the mailbox. */
    it("reads a first run as no cursor at all", async () => {
        expect(await readWatermark(watermarkPath(root, "never-run"))).toEqual({});
    });

    it("reads a truncated or hand-edited file the same way, rather than throwing", async () => {
        const path = watermarkPath(root, "google");
        await writeWatermark(path, { historyId: "1" });
        await writeFile(path, '{"historyId": "99');
        expect(await readWatermark(path)).toEqual({});
    });

    it("drops fields of the wrong type instead of carrying them into a request", async () => {
        const path = watermarkPath(root, "google");
        await writeWatermark(path, { historyId: "1" });
        await writeFile(path, JSON.stringify({ historyId: 12345, announced: "nope" }));
        expect(await readWatermark(path)).toEqual({});
    });

    it("makes the directory it needs on the way", async () => {
        const path = watermarkPath(join(root, "deep", "nested"), "google");
        await writeWatermark(path, { historyId: "5" });
        expect(await readWatermark(path)).toEqual({ historyId: "5" });
    });
});
