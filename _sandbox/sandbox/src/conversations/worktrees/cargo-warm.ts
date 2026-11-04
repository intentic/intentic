import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { forkedExec } from "@intentic/base/git";
import type { Logger } from "pino";
import { readText } from "../../system/resources/cgroup.js";
import { listPids } from "../../system/resources/process-scan.js";
import { spawnAs } from "../../workload/workload-class.js";
import { walkDirs } from "../../workspace/layout/dir-walk.js";
import { cargoTagged, removeQuietly } from "./build-outputs/build-outputs.js";

// ONE SET OF COMPILED RUST DEPENDENCIES PER REPOSITORY (2026-11-04, a prototype behind `sharedCargoTargets`, off by
// default). Every checkout that built a Rust workspace held its own full `target/`: 32 of them filled a 1 TB disk with
// 424 GB of near-identical dependency builds. With the setting on, an isolated checkout's `<workspace>/target` is an
// overlay like the dependency mirrors (isolation.ts): its lower layer a frozen copy of the main checkout's last finished
// build, its upper this checkout's own writes, so a checkout holds only what it compiled differently.
//
// - REUSE IS CARGO'S CALL, unit by unit, from its own fingerprints: a snapshot never makes a build wrong, only cheaper.
//   It is correct because every isolated checkout is seen at the main checkout's own path (/work): an artifact Cargo
//   calls fresh at another path still carries the path it was built at (`env!("CARGO_MANIFEST_DIR")`, an OUT_DIR),
//   which measured fresh-but-wrong when a target was copied to a checkout at its own path.
// - What it reuses: every dependency from a registry or from outside the checkout, and their build scripts. The
//   checkout's own crates rebuild, since Cargo judges a path crate by mtime and a new checkout's files are all newer
//   than any snapshot. Nothing is reused across a different CARGO_HOME path, RUSTFLAGS, profile or toolchain.
// - THE LOWER NEVER CHANGES WHILE MOUNTED: a snapshot is a real copy (`cp -a --reflink=auto`), never hardlinks into the
//   main checkout's live target, since Cargo rewrites its fingerprints and `.d` files in place (measured: rustc replaces
//   an rlib with a new inode, Cargo truncates and rewrites the fingerprint files). `incremental/` is left out.
// - Made from the main checkout's target, under Cargo's own lock, when its Cargo.lock or toolchain no longer matches the
//   newest snapshot; in the background of a turn's plan, so a turn mounts what is already frozen. A layer is pinned to
//   the snapshot it was first built over; older snapshots go once no live overlay reads one (the kernel's mount tables).
// - Without namespaces (no CAP_SYS_ADMIN), in a fenced conversation or in the unprivileged agent domain, nothing is
//   asked for or mounted, and every checkout builds its own target as before.

const STORE = "cargo-warm";
// Beside a layer's upper and work: the snapshot it reads through.
const PIN = "warm-lower";
// A copy being made, and a snapshot set aside to be removed; neither is ever mounted.
const PARTIAL = ".partial-";
const RETIRED = ".retired-";
// `<created at, ms>-<Cargo.lock hash>-<toolchain hash>`: sorts by age, and says which lock and toolchain it was built for.
const SNAPSHOT_ID = /^\d{13}-[0-9a-f]{12}-[0-9a-f]{8}$/u;
// One more level than the mirror walk: this monorepo's crates sit three below the root (_editor/desktop-app/src-tauri).
const WALK_DEPTH = 4;
// Folders read per plan at most, since it runs before every turn; this monorepo holds about 900 to that depth.
const WALK_BUDGET = 5_000;
// A target-relative file Cargo keeps at the top: its tag, and its cache of what rustc said.
const TARGET_FILES = ["CACHEDIR.TAG", ".rustc_info.json"];
// How often one workspace's main checkout is looked at again for a new snapshot.
const REFRESH_EVERY_MS = 10 * 60 * 1000;
// A pin this recent holds its snapshot whatever the mount tables say: a view prepared and not yet mounted.
const PIN_GRACE_MS = 10 * 60 * 1000;
// A copy no daemon finished; one in flight is younger, since even a 30 GB target copies within the hour.
const PARTIAL_STALE_MS = 6 * 60 * 60 * 1000;
// flock(1)'s exit when the lock is held (`-E`): a build is running there.
const BUSY = 75;

