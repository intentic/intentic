import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { requires } from "@intentic/testing/requires";
import { z } from "zod";
import type { Logger } from "pino";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import {
    cargoWorkspaces,
    freezeWarmSnapshot,
    isWarmLayer,
    overlayLayersIn,
    pinWarmLower,
    releaseWarmLayers,
    retireAllWarmSnapshots,
    retireWarmSnapshots,
    warmKey,
    warmLayersOf,
} from "./cargo-warm.js";
import { createTurnIsolation, type IsolationPlan, MAIN_MOUNT, warmMountsOf } from "./isolation.js";
import { fstabOf, mountPointsOf, mountTable } from "./mount-table.js";

// The warm Cargo layer (cargo-warm.ts): how a snapshot is made, pinned, retired and released on disk, and, where this
// machine has cargo and can mount an overlay in a user namespace, a second checkout's build reading the first's
// compiled dependencies through the real mount table.

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        // The kernel makes an overlay work dir's own `work` 000, which even its owner must open before removing.
        spawnSync("find", [dir, "-type", "d", "-name", "work", "-exec", "chmod", "700", "{}", "+"]);
        await rm(dir, { recursive: true, force: true });
    }
});

const scratch = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-warm-"));
    dirs.push(dir);
    return dir;
};

const KEY = "aaaaaaaaaaaa-bbbbbbbb";
const removeNow = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

// A built target as Cargo lays one out: a profile with fingerprints, a dependency, the binary uplifted from deps/ by a
// hard link, and the incremental cache no snapshot carries.
const fakeTarget = async (target: string): Promise<void> => {
    await mkdir(join(target, "debug", ".fingerprint", "dep-1"), { recursive: true });
    await mkdir(join(target, "debug", "deps"), { recursive: true });
    await mkdir(join(target, "debug", "incremental", "app-1"), { recursive: true });
    await writeFile(join(target, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n# created by cargo\n");
    await writeFile(join(target, "debug", ".fingerprint", "dep-1", "lib-dep"), "fingerprint");
    await writeFile(join(target, "debug", "deps", "app-1"), "binary");
    await link(join(target, "debug", "deps", "app-1"), join(target, "debug", "app"));
    await writeFile(join(target, "debug", "incremental", "app-1", "query-cache.bin"), "cache");
};

const freezeAt = async (store: string, source: string, now: number): Promise<string> => {
    expect(await freezeWarmSnapshot({ store, crate: "", source, key: KEY, now })).toBe("frozen");
    return (await snapshotDirs(store)).find((path) => path.includes(`/${String(now)}-`)) ?? "";
};

const snapshotDirs = async (store: string): Promise<string[]> => {
    const homes = await readdir(store);
    const found: string[] = [];
    for (const home of homes) {
        found.push(...(await readdir(join(store, home))).map((name) => join(store, home, name)));
    }
    return found.toSorted();
};

test("a snapshot copies each profile but its incremental cache, keeping Cargo's links between deps/ and what it uplifted", async () => {
    const dir = await scratch();
    await fakeTarget(join(dir, "target"));
    const snapshot = await freezeAt(join(dir, "store"), join(dir, "target"), 1_700_000_000_000);
    expect(snapshot).toMatch(/\/1700000000000-aaaaaaaaaaaa-bbbbbbbb$/u);
    expect((await readdir(join(snapshot, "target"))).toSorted()).toEqual(["CACHEDIR.TAG", "debug"]);
    expect((await readdir(join(snapshot, "target", "debug"))).toSorted()).toEqual([".fingerprint", "app", "deps"]);
    const [binary, uplifted] = await Promise.all([stat(join(snapshot, "target", "debug", "deps", "app-1")), stat(join(snapshot, "target", "debug", "app"))]);
    expect(uplifted.ino).toBe(binary.ino);
    // Nothing of the copy is left half-made beside it.
    expect(await snapshotDirs(join(dir, "store"))).toEqual([snapshot]);
});

test("a checkout's Cargo workspaces are the folders holding a lock beside their manifest, never one inside a target", async () => {
    const dir = await scratch();
    for (const [folder, names] of [
        ["", ["Cargo.toml", "Cargo.lock"]],
        ["crates/member", ["Cargo.toml"]],
        ["tools/cli", ["Cargo.toml", "Cargo.lock"]],
        ["target/package/copied", ["Cargo.toml", "Cargo.lock"]],
    ] satisfies [string, string[]][]) {
        await mkdir(join(dir, folder), { recursive: true });
        for (const name of names) {
            await writeFile(join(dir, folder, name), "");
        }
    }
    expect(await cargoWorkspaces(dir)).toEqual(["", "tools/cli"]);
});

test("a plan asks for no warm layer while the setting is off", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "main"), { recursive: true });
    await files(join(dir, "wt"), { "Cargo.toml": "", "Cargo.lock": "" });
    const isolation = createTurnIsolation({
        root: join(dir, "main"),
        historyRoot: join(dir, "history"),
        logger: unstubbed<Logger>("logger", {}),
        cargoWarm: () => Promise.resolve(false),
    });
    expect(Object.keys(await isolation.planFor(join(dir, "wt"), undefined))).not.toContain("cargoWarm");
});

