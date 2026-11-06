import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pollUntil } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { freshImport } from "@intentic/testing/bun";
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

// Each case below gets a repository of its own, so no fold another case kept is in play.
const git = async (repo: string, ...args: string[]): Promise<string> =>
    (await exec("git", ["-C", join(root, repo), ...args], { env: GIT_ENV })).stdout.trim();

const newRepo = async (repo: string): Promise<void> => {
    await mkdir(join(root, repo), { recursive: true });
    await git(repo, "init", "-q");
};

// Writes the files and commits them, returning the new head.
const commit = async (repo: string, files: Readonly<Record<string, string>>, message: string): Promise<string> => {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, repo, path, ".."), { recursive: true });
        await writeFile(join(root, repo, path), content);
    }
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", message);
    return await git(repo, "rev-parse", "HEAD");
};

// Only path and repo matter to churn; the rest is filler.
const entriesIn = (repo: string, paths: readonly string[]): FileEntry[] =>
    paths.map((path) => ({ path: `${repo}/${path}`, abs: join(root, repo, path), mtimeMs: 0, size: 0, repo }));

// A read from scratch to compare against: a window reaching back fifty years is never served from a kept fold.
const fromScratch = (entries: readonly FileEntry[]) => churnOf(root, entries, { since: "600m" });

// The `git log` invocations a read ran, as git's own trace names them.
let traces = 0;
const logsDuring = async <T>(read: () => Promise<T>): Promise<{ value: T; logs: string[] }> => {
    const tracePath = join(root, `git-trace-${(traces += 1)}.log`);
    const previous = process.env["GIT_TRACE"];
    process.env["GIT_TRACE"] = tracePath;
    let value: T;
    try {
        value = await read();
    } finally {
        if (previous === undefined) {
            delete process.env["GIT_TRACE"];
        } else {
            process.env["GIT_TRACE"] = previous;
        }
    }
    const trace = (await readFile(tracePath, "utf8").catch(undefinedIfMissing)) ?? "";
    const logs = trace
        .split("\n")
        .filter((line) => line.includes("built-in: git log "))
        .map((line) => line.slice(line.indexOf("git log ")).replaceAll("'", ""));
    return { value, logs };
};

test("a fast-forward reads only the new commits, and the fold matches a read from scratch", async () => {
    await newRepo("ff");
    const first = await commit("ff", { "a.ts": "one\ntwo\n", "b.ts": "bee\n" }, "first");
    const entries = entriesIn("ff", ["a.ts", "b.ts", "c.ts", "d.ts", "img.bin"]);
    expect((await churnOf(root, entries, {})).get("ff/a.ts")).toMatchObject({ commits: 1, adds: 2, dels: 0 });

    await git("ff", "mv", "b.ts", "d.ts");
    await commit("ff", { "a.ts": "one\nTWO\nthree\n", "c.ts": "sea\n", "img.bin": "\u0000\u0001binary" }, "second");
    const third = await commit("ff", { "c.ts": "sea\nsaw\n" }, "third");

    const { value: brought, logs } = await logsDuring(() => churnOf(root, entries, {}));
    expect(logs).toEqual([`git log --numstat --format=commit:%ct ${first}..${third} --`]);
    expect(brought).toEqual(await fromScratch(entries));
    expect(brought.get("ff/a.ts")).toMatchObject({ commits: 2, adds: 4, dels: 1 });
    // A binary counts as a commit with no lines; a rename (`{b.ts => d.ts}`) names neither path, as before.
    expect(brought.get("ff/img.bin")).toMatchObject({ commits: 1, adds: 0, dels: 0 });
    expect(brought.get("ff/d.ts")).toBeUndefined();
    expect(brought.get("ff/b.ts")).toMatchObject({ commits: 1, adds: 1 });
});

test("a head that is not a descendant (an amend, a reset) reads all of history again", async () => {
    await newRepo("rw");
    await commit("rw", { "a.ts": "one\n" }, "first");
    await commit("rw", { "a.ts": "one\ntwo\n", "b.ts": "bee\n" }, "second");
    const entries = entriesIn("rw", ["a.ts", "b.ts"]);
    expect((await churnOf(root, entries, {})).get("rw/a.ts")?.commits).toBe(2);

    await writeFile(join(root, "rw/a.ts"), "one\nTWO\nthree\n");
    await git("rw", "commit", "-q", "-a", "--amend", "-m", "second, again");
    const amended = await git("rw", "rev-parse", "HEAD");

    const { value: reread, logs } = await logsDuring(() => churnOf(root, entries, {}));
    expect(logs).toEqual([`git log --numstat --format=commit:%ct ${amended} --`]);
    expect(reread).toEqual(await fromScratch(entries));
    expect(reread.get("rw/a.ts")).toMatchObject({ commits: 2, adds: 3, dels: 0 });
});

