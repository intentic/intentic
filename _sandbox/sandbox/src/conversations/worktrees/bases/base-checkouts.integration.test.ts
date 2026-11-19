import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseAsk } from "@intentic/sandbox-contract/schemas/bases";
import type { Logger } from "pino";
import type { WarmRequest } from "../build-outputs/warm-checkout.js";
import { BaseRefused, type BaseCheckoutsDeps, basesRoot, createBaseCheckouts, HOLD_IDLE_MS, SHELL_HOLDER } from "./base-checkouts.js";

// Base checkouts (base-checkouts.ts) over a real repository: which commit an ask names, one checkout per commit shared
// by its holders, restored when handed out, and removed once nobody holds it and nothing runs in it.

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const git = (cwd: string, ...args: string[]): string => {
    const ran = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    expect(ran.status).toBe(0);
    return ran.stdout.trim();
};

const quiet: Pick<Logger, "info" | "warn"> = { info: () => undefined, warn: () => undefined };

interface Fixture {
    readonly history: string;
    readonly main: string;
    // A conversation's checkout: two commits of its own on top of main's first.
    readonly checkout: string;
    readonly fork: string;
    readonly tip: string;
    readonly warmed: WarmRequest[];
    readonly deps: BaseCheckoutsDeps;
}

const fixture = async (overrides: Partial<BaseCheckoutsDeps> = {}): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), "bases-"));
    dirs.push(root);
    const main = join(root, "main");
    const checkout = join(root, "history", "worktrees", "c1");
    await mkdir(join(main, "src"), { recursive: true });
    await writeFile(join(main, "src", "lib.rs"), "pub const V: u32 = 1;\n");
    git(root, "init", "-q", "-b", "main", main);
    git(main, "add", "-A");
    git(main, "commit", "-qm", "one");
    const fork = git(main, "rev-parse", "HEAD");
    git(main, "worktree", "add", "-q", "-b", "agent/c1", checkout, fork);
    await writeFile(join(checkout, "src", "lib.rs"), "pub const V: u32 = 2;\n");
    git(checkout, "commit", "-qam", "mine");
    // Main moves on after the conversation started.
    await writeFile(join(main, "README.md"), "later\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "two");
    const warmed: WarmRequest[] = [];
    const deps: BaseCheckoutsDeps = {
        historyRoot: join(root, "history"),
        mainDir: () => main,
        withRepoLock: (_repo, task) => task(),
        repos: () => Promise.resolve(["root"]),
        live: (id) => id === "c1" || id === "c2",
        warm: (request) => {
            warmed.push(request);
            return Promise.resolve([]);
        },
        logger: quiet,
        space: () => Promise.resolve({ freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }),
        programs: () => Promise.resolve([]),
        ...overrides,
    };
    return { history: join(root, "history"), main, checkout, fork, tip: git(main, "rev-parse", "HEAD"), warmed, deps };
};

