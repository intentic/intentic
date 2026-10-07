import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { requires } from "@intentic/testing/requires";
import { nsenterArgv } from "../../workload/namespace-entry.js";
import { hiddenIn, type IsolationAnchor } from "./isolation.js";
import { type FencedPlan, SANDBOX_UID, type SandboxSources, startSandboxAnchor } from "./turn-sandbox.js";

// A real fenced sandbox around a small workspace: what a turn inside can see, what it holds, and when it ends. The argv
// is pinned in turn-sandbox.test.ts; this is the kernel's answer to it.

const sandbox = requires(
    existsSync(HISTORY_ROOT) &&
        spawnSync("bwrap", ["--unshare-user", "--unshare-pid", "--disable-userns", "--cap-drop", "ALL", "--ro-bind", "/", "/", "true"], { timeout: 10_000 })
            .status === 0,
    `bubblewrap with user namespaces, and the history volume at ${HISTORY_ROOT}`,
    { lane: "machine" },
);

interface World {
    readonly base: string;
    readonly plan: FencedPlan;
    readonly sources: SandboxSources;
    readonly neighbour: string;
}

// A main checkout holding two areas, a dependency tree hard-linked from the package store as pnpm installs it, and a
// shelf of two folders; this conversation's sparse checkout holding one area with its repository pointer, and a folder
// of the other left behind (a narrowing that failed); a neighbour conversation's checkout; and a daemon home holding a
// key no turn should see. The fence: the one area, and one folder of the shelf.
const world = async (): Promise<World> => {
    const base = await mkdtemp(join(HISTORY_ROOT, ".turn-sandbox-"));
    const main = join(base, "work");
    const worktree = join(base, "history", "worktrees", "conv-1");
    const neighbour = join(base, "history", "worktrees", "conv-2");
    const home = join(base, "home");
    for (const dir of [
        join(main, "support"),
        join(main, "finance"),
        join(main, "node_modules", "dep"),
        join(main, ".pnpm-store", "files"),
        join(main, "refs", "sdk"),
        join(main, "refs", "private"),
        join(worktree, "support"),
        join(worktree, "finance"),
        neighbour,
        join(home, ".ssh"),
    ]) {
        await mkdir(dir, { recursive: true });
    }
    await writeFile(join(main, ".pnpm-store", "files", "dep-linked"), "stored");
    await link(join(main, ".pnpm-store", "files", "dep-linked"), join(main, "node_modules", "dep", "linked.js"));
    await writeFile(join(main, "refs", "sdk", "README.md"), "sdk");
    await writeFile(join(main, "refs", "private", "notes.md"), "private");
    await writeFile(join(worktree, "finance", "leftover.csv"), "left behind");
    await writeFile(join(main, "finance", "payroll.csv"), "main's");
    await writeFile(join(main, "node_modules", "dep", "index.js"), "dependency");
    await writeFile(join(worktree, "support", "notes.md"), "mine");
    await writeFile(join(worktree, ".git"), "gitdir: /history/gits/root/worktrees/conv-1\n");
    await writeFile(join(neighbour, "draft.md"), "theirs");
    await writeFile(join(home, ".bashrc"), "# shell");
    await writeFile(join(home, ".ssh", "id_ed25519"), "key");
    const folders = ["support", "refs/sdk"];
    const plan: FencedPlan = {
        worktree,
        root: main,
        mirrors: ["node_modules"],
        overlays: join(base, "history", "overlays", "conv-1"),
        fence: {
            folders,
            hidden: await hiddenIn(worktree, folders),
            sessions: join(base, "history", "conversations", "conv-1", "sessions"),
            gitPointers: [""],
        },
    };
    const sources: SandboxSources = { home, engines: join(base, "engines"), queue: join(base, "queue") };
    return { base, plan, sources, neighbour };
};

const inside = (anchor: IsolationAnchor, script: string) => {
    const entry = nsenterArgv(anchor.pid, anchor.cwd, "sh", ["-c", script]);
    const ran = spawnSync(entry.command, entry.args, { encoding: "utf8", timeout: 20_000 });
    return { code: ran.status, out: `${ran.stdout}${ran.stderr}`.trim() };
};

// A zombie has ended: what it lacks is a parent to collect its exit status, which is PID 1's job once its own parent
// has gone. A sandbox's container runs docker-init there, which collects; CI's job container runs `tail -f /dev/null`,
// which never does, so there every ended anchor stayed a zombie and read as running.
const alive = (pid: number): boolean => {
    let stat: string;
    try {
        stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    } catch {
        return false;
    }
    // The state follows the command, which is in parentheses and may hold any character, the last ")" included.
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
};

