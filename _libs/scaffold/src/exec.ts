import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Shared promisified execFile — the most repeated one-liner across both apps (12+ files). Centralised here so
// consumers import one symbol instead of repeating the import + promisify dance.
export const exec = promisify(execFile);

// The policy flags every git invocation carries, whichever runner executes it.
//
// `core.fileMode=false`: workspace files arrive by browser upload, and the File API cannot expose Unix
// permissions — the packer stamps every entry 0644 (tarStream.ts), so executables committed as 100755 land
// 100644 and git reports each as a mode-only change. A dropped repo keeps its own .git (dropEntries.ts, so it
// stays connected to its remote), and the `filemode = true` that git init/clone writes there outranks system and
// global config — and is restored by the next upload. `-c` is the ONLY precedence that beats it.
//
// `--no-optional-locks`: a plain `git status` refreshes the stat cache, which takes .git/index.lock and rewrites
// .git/index. The daemon polls status on every workspace change, including while the browser is still uploading
// a dropped repo's own .git/index — two writers on one file. Reads must not mutate the repo they inspect, so the
// optional locks are off; the locks a commit/add genuinely needs are unaffected.
export const GIT_GLOBAL_ARGS = ["--no-optional-locks", "-c", "core.fileMode=false"] as const;

// Runs a git subcommand inside `dir`; injectable so git operations are unit-testable without a real repo.
// Shared between the sandbox's git module and the CLI's adopt.
export type GitRunner = (dir: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
export const defaultGit: GitRunner = (dir, args) => exec("git", [...GIT_GLOBAL_ARGS, "-C", dir, ...args]);
