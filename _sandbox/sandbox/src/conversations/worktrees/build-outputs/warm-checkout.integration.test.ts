import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { cargoDirsOf, type WarmCheckoutDeps, warmCheckout } from "./warm-checkout.js";

// Which build a new checkout's Cargo target is seeded from (warm-checkout.ts): the preferred conversation's when it
// built, else the main checkout's or another conversation's with the same Cargo.lock, newest first; never one git would
// stage, never over a target the checkout already has.

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const put = async (path: string, text = "x"): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
};

const TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# created by cargo\n";
const quiet: Pick<Logger, "info" | "warn"> = { info: () => undefined, warn: () => undefined };

// A checkout that built: its manifest and lock, and a target whose one dependency unit says where it came from.
const builtCheckout = async (dir: string, lock: string, builtAt: number, from: string): Promise<void> => {
    await put(join(dir, "Cargo.toml"), '[package]\nname = "app"\n');
    await put(join(dir, "Cargo.lock"), lock);
    await put(join(dir, "target", "CACHEDIR.TAG"), TAG);
    await put(join(dir, "target", "debug", ".cargo-lock"), "");
    await put(join(dir, "target", "debug", "build", "serde", "aaaaaaaaaaaaaaaa", "out", "from"), from);
    const at = new Date(builtAt);
    for (const part of ["", "build"]) {
        await utimes(join(dir, "target", "debug", part), at, at);
    }
};

interface Fixture {
    readonly deps: WarmCheckoutDeps;
    readonly dest: string;
    readonly main: string;
    readonly worktreesRoot: string;
}

const fixture = async (): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), "warm-checkout-"));
    dirs.push(root);
    const history = join(root, "history");
    const worktreesRoot = join(history, "worktrees");
    const main = join(root, "work");
    const dest = join(worktreesRoot, "new");
    await put(join(dest, "Cargo.toml"), '[package]\nname = "app"\n');
    await put(join(dest, "Cargo.lock"), "lock-1");
    await put(join(dest, ".gitignore"), "target\n");
    expect(spawnSync("git", ["init", "-q", dest]).status).toBe(0);
    const deps: WarmCheckoutDeps = {
        historyRoot: history,
        worktreesRoot,
        mainDir: () => main,
        worktreeDir: (id) => join(worktreesRoot, id),
        logger: quiet,
        space: () => Promise.resolve({ freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }),
    };
    return { deps, dest, main, worktreesRoot };
};

const seededFrom = (dest: string): Promise<string> => readFile(join(dest, "target", "debug", "build", "serde", "aaaaaaaaaaaaaaaa", "out", "from"), "utf8");

test("a spawned child's target comes from its parent whenever the parent built", async () => {
    const f = await fixture();
    await builtCheckout(join(f.worktreesRoot, "parent"), "lock-other", 1_000, "parent");
    await builtCheckout(join(f.worktreesRoot, "sibling"), "lock-1", 9_000_000_000_000, "sibling");
    const outcomes = await warmCheckout(f.deps, { checkouts: [{ repo: "root", dir: f.dest }], preferred: "parent", exclude: ["new"], label: "new" });
    expect(outcomes).toMatchObject([{ rel: "target", state: "seeded", from: join(f.worktreesRoot, "parent", "target"), profiles: ["debug"] }]);
    expect(await seededFrom(f.dest)).toBe("parent");
});

test("otherwise the same Cargo.lock wins over a newer build of another, and the newest of those is taken", async () => {
    const f = await fixture();
    await builtCheckout(f.main, "lock-1", 1_000_000_000_000, "main");
    await builtCheckout(join(f.worktreesRoot, "same-lock"), "lock-1", 2_000_000_000_000, "same-lock");
    await builtCheckout(join(f.worktreesRoot, "other-lock"), "lock-2", 3_000_000_000_000, "other-lock");
    // The checkout being seeded is never its own lender, nor is a conversation the caller leaves out.
    await builtCheckout(join(f.worktreesRoot, "excluded"), "lock-1", 4_000_000_000_000, "excluded");
    await warmCheckout(f.deps, { checkouts: [{ repo: "root", dir: f.dest }], preferred: undefined, exclude: ["new", "excluded"], label: "new" });
    expect(await seededFrom(f.dest)).toBe("same-lock");
});

test("a target git would stage is never seeded, and one the checkout has is left alone", async () => {
    const f = await fixture();
    await builtCheckout(f.main, "lock-1", 1_000, "main");
    await writeFile(join(f.dest, ".gitignore"), "");
    expect(await warmCheckout(f.deps, { checkouts: [{ repo: "root", dir: f.dest }], preferred: undefined, exclude: ["new"], label: "new" })).toEqual([
        { rel: "target", state: "skipped", reason: "git does not ignore it here, so a seeded target would be staged" },
    ]);
    await writeFile(join(f.dest, ".gitignore"), "target\n");
    await put(join(f.dest, "target", "own"), "own");
    expect(await warmCheckout(f.deps, { checkouts: [{ repo: "root", dir: f.dest }], preferred: undefined, exclude: ["new"], label: "new" })).toEqual([]);
});

test("every folder holding a Cargo.toml is a candidate, never one inside a target", async () => {
    const f = await fixture();
    await put(join(f.dest, "tools", "gen", "Cargo.toml"));
    await put(join(f.dest, "target", "package", "x", "Cargo.toml"));
    expect(await cargoDirsOf(f.dest)).toEqual(["", "tools/gen"]);
});
