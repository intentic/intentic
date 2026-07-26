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

// Node's execFile buffers stdout and REJECTS past its default 1 MiB, which real git output clears easily: an
// `ls-files`/`status` over a workspace with a large untracked tree (an un-gitignored node_modules, a build dir,
// a repo mid-upload) blows the limit and the caller sees ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead of a repo.
// 16 MiB is ~200k paths — past any tree a human reviews, and it matches what history.ts and iq-engine already
// pass. Not unbounded on purpose: a runaway git should fail, not exhaust the daemon's heap.
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

// Concurrency, not flakiness: `.git/index.lock` exists for the length of one index write, and in this product
// TWO writers share every worktree — the agent running `git add` in its turn and the owner clicking Stage in
// the panel. Whoever arrives second gets "Unable to create '.../index.lock': File exists", which is not an
// error about the repo, it is an error about the timing. Retry it (quadratic backoff, ~1.4s over 6 attempts,
// the shape VSCode's git extension settled on) and the loser simply proceeds a moment later.
//
// Only that one message retries. A genuinely failed command — bad ref, conflict, rejected push — must surface
// on its first attempt, because retrying it would just make the user wait to be told the same thing.
const LOCK_CONTENTION = /index\.lock.*File exists|Unable to create.*\.lock/i;
const RETRY_ATTEMPTS = 6;

const isLockContention = (error: unknown): boolean => {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === "string" && LOCK_CONTENTION.test(stderr);
};

// Runs a git subcommand inside `dir`; injectable so git operations are unit-testable without a real repo.
// Shared between the sandbox's git module and the CLI's adopt.
export type GitRunner = (dir: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
export const defaultGit: GitRunner = async (dir, args) => {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await exec("git", [...GIT_GLOBAL_ARGS, "-C", dir, ...args], { maxBuffer: MAX_GIT_OUTPUT });
        } catch (error) {
            if (attempt >= RETRY_ATTEMPTS || !isLockContention(error)) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 50));
        }
    }
};