export interface CargoWarmRequest {
    // Where the snapshots live (cargoWarmRoot).
    readonly store: string;
    // Checkout-relative Cargo workspace roots ("" is the checkout's root).
    readonly crates: readonly string[];
}

// One warm layer in a view: the checkout-relative target it lies over, and the snapshot's target it reads through.
export interface WarmMount {
    readonly rel: string;
    readonly lower: string;
}

interface Snapshot {
    readonly dir: string;
    readonly createdAt: number;
    readonly key: string;
}

export const cargoWarmRoot = (historyRoot: string): string => join(historyRoot, STORE);

// One workspace's snapshots, by its checkout-relative path; the leading slash keeps the root's ("") a name of its own.
const crateStore = (store: string, crate: string): string => join(store, encodeURIComponent(`/${crate}`));

export const warmTargetOf = (crate: string): string => (crate === "" ? "target" : `${crate}/target`);

// Cargo workspace roots in a checkout: a folder holding Cargo.toml and Cargo.lock, which Cargo keeps only at a
// workspace's root. Never into a target, the reference shelf, or anything walkDirs leaves out (mirrors, hidden folders);
// a path an overlay option cannot spell (overlay-layers.ts) is left to build its own target.
export const cargoWorkspaces = async (checkout: string): Promise<string[]> => {
    const found: string[] = [];
    await walkDirs(checkout, { maxDepth: WALK_DEPTH, maxDirs: WALK_BUDGET }, (dir, entries, subdirs) => {
        const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
        if (files.has("Cargo.toml") && files.has("Cargo.lock") && !/[,:]/u.test(dir.rel)) {
            found.push(dir.rel);
        }
        return Promise.resolve(subdirs.filter((subdir) => subdir.name !== "target" && (dir.rel !== "" || subdir.name !== "refs")));
    });
    return found.toSorted();
};

// Absent or an empty folder: a target the checkout has not built into itself. A link is somebody's choice of where
// the target lives, and a full folder the checkout's own build (from before the setting, or a turn without namespace).
export const targetFree = async (path: string): Promise<boolean> => {
    const entry = await lstat(path).catch(undefinedIfMissing);
    return entry === undefined || (entry.isDirectory() && (await readdir(path)).length === 0);
};

const snapshotsOf = async (store: string, crate: string): Promise<Snapshot[]> => {
    const home = crateStore(store, crate);
    const names: string[] = (await readdir(home).catch(undefinedIfMissing)) ?? [];
    return names
        .filter((name) => SNAPSHOT_ID.test(name))
        .map((name) => ({ dir: join(home, name), createdAt: Number(name.slice(0, 13)), key: name.slice(14) }))
        .toSorted((left, right) => right.createdAt - left.createdAt);
};

// Pins and retirements of one workspace's snapshots run one at a time, so a retirement never takes a snapshot a view
// was just handed.
const pins = keyedLock<string>();

const readPin = async (layer: string): Promise<string | undefined> => (await readFile(join(layer, PIN), "utf8").catch(undefinedIfMissing))?.trim();

const holdsAnything = async (dir: string): Promise<boolean> => ((await readdir(dir).catch(undefinedIfMissing)) ?? []).length > 0;

// The kernel makes the work dir's own `work` 000; opened first, so a remover without CAP_DAC_OVERRIDE can take it too.
const openWorkDir = (layer: string): Promise<void> => chmod(join(layer, "work", "work"), 0o700).catch(undefinedIfMissing);

// What a checkout built over one snapshot, thrown away with the pin.
const discardLayer = async (layer: string): Promise<void> => {
    await openWorkDir(layer);
    for (const part of ["upper", "work", PIN]) {
        await rm(join(layer, part), { recursive: true, force: true });
    }
};

/**
 * The snapshot target a checkout's layer reads through, pinned in the layer (and the pin's time renewed) so no
 * retirement takes it. A layer keeps the snapshot it was first built over while it holds anything, since what Cargo
 * wrote there was decided against that snapshot's files; an empty layer, or one whose snapshot is gone, starts over the
 * newest. Undefined while the workspace has no snapshot: the checkout then builds a target of its own.
 */
