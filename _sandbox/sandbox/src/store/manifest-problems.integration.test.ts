import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "./json-file.js";
import { clearManifestProblems, manifestProblems, withSkewHint } from "./manifest-problems.js";
import { objectParse } from "./unknown-keys.js";

// End-to-end: a manifest breaks on disk, the daemon reads it, the problem is queryable, then fixing the file clears it.
// Unit-level behavior is tested next door.

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

const Settings = z.object({ hashlineEdits: z.boolean().default(false), skills: z.array(z.string()).default([]) });
// settings.json and personas.json are hand-edited files, which is what makes them reportable; manifestProblems only
// surfaces paths the contract's table lists, so the name matters here, not the schema.
const manifestAt = (root: string, name: string) => {
    // Both live under state dir's config group, the hand-edited slice the notice is addressed to.
    const path = join(root, STATE_DIR, "config", name);
    return { path, file: jsonFile(path, { parse: objectParse(Settings), fallback: () => Settings.parse({}) }) };
};
const settingsFile = (root: string) => manifestAt(root, "settings.json");
const personasFile = (root: string) => manifestAt(root, "personas.json");
const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};

test("a file that has never been written reports nothing: that is first boot, not a fault", async () => {
    const root = await workspace();
    const { file } = settingsFile(root);
    expect(await file.read()).toEqual({ hashlineEdits: false, skills: [] });
    expect(manifestProblems(root)).toEqual([]);
});

test("a healthy file reports nothing", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"hashlineEdits": true}`);
    expect(await file.read()).toEqual({ hashlineEdits: true, skills: [] });
    expect(manifestProblems(root)).toEqual([]);
});

test("a file that is not JSON is reported, workspace-relative, as wholly ignored", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"hashlineEdits": tru`);
    // The read still succeeds; the daemon boots on a broken file, just not silently.
    expect(await file.read()).toEqual({ hashlineEdits: false, skills: [] });
    expect(manifestProblems(root)).toEqual([
        { path: `${STATE_DIR}/config/settings.json`, problems: [{ kind: `unreadable`, detail: `the file is not valid JSON` }] },
    ]);
});

test("a file the schema rejects outright is reported as wholly ignored", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"hashlineEdits": "yes please"}`);
    expect(await file.read()).toEqual({ hashlineEdits: false, skills: [] });
    expect(manifestProblems(root)[0]?.problems[0]?.kind).toBe(`unreadable`);
});

test("a misspelled key is named, with what it was probably meant to be", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"hashlineEdits": true, "skils": ["lsp"]}`);
    // The rest of the file still applies: a typo is reported, not a reason to refuse the whole file.
    expect(await file.read()).toEqual({ hashlineEdits: true, skills: [] });
    expect(manifestProblems(root)).toEqual([
        { path: `${STATE_DIR}/config/settings.json`, problems: [{ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }] },
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

test("deleting a broken manifest clears it too, not just fixing it", async () => {
    const root = await workspace();
    const { path, file } = settingsFile(root);
    await write(path, `{"hashlineEdits": tru`);
    await file.read();
    expect(manifestProblems(root)).toHaveLength(1);

    // Absent counts as nothing wrong, so it must clear the previous complaint rather than leave it standing.
    await rm(path);
    expect(await file.read()).toEqual({ hashlineEdits: false, skills: [] });
    expect(manifestProblems(root)).toEqual([]);
});

test("one broken manifest does not implicate the others", async () => {
    const root = await workspace();
    const broken = settingsFile(root);
    const healthy = personasFile(root);

    await write(broken.path, `{"skils": []}`);
    await write(healthy.path, `{"hashlineEdits": true}`);
    await broken.file.read();
    await healthy.file.read();

    expect(manifestProblems(root).map((report) => report.path)).toEqual([`${STATE_DIR}/config/settings.json`]);
});

test("a broken DAEMON-WRITTEN file is not put in front of the owner", async () => {
    const root = await workspace();
    const hand = settingsFile(root);
    // A daemon-written ledger, not hand-edited; nobody would see "fix the file" advice, so it must recover by being
    // rewritten instead of being surfaced.
    const ledgerPath = join(root, STATE_DIR, "records", "workflow-runs.json");
    const ledger = jsonFile<z.infer<typeof Settings>[]>(ledgerPath, {
        parse: (raw) => z.array(Settings).safeParse(raw).data,
        fallback: () => [],
    });

    await write(hand.path, `{"skils": []}`);
    await write(ledgerPath, `[{"hashlineEdits": "not a boolean"}]`);
    // Both fall back and the daemon boots either way; only the audience differs.
    expect(await ledger.read()).toEqual([]);
    await hand.file.read();

    expect(manifestProblems(root).map((report) => report.path)).toEqual([`${STATE_DIR}/config/settings.json`]);
});

test("after a rollback, a schema-rejected file is explained as newer rather than broken", async () => {
    const root = await workspace();
    const settings = settingsFile(root);
    // A shape only a newer schema would accept; this build rejects it outright.
    await write(settings.path, `{"hashlineEdits": {"level": 2}}`);
    await settings.file.read();

    // Without a newer-run stamp, the plain sentence: the file does not match, fix it.
    const plain = manifestProblems(root)[0]?.problems[0];
    expect(plain?.kind).toBe("unreadable");
    const plainDetail = plain?.detail ?? "";
    expect(plainDetail.length).toBeGreaterThan(0);

    // Stamped by a newer run, the same record reads as recognition; decoration happens on the way out only.
    const decorated = withSkewHint(manifestProblems(root)[0]?.problems ?? [], "1.199.0", "1.200.0")[0];
    expect(decorated?.detail).toContain("1.200.0");
    expect(decorated?.detail).toContain("1.199.0");
    expect(decorated?.detail).not.toBe(plainDetail);

    // A stamp that doesn't outrank the running build decorates nothing.
    expect(withSkewHint(manifestProblems(root)[0]?.problems ?? [], "1.200.0", "1.200.0")[0]?.detail).toBe(plainDetail);
    // Nor does a mangled-JSON file, whatever the stamp says: a newer build would have written valid JSON.
    await write(settings.path, `not json`);
    await settings.file.read();
    expect(withSkewHint(manifestProblems(root)[0]?.problems ?? [], "1.199.0", "1.200.0")[0]?.detail).toMatch(/JSON/i);
});