test("a target nothing built is not frozen", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "target"), { recursive: true });
    expect(await freezeWarmSnapshot({ store: join(dir, "store"), crate: "", source: join(dir, "target"), key: KEY, now: 1_700_000_000_000 })).toBe("unbuilt");
});

test("a layer reads through the newest snapshot, keeps the one it built over, and starts over the newest once that one is gone", async () => {
    const dir = await scratch();
    const store = join(dir, "store");
    await fakeTarget(join(dir, "target"));
    const layer = join(dir, "overlays", "c1", "target");
    expect(await pinWarmLower(store, "", layer)).toBeUndefined();

    const first = await freezeAt(store, join(dir, "target"), 1_700_000_000_000);
    expect(await pinWarmLower(store, "", layer)).toBe(join(first, "target"));
    expect(await isWarmLayer(layer)).toBe(true);

    // Still empty: a newer snapshot is taken up at once.
    const second = await freezeAt(store, join(dir, "target"), 1_700_000_000_001);
    expect(await pinWarmLower(store, "", layer)).toBe(join(second, "target"));

    // Built into: it stays over what it was built over.
    await mkdir(join(layer, "upper", "debug"), { recursive: true });
    await writeFile(join(layer, "upper", "debug", "own"), "x");
    const third = await freezeAt(store, join(dir, "target"), 1_700_000_000_002);
    expect(await pinWarmLower(store, "", layer)).toBe(join(second, "target"));

    // Its snapshot gone, what it built goes with it, and it starts over the newest.
    await rm(second, { recursive: true, force: true });
    expect(await pinWarmLower(store, "", layer)).toBe(join(third, "target"));
    expect(existsSync(join(layer, "upper"))).toBe(false);
});

test("retiring keeps the newest snapshot, one a live overlay reads and one pinned moments ago, and removes the rest", async () => {
    const dir = await scratch();
    const store = join(dir, "store");
    const overlays = join(dir, "overlays");
    await fakeTarget(join(dir, "target"));
    const now = 1_700_000_100_000;
    const [old, mounted, pinned, newest] = [
        await freezeAt(store, join(dir, "target"), now - 4000),
        await freezeAt(store, join(dir, "target"), now - 3000),
        await freezeAt(store, join(dir, "target"), now - 2000),
        await freezeAt(store, join(dir, "target"), now - 1000),
    ];
    // An idle checkout pinned to the oldest an hour ago, and a view prepared just now over another.
    const pinsOnDisk = [
        { id: "idle", snapshot: old, at: now - 60 * 60_000 },
        { id: "preparing", snapshot: pinned, at: now },
    ];
    for (const pin of pinsOnDisk) {
        await mkdir(join(overlays, pin.id, "target"), { recursive: true });
        await writeFile(join(overlays, pin.id, "target", "warm-lower"), `${pin.snapshot}\n`);
        await utimes(join(overlays, pin.id, "target", "warm-lower"), pin.at / 1000, pin.at / 1000);
    }
    const retired = await retireWarmSnapshots({
        store,
        crate: "",
        overlays,
        now,
        mounted: () => Promise.resolve(new Set([join(mounted, "target")])),
        remove: removeNow,
    });
    expect(retired).toEqual([old]);
    expect(await snapshotDirs(store)).toEqual([mounted, pinned, newest]);
});

