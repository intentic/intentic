import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { createTurnIsolation } from "../../agents/worktrees/isolation.js";
import { watchCheck } from "./watch-check.js";

const logger = unstubbed<Logger>("logger", { warn: () => {} });

let scratch: string;
beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "watch-check-"));
});
afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
});

// A plain check never asks about the namespace, so any isolation serves.
const plain = watchCheck(createTurnIsolation({ root: "/nonexistent-root", historyRoot: "/nonexistent-history", logger }));

test("reports the check's own exit code and what it printed", async () => {
    expect(await plain("echo waiting; exit 3", { cwd: scratch, env: {} })).toEqual({ exitCode: 3, output: "waiting" });
    expect(await plain("echo done", { cwd: scratch, env: {} })).toEqual({ exitCode: 0, output: "done" });
});

test("runs in the directory it was armed in, with the credentials it was armed with", async () => {
    const result = await plain('printf "%s %s" "$(pwd)" "$TOKEN_CI"', { cwd: scratch, env: { TOKEN_CI: "tok" } });
    expect(result).toEqual({ exitCode: 0, output: `${scratch} tok` });
});

test("a directory that is gone is a broken check, not a condition that does not hold yet", async () => {
    const result = await plain("true", { cwd: join(scratch, "gone"), env: {} });
    expect(result.exitCode).toBeUndefined();
    expect(result.broken).toContain("is gone");
});

test("an isolated conversation whose worktree is gone is a broken check", async () => {
    const result = await plain("true", { cwd: scratch, env: {}, placement: { worktree: join(scratch, "gone"), fenced: false } });
    expect(result.broken).toContain("worktree");
});

// Needs CAP_SYS_ADMIN and the history volume; skipped otherwise.
const NAMESPACE = existsSync(HISTORY_ROOT) && spawnSync("unshare", ["--mount", "--propagation", "private", "true"], { timeout: 10_000 }).status === 0;

interface World {
    readonly root: string;
    readonly worktree: string;
    readonly neighbour: string;
    readonly check: ReturnType<typeof watchCheck>;
    readonly dispose: () => Promise<void>;
}

// A workspace root and two conversations' worktrees, under the history volume like the real ones.
const world = async (): Promise<World> => {
    const base = await mkdtemp(join(HISTORY_ROOT, ".watch-check-"));
    const root = join(base, "work");
    const history = join(base, "history");
    const worktree = join(history, "worktrees", "conv-1");
    const neighbour = join(history, "worktrees", "conv-2");
    for (const dir of [root, worktree, neighbour]) {
        await mkdir(dir, { recursive: true });
    }
    await writeFile(join(worktree, "marker"), "mine");
    await writeFile(join(neighbour, "secret"), "theirs");
    const isolation = createTurnIsolation({ root, historyRoot: history, logger });
    return { root, worktree, neighbour, check: watchCheck(isolation), dispose: () => rm(base, { recursive: true, force: true }) };
};

test.skipIf(!NAMESPACE)("an isolated conversation's check sees the conversation's own tree at the workspace path", async () => {
    const w = await world();
    try {
        const placement = { worktree: w.worktree, fenced: false };
        expect((await w.check(`test -f ${join(w.root, "marker")} && pwd`, { cwd: w.worktree, env: {}, placement })).exitCode).toBe(0);
        // The daemon's own world reads the owner's checkout under the same path.
        expect((await w.check(`test -f ${join(w.root, "marker")}`, { cwd: w.root, env: {} })).exitCode).toBe(1);
    } finally {
        await w.dispose();
    }
});

test.skipIf(!NAMESPACE)("starts in the workspace root as the turn saw it, so a relative path means what it meant there", async () => {
    const w = await world();
    try {
        const result = await w.check("cat marker", { cwd: w.worktree, env: {}, placement: { worktree: w.worktree, fenced: false } });
        expect(result).toEqual({ exitCode: 0, output: "mine" });
    } finally {
        await w.dispose();
    }
});

test.skipIf(!NAMESPACE)("a fenced conversation's check cannot see what its fence hides", async () => {
    const w = await world();
    try {
        const secret = join(w.neighbour, "secret");
        expect((await w.check(`test -f ${secret}`, { cwd: w.worktree, env: {}, placement: { worktree: w.worktree, fenced: false } })).exitCode).toBe(
            0,
        );
        expect((await w.check(`test -f ${secret}`, { cwd: w.worktree, env: {}, placement: { worktree: w.worktree, fenced: true } })).exitCode).toBe(
            1,
        );
    } finally {
        await w.dispose();
    }
});
