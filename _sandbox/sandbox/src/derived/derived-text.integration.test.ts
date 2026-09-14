import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deriveText } from "./derived-text.js";
import type { ExecFn } from "./fileq.js";

/* The on-demand half: what a reader gets back when they ask for a file to be rendered now. */

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "derived-text-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const writeShadow = async (relPath: string, body: string): Promise<void> => {
    const path = join(root, STATE_DIR, "local/cache/derived", `${relPath}.md`);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `---\nsource: ${relPath}\nsha256: abc\nderiver: archive+tar v1\n---\n\n${body}\n`);
};

const failing = (code: number | string, stdout: string): ExecFn => {
    return async () => {
        throw Object.assign(new Error("fileq failed"), { code, stdout });
    };
};

test("a successful derive answers with the shadow the run just wrote", async () => {
    const exec: ExecFn = async (command, args) => {
        expect([command, args]).toEqual(["fileq", ["derive", "--json", "bundle.zip"]]);
        await writeShadow("bundle.zip", "- Archive: zip");
        return { stdout: '{"kind":"derived","relPath":"bundle.zip"}\n' };
    };
    expect(await deriveText(root, "bundle.zip", exec)).toMatchObject({ present: true, deriver: "archive+tar v1", content: "- Archive: zip\n" });
});

// No service runs in these tests, so the pass reports itself stopped; asserted rather than elided, since a reader is
// shown this and "nothing is rendering" is the honest thing to show them.
const STOPPED = { enabled: false, queued: 0, deriving: [], sweeping: false, broken: false };

test("a refusal carries fileq's own reason back, rather than a bare failure", async () => {
    const result = await deriveText(root, "huge.pdf", failing(1, '{"kind":"skipped","relPath":"huge.pdf","reason":"too-large (300 MB)"}\n'));
    expect(result).toEqual({
        present: false,
        path: "huge.pdf",
        derivable: false,
        state: "undeliverable",
        queue: STOPPED,
        reason: "too-large (300 MB)",
    });
});

test("a sandbox without the binary blames the sandbox, not the file: `broken`, never `undeliverable`", async () => {
    const result = await deriveText(root, "notes.docx", failing("ENOENT", ""));
    expect(result).toEqual({
        present: false,
        path: "notes.docx",
        derivable: false,
        state: "broken",
        queue: STOPPED,
        reason: "this sandbox has no fileq binary, so nothing can be rendered as text here",
    });
});

test("a shadow still matching its source is settled, whatever else the pass has queued", async () => {
    const exec: ExecFn = async () => {
        await writeShadow("bundle.zip", "- Archive: zip");
        return { stdout: '{"kind":"derived","relPath":"bundle.zip"}\n' };
    };
    // The source does not exist, so there is no hash to disagree with the front matter's: not stale, so not waiting.
    expect(await deriveText(root, "bundle.zip", exec)).toMatchObject({ present: true, stale: false, state: "idle" });
});