test("a disk-freeing pass retires every workspace's unused snapshots at once, keeping each one's newest", async () => {
    const dir = await scratch();
    const store = join(dir, "store");
    await fakeTarget(join(dir, "target"));
    const kept: string[] = [];
    const gone: string[] = [];
    for (const crate of ["", "tools/cli"]) {
        for (const now of [1_700_000_000_000, 1_700_000_000_001]) {
            expect(await freezeWarmSnapshot({ store, crate, source: join(dir, "target"), key: KEY, now })).toBe("frozen");
        }
        const [older, newest] = (await snapshotDirs(store)).filter((path) => !kept.includes(path) && !gone.includes(path));
        gone.push(older ?? "");
        kept.push(newest ?? "");
    }
    const retired = await retireAllWarmSnapshots({ store, overlays: join(dir, "overlays"), now: 1_700_000_100_000, mounted: () => Promise.resolve(new Set<string>()), remove: removeNow });
    expect(retired.toSorted()).toEqual(gone.toSorted());
    expect(await snapshotDirs(store)).toEqual(kept.toSorted());
});

test("releasing a checkout's layers takes the incremental caches alone or the whole upper with its pin, never a mounted one", async () => {
    const dir = await scratch();
    const overlays = join(dir, "overlays", "c1");
    const own = join(overlays, encodeURIComponent("crates/app/target"));
    const live = join(overlays, encodeURIComponent("target"));
    for (const layer of [own, live]) {
        await mkdir(join(layer, "upper", "debug", "incremental", "app-1"), { recursive: true });
        await mkdir(join(layer, "upper", "debug", "deps"), { recursive: true });
        await mkdir(join(layer, "work", "work"), { recursive: true });
        await chmod(join(layer, "work", "work"), 0o000);
        await writeFile(join(layer, "warm-lower"), `${HISTORY_ROOT}/cargo-warm/%2F/1700000000000-aaaaaaaaaaaa-bbbbbbbb\n`);
    }
    const mounted = (): Promise<ReadonlySet<string>> => Promise.resolve(new Set([join(live, "upper")]));

    const incremental = await releaseWarmLayers(overlays, { scope: "incremental", mounted, remove: removeNow });
    expect(incremental).toEqual({ removed: ["crates/app/target/debug/incremental"], failed: [], skipped: ["target"] });
    expect(await readdir(join(own, "upper", "debug"))).toEqual(["deps"]);
    expect(await isWarmLayer(own)).toBe(true);

    const all = await releaseWarmLayers(overlays, { mounted, remove: removeNow });
    expect(all).toEqual({ removed: ["crates/app/target"], failed: [], skipped: ["target"] });
    expect((await readdir(own)).toSorted()).toEqual([]);
    expect((await warmLayersOf(overlays)).map((layer) => layer.rel)).toEqual(["target"]);
});

test("a warm target is mounted last, over the checkout's own folder, reading through its snapshot into the checkout's layer", () => {
    const plan: IsolationPlan = { worktree: `${HISTORY_ROOT}/worktrees/c1`, root: WORKSPACE_ROOT, mirrors: ["node_modules"], overlays: `${HISTORY_ROOT}/overlays/c1`, fence: undefined };
    const lower = `${HISTORY_ROOT}/cargo-warm/%2Fcrates%2Fapp/1700000000000-aaaaaaaaaaaa-bbbbbbbb/target`;
    const facts = { shelf: false, store: false, volatile: true, warm: [{ rel: "crates/app/target", lower }] };
    expect(mountTable(plan, facts).at(-1)).toEqual({
        source: "intentic-modules",
        target: "/work/crates/app/target",
        type: "overlay",
        options: `lowerdir=${lower},upperdir=/history/overlays/c1/crates%2Fapp%2Ftarget/upper,workdir=/history/overlays/c1/crates%2Fapp%2Ftarget/work,volatile`,
    });
    expect(mountPointsOf(plan, facts).at(-1)).toBe("/history/worktrees/c1/crates/app/target");
});

