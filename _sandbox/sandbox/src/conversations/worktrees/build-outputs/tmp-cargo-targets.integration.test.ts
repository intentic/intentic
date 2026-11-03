import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTmpTargets, IDLE_MS, reapTmpCargoTargets } from "./tmp-cargo-targets.js";

const CARGO_TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n";
const NOW = 100 * IDLE_MS;
const logger = { info: () => {}, warn: () => {} };

let root: string;

// A Cargo target at `rel` below the fake /tmp, every folder in it last written `ageMs` ago.
const target = (rel: string, ageMs: number): string => {
    const dir = join(root, rel);
    mkdirSync(join(dir, "debug", "deps"), { recursive: true });
    writeFileSync(join(dir, "CACHEDIR.TAG"), CARGO_TAG);
    const at = new Date(NOW - ageMs);
    for (const path of [join(dir, "debug", "deps"), join(dir, "debug"), dir]) {
        utimesSync(path, at, at);
    }
    return dir;
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tmp-targets-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("an idle Cargo target nothing names goes; a fresh one, one in use and anything untagged stay", async () => {
    const idle = target("shinobi-wasm", 2 * IDLE_MS);
    const nested = target("scratch/target", 2 * IDLE_MS);
    const fresh = target("today", IDLE_MS / 2);
    const inUse = target("queued", 2 * IDLE_MS);
    const named = target("argv", 2 * IDLE_MS);
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n# another tool\n");
    expect((await findTmpTargets(root)).toSorted()).toEqual([named, fresh, inUse, nested, idle].toSorted());

    const removed = await reapTmpCargoTargets({
        root,
        now: NOW,
        logger,
        programs: async () => [{ argv: ["cargo", "build", "--target-dir", named] }],
        targetDirs: async () => [inUse],
    });
    expect(removed.toSorted()).toEqual([idle, nested].toSorted());
    for (const kept of [fresh, inUse, named, join(root, "notes")]) {
        expect(existsSync(kept)).toBe(true);
    }
});
