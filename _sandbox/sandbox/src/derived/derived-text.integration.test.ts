import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { deriveText, readDerivedText, subscribeDerived } from "./derived-text.js";
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

test("a refusal carries fileq's own reason back, rather than a bare failure", async () => {
    const result = await deriveText(root, "huge.pdf", failing(1, '{"kind":"skipped","relPath":"huge.pdf","reason":"too-large (300 MB)"}\n'));
    expect(result).toEqual({
        present: false,
        path: "huge.pdf",
        derivable: false,
        state: "undeliverable",
        reason: "too-large (300 MB)",
    });
});

test("a derive that ran out of time says so, rather than reading as a file with nothing to render", async () => {
    const timedOut: ExecFn = async () => {
        throw Object.assign(new Error("Command failed: fileq derive --json scan.pdf"), { code: null, killed: true, signal: "SIGTERM", stdout: "" });
    };
    const result = await deriveText(root, "scan.pdf", timedOut);
    expect(result).toMatchObject({ present: false, path: "scan.pdf", reason: "fileq ran past its 120s limit and was stopped" });
});

test("a derive that crashed names the crash", async () => {
    const result = await deriveText(root, "notes.docx", failing(134, ""));
    expect(result).toMatchObject({ present: false, path: "notes.docx", reason: "fileq failed: fileq failed" });
});

test("a sandbox without the binary blames the sandbox, not the file: `broken`, never `undeliverable`", async () => {
    const result = await deriveText(root, "notes.docx", failing("ENOENT", ""));
    expect(result).toEqual({
        present: false,
        path: "notes.docx",
        derivable: false,
        state: "broken",
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
    // Waits for each child to ARRIVE rather than spending a fixed number of event-loop turns on the drain: a handoff
    // costs several turns of real filesystem work, and more of them on a loaded machine, so a turn budget sized against
    // an idle run empties mid-drain and leaves `all` pending until the suite's own timeout.
    const releaseNext = async (): Promise<void> => {
        let release = releases.shift();
        while (release === undefined) {
            await new Promise((resolve) => setImmediate(resolve));
            release = releases.shift();
        }
        release();
    };
    for (let child = 0; child < 6; child += 1) {
        await releaseNext();
    }
    await all;
    expect(peak).toBe(2);
});

test("a rendering still matching its source is settled", async () => {
    const exec: ExecFn = async () => {
        await writeShadow("bundle.zip", "- Archive: zip");
        return { stdout: '{"kind":"derived","relPath":"bundle.zip"}\n' };
    };
    // The source does not exist, so there is no hash to disagree with the front matter's: not stale, so not waiting.
    expect(await deriveText(root, "bundle.zip", exec)).toMatchObject({ present: true, stale: false, state: "idle" });
});

// Nothing renders in the background any more, so the one wait a reader can see is a rendering someone asked for: a
// second reader arriving mid-run is told so rather than offered to start another, and hears the text land.
test("a reader arriving mid-render is told the file is being read, and hears it land", async () => {
    // A zip's magic, so the file is one a reader claims before any rendering of it exists.
    await writeFile(join(root, "slow.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const exec: ExecFn = async () => {
        await gate;
        await writeShadow("slow.zip", "- Archive: zip");
        return { stdout: "" };
    };
    const heard: string[][] = [];
    const stop = subscribeDerived((paths) => heard.push(paths));
    try {
        const running = deriveText(root, "slow.zip", exec);
        expect(await readDerivedText(root, "slow.zip")).toMatchObject({ present: false, derivable: true, state: "deriving" });
        release();
        expect(await running).toMatchObject({ present: true, state: "idle" });
        expect(heard).toEqual([["slow.zip"]]);
        expect(await readDerivedText(root, "slow.zip")).toMatchObject({ present: true, state: "idle" });
    } finally {
        stop();
    }
});

// The same relative path under two roots is two files: a run in one must neither be shared with nor reported to a reader
// of the other.
test("a derivation under one root is not another root's, though the relative path is the same", async () => {
    const other = await mkdtemp(join(tmpdir(), "derived-text-other-"));
    try {
        const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        await writeFile(join(root, "same.zip"), zip);
        await writeFile(join(other, "same.zip"), zip);
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let runs = 0;
        const exec: ExecFn = async () => {
            runs += 1;
            await gate;
            return { stdout: "" };
        };
        const held = deriveText(root, "same.zip", exec);

        expect(await readDerivedText(other, "same.zip")).toMatchObject({ present: false, derivable: true, state: "idle" });
        const second = deriveText(other, "same.zip", exec);
        release();
        await Promise.all([held, second]);
        expect(runs).toBe(2);
    } finally {
        await rm(other, { recursive: true, force: true });
    }
});
