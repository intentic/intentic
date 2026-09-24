import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The pause lives at ~/.intentic/machine/paused, derived from homedir() at import time, so HOME points at a throwaway
// dir before the dynamic import.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "machine-pause-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { readPausedAt } = await import("./indicator.js");
const { baseDir } = await import("../config.js");
const { mkdir, rm, symlink, writeFile } = await import("node:fs/promises");

const pausePath = join(baseDir, "paused");

beforeEach(async () => {
    await mkdir(baseDir, { recursive: true });
    await rm(pausePath, { force: true });
});

test("no pause file is no pause", async () => {
    expect(await readPausedAt()).toBeUndefined();
});

test("a pause file is the pause, dated when the person pressed it", async () => {
    await writeFile(pausePath, "");
    expect(await readPausedAt()).toBeInstanceOf(Date);
});

// The person's stop for the mouse and keyboard: a file that is there but cannot be looked at must not read as lifted.
// A link that loops stands in for EACCES, which a test running as root cannot provoke.
test("a pause file that cannot be read throws rather than reading as no pause", async () => {
    await symlink("paused", pausePath);
    await expect(readPausedAt()).rejects.toThrow(expect.objectContaining({ code: "ELOOP" }));
});
