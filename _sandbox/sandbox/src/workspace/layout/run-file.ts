import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage, isMissing, undefinedIfMissing } from "@intentic/base/errors";
import { RUN_TARGETS_FILE, type RepoRunTargets, RunTargetsFileSchema, type RunTarget } from "@intentic/sandbox-contract/schemas/run-targets";
import type { AppPreview } from "./app-previews.js";
import { ROOT_REPO, repoDirOf } from "./repo-discovery.js";

/* A REPOSITORY'S `.intentic/run.json`, read the one way every reader takes it: the Run dialog's list (runs.targets), a
   run on a computer (runs.start), and the targets that run in the sandbox, which are served as the repository's apps
   (`<repo>--<target>`, each with its own preview address, Start and Stop). Read fresh every time: a commit or an agent
   can change the file between two reads. */

// The workspace's own repository (ROOT_REPO) keeps its file at the workspace root.
const filePath = (repo: string): string => (repo === ROOT_REPO ? RUN_TARGETS_FILE : `${repo}/${RUN_TARGETS_FILE}`);

const parsed = (repo: string, text: string): RepoRunTargets => {
    try {
        return { repo, path: filePath(repo), targets: RunTargetsFileSchema.parse(JSON.parse(text)).targets };
    } catch (error) {
        return { repo, path: filePath(repo), targets: [], error: errorMessage(error) };
    }
};

/** The repository's targets, or what is wrong with its file; undefined when it has none. */
export const readRunFile = async (root: string, repo: string): Promise<RepoRunTargets | undefined> => {
    let text: string | undefined;
    try {
        text = await readFile(join(repoDirOf(root, repo), RUN_TARGETS_FILE), "utf8").catch(undefinedIfMissing);
    } catch (error) {
        return { repo, path: filePath(repo), targets: [], error: `the file could not be read (${errnoCode(error) ?? errorMessage(error)})` };
    }
    return text === undefined ? undefined : parsed(repo, text);
};

// The targets of the file at `dir` that run in the sandbox; none for a missing or broken file, which the dialog reports.
export const sandboxTargetsAt = (dir: string): RunTarget[] => {
    let text: string;
    try {
        text = readFileSync(join(dir, RUN_TARGETS_FILE), "utf8");
    } catch (error) {
        // No file, or a `.intentic` that is a file rather than a folder: nothing declared.
        if (isMissing(error) || errnoCode(error) === "ENOTDIR") {
            return [];
        }
        throw error;
    }
    return parsed("", text).targets.filter((target) => target.command !== undefined);
};

/** The repository's sandbox targets as apps: run from its root, its `env` filled like an app's ({previewUrl:<sibling>}). */
export const runFileApps = (dir: string): AppPreview[] =>
    sandboxTargetsAt(dir).map((target) => ({
        app: target.name,
        kind: undefined,
        pkg: "",
        preview: { dev: target.command ?? "", env: target.env },
        command: target.command,
    }));
