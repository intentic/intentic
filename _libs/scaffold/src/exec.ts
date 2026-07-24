import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Shared promisified execFile — the most repeated one-liner across both apps (12+ files). Centralised here so
// consumers import one symbol instead of repeating the import + promisify dance.
export const exec = promisify(execFile);

// Workspace files arrive by browser upload, and the File API cannot expose Unix permissions — the packer stamps
// every entry 0644 (tarStream.ts), so executables committed as 100755 land 100644 and git reports each as a
// mode-only change. A dropped repo keeps its own .git (dropEntries.ts, so it stays connected to its remote), and
// the `filemode = true` that git init/clone writes there outranks system and global config — and is restored by
// the next upload. `-c` is the ONLY precedence that beats it, so the policy rides every invocation.
export const IGNORE_FILE_MODE = ["-c", "core.fileMode=false"] as const;

// Runs a git subcommand inside `dir`; injectable so git operations are unit-testable without a real repo.
// Shared between the sandbox's git module and the CLI's adopt.
export type GitRunner = (dir: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
export const defaultGit: GitRunner = (dir, args) => exec("git", [...IGNORE_FILE_MODE, "-C", dir, ...args]);
