import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";

// Where a project's recent work has landed, read off its git history: the compact project map's ranking of areas and
// its "recent work" line. Still derived from the tree rather than written down, so it cannot go stale the way a
// paragraph would; it just reads the tree's history as well as its shape.
//
// Why it exists: the full map ranks areas by file count and stops at the top level, but sessions' first edits land a
// level or two deeper. Of 742 sessions that edited something (2026-09-15 to 10-06), four editor feature folders, the
// contract schemas and the daemon's agent folder took 38% of the first edits; the top 30 folders took 65%.

// Three weeks: long enough to hold a few hundred commits on an active repo, short enough that a finished push no
// longer reads as where work is.
const RECENT_DAYS = 21;
const RECENT_COMMITS = 400;
// git on a large history is well under a second here; a stuck one costs the line, never the turn.
const GIT_TIMEOUT_MS = 3_000;

// Folders whose churn says nothing about where work is: generated output, translations that follow every UI change,
// recorded baselines and fixtures.
const QUIET_DIRS = new Set(["generated", "dist", "locales", "baselines", "fixtures", "__snapshots__"]);
// Docs follow code here (a README changes in the commit that changed its package), and lockfiles follow installs.
const QUIET_FILE = /\.(md|lock|snap)$|(^|[-.])lock\.(json|ya?ml)$/;

// A folder of folders (features/, components/, a package's src/agent/): opened one more level, since the folder that
// names a feature is the one a session goes to. Judged by shape, not by name.
const SHELF_MIN_DIRS = 4;

export interface WorkspaceActivity {
    // Commits read, across every repository the project holds.
    readonly commits: number;
    // Distinct commits per project-relative folder at every depth, so an area of any depth can be scored.
    readonly byFolder: ReadonlyMap<string, number>;
    // The feature-sized folders most commits touched, busiest first.
    readonly hot: readonly { readonly folder: string; readonly commits: number }[];
}

const changedFiles = (repoDir: string): string[][] => {
    try {
        const out = execFileSync(
            "git",
            ["-C", repoDir, "log", `--since=${RECENT_DAYS}.days`, "-n", String(RECENT_COMMITS), "--no-merges", "--relative", "--name-only", "--format=%x1e"],
            { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
        );
        return out
            .split("\u001e")
            .slice(1)
            .map((commit) => commit.split("\n").filter((line) => line !== ""));
    } catch {
        // allow(silent-catch): not a repository, no git, or too slow: no history is a fact about this project, not a
        // failure of the turn.
        return [];
    }
};

// A `.git` directory, or the file a worktree or submodule has in its place.
const isRepo = (dir: string): boolean => existsSync(join(dir, ".git"));

const isQuiet = (path: string): boolean => {
    const segments = path.split("/");
    return (
        QUIET_FILE.test(segments.at(-1) ?? "") ||
        segments.slice(0, -1).some((segment) => segment.startsWith(".") || IGNORED_DIRS.has(segment) || QUIET_DIRS.has(segment))
    );
};

export interface ActivityInput {
    // The project the map describes, absolute.
    readonly projectRoot: string;
    // Its top-level areas, project-relative: the ones that are repositories of their own are read too, since a nested
    // repository's history is invisible from the outer one.
    readonly areas: readonly string[];
}

export const workspaceActivityOf = ({ projectRoot, areas }: ActivityInput): WorkspaceActivity => {
    const repos = [
        ...(isRepo(projectRoot) ? [{ dir: projectRoot, prefix: "" }] : []),
        ...areas.filter((area) => isRepo(join(projectRoot, area))).map((area) => ({ dir: join(projectRoot, area), prefix: `${area}/` })),
    ];
    const commits = repos.flatMap(({ dir, prefix }) => changedFiles(dir).map((files) => files.map((file) => `${prefix}${file}`)));

    const shelves = new Map<string, boolean>();
    const isShelf = (folder: string): boolean => {
        const known = shelves.get(folder);
        if (known !== undefined) {
            return known;
        }
        let shelf = false;
        try {
            const entries = readdirSync(join(projectRoot, folder), { withFileTypes: true });
            const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).length;
            const files = entries.filter((entry) => entry.isFile()).length;
            shelf = dirs >= SHELF_MIN_DIRS && files < dirs;
        } catch {
            // allow(silent-catch): gone since the commit, or unreadable: no shape to judge, so no deeper.
        }
        shelves.set(folder, shelf);
        return shelf;
    };
    // The feature-sized folder a file belongs to: one past a `src`, opened once more when that is a shelf; without a
    // `src`, three levels down (area, package, folder), opened the same way.
    const featureOf = (path: string): string | undefined => {
        const dirs = path.split("/").slice(0, -1);
        if (dirs.length === 0) {
            return undefined;
        }
        const src = dirs.indexOf("src");
        const start = src >= 0 ? src + 2 : 3;
        let depth = Math.min(start, dirs.length);
        if (depth < dirs.length && isShelf(dirs.slice(0, depth).join("/"))) {
            depth += 1;
        }
        return dirs.slice(0, depth).join("/");
    };

    const byFolder = new Map<string, number>();
    const byFeature = new Map<string, number>();
    for (const files of commits) {
        const kept = files.filter((file) => !isQuiet(file));
        const folders = new Set(kept.flatMap((file) => file.split("/").slice(0, -1).map((_, at, dirs) => dirs.slice(0, at + 1).join("/"))));
        for (const folder of folders) {
            byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
        }
        for (const feature of new Set(kept.map(featureOf).filter((folder) => folder !== undefined))) {
            byFeature.set(feature, (byFeature.get(feature) ?? 0) + 1);
        }
    }
    const hot = [...byFeature.entries()]
        .map(([folder, count]) => ({ folder, commits: count }))
        .toSorted((left, right) => right.commits - left.commits || left.folder.localeCompare(right.folder));
    return { commits: commits.length, byFolder, hot };
};

// Folders that share a parent read as one entry, `parent/{a,b}`, in the order their busiest member earned.
export const groupedFolders = (folders: readonly string[]): string[] => {
    const groups = new Map<string, string[]>();
    for (const folder of folders) {
        const cut = folder.lastIndexOf("/");
        const parent = cut === -1 ? "" : folder.slice(0, cut);
        groups.set(parent, [...(groups.get(parent) ?? []), cut === -1 ? folder : folder.slice(cut + 1)]);
    }
    // Top-level names have no parent to share, so they stay a plain list.
    return [...groups.entries()].flatMap(([parent, names]) =>
        parent === "" ? names : [`${parent}/${names.length === 1 ? (names[0] ?? "") : `{${names.join(",")}}`}`],
    );
};
