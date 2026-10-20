// What a machine can decide about a change, written into the tree so no model has to type it. Every land runs these in
// the tree it writes into, on what it landed (the sandbox's conversations/land/rederive.ts), so a derived file there is
// always the one that tree's sources make, and a lowered baseline is written for the change that earned it. By hand
// they do the same for any checkout of this repository:
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
import { touchesTables } from "../tools/layer-tables.mjs";

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

const BASELINES = "_tools/checks/baselines";

// Lowers each ratcheted check's baseline where `changed` beat it (`--tighten`, lib/ratchet.mjs), so the lower count is
// written for the change that earned it and no other run moves it. Answers the ids whose baseline moved, and nothing
// when the change set is unknown: an unscoped tighten would credit this change with every other change's shrinkage.
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

// Each derived file's writer: the changed paths that call for it, and the command that writes it, run from `cwd`. What
// `writes` names is `merge=derived` in .gitattributes, so no land carries it and a rebase keeps the side it lands on;
// a land runs this in the tree it writes into instead. The layer tables and the translations are the exception: a
// generated region inside a hand-written README, and what a machine may decide about a hand-written catalog (dropping
// what English no longer has), both merged like the rest of the file. In this order: the shapes freeze reads the registry the daemon's
// indexes write.
//
// From source, never from a build: `bun` with the `@intentic/src` condition reads every workspace package's own src/,
// so a writer answers for the tree as it stands in any checkout with an install. The lock and the shapes used to read
// whatever dist an earlier build had left: in a worktree there was none, and the shapes freeze crashed on a dist that
// lacked a module new in the contract, so the stored shapes fell behind main's schemas unseen.
const CONTRACT_SOURCES = "_shared/sandbox-contract/src/";
const DAEMON_SOURCES = "_sandbox/sandbox/src/";
const under = (...prefixes) => (_root, path) => prefixes.some((prefix) => path.startsWith(prefix));
const FROM_SOURCE = ["bun", "--conditions=@intentic/src"];
export const DERIVED = [
    {
        id: "contract lock",
        wants: under(CONTRACT_SOURCES),
        cwd: "_shared/sandbox-contract",
        argv: [...FROM_SOURCE, "scripts/write-lock.mjs"],
        writes: ["_shared/sandbox-contract/contract.lock.json"],
    },
    {
        id: "daemon indexes",
        wants: under(DAEMON_SOURCES),
        cwd: "_sandbox/sandbox",
        argv: [process.execPath, "scripts/write-indexes.mjs"],
        writes: ["_sandbox/sandbox/src/bootstrap/state-registry.ts", "_sandbox/sandbox/src/app-raw-routes.ts", "_sandbox/sandbox/src/bootstrap/slices/slice-registry.ts"],
    },
    {
        id: "state shapes",
        wants: under(DAEMON_SOURCES, CONTRACT_SOURCES),
        cwd: "_sandbox/sandbox",
        argv: [...FROM_SOURCE, "src/store/shapes/write-state-shapes.ts", "--freeze"],
        writes: ["_sandbox/sandbox/src/store/generated/state-shapes.json"],
    },
    { id: "layer tables", wants: touchesTables, cwd: ".", argv: [process.execPath, "_tools/checks/layer-tables.mjs", "--fix"], writes: [] },
    // A translation keeps only what English still says: a key `en.json` dropped leaves every other language's copy too.
    {
        id: "translations",
        wants: (_root, path) => /\/locales\/[\w-]+\.json$/.test(path),
        cwd: ".",
        argv: [process.execPath, "_tools/checks/i18n-catalogs.mjs", "--fix"],
        writes: [],
    },
];

// Each dirty path's content (or its absence), so a fixer's write shows even on a file the change had already modified.
const dirtyContents = (root) =>
    new Map(
        (git(root, "status", "--porcelain", "--untracked-files=all") ?? "")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(3).trim().split(" -> ").at(-1))
            .map((path) => [path, existsSync(join(root, path)) ? git(root, "hash-object", path)?.trim() : "absent"]),
    );
const snapshot = (root) => JSON.stringify([...dirtyContents(root)]);

// Runs, in `root`, every writer whose inputs `changed` touches; answers the ids of those that moved a file. A writer
// whose directory the tree lacks has nothing to write.
export const writeDerived = (root, changed) =>
    DERIVED.filter((writer) => changed.some((path) => writer.wants(root, path)) && existsSync(join(root, writer.cwd)))
        .filter((writer) => {
            const before = snapshot(root);
            spawnSync(writer.argv[0], writer.argv.slice(1), { cwd: join(root, writer.cwd), stdio: "ignore" });
            return snapshot(root) !== before;
        })
        .map((writer) => writer.id);

/**
 * Every machine fixer scoped to `changed` (repo-relative paths), in `root`: rustfmt on the crates it touched, the
 * ratcheted baselines it beat, and every derived file whose sources it reached (DERIVED). Answers which ran and which
 * paths they wrote.
 */
export const fixChange = (root, changed) => {
    const before = dirtyContents(root);
    const ran = [];
    if (rustfmtAvailable(root) && formatCrates(root, touchedCrates(root, changed)).length > 0) {
        ran.push("rustfmt");
    }
    ran.push(...tightenBaselines(root, changed), ...writeDerived(root, changed));
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
