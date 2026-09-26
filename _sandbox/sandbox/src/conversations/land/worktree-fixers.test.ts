import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pino } from "pino";
import { runWorktreeFixers, WORKTREE_FIXERS } from "./worktree-fixers.js";

// The repository's own fixers, run in a conversation's worktree before its land: only where the repository ships them,
// on what the turn changed since the commit it started from, and never failing the land it runs before.

const logger = pino({ level: "silent" });
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A worktree, shipping the fixers or not.
const worktree = (ships: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-fixers-"));
    dirs.push(dir);
    if (ships) {
        mkdirSync(dirname(join(dir, WORKTREE_FIXERS)), { recursive: true });
        writeFileSync(join(dir, WORKTREE_FIXERS), "");
    }
    return dir;
};

describe("the worktree's fixers", () => {
    test("run where the repository ships them, on what changed since the turn's start, and answer what they wrote", async () => {
        const shipping = worktree(true);
        const asked: string[][] = [];
        const runs = await runWorktreeFixers({ logger }, "c", [
            { repo: "root", from: "abc123", dir: shipping },
            { repo: "docs", from: "def456", dir: worktree(false) },
        ], async (dir, from) => {
            asked.push([dir, from]);
            return `building the contract\n{"ran":["contract lock"],"wrote":["_shared/sandbox-contract/contract.lock.json"]}\n`;
        });
        expect(asked).toEqual([[shipping, "abc123"]]);
        expect(runs).toEqual([{ repo: "root", ran: ["contract lock"], wrote: ["_shared/sandbox-contract/contract.lock.json"] }]);
    });

    test("are skipped for a repository whose starting commit is unknown", async () => {
        const runs = await runWorktreeFixers({ logger }, "c", [{ repo: "root", from: "", dir: worktree(true) }], async () => {
            throw new Error("not asked");
        });
        expect(runs).toEqual([]);
    });

    // A fixer that dies or prints something else leaves the change as the turn wrote it; the land goes on.
    test("that fail or print no answer are passed over without failing anything", async () => {
        const span = [{ repo: "root", from: "abc123", dir: worktree(true) }];
        expect(await runWorktreeFixers({ logger }, "c", span, () => Promise.reject(new Error("timed out")))).toEqual([]);
        expect(await runWorktreeFixers({ logger }, "c", span, async () => "no json here")).toEqual([]);
    });
});
