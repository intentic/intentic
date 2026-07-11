import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Shared promisified execFile — the most repeated one-liner across both apps (12+ files). Centralised here so
// consumers import one symbol instead of repeating the import + promisify dance.
export const exec = promisify(execFile);

// Runs a git subcommand inside `dir`; injectable so git operations are unit-testable without a real repo.
// Shared between the sandbox's git module and the CLI's adopt.
export type GitRunner = (dir: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
export const defaultGit: GitRunner = (dir, args) => exec("git", ["-C", dir, ...args]);
