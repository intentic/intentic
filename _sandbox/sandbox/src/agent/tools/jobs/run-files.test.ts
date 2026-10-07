import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunFile, readRunFile, renameRunFile, writeRunFile } from "./run-files.js";

// A fenced turn owns its capture dirs as root owns them, so whatever the daemon writes or reads there must not follow a
// link the turn planted, at the file's own name or in place of the dir.

const dirs: string[] = [];
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "run-files-"));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writes, appends, renames and reads a run's files, the last bytes when asked", () => {
    const run = scratch();
    writeRunFile(run, "out", "first\n");
    appendRunFile(run, "out", "second\n");
    writeRunFile(run, "status.part", "0\n");
    renameRunFile(run, "status.part", "status");
    expect(readFileSync(join(run, "out"), "utf8")).toBe("first\nsecond\n");
    expect(readRunFile(run, "status").text).toBe("0\n");
    expect(readRunFile(run, "out", 7).text).toBe("second\n");
    expect(readRunFile(run, "out").mtimeMs).toBeGreaterThan(0);
});

test("a link planted at a file's name is neither written through nor read through", () => {
    const run = scratch();
    const kept = join(scratch(), "rc");
    writeFileSync(kept, "root's own\n");
    symlinkSync(kept, join(run, "job.json.tmp"));
    symlinkSync(kept, join(run, "out"));
    expect(() => writeRunFile(run, "job.json.tmp", '{"command":"$(evil)"}')).toThrow();
    expect(() => appendRunFile(run, "out", "more")).toThrow();
    expect(() => readRunFile(run, "out")).toThrow();
    expect(readFileSync(kept, "utf8")).toBe("root's own\n");
});

test("a run dir that is itself a link is refused", () => {
    const elsewhere = scratch();
    writeFileSync(join(elsewhere, "out"), "a hidden file\n");
    const run = join(scratch(), "intentic-run-x");
    symlinkSync(elsewhere, run);
    expect(() => readRunFile(run, "out")).toThrow();
    expect(() => writeRunFile(run, "agent", "echo hi")).toThrow();
    expect(readFileSync(join(elsewhere, "out"), "utf8")).toBe("a hidden file\n");
});
