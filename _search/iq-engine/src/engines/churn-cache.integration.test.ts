import { execFile } from "node:child_process";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { makeFixtureWorkspace } from "../testing.js";
import type { FileEntry } from "../types.js";
import { churnOf } from "./git.js";

const exec = promisify(execFile);
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture-author",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture-author",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
};

let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
});
afterAll(() => cleanup());

const entryOf = async (path: string): Promise<FileEntry> => {
    const abs = join(root, path);
    const info = await stat(abs);
    return { path, abs, mtimeMs: info.mtimeMs, size: info.size, repo: "alpha" };
};

// The all-history log is held while HEAD stays put; a new commit has to show up on the very next read.
test("all-history churn is reused for one HEAD and re-read once HEAD moves", async () => {
    const entries = [await entryOf("alpha/src/widget.ts")];
    const before = await churnOf(root, entries, {});
    expect(before.get("alpha/src/widget.ts")?.commits).toBe(1);
    expect((await churnOf(root, entries, {})).get("alpha/src/widget.ts")).toEqual(before.get("alpha/src/widget.ts"));

    await appendFile(join(root, "alpha/src/widget.ts"), "\nexport const another = 1;\n");
    await exec("git", ["-C", join(root, "alpha"), "commit", "-q", "-am", "touch widget"], { env: GIT_ENV });

    const after = await churnOf(root, entries, {});
    expect(after.get("alpha/src/widget.ts")?.commits).toBe(2);
    // A windowed read is never served from the all-history copy.
    expect((await churnOf(root, entries, { since: "1d" })).get("alpha/src/widget.ts")?.commits).toBe(2);
});
