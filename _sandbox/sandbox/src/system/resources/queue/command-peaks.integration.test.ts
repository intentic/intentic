import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandPeaksDocument, fileCommandPeaks } from "./command-peaks.js";

/* The peaks the memory gate prices a heavy command by, on a real history directory: the largest of a command's last
   five runs within two weeks, kept across a daemon restart, and bounded in what the file holds. */

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60_000;
const KEY = "cargo-verify @shinobi-society: cargo test --lib -p integra-render";
const COMMAND = "cargo test --lib -p integra-render";

let root: string;
// The file as the document's own schema reads it.
const storedFile = async () => commandPeaksDocument.schema.parse(JSON.parse(await readFile(join(root, commandPeaksDocument.path), "utf8")));
let clock: number;
const now = (): number => clock;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "command-peaks-"));
    clock = Date.UTC(2026, 10, 21);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("a command never measured has no learned peak, and one measured is priced by its largest recent run, after a restart too", async () => {
    const peaks = fileCommandPeaks(root, now);
    expect(await peaks.learned(KEY)).toBeUndefined();
    for (const gib of [8.8, 13.5, 10.8]) {
        await peaks.record(KEY, COMMAND, gib * GIB);
        clock += 60_000;
    }
    const learned = { command: COMMAND, peakBytes: Math.round(13.5 * 1024) * 1024 ** 2, runs: 3 };
    expect(await peaks.learned(KEY)).toEqual(learned);
    // A new daemon reads the same file.
    expect(await fileCommandPeaks(root, now).learned(KEY)).toEqual(learned);
});

test("only the last five runs within two weeks count", async () => {
    const peaks = fileCommandPeaks(root, now);
    for (const gib of [12, 2, 3, 4, 5, 6]) {
        await peaks.record(KEY, COMMAND, gib * GIB);
        clock += DAY_MS;
    }
    // The 12 GiB run is the sixth from last: out.
    expect(await peaks.learned(KEY)).toEqual({ command: COMMAND, peakBytes: 6 * GIB, runs: 5 });
    // Eleven days on, only the runs of the last two weeks remain: the three newest.
    clock += 11 * DAY_MS;
    expect(await peaks.learned(KEY)).toEqual({ command: COMMAND, peakBytes: 6 * GIB, runs: 3 });
    clock += 3 * DAY_MS;
    expect(await peaks.learned(KEY)).toBeUndefined();
    // A command nobody ran in two weeks leaves the file at the next record.
    await peaks.record("cargo @shinobi-society: cargo build", "cargo build", GIB);
    const file = await storedFile();
    expect(file.commands.map((entry) => entry.key)).toEqual(["cargo @shinobi-society: cargo build"]);
});

test("the file keeps the 300 commands run most recently", async () => {
    const peaks = fileCommandPeaks(root, now);
    for (let index = 0; index < 301; index += 1) {
        await peaks.record(`rule @repo: cargo test -p crate-${index}`, `cargo test -p crate-${index}`, GIB);
        clock += 1_000;
    }
    const file = await storedFile();
    expect(file.commands).toHaveLength(300);
    expect(file.commands[0]?.key).toBe("rule @repo: cargo test -p crate-300");
    expect(await peaks.learned("rule @repo: cargo test -p crate-0")).toBeUndefined();
    expect(await peaks.learned("rule @repo: cargo test -p crate-1")).toEqual({ command: "cargo test -p crate-1", peakBytes: GIB, runs: 1 });
});
