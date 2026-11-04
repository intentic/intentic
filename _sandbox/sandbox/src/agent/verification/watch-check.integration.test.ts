import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { requires } from "@intentic/testing/requires";
import { createTurnIsolation } from "../../conversations/worktrees/isolation.js";
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

const namespace = requires(
    existsSync(HISTORY_ROOT) && spawnSync("unshare", ["--mount", "--propagation", "private", "true"], { timeout: 10_000 }).status === 0,
    `CAP_SYS_ADMIN (unshare --mount) and the history volume at ${HISTORY_ROOT}`,
    // CI's verify-machine job runs it, in a privileged container with a tmpfs at /history (ci.yml).
    { lane: "machine" },
);

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

test.skipIf(!namespace.runs)(namespace.title("an isolated conversation's check sees the conversation's own tree at the workspace path"), async () => {
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

test.skipIf(!namespace.runs)(namespace.title("starts in the workspace root as the turn saw it, so a relative path means what it meant there"), async () => {
    const w = await world();
    try {
        const result = await w.check("cat marker", { cwd: w.worktree, env: {}, placement: { worktree: w.worktree, fenced: false } });
        expect(result).toEqual({ exitCode: 0, output: "mine" });
    } finally {
        await w.dispose();
    }
});

test.skipIf(!namespace.runs)(namespace.title("a fenced conversation's check cannot see what its fence hides"), async () => {
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

const jailRuns = requires(
    existsSync(HISTORY_ROOT) &&
        spawnSync("bwrap", ["--unshare-user", "--unshare-pid", "--disable-userns", "--cap-drop", "ALL", "--ro-bind", "/", "/", "true"], { timeout: 10_000 })
            .status === 0,
    `bubblewrap with user namespaces, and the history volume at ${HISTORY_ROOT}`,
    { lane: "machine" },
);

// While conversations can be private, a main-tree conversation's check runs in the jail its turns do: the directory it
// was armed in, and nothing of the history volume around the workspace. Asked per check, so the rule applies at once.
test.skipIf(!jailRuns.runs)(jailRuns.title("while conversations can be private a check runs in the jail, out of reach of the history volume"), async () => {
    const base = await mkdtemp(join(HISTORY_ROOT, ".watch-jail-"));
    try {
        const root = join(base, "work");
        const unit = join(base, "history", "conversations", "conv-2");
        await mkdir(join(root, "app"), { recursive: true });
        await mkdir(unit, { recursive: true });
        await writeFile(join(unit, "record.jsonl"), "their words\n");
        const isolation = createTurnIsolation({ root, historyRoot: join(base, "history"), logger });
        let wanted = true;
        const check = watchCheck(isolation, { wanted: async () => wanted, root, gits: join(base, "gits") });
        const script = `pwd; test -e ${join(unit, "record.jsonl")} && echo reached || echo out-of-reach`;
        expect(await check(script, { cwd: join(root, "app"), env: {} })).toEqual({ exitCode: 0, output: `${join(root, "app")}\nout-of-reach` });
        wanted = false;
        expect(await check(script, { cwd: join(root, "app"), env: {} })).toEqual({ exitCode: 0, output: `${join(root, "app")}\nreached` });
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
