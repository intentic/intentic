import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MARKER_MAX_BYTES, readJsonMarker, readJsonMarkerSync } from "./json-marker.js";

const Marker = z.object({ state: z.enum(["running", "exited"]), pid: z.number() });

const roots: string[] = [];
const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "json-marker-"));
    roots.push(root);
    return root;
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Both twins answer every case alike; each case runs through both.
const twins = [
    ["async", readJsonMarker],
    ["sync", async (...args: Parameters<typeof readJsonMarkerSync>) => readJsonMarkerSync(...args)],
] as const;

describe.each(twins)("%s", (_name, read) => {
    test("a marker that holds its shape reads as its parsed value", async () => {
        const path = join(await scratch(), "marker.json");
        await writeFile(path, JSON.stringify({ state: "exited", pid: 7, extra: true }));
        expect(await read(path, Marker)).toEqual({ state: "exited", pid: 7 });
    });

    test("a missing file, and a directory where the file belongs, read as undefined", async () => {
        const root = await scratch();
        expect(await read(join(root, "absent.json"), Marker)).toBeUndefined();
        await mkdir(join(root, "dir.json"));
        expect(await read(join(root, "dir.json"), Marker)).toBeUndefined();
    });

    test("text that is not JSON, a torn write included, reads as undefined", async () => {
        const path = join(await scratch(), "marker.json");
        await writeFile(path, '{"state":"runn');
        expect(await read(path, Marker)).toBeUndefined();
    });

    test("JSON that fails the schema reads as undefined", async () => {
        const path = join(await scratch(), "marker.json");
        await writeFile(path, JSON.stringify({ state: "sleeping", pid: 7 }));
        expect(await read(path, Marker)).toBeUndefined();
    });

    test("a file past the cap reads as undefined, one exactly at it is parsed", async () => {
        const root = await scratch();
        const body = JSON.stringify({ state: "running", pid: 1 });
        const atCap = join(root, "at.json");
        await writeFile(atCap, body);
        expect(await read(atCap, Marker, { maxBytes: body.length })).toEqual({ state: "running", pid: 1 });
        expect(await read(atCap, Marker, { maxBytes: body.length - 1 })).toBeUndefined();
        // The default cap, too: valid JSON padded past it is still refused.
        const padded = join(root, "padded.json");
        await writeFile(padded, `${body}${" ".repeat(MARKER_MAX_BYTES)}`);
        expect(await read(padded, Marker)).toBeUndefined();
    });
});
