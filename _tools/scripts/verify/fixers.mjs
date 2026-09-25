// What a machine can decide, done to the tree before any gate judges it, so no model is sent back to type it.
//
// Two callers. The check after a land runs these on the main tree (verify.mjs), the backstop. A conversation's worktree
// runs them before its land, so what they write rides the land that caused it instead of sitting uncommitted on main:
//
//   node _tools/scripts/verify/fixers.mjs --worktree <dir> --paths a,b,c     (or --paths-file <file>, or --since <rev>)
//
// Every fixer is scoped to the change and idempotent: a second run writes nothing. It prints one JSON line on stdout,
// `{"ran":[…],"wrote":[…]}`, the fixers that ran and the repo-relative paths whose content moved, and exits 0; a bad
// argument exits 2. It touches nothing outside the tree it is pointed at.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CHECKS } from "../../checks/manifest.mjs";
import { changedSince, git } from "../lib/git.mjs";

// Directories a crate walk never enters: build output and dependency trees hold no crate of this repository's.
const CRATE_SKIP = new Set(["node_modules", "target", "dist", "generated", ".cache", ".turbo", "out-tsc", ".git"]);
// A crate sits at most this deep below the root.
const CRATE_DEPTH = 4;

// Every directory holding a Cargo.toml, repo-relative.
export const crates = (root, dir = root, depth = 0) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (CRATE_SKIP.has(entry.name) || (entry.isDirectory() && entry.name.startsWith("."))) {
            return [];
        }
        if (entry.isDirectory()) {
            return depth < CRATE_DEPTH ? crates(root, join(dir, entry.name), depth + 1) : [];
        }
        return entry.name === "Cargo.toml" ? [relative(root, dir)] : [];
    });

// The crates holding any of `changed`; every crate when the change set is unknown.
export const touchedCrates = (root, changed) =>
    crates(root).filter((crate) => changed === undefined || changed.some((path) => path === crate || path.startsWith(`${crate}/`)));

// Whether cargo's formatter can run here at all.
export const rustfmtAvailable = (root) => spawnSync("cargo", ["fmt", "--version"], { cwd: root, encoding: "utf8" }).status === 0;

// Formats `list` in place; answers the crates whose files it changed.
export const formatCrates = (root, list) =>
    list.filter((crate) => {
        const before = git(root, "status", "--porcelain", "--", crate);
        spawnSync("cargo", ["fmt", "--manifest-path", join(crate, "Cargo.toml"), "--all"], { cwd: root, stdio: "ignore" });
        return git(root, "status", "--porcelain", "--", crate) !== before;
    });

// Runs each failing check's own `fix` (manifest.mjs); answers the ids it ran.
export const fixChecks = (root, verdicts) =>
    verdicts
        .filter((verdict) => !verdict.ok && verdict.measured)
        .flatMap((verdict) => {
            const check = CHECKS.find(({ id }) => id === verdict.id);
            if (check?.fix === undefined) {
                return [];
            }
            spawnSync(process.execPath, [join(root, "_tools/checks", check.file), ...check.fix], { cwd: root, stdio: "ignore" });
            return [check.id];
        });

const BASELINES = "_tools/checks/baselines";

// Lowers each ratcheted check's baseline where `changed` beat it (`--tighten`, lib/ratchet.mjs), so the lower count is
// written for the land that earned it and no other run moves it; answers the ids whose baseline moved. Nothing when the
// change set is unknown: an unscoped tighten would credit this land with every other change's shrinkage.
export const tightenBaselines = (root, changed) => {
    if (changed === undefined || changed.length === 0) {
        return [];
    }
    // By content rather than `git status`: a baseline already modified in the tree reads the same there after it moves.
    const snapshot = () => {
        const dir = join(root, BASELINES);
        return existsSync(dir) ? readdirSync(dir).map((name) => `${name}\n${readFileSync(join(dir, name), "utf8")}`).join("\n") : "";
    };
    return CHECKS.filter((check) => check.ratchet === true)
        .filter((check) => {
            const before = snapshot();
            spawnSync(process.execPath, [join(root, "_tools/checks", check.file), "--tighten", changed.join(",")], { cwd: root, stdio: "ignore" });
            return snapshot() !== before;
        })
        .map((check) => `${check.id} (baseline lowered)`);
};

const CONTRACT_SOURCES ="_shared/sandbox-contract/src/";
const CONTRACT_LOCK = "_shared/sandbox-contract/contract.lock.json";
const LOCK_WRITER = "_shared/sandbox-contract/scripts/write-lock.mjs";

