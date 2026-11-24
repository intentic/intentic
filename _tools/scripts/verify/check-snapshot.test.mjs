// Pins that the throwaway worktree a snapshot run checks out is taken back however the run ends (check-snapshot.mjs): a
// run killed at its deadline used to leave the worktree registered in the repository, and its directory under the temp dir.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { snapshotPoolOf, sweepSnapshots, withSnapshot } from "./check-snapshot.mjs";

const SNAPSHOT = fileURLToPath(new URL("./check-snapshot.mjs", import.meta.url));

// A repository with a stand-in checks runner that answers at once in the checkout, and hangs in a snapshot, kept or
// throwaway, first touching the file CHECK_SNAPSHOT_HANGING names, if any. `done` removes it with its kept base checkouts.
const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "check-snapshot-test-"));
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    mkdirSync(join(root, "_tools/checks"), { recursive: true });
    writeFileSync(
        join(root, "_tools/checks/run.mjs"),
        [
            `import { writeFileSync } from "node:fs";`,
            `if (/verify-(snapshot|base)-/.test(process.cwd())) {`,
            `    if (process.env.CHECK_SNAPSHOT_HANGING) writeFileSync(process.env.CHECK_SNAPSHOT_HANGING, "");`,
            `    await new Promise((resolve) => setTimeout(resolve, 60_000));`,
            `}`,
            `process.stdout.write("[]");`,
            ``,
        ].join("\n"),
    );
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    const pool = snapshotPoolOf(root);
    const done = () => {
        rmSync(pool, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    };
    return { root, run, pool, done };
};

const commit = (run, root, files) => {
    for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(root, name), text);
    }
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "next");
    return run("rev-parse", "HEAD");
};

// Every slot of the pool held by a run that is still going.
const holdEverySlot = (pool) => {
    mkdirSync(pool, { recursive: true });
    for (const slot of [0, 1, 2]) {
        writeFileSync(join(pool, `slot-${slot}.lock`), "");
    }
};

const snapshotsOf = (run) => run("worktree", "list", "--porcelain").split("\n").filter((line) => line.includes("verify-snapshot-"));
const keptOf = (run) => run("worktree", "list", "--porcelain").split("\n").filter((line) => line.includes("verify-base-"));

