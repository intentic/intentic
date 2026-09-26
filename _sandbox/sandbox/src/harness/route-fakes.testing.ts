import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { type Logger, pino } from "pino";
import type { AgentWorktrees } from "../conversations/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import { claudeStoreOf } from "../sessions/session-store.js";
import { workspacePaths } from "../workspace/workspace.js";
import { landingChecksNote } from "../workspace/deps/mainline-note.js";

// Route harness's recording fakes: the two process supervisors, inert history/files seams a test overrides selectively,
// and a temp workspace for repo-discovery suites. `services` composes the inert ones.

// What a conversation's opening turn discloses before its runtime says anything: the note telling it what runs after its
// work lands (workspace/deps/mainline-note.ts), as the harness's empty verify store reads it, the main tree never red.
export const OPENING_CHECKS_PREAMBLE: AgentEvent = { kind: "preamble", notes: [landingChecksNote([], false)] };

// A temp workspace on disk for repo discovery: each entry is a repo dir with a `.git`, optionally an operator/ panel
// (package.json with a dev script).
export const tempWorkspace = (repos: { name: string; panel?: boolean }[]): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "panels-"));
    for (const repo of repos) {
        const dir = join(root, repo.name);
        mkdirSync(join(dir, ".git"), { recursive: true });
        if (repo.panel === true) {
            mkdirSync(join(dir, "operator"), { recursive: true });
            writeFileSync(join(dir, "operator", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
        }
    }
    return workspacePaths(root);
};

// Inert history, no snapshots recorded, every id unknown; a test overrides just the members it asserts on.
export const fakeHistory = (overrides: Partial<Services["history"]> = {}): Services["history"] =>
    unstubbed("history", {
        start: () => {},
        stop: () => {},
        snapshot: async () => undefined,
        notifyUserWrite: () => {},
        list: async () => [],
        diff: async () => undefined,
        fileDiff: async () => undefined,
        restore: async () => false,
        ...overrides,
    });

// A real logger whose lines are kept, parsed and stripped of pid and time, for a suite asserting what a path logged at
// which level; every level is kept, so a suite filters by `message`.
export const recordingLogger = (): { readonly lines: Record<string, unknown>[]; readonly logger: Logger } => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
        { level: "trace", timestamp: false, messageKey: "message", formatters: { level: (label) => ({ level: label }) } },
        {
            write: (line: string) => {
                const { pid: _pid, hostname: _hostname, ...kept } = JSON.parse(line) as Record<string, unknown>;
                lines.push(kept);
            },
        },
    );
    return { lines, logger };
};

const exec = promisify(execFile);

// What a git command printed, trimmed; the runner every real-checkout suite reads its trees back with.
export const gitOut = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

// A main tree holding one committed file and a conversation's worktree on its own branch: real git for exactly what a
// land touches, every other worktree member inert. `root` holds both, for the suite to remove.
export const realCheckout = async (
    id: string,
): Promise<{ readonly root: string; readonly work: string; readonly worktree: string; readonly worktrees: AgentWorktrees }> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-turn-end-"));
    const work = join(root, "work");
    const worktree = join(root, "worktrees", id);
    await mkdir(work, { recursive: true });
    await gitOut(work, "init", "-q", "-b", "main");
    await writeFile(join(work, "app.ts"), "line one\n");
    await gitOut(work, "add", "-A");
    await gitOut(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    await gitOut(work, "worktree", "add", "-q", "-b", `agent/${id}`, worktree, "HEAD");
    const repos = [{ repo: "root", base: await gitOut(work, "rev-parse", "HEAD") }];
    return {
        root,
        work,
        worktree,
        worktrees: {
            conversationDir: () => worktree,
            worktreeDir: () => worktree,
            mainDir: () => work,
            sessionStore: (entry) => claudeStoreOf(work, root, entry),
            exists: async () => true,
            attached: async () => true,
            elsewhere: async () => [],
            snapshot: async () => repos,
            ensure: async () => ({ cwd: worktree, branch: `agent/${id}`, repos, fenced: false, elsewhere: [] }),
            remove: async () => {},
            retire: async () => {},
            reapRepoCheckout: async () => {},
            prune: async () => {},
            withRepoLock: (_repo, task) => task(),
            repoBusy: () => false,
        },
    };
};
