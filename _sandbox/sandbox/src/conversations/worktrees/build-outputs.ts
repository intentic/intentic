import { readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit } from "@intentic/base/git";

// BUILD OUTPUT IN QUIET CHECKOUTS (2026-10-21). A checkout lives until its conversation is archived (agentRetentionDays,
// 3 by default) or its held work is reclaimed (heldCheckoutDays, 14), and every build it ran leaves its output behind
// in it: measured that day, 38 GB across the finished checkouts, a Tauri `target/` of 9-14 GB in each conversation that
// built the desktop app. All of it is regenerable and none of it is the conversation's work, so once a checkout has
// sat quiet for a while its build output goes and the checkout itself stays. A conversation picked up again rebuilds
// on its first build, which is the whole cost.
//
// Only directories a build tool owns: named in BUILD_OUTPUTS, beside the file that makes that tool build there, ignored
// by git and holding nothing git tracks. node_modules and dist are never touched: in an isolated checkout they are
// mount points for the dependency overlays and main's built libraries (isolation.ts), not the checkout's own files.

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

// Candidates by name and marker, not descended into; symlinks are never followed. `root` is one repository's checkout.
const findBuildOutputs = async (root: string, depth = 0): Promise<string[]> => {
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
        if (BUILD_OUTPUTS.some(({ dir, markers }) => dir === entry.name && markers.some((marker) => files.has(marker)))) {
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

// Removes a checkout's build output and names what went; a directory that cannot be removed is left for the next pass.
export const pruneBuildOutputs = async (checkout: string): Promise<{ removed: string[]; failed: string[] }> => {
    const removed: string[] = [];
    const failed: string[] = [];
    if (!(await stat(checkout).then((info) => info.isDirectory(), () => false))) {
        return { removed, failed };
    }
    for (const path of await findBuildOutputs(checkout)) {
        if (!(await disposable(checkout, path))) {
            continue;
        }
        try {
            await rm(path, { recursive: true, force: true });
            removed.push(relative(checkout, path));
        } catch {
            failed.push(relative(checkout, path));
        }
    }
    return { removed, failed };
};