export const pinWarmLower = (store: string, crate: string, layer: string): Promise<string | undefined> =>
    pins(crateStore(store, crate), async () => {
        const snapshots = await snapshotsOf(store, crate);
        const pinned = await readPin(layer);
        const current = snapshots.find((snapshot) => snapshot.dir === pinned);
        const keep = current !== undefined && (current === snapshots[0] || (await holdsAnything(join(layer, "upper"))));
        if (!keep) {
            await discardLayer(layer);
        }
        const chosen = keep ? current : snapshots[0];
        if (chosen === undefined) {
            return undefined;
        }
        await mkdir(layer, { recursive: true });
        await writeFile(join(layer, PIN), `${chosen.dir}\n`);
        return join(chosen.dir, "target");
    });

const subdirsOf = async (dir: string): Promise<string[]> =>
    ((await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? []).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

const isProfile = (dir: string): Promise<boolean> => stat(join(dir, ".fingerprint")).then((entry) => entry.isDirectory(), () => false);

// A target's profile folders, target-relative: `debug`, `release`, and under a target triple `wasm32-unknown-unknown/debug`.
const profilesOf = async (target: string): Promise<string[]> => {
    const found: string[] = [];
    for (const first of await subdirsOf(target)) {
        if (await isProfile(join(target, first))) {
            found.push(first);
            continue;
        }
        for (const second of await subdirsOf(join(target, first))) {
            if (await isProfile(join(target, first, second))) {
                found.push(`${first}/${second}`);
            }
        }
    }
    return found;
};

const run = (command: string, args: readonly string[]): Promise<number> =>
    new Promise((resolve, reject) => {
        const child = spawnAs({ class: "command" }, command, args, { stdio: "ignore" });
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
    });

// One profile copied whole but for `incremental/`, by one `cp` so the links Cargo made between `deps/` and the files it
// uplifted stay links, at low priority, under Cargo's own lock on the folder (`.cargo-lock`, which every build holds)
// taken without waiting: a build running there means another time, and one that starts meanwhile waits for the copy.
const copyProfile = async (source: string, dest: string): Promise<"copied" | "busy"> => {
    const names = ((await readdir(source).catch(undefinedIfMissing)) ?? []).filter((name) => name !== "incremental");
    await mkdir(dest, { recursive: true });
    if (names.length === 0) {
        return "copied";
    }
    const lock = join(source, ".cargo-lock");
    const code = await run("flock", ["-n", "-E", String(BUSY), lock, "cp", "-a", "--reflink=auto", "--", ...names.map((name) => join(source, name)), dest]);
    if (code === BUSY) {
        return "busy";
    }
    if (code !== 0) {
        throw new Error(`cp exited ${String(code)} copying ${source}`);
    }
    return "copied";
};

export interface FreezeRequest {
    readonly store: string;
    readonly crate: string;
    // A built target, at the path every checkout sees its own at: the main checkout's.
    readonly source: string;
    readonly key: string;
    readonly now: number;
}

// Copies a built target into a new snapshot, made visible by one rename once complete, so a half-made one is never
// mounted. `busy` when a build held one of its profiles; `unbuilt` when it has none.
export const freezeWarmSnapshot = async (request: FreezeRequest): Promise<"frozen" | "busy" | "unbuilt"> => {
    const profiles = await profilesOf(request.source);
    if (profiles.length === 0) {
        return "unbuilt";
    }
    const home = crateStore(request.store, request.crate);
    const partial = join(home, `${PARTIAL}${randomBytes(4).toString("hex")}`);
    try {
        await mkdir(join(partial, "target"), { recursive: true });
        for (const name of TARGET_FILES) {
            await copyFile(join(request.source, name), join(partial, "target", name)).catch(undefinedIfMissing);
        }
        for (const profile of profiles) {
            if ((await copyProfile(join(request.source, profile), join(partial, "target", profile))) === "busy") {
                return "busy";
            }
        }
        await rename(partial, join(home, `${String(request.now).padStart(13, "0")}-${request.key}`));
        return "frozen";
    } finally {
        await rm(partial, { recursive: true, force: true });
    }
};

const digest = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/**
 * What decides whether a new snapshot is worth making: the lock file (which crates, at which versions) and the
 * toolchain that would compile them, asked where a rust-toolchain file would steer rustup. Never what decides reuse,
 * which Cargo does unit by unit: a snapshot under a stale key only lends less.
 */
export const warmKey = async (workspace: string): Promise<string> => {
    const lock = (await readFile(join(workspace, "Cargo.lock")).catch(undefinedIfMissing)) ?? "";
    const toolchain = await forkedExec("rustc", ["-vV"], { cwd: workspace, timeout: 15_000 }).then(
        (output) => output.stdout,
        // allow(silent-catch): no rustc for the daemon is an unknown toolchain, keyed as such; checkouts' builds decide.
        () => "",
    );
    return `${digest(lock).slice(0, 12)}-${digest(toolchain).slice(0, 8)}`;
};

// The lowerdir, upperdir and workdir every overlay in one mount table names, its octal escapes undone.
export const overlayLayersIn = (mountinfo: string): string[] =>
    mountinfo.split("\n").flatMap((line) => {
        const fields = line.split(" - ")[1]?.split(" ") ?? [];
        if (fields[0] !== "overlay") {
            return [];
        }
        return (fields[2] ?? "").split(",").flatMap((option) => {
            const at = option.indexOf("=");
            const name = option.slice(0, at);
            const value = option.slice(at + 1).replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
            if (name === "lowerdir") {
                return value.split(":");
            }
            return name === "upperdir" || name === "workdir" ? [value] : [];
        });
    });

// Every directory a live overlay uses as a layer, in any mount namespace on the machine, one mount table read per
// namespace: what says a snapshot or a layer is in use, whoever mounted it and whatever this daemon remembers.
const mountedOverlayDirs = async (): Promise<ReadonlySet<string>> => {
    const namespaces = new Set<string>();
    const dirs = new Set<string>();
    for (const pid of await listPids()) {
        // allow(silent-catch): a process gone, or one this daemon may not inspect, names no namespace it could read.
        const namespace = await readlink(`/proc/${String(pid)}/ns/mnt`).catch(() => undefined);
        if (namespace === undefined || namespaces.has(namespace)) {
            continue;
        }
        namespaces.add(namespace);
        for (const dir of overlayLayersIn((await readText(`/proc/${String(pid)}/mountinfo`)) ?? "")) {
            dirs.add(dir);
        }
    }
    return dirs;
};

export interface WarmLayer {
    // Checkout-relative: the target it lies over (`target`, `_sandbox/ic/target`).
    readonly rel: string;
    readonly layer: string;
    // The snapshot it reads through.
    readonly snapshot: string;
}

const decoded = (name: string): string | undefined => {
    try {
        return decodeURIComponent(name);
    } catch {
        // allow(silent-catch): a name no layer was ever given is not a layer.
        return undefined;
    }
};

// One conversation's warm target layers, from its overlays dir (isolation.ts overlaysDir).
export const warmLayersOf = async (overlays: string): Promise<WarmLayer[]> => {
    const layers: WarmLayer[] = [];
    for (const name of (await readdir(overlays).catch(undefinedIfMissing)) ?? []) {
        const rel = decoded(name);
        if (rel === undefined || (rel !== "target" && !rel.endsWith("/target"))) {
            continue;
        }
        const snapshot = await readPin(join(overlays, name));
        if (snapshot !== undefined) {
            layers.push({ rel, layer: join(overlays, name), snapshot });
        }
    }
    return layers;
};

// Whether a folder is one checkout's warm target layer: what the Storage scan files as build output, not as checkout.
export const isWarmLayer = async (dir: string): Promise<boolean> => (await readPin(dir)) !== undefined;

// Snapshots some layer of any conversation pinned at or after `since`.
const recentPins = async (overlaysRoot: string, since: number): Promise<ReadonlySet<string>> => {
    const pinned = new Set<string>();
    for (const id of await subdirsOf(overlaysRoot)) {
        for (const layer of await warmLayersOf(join(overlaysRoot, id))) {
            const at = (await stat(join(layer.layer, PIN)).catch(undefinedIfMissing))?.mtimeMs ?? 0;
            if (at >= since) {
                pinned.add(layer.snapshot);
            }
        }
    }
    return pinned;
};

// Snapshots set aside, and copies no daemon finished (PARTIAL_STALE_MS), removed outside the pin lock.
const sweepLeftovers = async (home: string, now: number, remove: (path: string) => Promise<void>): Promise<void> => {
    for (const name of (await readdir(home).catch(undefinedIfMissing)) ?? []) {
        const dir = join(home, name);
        const abandoned = name.startsWith(PARTIAL) && now - ((await stat(dir).catch(undefinedIfMissing))?.mtimeMs ?? now) > PARTIAL_STALE_MS;
        if (name.startsWith(RETIRED) || abandoned) {
            await remove(dir);
        }
    }
};

export interface RetireRequest {
    readonly store: string;
    readonly crate: string;
    // Every conversation's overlay layers (isolation.ts overlaysRoot), read for recent pins.
    readonly overlays: string;
    readonly now: number;
    readonly mounted?: () => Promise<ReadonlySet<string>>;
    readonly remove?: (path: string) => Promise<void>;
}

/**
 * Every snapshot past the newest goes once no live overlay reads through it and no layer pinned it within
 * PIN_GRACE_MS; a layer still pinned to one that went starts over the newest at its next turn (pinWarmLower). Set aside
 * by a rename under the pin lock, removed after it, so a turn's plan never waits on a removal. Answers what went.
 */
export const retireWarmSnapshots = async (request: RetireRequest): Promise<string[]> => {
    const home = crateStore(request.store, request.crate);
    const retired = await pins(home, async () => {
        const [, ...older] = await snapshotsOf(request.store, request.crate);
        if (older.length === 0) {
            return [];
        }
        const mounted = await (request.mounted ?? mountedOverlayDirs)();
        const recent = await recentPins(request.overlays, request.now - PIN_GRACE_MS);
        const unused = older.filter((snapshot) => !mounted.has(join(snapshot.dir, "target")) && !recent.has(snapshot.dir));
        for (const snapshot of unused) {
            await rename(snapshot.dir, join(home, `${RETIRED}${randomBytes(4).toString("hex")}`));
        }
        return unused.map((snapshot) => snapshot.dir);
    });
    await sweepLeftovers(home, request.now, request.remove ?? removeQuietly);
    return retired;
};

export interface RetireAllRequest extends Pick<RetireRequest, "overlays" | "now" | "remove"> {
    readonly store: string;
    readonly mounted?: () => Promise<ReadonlySet<string>>;
}

// Every workspace's unused snapshots at once, for a pass that frees disk rather than one that froze (the disk-pressure
// watch, after the build-output reaper released layers and so unpinned what they read); the mount tables read once.
export const retireAllWarmSnapshots = async (request: RetireAllRequest): Promise<string[]> => {
    const homes = await subdirsOf(request.store);
    if (homes.length === 0) {
        return [];
    }
    const tables = (request.mounted ?? mountedOverlayDirs)();
    const retired: string[] = [];
    for (const home of homes) {
        const crate = decoded(home)?.slice(1);
        if (crate !== undefined) {
            retired.push(...(await retireWarmSnapshots({ ...request, crate, mounted: () => tables })));
        }
    }
    return retired;
};

export interface RefreshRequest {
    readonly store: string;
    // The main checkout's root, where snapshots are copied from: the very path every isolated checkout is seen at.
    readonly main: string;
    readonly crates: readonly string[];
    readonly overlays: string;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now?: number;
}

const lastRefresh = new Map<string, number>();
// Workspaces this daemon is freezing or retiring right now.
const refreshing = new Set<string>();

const refreshOne = async (request: RefreshRequest, crate: string, now: number): Promise<void> => {
    const workspace = join(request.main, crate);
    const source = join(workspace, "target");
    if (await cargoTagged(source)) {
        const key = await warmKey(workspace);
        const [newest] = await snapshotsOf(request.store, crate);
        if (newest?.key !== key) {
            const outcome = await freezeWarmSnapshot({ store: request.store, crate, source, key, now });
            request.logger.info({ crate, outcome }, "cargo-warm: looked to freeze the main checkout's build for checkouts to read through");
        }
    }
    const retired = await retireWarmSnapshots({ store: request.store, crate, overlays: request.overlays, now });
    if (retired.length > 0) {
        request.logger.info({ crate, retired }, "cargo-warm: removed snapshots no checkout reads through any more");
    }
};

/**
 * Freezes what the main checkout has built of each workspace when its lock or toolchain moved past the newest snapshot,
 * then retires what nothing reads. Each workspace at most once per REFRESH_EVERY_MS and one at a time; never throws.
 */
export const refreshWarmSnapshots = async (request: RefreshRequest): Promise<void> => {
    const now = request.now ?? Date.now();
    for (const crate of request.crates) {
        const home = crateStore(request.store, crate);
        if (refreshing.has(home) || now - (lastRefresh.get(home) ?? Number.NEGATIVE_INFINITY) < REFRESH_EVERY_MS) {
            continue;
        }
        lastRefresh.set(home, now);
        refreshing.add(home);
        try {
            await refreshOne(request, crate, now);
        } catch (error) {
            request.logger.warn({ err: error, crate }, "cargo-warm: the main checkout's build could not be frozen or retired; checkouts keep what they read");
        } finally {
            refreshing.delete(home);
        }
    }
};

export interface ReleaseOptions {
    // Asked before each layer: false leaves the rest for a later pass (a turn opened meanwhile).
    readonly proceed?: () => boolean;
    // `incremental` takes only rustc's incremental caches from each upper, as build-outputs.ts's pass of that name does
    // from a plain target; the pin stays. `all`, the default, the whole upper.
    readonly scope?: "all" | "incremental";
    readonly remove?: (path: string) => Promise<void>;
    readonly mounted?: () => Promise<ReadonlySet<string>>;
}

// An upper's incremental caches, upper-relative (`debug/incremental`, `wasm32-unknown-unknown/debug/incremental`). Only
// ever in the upper, since no snapshot carries one, so taking them needs no whiteout in the lower's place.
const incrementalIn = async (upper: string): Promise<string[]> => {
    const found: string[] = [];
    for (const first of await subdirsOf(upper)) {
        const below = await subdirsOf(join(upper, first));
        if (below.includes("incremental")) {
            found.push(`${first}/incremental`);
        }
        for (const second of below) {
            if ((await subdirsOf(join(upper, first, second))).includes("incremental")) {
                found.push(`${first}/${second}/incremental`);
            }
        }
    }
    return found;
};

// One layer released by the pass's scope; answers the checkout-relative paths that went.
const releaseLayer = async (layer: WarmLayer, scope: "all" | "incremental", remove: (path: string) => Promise<void>): Promise<string[]> => {
    const upper = join(layer.layer, "upper");
    if (scope === "incremental") {
        const caches = await incrementalIn(upper);
        for (const cache of caches) {
            await remove(join(upper, cache));
        }
        return caches.map((cache) => `${layer.rel}/${cache}`);
    }
    await rm(join(layer.layer, PIN), { force: true });
    await openWorkDir(layer.layer);
    await remove(upper);
    await remove(join(layer.layer, "work"));
    return [layer.rel];
};

/**
 * Frees what one conversation's checkouts compiled into their warm layers, for the build-output reaper: the pin goes
 * first (so the snapshot may retire, and a half-freed layer is discarded whole at the next turn), then the upper and the
 * work dir. A layer a live overlay still uses is skipped, since an upper changed under a mount is undefined, as is
 * everything once `proceed` says stop. Paths are checkout-relative, as pruneBuildOutputs names its own.
 */
export interface Released {
    readonly removed: string[];
    readonly failed: string[];
    readonly skipped: string[];
}

export const releaseWarmLayers = async (overlays: string, options: ReleaseOptions = {}): Promise<Released> => {
    const result: Released = { removed: [], failed: [], skipped: [] };
    const layers = await warmLayersOf(overlays);
    if (layers.length === 0) {
        return result;
    }
    const mounted = await (options.mounted ?? mountedOverlayDirs)();
    const remove = options.remove ?? removeQuietly;
    for (const layer of layers) {
        if (mounted.has(join(layer.layer, "upper")) || options.proceed?.() === false) {
            result.skipped.push(layer.rel);
            continue;
        }
        try {
            result.removed.push(...(await releaseLayer(layer, options.scope ?? "all", remove)));
        } catch {
            // allow(silent-catch): named in `failed`, and the next pass or the next turn's discard takes the rest.
            result.failed.push(layer.rel);
        }
    }
    return result;
};