// What the `base` command sends from a checkout: its git dir, its HEAD, and the commit asked for.
const askFrom = (checkout: string, at?: BaseAsk["at"]): BaseAsk => {
    const ask: BaseAsk = { gitDir: git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"), head: git(checkout, "rev-parse", "HEAD") };
    if (at !== undefined) {
        ask.at = at;
    }
    return ask;
};

test("by default a base is the commit the conversation's work leaves the main line at, beside its checkout and never in it", async () => {
    const f = await fixture();
    const bases = createBaseCheckouts(f.deps);
    const base = await bases.ensure(askFrom(f.checkout), "c1");
    expect(base).toMatchObject({ repo: "root", commit: f.fork, created: true, holders: ["c1"], path: join(basesRoot(f.history), "root", f.fork.slice(0, 12)) });
    expect(await readFile(join(base.path, "src", "lib.rs"), "utf8")).toBe("pub const V: u32 = 1;\n");
    // The conversation's own checkout is untouched: its commit, its branch.
    expect(await readFile(join(f.checkout, "src", "lib.rs"), "utf8")).toBe("pub const V: u32 = 2;\n");
    expect(git(f.checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/c1");
    // Seeded from the asking conversation's builds first.
    expect(f.warmed).toEqual([{ checkouts: [{ repo: "root", dir: base.path }], preferred: "c1", exclude: [], label: `base root@${f.fork.slice(0, 12)}` }]);
});

test("main's tip and any commit are bases too, and an unknown commit or repository is refused in words", async () => {
    const f = await fixture();
    const bases = createBaseCheckouts(f.deps);
    expect((await bases.ensure(askFrom(f.checkout, "main"), "c1")).commit).toBe(f.tip);
    expect((await bases.ensure({ gitDir: askFrom(f.checkout).gitDir, at: f.fork }, SHELL_HOLDER)).commit).toBe(f.fork);
    await expect(bases.ensure({ gitDir: askFrom(f.checkout).gitDir, at: "0".repeat(40) }, "c1")).rejects.toBeInstanceOf(BaseRefused);
    await expect(bases.ensure({ gitDir: tmpdir(), at: "main" }, "c1")).rejects.toThrow(/not the git dir of a repository in this workspace/u);
});

test("one base per commit, shared: a second conversation is handed the same checkout, restored to its commit", async () => {
    const f = await fixture();
    const bases = createBaseCheckouts(f.deps);
    const first = await bases.ensure(askFrom(f.checkout), "c1");
    await writeFile(join(first.path, "src", "lib.rs"), "stray edit\n");
    const second = await bases.ensure(askFrom(f.checkout), "c2");
    expect(second).toMatchObject({ path: first.path, created: false });
    expect(second.holders.toSorted()).toEqual(["c1", "c2"]);
    expect(await readFile(join(second.path, "src", "lib.rs"), "utf8")).toBe("pub const V: u32 = 1;\n");
    expect((await bases.list()).map((base) => base.path)).toEqual([first.path]);
});

test("letting go removes a base nobody else holds, and leaves one another conversation still holds", async () => {
    const f = await fixture();
    const bases = createBaseCheckouts(f.deps);
    const base = await bases.ensure(askFrom(f.checkout), "c1");
    await bases.ensure(askFrom(f.checkout), "c2");
    expect(await bases.release("c1", askFrom(f.checkout))).toEqual({ released: [base.path], removed: [] });
    expect(await bases.release("c2", "all")).toEqual({ released: [base.path], removed: [base.path] });
    expect(await stat(base.path).catch(() => undefined)).toBeUndefined();
    // Its worktree link is gone with it.
    expect(git(f.main, "worktree", "list")).not.toContain(base.path);
    expect(await readdir(join(basesRoot(f.history), "root"))).toEqual([]);
});

test("the sweep removes a base whose holders went or went quiet, never one something runs in", async () => {
    let running: string | undefined;
    const f = await fixture({ programs: () => Promise.resolve(running === undefined ? [] : [{ argv: ["cargo", "test"], cwd: join(running, "src") }]) });
    const bases = createBaseCheckouts(f.deps);
    const kept = await bases.ensure(askFrom(f.checkout), "c1");
    const idle = await bases.ensure(askFrom(f.checkout, "main"), "c2");
    const gone = await bases.ensure(askFrom(f.checkout, "main"), "archived");
    expect(gone.path).toBe(idle.path);
    // c2's hold went quiet a day ago, but the archived conversation asked for the same commit just now: neither keeps it.
    const old = new Date(Date.now() - HOLD_IDLE_MS - 1000);
    await utimes(join(`${idle.path}.holds`, "c2"), old, old);
    running = kept.path;
    await utimes(join(`${kept.path}.holds`, "c1"), old, old);
    expect(await bases.sweep(Date.now())).toEqual([idle.path]);
    // The quiet one something runs in stays until it stops.
    running = undefined;
    expect(await bases.sweep(Date.now())).toEqual([kept.path]);
});

test("under disk pressure unused bases go, the least recently asked for first, until there is room", async () => {
    const f = await fixture();
    const bases = createBaseCheckouts(f.deps);
    const older = await bases.ensure(askFrom(f.checkout), "c1");
    const newer = await bases.ensure(askFrom(f.checkout, "main"), "c1");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(`${older.path}.holds`, "c1"), old, old);
    let asked = 0;
    expect(await bases.relieve(() => Promise.resolve((asked += 1) > 1))).toBe(1);
    expect(await stat(older.path).catch(() => undefined)).toBeUndefined();
    expect((await stat(newer.path)).isDirectory()).toBe(true);
});

test("a disk below its floor makes no new base, and says why", async () => {
    const f = await fixture({ space: () => Promise.resolve({ freeBytes: 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }) });
    await expect(createBaseCheckouts(f.deps).ensure(askFrom(f.checkout), "c1")).rejects.toThrow(/too little to give this conversation its own copy/u);
});