// A loose blob removed: HEAD and the ancestry still read, but numstat cannot count the file's lines and git fails.
const loseBlob = async (repo: string, path: string): Promise<void> => {
    const blob = await git(repo, "rev-parse", `HEAD:${path}`);
    await rm(join(root, repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
};

test("a history read that fails serves the last fold, told once per failing streak", async () => {
    await newRepo("st");
    await commit("st", { "a.ts": "one\n" }, "first");
    const entries = entriesIn("st", ["a.ts", "lost.ts"]);
    const told: Error[] = [];
    const history = { onStale: (error: Error) => void told.push(error) };
    const kept = await churnOf(root, entries, {}, history);
    expect(kept.get("st/a.ts")).toMatchObject({ commits: 1 });

    await commit("st", { "a.ts": "one\ntwo\n", "lost.ts": "gone\n" }, "second");
    await loseBlob("st", "lost.ts");

    expect(await churnOf(root, entries, {}, history)).toEqual(kept);
    expect(await churnOf(root, entries, {}, history)).toEqual(kept);
    expect(told).toHaveLength(1);
    expect(told[0]!.message).toContain("unable to read");
});

test("with nothing kept, a failed history read fails its caller", async () => {
    await newRepo("cold");
    await commit("cold", { "lost.ts": "gone\n" }, "first");
    await loseBlob("cold", "lost.ts");
    await expect(churnOf(root, entriesIn("cold", ["lost.ts"]), {}, { onStale: () => undefined })).rejects.toThrow("unable to read");
});

test("a kept fold survives a restart: the next process reads only what is new, and a damaged file reads all again", async () => {
    await newRepo("pd");
    await commit("pd", { "a.ts": "one\n" }, "first");
    const second = await commit("pd", { "a.ts": "one\ntwo\n", "b.ts": "bee\n" }, "second");
    const entries = entriesIn("pd", ["a.ts", "b.ts"]);
    const dir = join(root, "kept-churn");
    const kept = await churnOf(root, entries, {}, { dir });
    // Written behind the answer, never in its way.
    const written = async (): Promise<string[]> => ((await readdir(dir).catch(undefinedIfMissing)) ?? []).filter((name) => name.endsWith(".txt"));
    expect(await pollUntil(async () => (await written()).length === 1, { intervalMs: 20, timeoutMs: 10_000 })).toBe(true);

    // A fresh module is a fresh process as far as kept state goes.
    const restarted = await freshImport<typeof import("./git.js")>("./git.js", import.meta.url);
    const same = await logsDuring(() => restarted.churnOf(root, entries, {}, { dir }));
    expect(same.logs).toEqual([]);
    expect(same.value).toEqual(kept);

    const third = await commit("pd", { "b.ts": "bee\nbuzz\n" }, "third");
    const moved = await logsDuring(() => restarted.churnOf(root, entries, {}, { dir }));
    expect(moved.logs).toEqual([`git log --numstat --format=commit:%ct ${second}..${third} --`]);
    expect(moved.value).toEqual(await fromScratch(entries));

    // The fold of `third` is written behind that answer too; damaged before it lands, it would be repaired under us.
    const [name] = await written();
    const headOf = async (): Promise<string | undefined> => (await readFile(join(dir, name!), "utf8")).split("\n")[2];
    expect(await pollUntil(async () => (await headOf()) === third, { intervalMs: 20, timeoutMs: 10_000 })).toBe(true);
    await writeFile(join(dir, name!), "iq-churn 1\nnot a fold\n");
    const damaged = await freshImport<typeof import("./git.js")>("./git.js", import.meta.url);
    const reread = await logsDuring(() => damaged.churnOf(root, entries, {}, { dir }));
    expect(reread.logs).toEqual([`git log --numstat --format=commit:%ct ${third} --`]);
    expect(reread.value).toEqual(moved.value);
});
