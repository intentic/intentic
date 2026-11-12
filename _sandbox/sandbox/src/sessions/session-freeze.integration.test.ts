import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { type ColdFile, freezeSession, thawClaudeSession } from "./session-freeze.js";

// A Claude session compressed by the cold-session sweep and thawed back by a reader. Integration suite: real files.

const DAY_MS = 24 * 60 * 60_000;

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A store with one project folder, where the CLI files a session run from /work.
const storeWith = async (): Promise<{ readonly store: string; readonly project: string }> => {
    const store = await mkdtemp(join(tmpdir(), "session-freeze-"));
    roots.push(store);
    const project = join(store, "projects", "-work");
    await mkdir(project, { recursive: true });
    return { store, project };
};

// JSONL as the CLI writes it, long enough that compressing it saves something.
const transcript = (lines: number): string =>
    Array.from({ length: lines }, (_, index) => `${JSON.stringify({ type: "user", uuid: `u${index}`, message: { content: `line ${index} ${"x".repeat(index % 60)}` } })}\n`).join("");

// A file written `ageMs` ago, the CLI's mode, as the sweep would have found it.
const coldFile = async (path: string, text: string, ageMs: number): Promise<ColdFile> => {
    await writeFile(path, text, { mode: 0o600 });
    const at = new Date(Date.now() - ageMs);
    await utimes(path, at, at);
    return { path, seen: await lstat(path) };
};

test("a frozen session thaws back byte for byte, its subagents with it, under its own mode and mtime", async () => {
    const { store, project } = await storeWith();
    const session = randomUUID();
    const main = await coldFile(join(project, `${session}.jsonl`), transcript(2_000), 8 * DAY_MS);
    const subagents = join(project, session, "subagents");
    await mkdir(subagents, { recursive: true });
    const child = await coldFile(join(subagents, "agent-a1b2c3.jsonl"), transcript(300), 9 * DAY_MS);
    await writeFile(join(subagents, "agent-a1b2c3.meta.json"), "{}");

    const frozen = await freezeSession(session, [child, main], Date.now() + 1);
    expect(frozen.files).toBe(2);
    expect(frozen.bytesIn).toBe(main.seen.size + child.seen.size);
    expect(frozen.bytesOut).toBeLessThan(frozen.bytesIn / 5);
    expect((await readdir(project)).toSorted()).toEqual([session, `${session}.jsonl.zst`]);
    expect((await readdir(subagents)).toSorted()).toEqual(["agent-a1b2c3.jsonl.zst", "agent-a1b2c3.meta.json"]);
    // A plain zstd stream: `zstdcat` reads it as the JSONL it holds.
    expect(zstdDecompressSync(await readFile(`${main.path}.zst`)).toString("utf8")).toBe(transcript(2_000));

    expect(await thawClaudeSession(store, session)).toEqual({ thawed: 2, failed: [] });
    expect(await readFile(main.path, "utf8")).toBe(transcript(2_000));
    expect(await readFile(child.path, "utf8")).toBe(transcript(300));
    const back = await lstat(main.path);
    expect(Math.round(back.mtimeMs)).toBe(Math.round(main.seen.mtimeMs));
    expect(back.mode & 0o777).toBe(0o600);
    expect((await readdir(project)).toSorted()).toEqual([session, `${session}.jsonl`]);
    expect((await readdir(subagents)).toSorted()).toEqual(["agent-a1b2c3.jsonl", "agent-a1b2c3.meta.json"]);
    expect(await thawClaudeSession(store, session)).toEqual({ thawed: 0, failed: [] });
});

test("a session in another project folder is found by its id alone", async () => {
    const { store } = await storeWith();
    const elsewhere = join(store, "projects", "-work-intentic-worktrees-calm-vale");
    await mkdir(elsewhere, { recursive: true });
    const session = randomUUID();
    const main = await coldFile(join(elsewhere, `${session}.jsonl`), transcript(50), 8 * DAY_MS);
    expect((await freezeSession(session, [main], Date.now() + 1)).files).toBe(1);
    expect(await thawClaudeSession(store, session)).toEqual({ thawed: 1, failed: [] });
    expect(await readFile(main.path, "utf8")).toBe(transcript(50));
    expect(await thawClaudeSession(store, "../escape")).toEqual({ thawed: 0, failed: [] });
});

test("a freeze leaves the plain file as it was when a reader wanted the session, or the file moved, since it was judged", async () => {
    const { store, project } = await storeWith();
    const session = randomUUID();
    const main = await coldFile(join(project, `${session}.jsonl`), transcript(100), 8 * DAY_MS);
    const judged = Date.now() - 1_000;
    await thawClaudeSession(store, session);
    expect(await freezeSession(session, [main], judged)).toEqual({ files: 0, bytesIn: 0, bytesOut: 0 });
    expect(await readdir(project)).toEqual([`${session}.jsonl`]);

    await appendFile(main.path, transcript(1));
    expect((await freezeSession(session, [main], Date.now() + 1)).files).toBe(0);
    expect(await readdir(project)).toEqual([`${session}.jsonl`]);
    expect(await readFile(main.path, "utf8")).toBe(transcript(100) + transcript(1));
});

test("a name found both plain and compressed is left as it is by a thaw and by a freeze", async () => {
    const { store, project } = await storeWith();
    const session = randomUUID();
    const main = await coldFile(join(project, `${session}.jsonl`), "new\n", 8 * DAY_MS);
    await writeFile(`${main.path}.zst`, zstdCompressSync(Buffer.from("old\n")));
    expect(await thawClaudeSession(store, session)).toEqual({ thawed: 0, failed: [] });
    expect((await freezeSession(session, [main], Date.now() + 1)).files).toBe(0);
    expect(await readFile(main.path, "utf8")).toBe("new\n");
    expect(zstdDecompressSync(await readFile(`${main.path}.zst`)).toString("utf8")).toBe("old\n");
    expect((await readdir(project)).toSorted()).toEqual([`${session}.jsonl`, `${session}.jsonl.zst`]);
});

test("a compressed file that does not decompress stays where it was, and the thaw says so", async () => {
    const { store, project } = await storeWith();
    const session = randomUUID();
    await writeFile(join(project, `${session}.jsonl.zst`), "not zstd at all");
    const thawed = await thawClaudeSession(store, session);
    expect(thawed.thawed).toBe(0);
    expect(thawed.failed.map((failure) => failure.path)).toEqual([join(project, `${session}.jsonl`)]);
    expect(await readdir(project)).toEqual([`${session}.jsonl.zst`]);
});
