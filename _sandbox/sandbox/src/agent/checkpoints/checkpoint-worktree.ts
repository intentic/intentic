import type { RepoBase } from "@intentic/sandbox-contract/schemas/agent";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { withConversationTrailer } from "../../git-identity.js";
import { headSha } from "../../git/changes/changes.js";
import { latchedMainBranch } from "../../git/main-line-lock.js";
import { detachFromSharedLine } from "../../workspace/layout/worktree-links.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import type { AgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import { type ZeroedFile, zeroedFiles } from "../../git/integrity/zeroed-files.js";
import type { TurnCheckpoint } from "../../store/journals/turn-checkpoints.js";
import { CHECKPOINT_NOTE_HEADER, CHECKPOINT_NOTE_TITLE } from "../../sessions/vocabulary/prompt-envelope.js";

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

// Files the checkpoint would not commit because a crash zeroed them (zeroed-files.ts): left uncommitted in the tree,
// HEAD holding their last good content, and told in the same note so the agent restores them instead of building on
// NUL bytes.
export interface CheckpointRefusal {
    readonly repo: string;
    readonly files: readonly ZeroedFile[];
}

// Captures not yet told, per conversation. In memory: a capture is made as a turn opens or a message is steered, and
// told in the prompt that turn or the next one composes, in the same process.
const untold = new Map<string, CheckpointCapture[]>();
const refused = new Map<string, CheckpointRefusal[]>();
// The newest this many are told; a run of steered messages each committing a little says nothing more past it.
const UNTOLD_KEPT = 5;

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

const REFUSED_LISTED = 20;

// What the checkpoint left out, in words an agent acts on: which files, what HEAD still holds, the one command back.
const refusalText = (refusals: readonly CheckpointRefusal[]): string => {
    const lines = refusals.map(({ repo, files }) => {
        const listed = files.slice(0, REFUSED_LISTED).map(({ path, size, how }) => `\`${path}\` (${how === "nul" ? `${String(size)} bytes, all NUL` : "now empty"})`);
        const more = files.length > REFUSED_LISTED ? ` and ${String(files.length - REFUSED_LISTED)} more` : "";
        return `${repo}: ${listed.join(", ")}${more}`;
    });
    return `\n\nThese files read as zeroed by a crash (the host lost power or the disk dropped writes), so they were NOT committed: HEAD still holds their last good content. Restore each with \`git checkout HEAD -- <path>\` unless you emptied it on purpose, redo whatever edit of yours it lost, and tell the owner.\n${lines.join("\n")}`;
};

// The note for a run of captures, or undefined for none. Each names its commit and how to see it, since the commit
// is on the conversation's own branch and nothing else in the prompt mentions it.
export const checkpointNote = (captures: readonly CheckpointCapture[], refusals: readonly CheckpointRefusal[] = []): TurnNote | undefined => {
    if (captures.length === 0 && refusals.length === 0) {
        return undefined;
    }
    const lines = captures.map(
        ({ repo, sha, files, title }) =>
            `${repo}: ${plural(files, "file")} committed as ${sha.slice(0, 9)} "${title}"; see them with \`git show --stat ${sha.slice(0, 9)}\` and diff with \`git diff ${sha.slice(0, 9)}~1\`.`,
    );
    const committed =
        captures.length === 0
            ? ""
            : `\n\nChanges left uncommitted in your checkout were committed for you, so \`git status\` reads clean: nothing was lost, and nothing needs undoing.\n${lines.join("\n")}`;
    return {
        title: CHECKPOINT_NOTE_TITLE,
        text: `${CHECKPOINT_NOTE_HEADER}${committed}${refusals.length === 0 ? "" : refusalText(refusals)}`,
    };
};

// The note for every capture since the last one was told, clearing them: called once per composed prompt.
export const takeCheckpointNote = (conversationId: string): TurnNote | undefined => {
    const captures = untold.get(conversationId) ?? [];
    const refusals = refused.get(conversationId) ?? [];
    untold.delete(conversationId);
    refused.delete(conversationId);
    return checkpointNote(captures, refusals);
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

// The zeroed files to leave out of this repo's checkpoint, filed for the conversation's next note. A scan that fails
// leaves nothing out: the checkpoint is worth more than the check.
const zeroedOf = async (services: CheckpointDeps, conversationId: string, repo: string, dir: string, git: GitRunner): Promise<readonly ZeroedFile[]> => {
    const zeroed = await zeroedFiles(dir, git).catch((err) => {
        services.logger.warn({ err, conversationId, repo }, "checkpoints: the zeroed-file scan failed, the checkpoint commits everything");
        return [];
    });
    if (zeroed.length > 0) {
        refused.set(conversationId, [...(refused.get(conversationId) ?? []).filter((entry) => entry.repo !== repo), { repo, files: zeroed }]);
        services.logger.error(
            { conversationId, repo, files: zeroed.length, paths: zeroed.slice(0, REFUSED_LISTED).map(({ path }) => path) },
            "checkpoints: tracked files read as zeroed by a crash, left out of the checkpoint so HEAD keeps their last good content",
        );
    }
    return zeroed;
};

// Said here, where a logger is: commitWorktreeRemainder detaches a checkout standing on a line someone else stands on
// before any commit of it (workspace/layout/worktree-links.ts), and this is the first commit of a turn.
const offTheMainLine = async (services: CheckpointDeps, conversationId: string, repo: string, dir: string, git: GitRunner): Promise<void> => {
    // allow(silent-catch): a repo whose main line cannot be read locks nothing; a branch another checkout holds still counts.
    const locked = await latchedMainBranch(services.agentWorktrees.mainDir(repo), git).catch(() => undefined);
    const line = await detachFromSharedLine(dir, locked, git);
    if (line !== undefined) {
        services.logger.warn({ conversationId, repo, branch: line }, "checkpoints: the checkout stood on a line another checkout holds, detached in place before committing");
    }
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
            await offTheMainLine(services, conversationId, repo, dir, git);
            // Porcelain flags staged, unstaged and untracked changes but over-reports; the index decides what actually
            // goes in.
            const { stdout } = await git(dir, ["status", "--porcelain", "-z"]);
            const zeroed = stdout === "" ? [] : await zeroedOf(services, conversationId, repo, dir, git);
            // Titled as the turn boundary, so `git log` shows where each turn began instead of identical commit
            // names, and trailed with the conversation, since every agent commit has the same author.
            const committed =
                stdout !== "" && (await commitWorktreeRemainder(
                    repo,
                    dir,
                    withConversationTrailer(title, conversationId),
                    services.agentWorktrees.mainDir("root"),
                    git,
                    zeroed.map(({ path }) => path),
                ));
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
