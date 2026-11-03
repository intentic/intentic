import { open, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { sleep } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { defaultGit } from "@intentic/base/git";
import { spawnAs } from "../../../workload/workload-class.js";

// BUILD OUTPUT IN QUIET CHECKOUTS (2026-10-21). A checkout lives until its conversation is archived (agentRetentionDays,
// 3 by default) or its held work is reclaimed (heldCheckoutDays, 7), and every build it ran leaves its output behind
// in it: measured that day, 38 GB across the finished checkouts, a Tauri `target/` of 9-14 GB in each conversation that
// built the desktop app. All of it is regenerable and none of it is the conversation's work, so once a checkout has
// sat quiet for a while its build output goes and the checkout itself stays. A conversation picked up again rebuilds
// on its first build, which is the whole cost.
//
// Only directories a build tool owns: named in BUILD_OUTPUTS, beside the file that makes that tool build there, ignored
// by git and holding nothing git tracks. node_modules and dist are never touched: in an isolated checkout they are
// mount points for the dependency overlays and main's built libraries (isolation.ts), not the checkout's own files.
//
// CARGO'S OWN TAG (2026-11-03). Cargo writes a CACHEDIR.TAG into every target directory it makes, whatever it is called:
// shinobi's agents built into `target-wasm`, copied another conversation's `target` in under a new name, and pointed
// CARGO_TARGET_DIR at folders the name table never heard of. A folder holding Cargo's tag is build output by Cargo's own
// word, so it is found by the tag as well as by name; it still has to be ignored and untracked like any other.
//
// LOW PRIORITY (2026-11-03). A Rust target is 8-23 GB in hundreds of thousands of files. Removed in the daemon's own
// threads it took the IO a running turn's build was waiting on; it now goes through `rm` in a child at the command
// class's niceness and idle-most IO (workload-class.ts), so the kernel gives the disk to everything else first.

interface BuildOutput {
    readonly dir: string;
    // Any one of these beside the directory says which tool wrote it.
    readonly markers: readonly string[];
}

const BUILD_OUTPUTS: readonly BuildOutput[] = [
    { dir: "target", markers: ["Cargo.toml"] },
    { dir: "build", markers: ["build.gradle", "build.gradle.kts", "pubspec.yaml"] },
    { dir: ".gradle", markers: ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"] },
    { dir: ".dart_tool", markers: ["pubspec.yaml"] },
];

// Never descended into: git's own, the overlay mount points, and what is already somebody else's to clean.
const SKIPPED = new Set([".git", "node_modules", "dist", "refs", ".pnpm-store"]);

// Deep enough for this monorepo's deepest crate (_editor/android-native/core/target is 4 below a repo root) with room.
const MAX_DEPTH = 8;

// Cargo's cache directory tag: the signature every CACHEDIR.TAG carries (bford.info/cachedir), and Cargo's own line.
const CACHEDIR_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";
const CARGO_TAG = /created by cargo/i;

// Whether Cargo tagged this folder as its target directory; the first bytes are all the tag holds.
export const cargoTagged = async (dir: string): Promise<boolean> => {
    const handle = await open(join(dir, "CACHEDIR.TAG"), "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return false;
    }
    try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0);
        const head = buffer.subarray(0, bytesRead).toString("utf8");
        return head.startsWith(CACHEDIR_SIGNATURE) && CARGO_TAG.test(head);
    } finally {
        await handle.close();
    }
};

// Whether `dir`, an entry of a folder whose plain files are `siblings`, is a build tool's output by name and marker or by
// Cargo's tag. Read by the sweep and by the Storage scan, so the two cannot disagree about what one is.
const isBuildOutputDir = async (dir: string, name: string, siblings: ReadonlySet<string>): Promise<boolean> =>
    BUILD_OUTPUTS.some((output) => output.dir === name && output.markers.some((marker) => siblings.has(marker))) || (await cargoTagged(dir));

// The same question asked of one folder alone, its siblings read from beside it: the Storage scan's, which meets folders
// one at a time rather than listed with their parent's files.
export const isBuildOutputPath = async (dir: string): Promise<boolean> => {
    const name = basename(dir);
    for (const output of BUILD_OUTPUTS.filter((candidate) => candidate.dir === name)) {
        for (const marker of output.markers) {
            if (await pathExists(join(dirname(dir), marker))) {
                return true;
            }
        }
    }
    return cargoTagged(dir);
};

// Candidates by name and marker or Cargo's tag, not descended into; symlinks are never followed. `root` is one
// repository's checkout.
export const findBuildOutputs = async (root: string, depth = 0): Promise<string[]> => {
    if (depth > MAX_DEPTH) {
        return [];
    }
    // A directory gone since its parent was read (a build cleaning up) has nothing left to find.
    const entries = (await readdir(root, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    // A nested repository is its own checkout, judged by its own ignore rules in its own pass.
    if (depth > 0 && entries.some((entry) => entry.name === ".git")) {
        return [];
    }
    const files = new Set(entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name));
    const found: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || SKIPPED.has(entry.name)) {
            continue;
        }
        const path = join(root, entry.name);
        if (await isBuildOutputDir(path, entry.name, files)) {
            found.push(path);
            continue;
        }
        found.push(...(await findBuildOutputs(path, depth + 1)));
    }
    return found;
};

