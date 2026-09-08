import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "./json-file.js";
import { clearManifestProblems, manifestProblems } from "./manifest-problems.js";
import { clearManifestEditors, repairManifest } from "./manifest-repair.js";
import { objectParse } from "./unknown-keys.js";

// End-to-end repair: removes a stray key on a real file through the store that owns it, proving the repair is ordered
// against the daemon's own writes.

const roots: string[] = [];
const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-repair-"));
    roots.push(root);
    return root;
};
beforeEach(() => {
    clearManifestProblems();
    clearManifestEditors();
});
afterEach(async () => {
    clearManifestProblems();
    clearManifestEditors();
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

// A stand-in schema; the file name under test is what decides reportability, not the shape.
const Settings = z.object({ hashlineEdits: z.boolean().default(false), skills: z.array(z.string()).default([]) });
const REL = `${STATE_DIR}/config/settings.json`;

const settingsFile = (root: string) => {
    const path = join(root, STATE_DIR, "config", "settings.json");
    return { path, file: jsonFile(path, { parse: objectParse(Settings), fallback: () => Settings.parse({}) }) };
};
const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};
const contents = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

test("removing a stray key leaves every real setting where it was", async () => {
    const root = await workspace();
    const { path } = settingsFile(root);
    await write(path, `{"hashlineEdits": true, "contextShelf": "", "skills": ["lsp"]}`);

    expect(await repairManifest({ root, path: REL, key: "contextShelf" })).toBeUndefined();
    expect(await contents(path)).toEqual({ hashlineEdits: true, skills: ["lsp"] });
});

test("and the notice clears itself on the next read, with nothing to dismiss", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"contextShelf": ""}`);
    await file.read();
    expect(manifestProblems(root)).toHaveLength(1);

    await repairManifest({ root, path: REL, key: "contextShelf" });
    await file.read();
    expect(manifestProblems(root)).toEqual([]);
});

test("renaming carries the value across, so the setting starts applying", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"skils": ["lsp"]}`);

    expect(await repairManifest({ root, path: REL, key: "skils", to: "skills" })).toBeUndefined();
    // A rename keeps the value the user typed; dropping it would cost them the setting.
    expect(await file.read()).toEqual({ hashlineEdits: false, skills: ["lsp"] });
});

test("a renamed key keeps its place in the file", async () => {
    const root = await workspace();
    const { path } = settingsFile(root);
    await write(path, `{"skils": ["lsp"], "hashlineEdits": true}`);

    await repairManifest({ root, path: REL, key: "skils", to: "skills" });
    // A hand-edited file has an order; delete-and-re-add would move the line to the bottom as an unasked-for diff.
    expect(Object.keys(await contents(path))).toEqual(["skills", "hashlineEdits"]);
});

test("renaming onto a key the file already has is refused, not merged", async () => {
    const root = await workspace();
    const { path } = settingsFile(root);
    await write(path, `{"skils": ["wrong"], "skills": ["right"]}`);

    // Either the guess is wrong, or already fixed by hand; both would overwrite the setting the user chose.
    expect(await repairManifest({ root, path: REL, key: "skils", to: "skills" })).toBe("name taken");
    expect(await contents(path)).toEqual({ skils: ["wrong"], skills: ["right"] });
});

test("a key already gone is a race with the reader's own editor, and says so", async () => {
    const root = await workspace();
    const { path } = settingsFile(root);
    await write(path, `{"hashlineEdits": true}`);

    expect(await repairManifest({ root, path: REL, key: "contextShelf" })).toBe("no such key");
});

test("a file the table does not report on cannot be edited through this door", async () => {
    const root = await workspace();
    const { path } = settingsFile(root);
    await write(path, `{"contextShelf": ""}`);

    // Guard is an exact match against REPORTED_MANIFEST_PATHS: no traversal to defend, no unlisted file reachable.
    expect(await repairManifest({ root, path: `${STATE_DIR}/secrets/ci.json`, key: "contextShelf" })).toBe("unknown file");
    expect(await repairManifest({ root, path: `package.json`, key: "name" })).toBe("unknown file");
    expect(await contents(path)).toEqual({ contextShelf: "" });
});

test("a file this build cannot read is left exactly as it is", async () => {
    const root = await workspace();
    const { path } = settingsFile(root);
    await write(path, `{"contextShelf": ""`);

    // Downgrades rule: unparseable bytes are never rewritten, and the repair must say so, not silently succeed.
    expect(await repairManifest({ root, path: REL, key: "contextShelf" })).toBe("unreadable file");
    expect(await readFile(path, "utf8")).toBe(`{"contextShelf": ""`);
});

test("a repair and a save cannot lose each other", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"contextShelf": "", "skills": []}`);

    // Settings writes rewrite the whole file on every switch; without the store's queue, a concurrent repair and save
    // would lose one or reinstate the removed key.
    await Promise.all([
        repairManifest({ root, path: REL, key: "contextShelf" }),
        file.update((current) => ({ ...current, hashlineEdits: true })),
    ]);

    const after = await contents(path);
    expect(after["hashlineEdits"]).toBe(true);
    expect(Object.hasOwn(after, "contextShelf")).toBe(false);
});
