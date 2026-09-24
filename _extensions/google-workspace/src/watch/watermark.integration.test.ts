import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWatermark, watermarkPath, writeWatermark } from "./watermark.js";

/* THE RESUME MARK, ACROSS A REAL RESTART. */

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gw-watermark-"));
});

describe("watermarkPath", () => {
    it("puts a connection's state under the workspace's runtime tree, one directory per account", () => {
        expect(watermarkPath("/work", "work_gmail")).toBe("/work/.intentic/local/runtime/extensions/google-workspace/work_gmail/watch.json");
    });
});

// What a read reported as unreadable, for the cases that say something was.
let reported: string[];
const report = (detail: string): void => void reported.push(detail);

beforeEach(() => {
    reported = [];
});

describe("readWatermark", () => {
    it("reads back exactly what a running watcher wrote", async () => {
        const path = watermarkPath(root, "google");
        await writeWatermark(path, { historyId: "998877", announced: { evt1: "2026-08-09T12:00:00Z" } });
        expect(await readWatermark(path, report)).toEqual({ historyId: "998877", announced: { evt1: "2026-08-09T12:00:00Z" } });
    });

    /* A missing mark means "start from now", which dispatches nothing. */
    it("reads a first run as no cursor at all", async () => {
        expect(await readWatermark(watermarkPath(root, "never-run"), report)).toEqual({});
        expect(reported).toEqual([]);
    });

    it("reads a truncated or hand-edited file the same way, rather than throwing, and says so", async () => {
        const path = watermarkPath(root, "google");
        await writeWatermark(path, { historyId: "1" });
        await writeFile(path, '{"historyId": "99');
        expect(await readWatermark(path, report)).toEqual({});
        expect(reported).toEqual([expect.stringMatching(/^not JSON: /)]);
    });

    /* A MARK THAT COULD NOT BE READ IS NOT A MISSING ONE: the re-baseline would be written over it. */
    it("throws on a read that failed rather than reading it as a first run", async () => {
        const path = watermarkPath(root, "google");
        await mkdir(path, { recursive: true });
        await expect(readWatermark(path, report)).rejects.toMatchObject({ code: "EISDIR" });
    });

    it("drops fields of the wrong type instead of carrying them into a request", async () => {
        const path = watermarkPath(root, "google");
        await writeWatermark(path, { historyId: "1" });
        await writeFile(path, JSON.stringify({ historyId: 12345, announced: "nope" }));
        expect(await readWatermark(path, report)).toEqual({});
    });

    it("makes the directory it needs on the way", async () => {
        const path = watermarkPath(join(root, "deep", "nested"), "google");
        await writeWatermark(path, { historyId: "5" });
        expect(await readWatermark(path, report)).toEqual({ historyId: "5" });
    });

    it("leaves nothing staged beside the mark it wrote", async () => {
        const path = watermarkPath(root, "google");
        await writeWatermark(path, { historyId: "1" });
        await writeWatermark(path, { historyId: "2" });
        expect(await readdir(join(path, ".."))).toEqual(["watch.json"]);
        expect(await readWatermark(path, report)).toEqual({ historyId: "2" });
    });
});