const until = async (condition: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (condition()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return condition();
};

test.skipIf(!sandbox.runs)(sandbox.title("a fenced turn sees its own checkout at the workspace root and nothing else of the workspace"), async () => {
    const w = await world();
    const anchor = await startSandboxAnchor(w.plan, w.sources);
    try {
        expect(inside(anchor, "pwd; cat support/notes.md")).toEqual({ code: 0, out: `${w.plan.root}\nmine` });
        // The other area, present in the main checkout, is not on this filesystem: at most an empty cover where the
        // checkout still held its directory.
        expect(inside(anchor, `test -e ${join(w.plan.root, "finance", "payroll.csv")}`).code).toBe(1);
        // Nor is another conversation's checkout, nor the history volume around them.
        expect(inside(anchor, `test -e ${join(w.neighbour, "draft.md")}`).code).toBe(1);
        expect(inside(anchor, `ls ${join(w.base, "history", "worktrees")}`).code).not.toBe(0);
        // Dependencies come in as an overlay of the main tree's, and what the turn writes there stays in its layer.
        expect(inside(anchor, "cat node_modules/dep/index.js && echo && echo built > node_modules/dep/out.txt && cat node_modules/dep/out.txt")).toEqual({
            code: 0,
            out: "dependency\nbuilt",
        });
        expect(existsSync(join(w.plan.root, "node_modules", "dep", "out.txt"))).toBe(false);
        // What it writes in its checkout is in the conversation's worktree, where the daemon commits it from.
        expect(inside(anchor, "echo edited > support/notes.md").code).toBe(0);
        expect(spawnSync("cat", [join(w.plan.worktree, "support", "notes.md")], { encoding: "utf8" }).stdout).toBe("edited\n");
    } finally {
        anchor.dispose();
        await rm(w.base, { recursive: true, force: true });
    }
});

test.skipIf(!sandbox.runs)(sandbox.title("the fence, not the checkout, decides what of the shelf, the store and leftovers a fenced turn reaches"), async () => {
    const w = await world();
    const anchor = await startSandboxAnchor(w.plan, w.sources);
    try {
        // The shelf folder the fence names, and not its sibling.
        expect(inside(anchor, `cat ${join(w.plan.root, "refs", "sdk", "README.md")}`)).toEqual({ code: 0, out: "sdk" });
        expect(inside(anchor, `test -e ${join(w.plan.root, "refs", "private", "notes.md")}`).code).toBe(1);
        // A folder of the other area still in the checkout is covered, and the file is untouched on disk.
        expect(inside(anchor, "ls finance").out).toBe("");
        expect(await readFile(join(w.plan.worktree, "finance", "leftover.csv"), "utf8")).toBe("left behind");
        // The turn is the owner of the store's files, and they are the same inodes as the main checkout's dependencies:
        // a write through the store stays in the conversation's layer.
        expect(inside(anchor, `cat .pnpm-store/files/dep-linked && echo tampered > .pnpm-store/files/dep-linked`)).toEqual({ code: 0, out: "stored" });
        expect(await readFile(join(w.plan.root, "node_modules", "dep", "linked.js"), "utf8")).toBe("stored");
        expect(await readFile(join(w.plan.root, ".pnpm-store", "files", "dep-linked"), "utf8")).toBe("stored");
    } finally {
        anchor.dispose();
        await rm(w.base, { recursive: true, force: true });
    }
});

test.skipIf(!sandbox.runs)(sandbox.title("the repository pointer reads empty, so git finds no history in a fenced checkout"), async () => {
    const w = await world();
    const anchor = await startSandboxAnchor(w.plan, w.sources);
    try {
        expect(inside(anchor, "wc -c < .git").out).toBe("0");
        expect(inside(anchor, "git rev-parse HEAD").code).not.toBe(0);
        // The pointer itself is untouched outside: the daemon's own git still works on the worktree.
        expect(spawnSync("cat", [join(w.plan.worktree, ".git")], { encoding: "utf8" }).stdout).toContain("gitdir:");
    } finally {
        anchor.dispose();
        await rm(w.base, { recursive: true, force: true });
    }
});

test.skipIf(!sandbox.runs)(sandbox.title("an entrant holds no capability, cannot gain one, and sees only the sandbox's own processes"), async () => {
    const w = await world();
    const anchor = await startSandboxAnchor(w.plan, w.sources);
    try {
        expect(inside(anchor, "id -u").out).toBe(String(SANDBOX_UID));
        const status = inside(anchor, "grep -E '^(CapEff|CapPrm|NoNewPrivs):' /proc/self/status").out;
        expect(status).toContain("CapEff:\t0000000000000000");
        expect(status).toContain("CapPrm:\t0000000000000000");
        expect(status).toContain("NoNewPrivs:\t1");
        // Its own pid namespace: the anchor and this shell, not the daemon's process table.
        const pids = Number(inside(anchor, "ls -d /proc/[0-9]* | wc -l").out);
        expect(pids).toBeLessThan(10);
    } finally {
        anchor.dispose();
        await rm(w.base, { recursive: true, force: true });
    }
});

test.skipIf(!sandbox.runs)(sandbox.title("the home holds the listed dotfiles and none of the daemon's credentials"), async () => {
    const w = await world();
    const anchor = await startSandboxAnchor(w.plan, w.sources);
    try {
        expect(inside(anchor, `cat ${join(w.sources.home, ".bashrc")}`).out).toBe("# shell");
        expect(inside(anchor, `test -e ${join(w.sources.home, ".ssh")}`).code).toBe(1);
        expect(inside(anchor, "test -s /etc/shadow").code).toBe(1);
    } finally {
        anchor.dispose();
        await rm(w.base, { recursive: true, force: true });
    }
});

test.skipIf(!sandbox.runs)(sandbox.title("released, the sandbox ends once nothing the turn started is running, and not before"), async () => {
    const w = await world();
    const anchor = await startSandboxAnchor(w.plan, w.sources);
    try {
        // Something the turn left running, like a dev server the person kept.
        const entry = nsenterArgv(anchor.pid, anchor.cwd, "sh", ["-c", "sleep 6 >/dev/null 2>&1 &"]);
        expect(spawnSync(entry.command, entry.args, { timeout: 10_000 }).status).toBe(0);
        anchor.dispose();
        // Still up while it runs; gone within a few anchor ticks once it has ended.
        expect(await until(() => !alive(anchor.pid), 4_000)).toBe(false);
        expect(await until(() => !alive(anchor.pid), 15_000)).toBe(true);
    } finally {
        anchor.dispose();
        await rm(w.base, { recursive: true, force: true });
    }
});