test("every layer a live overlay names is read from a mount table, its escapes undone", () => {
    const mountinfo = [
        "290 1 0:80 / / rw,relatime - ext4 /dev/sdd rw",
        "312 290 0:85 / /work/target rw,relatime - overlay intentic-modules rw,lowerdir=/history/cargo-warm/a\\040b/target,upperdir=/history/overlays/c1/target/upper,workdir=/history/overlays/c1/target/work,volatile",
        "313 290 0:86 / /work/node_modules rw - overlay intentic-modules rw,lowerdir=/mnt/one:/mnt/two,upperdir=/u,workdir=/w",
    ].join("\n");
    expect(overlayLayersIn(mountinfo)).toEqual([
        "/history/cargo-warm/a b/target",
        "/history/overlays/c1/target/upper",
        "/history/overlays/c1/target/work",
        "/mnt/one",
        "/mnt/two",
        "/u",
        "/w",
    ]);
});

// Whether this machine can mount an overlay in a user namespace of its own, which is all the end-to-end test needs of
// the kernel; the daemon does the same as root with CAP_SYS_ADMIN.
const userOverlay = (): boolean => {
    const dir = mkdtempSync(join(tmpdir(), "cargo-warm-probe-"));
    try {
        for (const part of ["lower", "upper", "work", "merged"]) {
            mkdirSync(join(dir, part));
        }
        const options = `lowerdir=${dir}/lower,upperdir=${dir}/upper,workdir=${dir}/work`;
        return spawnSync("unshare", ["-rm", "mount", "-t", "overlay", "probe", "-o", options, join(dir, "merged")], { timeout: 10_000 }).status === 0;
    } finally {
        spawnSync("chmod", ["-R", "u+rwx", dir]);
        rmSync(dir, { recursive: true, force: true });
    }
};

// The account's home as passwd has it: `suites` gives each run a throwaway HOME, and Bun's userInfo() follows HOME.
const accountHome = (): string => spawnSync("getent", ["passwd", String(userInfo().uid)], { encoding: "utf8" }).stdout.split(":")[5] ?? "";

// Cargo's own environment, without whatever the developer's shell steers it with (a target dir elsewhere, flags, a
// wrapper), and with rustup and Cargo homes in the account's real home, where the rustup proxy finds its toolchain. One
// CARGO_HOME for both builds, as a sandbox has: at another path the registry's crates measured as changed sources and
// every one of them rebuilt.
const cargoEnv = (): NodeJS.ProcessEnv => {
    const home = accountHome();
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CARGO_TARGET_DIR|CARGO_BUILD_|RUSTFLAGS|RUSTC_WRAPPER|CARGO_PROFILE_)/u.test(name))),
        RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(home, ".rustup"),
        CARGO_HOME: process.env["CARGO_HOME"] ?? join(home, ".cargo"),
    };
};

const machine = requires(
    spawnSync("cargo", ["--version"], { env: cargoEnv(), timeout: 30_000 }).status === 0 && userOverlay(),
    "cargo on PATH and overlay mounts in an unprivileged user namespace",
    { absentOnCi: "cargo is baked into ci-desktop only, and that job's container may not mount overlays" },
);

const files = async (root: string, tree: Readonly<Record<string, string>>): Promise<void> => {
    for (const [path, text] of Object.entries(tree)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
    }
};

// Two dependencies outside the checkout, one with a build script, standing in for the registry's: Cargo judges both by
// what it recorded, not by the checkout's files, and they need no network.
const DEPS = {
    "leaf/Cargo.toml": '[package]\nname = "leaf"\nversion = "0.1.0"\nedition = "2021"\n',
    "leaf/build.rs": 'fn main() {\n    let out = std::env::var("OUT_DIR").unwrap();\n    std::fs::write(format!("{out}/gen.rs"), "pub const GEN: u32 = 7;").unwrap();\n}\n',
    "leaf/src/lib.rs": 'include!(concat!(env!("OUT_DIR"), "/gen.rs"));\n',
    "mid/Cargo.toml": '[package]\nname = "mid"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nleaf = { path = "../leaf" }\n',
    "mid/src/lib.rs": "pub fn value() -> u32 {\n    leaf::GEN * 6\n}\n",
};

const WORKSPACE = {
    "Cargo.toml": '[workspace]\nmembers = ["app"]\nresolver = "2"\n',
    "app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nmid = { path = "../../deps/mid" }\n',
    "app/src/main.rs": 'fn main() {\n    println!("{}", mid::value());\n}\n',
    ".gitignore": "target\n",
};

interface Units {
    readonly fresh: string[];
    readonly built: string[];
}

// The part of Cargo's `--message-format=json` lines read here.
const ArtifactMessage = z.object({
    reason: z.literal("compiler-artifact"),
    fresh: z.boolean(),
    target: z.object({ name: z.string(), kind: z.array(z.string()) }),
});

