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

// Opening a file asks for a derivation without anyone pressing a button, so these two bounds are what keeps a reader
// walking a folder of documents from putting a child process per file on the box at once.
test("two asks for the same file share one run rather than spawning a second", async () => {
    let runs = 0;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const exec: ExecFn = async () => {
        runs += 1;
        await held;
        await writeShadow("bundle.zip", "- Archive: zip");
        return { stdout: '{"kind":"derived","relPath":"bundle.zip"}\n' };
    };
    const first = deriveText(root, "bundle.zip", exec);
    const second = deriveText(root, "bundle.zip", exec);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(left).toEqual(right);
    // The sharing lasts exactly as long as the run: the next ask is a fresh one, since the file may have moved on.
    await deriveText(root, "bundle.zip", exec);
    expect(runs).toBe(2);
});

test("never more than two children at once, however many files a reader opens", async () => {
    let live = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const exec: ExecFn = async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((resolve) => releases.push(resolve));
        live -= 1;
        return { stdout: '{"kind":"skipped","relPath":"x","reason":"unsupported"}\n' };
    };
    const all = Promise.all(Array.from({ length: 6 }, (_, index) => deriveText(root, `file${index}.zip`, exec)));
    // Released one at a time, so a queue that let everything through would have shown its peak before the first ends.
    // A fixed number of turns rather than "until the list is empty": the next child starts a tick after the one before
    // it ends, so an empty list mid-drain means "not started yet". Six handoffs need six of these; the rest are slack.
    for (let turn = 0; turn < 30; turn += 1) {
        releases.shift()?.();
        await new Promise((resolve) => setImmediate(resolve));
    }
    await all;
    expect(peak).toBe(2);
});

test("a shadow still matching its source is settled, whatever else the pass has queued", async () => {
    const exec: ExecFn = async () => {
        await writeShadow("bundle.zip", "- Archive: zip");
        return { stdout: '{"kind":"derived","relPath":"bundle.zip"}\n' };
    };
    // The source does not exist, so there is no hash to disagree with the front matter's: not stale, so not waiting.
    expect(await deriveText(root, "bundle.zip", exec)).toMatchObject({ present: true, stale: false, state: "idle" });
});