test("a snapshot older than the limit is taken back, a younger one is left", () => {
    const { root, run } = repo();
    const made = [];
    try {
        for (const name of ["old", "young"]) {
            const parent = mkdtempSync(join(tmpdir(), "verify-snapshot-"));
            made.push(parent);
            run("worktree", "add", "--detach", join(parent, "before"), "HEAD");
            if (name === "old") {
                utimesSync(parent, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
            }
        }
        assert.equal(snapshotsOf(run).length, 2);
        assert.equal(sweepSnapshots(root), 1);
        assert.deepEqual(snapshotsOf(run).map((line) => line.replace("worktree ", "")), [join(made[1], "before")]);
        assert.equal(existsSync(made[0]), false);
        assert.equal(existsSync(made[1]), true);
    } finally {
        for (const parent of made) {
            rmSync(parent, { recursive: true, force: true });
        }
        rmSync(root, { recursive: true, force: true });
    }
});

// A `worktree add` killed after its checkout but before its last step leaves the worktree locked as "initializing":
// one --force refuses it and `worktree prune` skips it, so it stayed registered for good.
test("a snapshot left locked by a killed `worktree add` is taken back too", () => {
    const { root, run } = repo();
    const parent = mkdtempSync(join(tmpdir(), "verify-snapshot-"));
    try {
        run("worktree", "add", "--detach", join(parent, "before"), "HEAD");
        run("worktree", "lock", "--reason", "initializing", join(parent, "before"));
        utimesSync(parent, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
        assert.equal(sweepSnapshots(root), 1);
        assert.deepEqual(snapshotsOf(run), []);
        assert.equal(existsSync(parent), false);
    } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});

// A run of reportsAt in a process group of its own, as the sandbox runs a check in, so a signal reaches the checks
// inside the run too; resolves once the stand-in checks hang inside the snapshot. Waiting for the snapshot to show in
// git's list instead raced: a signal that lands while the run is still in its own synchronous code is handled only
// after its next spawnSync returns, which is the stand-in's whole minute.
const killableRun = async (root) => {
    const hanging = `${root}.hanging`;
    const script = `import { reportsAt } from ${JSON.stringify(SNAPSHOT)}; console.log(String(reportsAt(${JSON.stringify(root)}, "HEAD", ["x"])));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CHECK_SNAPSHOT_HANGING: hanging },
    });
    const ended = new Promise((resolve) => child.once("exit", resolve));
    for (let tries = 0; !existsSync(hanging) && tries < 200; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(hanging), true, "the run never reached its checks in a snapshot");
    rmSync(hanging);
    return async () => {
        process.kill(-child.pid, "SIGTERM");
        await ended;
    };
};

test("a run killed with its checks leaves no snapshot behind", async () => {
    const { root, run, pool, done } = repo();
    try {
        // Every kept checkout busy: the run takes a throwaway one, which goes with it.
        holdEverySlot(pool);
        const kill = await killableRun(root);
        assert.equal(snapshotsOf(run).length, 1);
        await kill();
        assert.deepEqual(snapshotsOf(run), []);
    } finally {
        done();
    }
});

test("a run killed with its checks gives its kept checkout back, lent links and lock gone, the checkout kept", async () => {
    const { root, run, pool, done } = repo();
    try {
        mkdirSync(join(root, "node_modules"));
        const kill = await killableRun(root);
        assert.equal(existsSync(join(pool, "slot-0.lock")), true);
        assert.equal(lstatSync(join(pool, "slot-0/before/node_modules")).isSymbolicLink(), true);
        await kill();
        assert.equal(existsSync(join(pool, "slot-0.lock")), false);
        assert.equal(existsSync(join(pool, "slot-0/before/node_modules")), false);
        assert.deepEqual(keptOf(run), [`worktree ${join(realpathSync(pool), "slot-0/before")}`]);
    } finally {
        done();
    }
});

// 2026-11-24: every turn that ended with a failing check wrote the whole base commit out under the temp dir and deleted
// it again, 202 MB of this repository each time.
test("the next run moves the kept checkout to its commit, rewriting only what changed and clearing what the last left", () => {
    const { root, run, done } = repo();
    try {
        const first = commit(run, root, { "a.txt": "a1\n", "b.txt": "b\n", "c.txt": "c\n" });
        const second = commit(run, root, { "a.txt": "a2\n" });
        const left = withSnapshot(root, first, (snapshot) => {
            writeFileSync(join(snapshot, "b.txt"), "changed by a check\n");
            mkdirSync(join(snapshot, ".cache"));
            writeFileSync(join(snapshot, ".cache/state"), "left behind\n");
            return { snapshot, untouched: statSync(join(snapshot, "c.txt")).ino };
        });
        assert.equal(run("rev-parse", "HEAD"), second);
        // `HEAD` is the caller's, not the kept checkout's own, which still stands at the first commit.
        const seen = withSnapshot(root, "HEAD", (snapshot) => ({
            snapshot,
            a: readFileSync(join(snapshot, "a.txt"), "utf8"),
            b: readFileSync(join(snapshot, "b.txt"), "utf8"),
            cache: existsSync(join(snapshot, ".cache")),
            untouched: statSync(join(snapshot, "c.txt")).ino,
        }));
        assert.deepEqual(seen, { snapshot: left.snapshot, a: "a2\n", b: "b\n", cache: false, untouched: left.untouched });
        assert.match(left.snapshot, /verify-base-[0-9a-f]{12}\/slot-0\/before$/);
        assert.deepEqual(snapshotsOf(run), []);
    } finally {
        done();
    }
});

// `count` snapshots held at once, each taken inside the one before: their paths, the outermost first.
const nested = (root, count, taken = []) =>
    count === 0 ? taken : withSnapshot(root, "HEAD", (snapshot) => nested(root, count - 1, [...taken, snapshot]));

test("runs at once each take a kept checkout of their own, and with all three held the next takes a throwaway one", () => {
    const { root, run, done } = repo();
    try {
        const paths = nested(root, 4);
        assert.deepEqual(
            paths.slice(0, 3).map((path) => path.split("/").slice(-2).join("/")),
            ["slot-0/before", "slot-1/before", "slot-2/before"],
        );
        assert.match(paths[3], /verify-snapshot-[^/]+\/before$/);
        assert.deepEqual(snapshotsOf(run), []);
        assert.equal(keptOf(run).length, 3);
    } finally {
        done();
    }
});

test("a lock left by a run killed outright is taken over once stale, and a fresh one is left to its run", () => {
    const { root, pool, done } = repo();
    try {
        mkdirSync(pool, { recursive: true });
        writeFileSync(join(pool, "slot-0.lock"), "");
        assert.match(withSnapshot(root, "HEAD", (snapshot) => snapshot), /slot-1\/before$/);
        utimesSync(join(pool, "slot-0.lock"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
        assert.match(withSnapshot(root, "HEAD", (snapshot) => snapshot), /slot-0\/before$/);
        assert.equal(existsSync(join(pool, "slot-0.lock")), false);
    } finally {
        done();
    }
});

test("a kept checkout the temp dir lost is made again in its place, with one registration", () => {
    const { root, run, pool, done } = repo();
    try {
        withSnapshot(root, "HEAD", () => undefined);
        rmSync(pool, { recursive: true, force: true });
        assert.equal(
            withSnapshot(root, "HEAD", (snapshot) => existsSync(join(snapshot, "_tools/checks/run.mjs"))),
            true,
        );
        assert.equal(keptOf(run).length, 1);
    } finally {
        done();
    }
});

// fair-badger-o1w6 (2026-10-21) was charged with 65 extension-kit findings in `../extensions`, standalone repositories
// it never touched: the snapshot under the temp dir had no `../extensions`, so the base found nothing there.
test("a snapshot reads the same neighbours as the checkout, and taking it back leaves them whole", () => {
    const workspace = mkdtempSync(join(tmpdir(), "check-snapshot-workspace-"));
    let pool;
    try {
        const root = join(workspace, "repo");
        mkdirSync(root);
        execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
        writeFileSync(join(root, "a.txt"), "a\n");
        execFileSync("git", ["add", "-A"], { cwd: root });
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"], { cwd: root });
        pool = snapshotPoolOf(root);
        mkdirSync(join(workspace, "extensions/acceptance"), { recursive: true });
        writeFileSync(join(workspace, "extensions/acceptance/view.vue"), "<template />\n");
        let link;
        const seen = withSnapshot(root, "HEAD", (snapshot) => {
            link = join(snapshot, "..", "extensions");
            return readFileSync(join(snapshot, "..", "extensions/acceptance/view.vue"), "utf8");
        });
        assert.equal(seen, "<template />\n");
        assert.equal(existsSync(link), false);
        assert.equal(lstatSync(join(workspace, "extensions/acceptance/view.vue")).isFile(), true);
    } finally {
        if (pool !== undefined) {
            rmSync(pool, { recursive: true, force: true });
        }
        rmSync(workspace, { recursive: true, force: true });
    }
});
