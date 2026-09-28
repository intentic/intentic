import { projectDirNameOf, RESERVED_PROJECT_DIR_NAMES } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";

// A PROJECT SANDBOX is made for one folder on the owner's computer, synced live into `/work/<name>`
// (sandbox-contract's ids/project-dir.ts); `ic` names it in SANDBOX_PROJECT_DIR. What the daemon does differently for
// one reads the name through here: no starter site beside it, the folder made a repo of its own, a note in the
// workspace's AGENTS.md, and the name in the /events hello.

type ProjectDirConfig = Pick<Config, "workspaceRoot" | "sandbox">;

// The folder's workspace-relative name, or undefined on a sandbox that was given none. A value that names no project
// folder reads as undefined too, but only a test ever sees that: requireProjectDir has refused to boot on one.
export const projectDirOf = (config: ProjectDirConfig): string | undefined =>
    config.sandbox.projectDir === "" ? undefined : projectDirNameOf(config.sandbox.projectDir, config.workspaceRoot);

// Why the configured folder is not one a project may use, or undefined when it is (or none is configured). The rule is
// spelled out whole, since the operator reading it has only the env and this line to go on.
export const projectDirComplaint = (config: ProjectDirConfig): string | undefined => {
    const value = config.sandbox.projectDir;
    if (value === "" || projectDirOf(config) !== undefined) {
        return undefined;
    }
    return (
        `SANDBOX_PROJECT_DIR=${value} is not a project folder: it must be ${config.workspaceRoot}/<name>, one folder directly ` +
        `under the workspace root, whose name starts with a letter or digit, holds only letters, digits, '.', '_' and '-', ` +
        `is at most 64 characters long, and is none of the names the daemon keeps for itself (${RESERVED_PROJECT_DIR_NAMES.join(", ")})`
    );
};

// Fail-closed like the local floor (boot/profile.ts): the owner's folder synced over the workspace root, `public/` or a
// state dir would be served to anyone with a link, seeded over or treated as the daemon's own, so a value naming one
// refuses to serve rather than guessing which folder was meant.
export const requireProjectDir = (config: ProjectDirConfig): void => {
    const complaint = projectDirComplaint(config);
    if (complaint === undefined) {
        return;
    }
    process.stderr.write(`FATAL: ${complaint}.\nFix it (or unset it on a sandbox that is not a project's) and restart.\n`);
    process.exit(78); // EX_CONFIG, same as the auth floor.
};

// Whether a fresh workspace gets the daemon's starter site: never beside the owner's project, where a demo repo would
// be the first thing an agent mistook for their work.
export const seedsStarterSite = (config: ProjectDirConfig): boolean => projectDirOf(config) === undefined;
