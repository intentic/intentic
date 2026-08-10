import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "./json-file.js";
import { clearManifestProblems, manifestProblems } from "./manifest-problems.js";
import { objectParse } from "./unknown-keys.js";

/* The whole path, on a real file: a manifest breaks on disk, the daemon reads it, and what it could not make
 * sense of is available to be shown — then the file is fixed and the complaint goes away by itself. Everything
 * between is unit-tested next door; this is the part that only a real read can prove. */

const roots: string[] = [];
const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-manifest-"));
    roots.push(root);
    return root;
};
beforeEach(() => clearManifestProblems());
afterEach(async () => {
    clearManifestProblems();
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

const Settings = z.object({ terseOutput: z.boolean().default(false), skills: z.array(z.string()).default([]) });
const settingsFile = (root: string) => {
    const path = join(root, STATE_DIR, "settings.json");
    return { path, file: jsonFile(path, { parse: objectParse(Settings), fallback: () => Settings.parse({}) }) };
};
const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};

test("a file that has never been written reports nothing — that is first boot, not a fault", async () => {
    const root = await workspace();
    const { file } = settingsFile(root);
    expect(await file.read()).toEqual({ terseOutput: false, skills: [] });
    expect(manifestProblems(root)).toEqual([]);
});

test("a healthy file reports nothing", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"terseOutput": true}`);
    expect(await file.read()).toEqual({ terseOutput: true, skills: [] });
    expect(manifestProblems(root)).toEqual([]);
});

test("a file that is not JSON is reported, workspace-relative, as wholly ignored", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"terseOutput": tru`);
    // The read still succeeds — the daemon must boot with a broken settings file — but no longer in silence.
    expect(await file.read()).toEqual({ terseOutput: false, skills: [] });
    expect(manifestProblems(root)).toEqual([
        { path: `${STATE_DIR}/settings.json`, problems: [{ kind: `unreadable`, detail: `the file is not valid JSON` }] },
    ]);
});

test("a file the schema rejects outright is reported as wholly ignored", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"terseOutput": "yes please"}`);
    expect(await file.read()).toEqual({ terseOutput: false, skills: [] });
    expect(manifestProblems(root)[0]?.problems[0]?.kind).toBe(`unreadable`);
});

test("a misspelled key is named, with what it was probably meant to be", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"terseOutput": true, "skils": ["lsp"]}`);
    // The rest of the file still applies — that is the difference between reporting a typo and refusing a file.
    expect(await file.read()).toEqual({ terseOutput: true, skills: [] });
    expect(manifestProblems(root)).toEqual([
        { path: `${STATE_DIR}/settings.json`, problems: [{ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }] },
    ]);
});

test("fixing the file clears the complaint on the next read, with nothing to dismiss", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"skils": ["lsp"]}`);
    await file.read();
    expect(manifestProblems(root)).toHaveLength(1);

    await write(path, `{"skills": ["lsp"]}`);
    await file.read();
    expect(manifestProblems(root)).toEqual([]);
});

test("one broken manifest does not implicate the others", async () => {
    const root = await workspace();
    const broken = settingsFile(root);
    const otherPath = join(root, STATE_DIR, "other.json");
    const other = jsonFile(otherPath, { parse: objectParse(Settings), fallback: () => Settings.parse({}) });

    await write(broken.path, `{"skils": []}`);
    await write(otherPath, `{"terseOutput": true}`);
    await broken.file.read();
    await other.read();

    expect(manifestProblems(root).map((report) => report.path)).toEqual([`${STATE_DIR}/settings.json`]);
});
