// What a machine can decide, done to the tree before any gate judges it, so no model is sent back to type it.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { CHECKS } from "../../checks/manifest.mjs";
import { git } from "../lib/git.mjs";

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

const CONTRACT_SOURCES = "_shared/sandbox-contract/src/";
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
    spawnSync(process.execPath, ["--import", "tsx", SHAPES_WRITER], { cwd: join(root, DAEMON), stdio: "ignore" });
    return existsSync(join(root, STATE_SHAPES)) && git(root, "hash-object", STATE_SHAPES) !== before;
};
