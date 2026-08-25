import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentTurn, RunnerSync, RunnerSyncLine, RunnerTurn } from "@intentic/sandbox-contract";
import { runnerIncomingRef } from "@intentic/sandbox-contract";
import { defaultGit } from "@intentic/scaffold";
import { whenAborted } from "../abort.js";
import { mainBranchOf } from "../agents/agent-refs.js";
import type { ConversationWorktree } from "../agents/worktrees.js";
import type { Services } from "../composition.js";

/* ONE TURN, EXECUTED ON A RUNNER, the parent's side of the dispatch (docs/remote-runners-plan.md §5 at the
 * workspace root). The shape mirrors what the isolated arm does locally, station for station:
 *
 *   sync pull   — the runner brings its mirror of each repo's main line and the conversation's branch up to
 *                 date (the local arm's pre-turn rebase happens THERE, on the runner's CPU, which is the
 *                 whole point of the placement).
 *   runTurn     — the frames a local turn would have produced, re-yielded verbatim; the caller persists and
 *                 publishes them exactly as local ones.
 *   sync push   — the runner delivers the branch to refs/runner-incoming/<id>, and this side advances the
 *                 checked-out branch by hard-resetting the MIRROR worktree onto it, the move git sanctions
 *                 for a checked-out ref. The push runs in the finally: an aborted or failed turn still
 *                 delivers everything the runner committed, which is the failure model's "nothing lost that
 *                 was pushed".
 *
 * Attachments ride inline (base64) because they are daemon state, not repo content: the runner's mirror
 * syncs git, and a prompt naming a file the git road cannot carry would otherwise point at nothing. */

// One sync's lines are narrated to the log rather than the transcript: they are operations plumbing (clone
// progress, per-repo acks), and the transcript's own worktree frame already tells the user where they stand.
const drainSync = async (services: Services, stream: AsyncIterable<RunnerSyncLine>): Promise<string | undefined> => {
    for await (const line of stream) {
        if (line.kind === "line") {
            services.logger.info({ line: line.text }, "runner sync");
            continue;
        }
        return line.ok ? undefined : (line.detail ?? "the runner's workspace sync failed without saying why");
    }
    return "the runner's sync stream ended without an outcome — the link likely dropped";
};

// The composition as the sync input names it: repo id, workspace-relative dir ("" for the root), and each
// repo's own main branch name, read from the parent's checkout because the parent is the origin.
const syncRepos = async (services: Services, worktree: ConversationWorktree): Promise<RunnerSync["repos"]> => {
    const repos: { repo: string; dir: string; mainBranch: string }[] = [];
    for (const { repo } of worktree.repos) {
        const mainBranch = (await mainBranchOf(services.agentWorktrees.mainDir(repo), defaultGit).catch(() => undefined)) ?? "main";
        repos.push({ repo, dir: repo === "root" ? "" : repo, mainBranch });
    }
    return repos;
};

const inlineAttachments = async (services: Services, paths: readonly string[] | undefined): Promise<RunnerTurn["attachments"]> => {
    if (paths === undefined || paths.length === 0) {
        return undefined;
    }
    const files: { path: string; bytesBase64: string }[] = [];
    for (const path of paths) {
        try {
            files.push({ path, bytesBase64: (await readFile(join(services.workspace.root, path))).toString("base64") });
        } catch (error) {
            // A missing attachment costs itself, never the turn: the prompt still says what it says.
            services.logger.warn({ err: error, path }, "runner dispatch: attachment could not be read");
        }
    }
    return files.length > 0 ? files : undefined;
};

/* Advance the mirror after a push: each repo whose incoming ref moved gets its worktree hard-reset onto it,
 * which moves the checked-out agent/<id> branch through the sanctioned door and leaves diff, standing and
 * land reading the runner's work exactly as they read a local turn's. Best-effort per repo — one repo's
 * failure must not hide another's delivery. */
const advanceMirror = async (services: Services, conversationId: string, worktree: ConversationWorktree): Promise<void> => {
    const incoming = runnerIncomingRef(conversationId);
    for (const { repo } of worktree.repos) {
        const main = services.agentWorktrees.mainDir(repo);
        const delivered = await defaultGit(main, ["rev-parse", "--verify", "--quiet", incoming]).then(
            (out) => out.stdout.trim(),
            () => "",
        );
        if (delivered === "") {
            continue;
        }
        try {
            await defaultGit(services.agentWorktrees.worktreeDir(conversationId, repo), ["reset", "--hard", delivered]);
            // Spent: a stale incoming ref must not re-apply on a later turn that pushed nothing for this repo.
            await defaultGit(main, ["update-ref", "-d", incoming]);
        } catch (error) {
            services.logger.warn({ err: error, repo, id: conversationId }, "runner dispatch: advancing the mirror failed");
        }
    }
};

export async function* dispatchRemoteTurn(
    services: Services,
    input: AgentTurn & { conversationId: string },
    runnerId: string,
    worktree: ConversationWorktree,
    signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent> {
    const client = services.runnerHub.client(runnerId);
    if (client === undefined) {
        yield {
            kind: "error",
            message: `The runner "${runnerId}" is offline — its machine is asleep, or the runner container is down. This conversation runs there; wake it, or start a new conversation to work here.`,
        };
        yield { kind: "done" };
        return;
    }
    const branch = worktree.branch;
    const repos = await syncRepos(services, worktree);
    const sync = (op: "pull" | "push"): RunnerSync => ({ op, conversationId: input.conversationId, branch, repos });

    const pulled = await drainSync(services, await client.syncWorkspace(sync("pull")));
    if (pulled !== undefined) {
        yield { kind: "error", message: `Preparing the runner's workspace failed: ${pulled}` };
        yield { kind: "done" };
        return;
    }

    // The user's Stop reaches the runner as an explicit interrupt: closing the stream alone races the
    // provider on the far side, and an abort that only the parent knows about is a turn that keeps spending.
    const interrupt = (): void => {
        void client.interrupt({ conversationId: input.conversationId }).catch(() => undefined);
    };
    // The sync pull above is a round trip to another machine, so a Stop during it lands on an already-aborted
    // signal that a bare listener never hears — the runner would keep the turn nobody is waiting for.
    const unwatchAbort = whenAborted(signal, interrupt);
    try {
        const turn: RunnerTurn = {
            conversationId: input.conversationId,
            branch,
            prompt: input.prompt,
            provider: input.agent ?? "claude",
            harness: input.harness ?? "native",
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(input.fast !== undefined ? { fast: input.fast } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        };
        const attachments = await inlineAttachments(services, input.attachments);
        for await (const event of await client.runTurn(
            { ...turn, ...(attachments !== undefined ? { attachments } : {}) },
            signal !== undefined ? { signal } : {},
        )) {
            yield event;
        }
    } finally {
        unwatchAbort();
        /* Deliver whatever the runner committed, however the turn ended. Best-effort: a push the dropped
         * link refuses leaves the branch on the runner, which the next dispatch's pull reconciles — the
         * exact exposure a local power loss has today, and never data loss (the failure model's terms). */
        try {
            const pushed = await drainSync(services, await client.syncWorkspace(sync("push")));
            if (pushed !== undefined) {
                services.logger.warn({ id: input.conversationId, reason: pushed }, "runner dispatch: push after the turn failed");
            }
        } catch (error) {
            services.logger.warn({ err: error, id: input.conversationId }, "runner dispatch: push after the turn failed");
        }
        await advanceMirror(services, input.conversationId, worktree);
    }
}
