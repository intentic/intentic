import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import { whenFileAppears } from "./file-appears.js";

const dirs: string[] = [];
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "file-appears-"));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("fires once when the file is renamed into place, the way tmux-run publishes a status", async () => {
    const dir = scratch();
    let seen = 0;
    const stop = whenFileAppears(join(dir, "status"), () => (seen += 1));
    expect(stop).toEqual(expect.any(Function));
    writeFileSync(join(dir, "other"), "x");
    writeFileSync(join(dir, "status.part"), "0\n");
    renameSync(join(dir, "status.part"), join(dir, "status"));
    await waitFor(() => expect(seen).toBe(1));
    writeFileSync(join(dir, "status"), "1\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toBe(1);
});

test("fires at once for a file that is already there", () => {
    const dir = scratch();
    writeFileSync(join(dir, "status"), "0\n");
    let seen = 0;
    whenFileAppears(join(dir, "status"), () => (seen += 1));
    expect(seen).toBe(1);
});

test("a stopped watch never fires", async () => {
    const dir = scratch();
    let seen = 0;
    whenFileAppears(join(dir, "status"), () => (seen += 1))?.();
    writeFileSync(join(dir, "status"), "0\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toBe(0);
});

test("answers undefined for a directory it cannot watch, leaving the caller's clock to notice", () => {
    expect(whenFileAppears(join(tmpdir(), "file-appears-missing-dir", "status"), () => undefined)).toBeUndefined();
});