// Rewrites the wire-contract lock from the emitted dist when a contract source changed; answers whether the lock moved.
export const regenerateContractLock = (root, changed) => {
    if (!(changed ?? []).some((path) => path.startsWith(CONTRACT_SOURCES)) || !existsSync(join(root, LOCK_WRITER))) {
        return false;
    }
    const before = git(root, "hash-object", CONTRACT_LOCK);
    spawnSync(process.execPath, [join(root, LOCK_WRITER)], { cwd: root, stdio: "ignore" });
    return git(root, "hash-object", CONTRACT_LOCK) !== before;
};

const DAEMON = "_sandbox/sandbox";
const STATE_SHAPES = `${DAEMON}/src/store/generated/state-shapes.json`;
const SHAPES_WRITER = "src/store/shapes/write-state-shapes.ts";

// Freezes any new shape of a stored document and rewrites the type-level checks that every frozen shape still converts
// to today's schema (the daemon's store/shapes/write-state-shapes.ts), when a daemon or contract source changed. The
// typecheck after it is what judges: this only records, the way the contract lock does. Answers whether the file moved.
export const regenerateStateShapes = (root, changed) => {
    const touches = (changed ?? []).some((path) => path.startsWith(`${DAEMON}/src/`) || path.startsWith(CONTRACT_SOURCES));
    if (!touches || !existsSync(join(root, DAEMON, SHAPES_WRITER))) {
        return false;
    }
    const before = existsSync(join(root, STATE_SHAPES)) ? git(root, "hash-object", STATE_SHAPES) : "";
    spawnSync(process.execPath, ["--import", "tsx", SHAPES_WRITER, "--freeze"], { cwd: join(root, DAEMON), stdio: "ignore" });
    return existsSync(join(root, STATE_SHAPES)) && git(root, "hash-object", STATE_SHAPES) !== before;
};

// Emits the contract's declarations and dist, which the lock is written from and the shape writer reads, in `root`
// alone: on the main tree the declarations emit already ran, in a worktree nothing has.
const emitContract = (root) => {
    const tsgo = join(root, "node_modules/.bin/tsgo");
    if (existsSync(tsgo)) {
        spawnSync(tsgo, ["-b", "_shared/sandbox-contract"], { cwd: root, stdio: "ignore" });
    }
};

// Each dirty path's content (or its absence), so a fixer's write shows even on a file the change had already modified.
const dirtyContents = (root) =>
    new Map(
        (git(root, "status", "--porcelain", "--untracked-files=all") ?? "")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(3).trim().split(" -> ").at(-1))
            .map((path) => [path, existsSync(join(root, path)) ? git(root, "hash-object", path)?.trim() : "absent"]),
    );

/**
 * Every machine fixer scoped to `changed` (repo-relative paths), in `root`: rustfmt on the crates it touched, the
 * ratcheted baselines it beat, the contract lock when it changed the contract, and the stored shapes when it changed a
 * daemon or contract source. Answers which ran and which paths they wrote.
 */
export const fixChange = (root, changed) => {
    const before = dirtyContents(root);
    const ran = [];
    if (rustfmtAvailable(root) && formatCrates(root, touchedCrates(root, changed)).length > 0) {
        ran.push("rustfmt");
    }
    ran.push(...tightenBaselines(root, changed));
    const contract = changed.some((path) => path.startsWith(CONTRACT_SOURCES));
    if (contract || changed.some((path) => path.startsWith(`${DAEMON}/src/`))) {
        if (contract) {
            emitContract(root);
        }
        if (regenerateContractLock(root, changed)) {
            ran.push("contract lock");
        }
        if (regenerateStateShapes(root, changed)) {
            ran.push("state shapes");
        }
    }
    const after = dirtyContents(root);
    const wrote = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).toSorted();
    return { ran, wrote };
};

const argument = (args, name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const args = process.argv.slice(2);
    const worktree = argument(args, "--worktree");
    const listed = argument(args, "--paths");
    const listFile = argument(args, "--paths-file");
    const since = argument(args, "--since");
    if (worktree === undefined || [listed, listFile, since].filter((given) => given !== undefined).length !== 1) {
        process.stderr.write("fixers: --worktree <dir> and exactly one of --paths a,b / --paths-file <file> / --since <rev>\n");
        process.exit(2);
    }
    const root = resolve(worktree);
    if (!existsSync(join(root, "_tools/checks/manifest.mjs"))) {
        process.stderr.write(`fixers: ${root} is not a checkout of this repository\n`);
        process.exit(2);
    }
    const changed =
        since !== undefined
            ? changedSince(root, since)
            : (listFile === undefined ? listed : readFileSync(listFile, "utf8")).split(/[,\n]/).map((path) => path.trim()).filter(Boolean);
    if (changed === undefined) {
        process.stderr.write(`fixers: git could not list what changed since ${since}\n`);
        process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(fixChange(root, changed))}\n`);
}