// Which units a `--message-format=json` build reused and which it compiled, by target name and kind.
const unitsOf = (stdout: string): Units => {
    const units: Units = { fresh: [], built: [] };
    for (const line of stdout.split("\n").filter((text) => text.startsWith("{"))) {
        const message = ArtifactMessage.safeParse(JSON.parse(line));
        if (message.success) {
            (message.data.fresh ? units.fresh : units.built).push(`${message.data.target.name}:${message.data.target.kind.join(",")}`);
        }
    }
    return { fresh: units.fresh.toSorted(), built: units.built.toSorted() };
};

const git = (cwd: string, ...args: string[]): void => {
    expect(spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd }).status).toBe(0);
};

test.skipIf(!machine.runs)(
    machine.title("a second checkout, seen at the main checkout's path, builds its dependencies from the frozen snapshot and keeps only its own crate"),
    async () => {
        const dir = await scratch();
        const main = join(dir, "main");
        const worktree = join(dir, "wt");
        const store = join(dir, "cargo-warm");
        await files(join(dir, "deps"), DEPS);
        await files(main, WORKSPACE);
        const env = cargoEnv();
        expect(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: main, env }).status).toBe(0);
        git(main, "init", "-q", "-b", "main");
        git(main, "add", "-A");
        git(main, "commit", "-qm", "init");

        const first = spawnSync("cargo", ["build", "--offline", "--message-format=json"], { cwd: main, env, encoding: "utf8", timeout: 300_000 });
        expect(first.status).toBe(0);
        expect(unitsOf(first.stdout)).toEqual({ fresh: [], built: ["app:bin", "build-script-build:custom-build", "leaf:lib", "mid:lib"] });
        expect(await freezeWarmSnapshot({ store, crate: "", source: join(main, "target"), key: await warmKey(main), now: Date.now() })).toBe("frozen");

        git(main, "worktree", "add", "-q", worktree, "HEAD");
        const plan: IsolationPlan = { worktree, root: main, mirrors: [], overlays: join(dir, "overlays", "wt"), fence: undefined, cargoWarm: { store, crates: [""] } };
        const warm = await warmMountsOf(plan, undefined);
        expect(warm.map((mount) => mount.rel)).toEqual(["target"]);
        const facts = { shelf: false, store: false, volatile: false, warm };
        await mkdir(join(worktree, "target"), { recursive: true });
        // The table's own entries for the checkout and its target; the main checkout aside at MAIN_MOUNT and the shared
        // state from it are a root-only path this suite has no need of.
        const table = mountTable(plan, facts).filter((entry) => entry.target !== MAIN_MOUNT && !entry.source.startsWith(MAIN_MOUNT));
        expect(table.map((entry) => entry.target)).toEqual([main, join(main, "target")]);
        const fstab = join(dir, "warm.fstab");
        await writeFile(fstab, fstabOf(table));
        const mainDeps = (await readdir(join(main, "target", "debug", "deps"))).toSorted();
        const second = spawnSync(
            "unshare",
            ["-rm", "sh", "-c", `set -e\nmount -a --fstab ${shellQuote(fstab)}\ncd ${shellQuote(main)}\ncargo build --offline --message-format=json`],
            { env, encoding: "utf8", timeout: 300_000 },
        );
        expect(second.status).toBe(0);
        // Every dependency and its build script read from the snapshot; only the checkout's own crate compiled, since a
        // new checkout's files are newer than anything frozen.
        expect(unitsOf(second.stdout)).toEqual({ fresh: ["build-script-build:custom-build", "leaf:lib", "mid:lib"], built: ["app:bin"] });
        const upper = join(dir, "overlays", "wt", "target", "upper", "debug");
        const kept = await readdir(join(upper, "deps"));
        expect(kept.filter((name) => name.startsWith("libleaf") || name.startsWith("libmid"))).toEqual([]);
        expect(kept.some((name) => name.startsWith("app-"))).toBe(true);
        // The checkout's own target folder stays an empty mount point, and the main checkout's build is untouched.
        expect(await readdir(join(worktree, "target"))).toEqual([]);
        expect((await readdir(join(main, "target", "debug", "deps"))).toSorted()).toEqual(mainDeps);
    },
);