// Ignored, and nothing under it tracked: a directory a repo commits (a fixture named `build`) is never output. Either
// git read failing reads as "keep": `check-ignore` exits 1 for a path it does not ignore, which is its answer.
const disposable = async (checkout: string, path: string): Promise<boolean> => {
    const rel = relative(checkout, path);
    const ignored = await defaultGit(checkout, ["check-ignore", "-q", "--", rel]).then(
        () => true,
        () => false,
    );
    if (!ignored) {
        return false;
    }
    const tracked = await defaultGit(checkout, ["ls-files", "--", rel]).then(
        ({ stdout }) => stdout.trim() !== "",
        () => true,
    );
    return !tracked;
};

// One folder removed by `rm` at low CPU and IO priority; where no `rm` can be started, by the daemon's own call.
export const removeQuietly = async (path: string): Promise<void> => {
    const exited = await new Promise<number | "unstarted">((resolve) => {
        const child = spawnAs({ class: "command" }, "rm", ["-rf", "--", path], { stdio: "ignore" });
        child.once("error", () => resolve("unstarted"));
        child.once("close", (code) => resolve(code ?? 1));
    });
    if (exited === "unstarted") {
        await rm(path, { recursive: true, force: true });
    } else if (exited !== 0) {
        throw new Error(`rm exited ${String(exited)} removing ${path}`);
    }
};

// INCREMENTAL FIRST (2026-11-03). Of one shinobi checkout's 32 GB `target/`, 16 GB was `debug/incremental`: rustc's
// per-session cache for the workspace's own crates, the half that only speeds up the next edit of the same session. It
// goes after an hour idle, the rest of the output after the settings' idle hours; a build after that recompiles the
// workspace's crates once, never the dependencies.
const INCREMENTAL = "incremental";

// A Cargo target's incremental caches: `<target>/<profile>/incremental`, and `<target>/<triple>/<profile>/incremental`
// for a cross build (the wasm32 one beside debug/).
const incrementalDirs = async (target: string): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
        const entries = (await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
        for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
            const path = join(dir, entry.name);
            if (entry.name === INCREMENTAL) {
                found.push(path);
            } else if (depth < 2) {
                await walk(path, depth + 1);
            }
        }
    };
    await walk(target, 0);
    return found;
};

// A Cargo target by name beside its Cargo.toml, or by Cargo's own tag.
const isCargoTarget = async (path: string): Promise<boolean> =>
    (basename(path) === "target" && (await pathExists(join(dirname(path), "Cargo.toml")))) || cargoTagged(path);

// Which part of a build output a pass takes: all of it, or only Cargo's incremental caches.
export type PruneScope = "all" | "incremental";

// What a pass removes of one build output folder it found: the folder itself, or the incremental caches inside it when
// it is a Cargo target (a Gradle or Flutter folder has none, and is left whole for the full pass).
const unitsOf = async (path: string, scope: PruneScope): Promise<string[]> => {
    if (scope === "all") {
        // An empty one frees nothing, and under a shared Cargo target it is the overlay's mount point: removed from the
        // daemon's side it would unmount the layer inside a namespace still holding it (cargo-warm.ts).
        const entries = (await readdir(path).catch(undefinedIfMissing)) ?? [];
        return entries.length === 0 ? [] : [path];
    }
    return (await isCargoTarget(path)) ? incrementalDirs(path) : [];
};

export interface PruneOptions {
    // `incremental` removes only Cargo's incremental caches; `all`, the default, every build output folder whole.
    readonly scope?: PruneScope;
    // Asked before each folder: false leaves the rest for a later pass (a turn opened in the checkout meanwhile).
    readonly proceed?: () => boolean;
    // A pause between folders, so a sweep of many spreads its IO rather than taking the disk in one burst.
    readonly paceMs?: number;
    readonly remove?: (path: string) => Promise<void>;
}

// Removes a checkout's build output and names what went; a directory that cannot be removed is left for the next pass,
// and one the pass stopped before is `skipped`.
export const pruneBuildOutputs = async (
    checkout: string,
    options: PruneOptions = {},
): Promise<{ removed: string[]; failed: string[]; skipped: string[] }> => {
    const removed: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    if (!(await stat(checkout).then((info) => info.isDirectory(), () => false))) {
        return { removed, failed, skipped };
    }
    const remove = options.remove ?? removeQuietly;
    for (const output of await findBuildOutputs(checkout)) {
        if (!(await disposable(checkout, output))) {
            continue;
        }
        for (const path of await unitsOf(output, options.scope ?? "all")) {
            if (options.proceed?.() === false) {
                skipped.push(relative(checkout, path));
                continue;
            }
            if (removed.length + failed.length > 0) {
                await sleep(options.paceMs ?? 0);
            }
            try {
                await remove(path);
                removed.push(relative(checkout, path));
            } catch {
                failed.push(relative(checkout, path));
            }
        }
    }
    return { removed, failed, skipped };
};
