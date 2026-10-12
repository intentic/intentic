import type { RepoBase, TurnNote } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { withConversationTrailer } from "../../git-identity.js";
import { headSha } from "../../git/changes/changes.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import type { AgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import type { TurnCheckpoint } from "./turn-checkpoints.js";

// Pins an isolated conversation's checkout (an isolated turn has no workspace-history capture to checkpoint on): commits
// what the checkout holds, then reads back the commit per repo, since HEAD alone would miss prior turns' uncommitted
// work. A failing repo drops out without failing the others; an checkpoint covering some repos beats none.

// What one checkpoint commit took out of the working tree: the agent's own uncommitted work, which `git status` no
// longer shows once it is committed. Agents read a clean status after a resume as their work being gone, and one undid
// the commit and cleaned the tree to "recover" it. So each capture is kept until the conversation's next prompt is
// composed, which says where the work went (checkpointNote).
export interface CheckpointCapture {
    readonly repo: string;
    readonly sha: string;
    readonly files: number;
    readonly title: string;
}

// Captures not yet told, per conversation. In memory: a capture is made as a turn opens or a message is steered, and
// told in the prompt that turn or the next one composes, in the same process.
const untold = new Map<string, CheckpointCapture[]>();
// The newest this many are told; a run of steered messages each committing a little says nothing more past it.
const UNTOLD_KEPT = 5;

export const CHECKPOINT_NOTE_HEADER = "## Your uncommitted work was committed";
export const CHECKPOINT_NOTE_TITLE = "Uncommitted work committed";

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

// The note for a run of captures, or undefined for none. Each names its commit and how to see it, since the commit
// is on the conversation's own branch and nothing else in the prompt mentions it.
export const checkpointNote = (captures: readonly CheckpointCapture[]): TurnNote | undefined => {
    if (captures.length === 0) {
        return undefined;
    }
    const lines = captures.map(
        ({ repo, sha, files, title }) =>
            `${repo}: ${plural(files, "file")} committed as ${sha.slice(0, 9)} "${title}"; see them with \`git show --stat ${sha.slice(0, 9)}\` and diff with \`git diff ${sha.slice(0, 9)}~1\`.`,
    );
    return {
        title: CHECKPOINT_NOTE_TITLE,
        text: `${CHECKPOINT_NOTE_HEADER}\n\nChanges left uncommitted in your checkout were committed for you, so \`git status\` reads clean: nothing was lost, and nothing needs undoing.\n${lines.join("\n")}`,
    };
};

// The note for every capture since the last one was told, clearing them: called once per composed prompt.
export const takeCheckpointNote = (conversationId: string): TurnNote | undefined => {
    const captures = untold.get(conversationId) ?? [];
    untold.delete(conversationId);
    return checkpointNote(captures);
};

const committedFiles = async (dir: string, git: GitRunner): Promise<number> => {
    const { stdout } = await git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", "HEAD"]);
    return stdout.split("\0").filter((path) => path !== "").length;
};

export interface CheckpointDeps {
    readonly agentWorktrees: Pick<AgentWorktrees, "worktreeDir" | "mainDir">;
    readonly logger: Logger;
}

// Resolves `forkOf.files: 'then'` to the source's own commits, or undefined when it can't; the caller then falls back
// to today's files rather than refuse the fork. Shas come from the daemon's own record only, never the request.
export const forkWorktreeBase = async (
    checkpoints: { readonly of: (conversationId: string, index: number) => Promise<TurnCheckpoint | undefined> },
    forkOf: { readonly conversationId: string; readonly keep: number; readonly files: "then" | "now" } | undefined,
): Promise<RepoBase[] | undefined> => {
    if (forkOf?.files !== "then") {
        return undefined;
    }
    const checkpoint = await checkpoints.of(forkOf.conversationId, forkOf.keep);
    return checkpoint?.kind === "worktree" ? [...checkpoint.repos] : undefined;
};

export const checkpointWorktree = async (
    services: CheckpointDeps,
    conversationId: string,
    repos: readonly { readonly repo: string; readonly base: string }[],
    // Commit message shown in `git log`; a steered message needs its own title, distinct from the turn boundary's.
    title = "Agent: before this turn",
    git: GitRunner = defaultGit,
): Promise<RepoBase[]> => {
    const anchored: RepoBase[] = [];
    for (const { repo } of repos) {
        const dir = services.agentWorktrees.worktreeDir(conversationId, repo);
        try {
            // Porcelain flags staged, unstaged and untracked changes but over-reports; the index decides what actually
            // goes in.
            const { stdout } = await git(dir, ["status", "--porcelain", "-z"]);
            // Titled as the turn boundary, so `git log` shows where each turn began instead of identical commit
            // names, and trailed with the conversation, since every agent commit has the same author.
            const committed =
                stdout !== "" && (await commitWorktreeRemainder(repo, dir, withConversationTrailer(title, conversationId), services.agentWorktrees.mainDir("root"), git));
            const base = await headSha(dir, git);
            if (committed && base !== undefined) {
                const capture: CheckpointCapture = { repo, sha: base, files: await committedFiles(dir, git), title };
                untold.set(conversationId, [...(untold.get(conversationId) ?? []), capture].slice(-UNTOLD_KEPT));
                services.logger.info({ conversationId, ...capture }, "checkpoints: committed the checkout's uncommitted work");
            }
            if (base !== undefined) {
                anchored.push({ repo, base });
            }
        } catch (error) {
            services.logger.warn({ err: error, conversationId, repo }, "checkpoints: pinning the worktree failed");
        }
    }
    return anchored;
};
