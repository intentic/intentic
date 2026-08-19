import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "./json-file.js";
import { clearManifestProblems, manifestProblems, withSkewHint } from "./manifest-problems.js";
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
/* Both of these are files a PERSON hand-edits, which is what puts them on the notice at all — the shape is a
 * stand-in, the name is the part under test. `manifestProblems` reports only the paths the contract's table says
 * a write refreshes, so a helper pointed at an invented name would assert nothing. */
const manifestAt = (root: string, name: string) => {
    // Both live in the state dir's `config` group — the reviewed, hand-edited slice, which is exactly the slice
    // the notice is addressed to.
    const path = join(root, STATE_DIR, "config", name);
    return { path, file: jsonFile(path, { parse: objectParse(Settings), fallback: () => Settings.parse({}) }) };
};
const settingsFile = (root: string) => manifestAt(root, "settings.json");
const personasFile = (root: string) => manifestAt(root, "personas.json");
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
        { path: `${STATE_DIR}/config/settings.json`, problems: [{ kind: `unreadable`, detail: `the file is not valid JSON` }] },
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
    await write(path, `{"terseOutput": tru`);
    await file.read();
    expect(manifestProblems(root)).toHaveLength(1);

    // Absent is "nothing wrong", so it must erase the last read's complaint rather than leave it standing. It
    // used to return before the recording step, which made removing the file the one repair that did nothing —
    // the notice outlived the file and only a daemon restart took it down.
    await rm(path);
    expect(await file.read()).toEqual({ terseOutput: false, skills: [] });
    expect(manifestProblems(root)).toEqual([]);
});

test("one broken manifest does not implicate the others", async () => {
    const root = await workspace();
    const broken = settingsFile(root);
    const healthy = personasFile(root);

    await write(broken.path, `{"skils": []}`);
    await write(healthy.path, `{"terseOutput": true}`);
    await broken.file.read();
    await healthy.file.read();

    expect(manifestProblems(root).map((report) => report.path)).toEqual([`${STATE_DIR}/config/settings.json`]);
});

test("a broken DAEMON-WRITTEN file is not put in front of the owner", async () => {
    const root = await workspace();
    const hand = settingsFile(root);
    // The ledger the daemon rewrites several times per workflow step. Nobody opens it, so "fix the file and this
    // clears on its own" is advice addressed to no one — and it feeds no query, so no write would refresh the
    // notice even if they did. It recovers by being written, which is what the next run does.
    const ledgerPath = join(root, STATE_DIR, "records", "workflow-runs.json");
    const ledger = jsonFile<z.infer<typeof Settings>[]>(ledgerPath, {
        parse: (raw) => z.array(Settings).safeParse(raw).data,
        fallback: () => [],
    });

    await write(hand.path, `{"skils": []}`);
    await write(ledgerPath, `[{"terseOutput": "not a boolean"}]`);
    // Both fall back — the daemon boots either way; only the audience differs.
    expect(await ledger.read()).toEqual([]);
    await hand.file.read();

    expect(manifestProblems(root).map((report) => report.path)).toEqual([`${STATE_DIR}/config/settings.json`]);
});

test("after a rollback, a schema-rejected file is explained as newer rather than broken", async () => {
    const root = await workspace();
    const settings = settingsFile(root);
    // A shape only a NEWER schema would accept — this build rejects it whole.
    await write(settings.path, `{"terseOutput": {"level": 2}}`);
    await settings.file.read();

    // Without the stamp, the plain sentence: the file does not match, fix the file.
    const plain = manifestProblems(root)[0]?.problems[0];
    expect(plain?.kind).toBe("unreadable");
    expect(plain?.detail).toBe("the file does not match what this build expects");

    // With the workspace stamped by a newer run than this build, the same record reads as recognition — the
    // decoration happens on the way OUT, so nothing about recording or self-clearing changes.
    const decorated = withSkewHint(manifestProblems(root)[0]?.problems ?? [], "1.199.0", "1.200.0")[0];
    expect(decorated?.detail).toContain("intentic 1.200.0, newer than this sandbox (1.199.0)");
    expect(decorated?.detail).toContain("Updating the sandbox will read it again");

    // A stamp that does NOT outrank the running build decorates nothing — an old stamp is not evidence.
    expect(withSkewHint(manifestProblems(root)[0]?.problems ?? [], "1.200.0", "1.200.0")[0]?.detail).toBe(
        "the file does not match what this build expects",
    );
    // …and neither does a mangled-JSON file, whatever the stamp says: newer builds write valid JSON.
    await write(settings.path, `not json`);
    await settings.file.read();
    expect(withSkewHint(manifestProblems(root)[0]?.problems ?? [], "1.199.0", "1.200.0")[0]?.detail).toBe("the file is not valid JSON");
});
