import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentTurn, RunnerSync, RunnerSyncLine, RunnerTurn } from "@intentic/sandbox-contract";
import { runnerIncomingRef } from "@intentic/sandbox-contract";
import { defaultGit } from "@intentic/scaffold";
import { whenAborted } from "../abort.js";
import { mainBranchOf } from "../agents/land/agent-refs.js";
import type { ConversationWorktree } from "../agents/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import { forgetRemoteRequest, forgetRemoteRequestsOf, noteRemoteRequest } from "./runner-requests.js";

// One turn executed on a runner, the parent's side of the dispatch (docs/remote-runners-plan.md §5): mirrors the
// isolated arm's local shape, station for station.
// sync pull: the runner brings its mirror of each repo and the conversation's branch up to date.
// runTurn: re-yields the frames a local turn would have produced, persisted and published the same way.
// sync push: delivers to refs/runner-incoming/<id>; run in a finally, so an aborted turn still delivers what was
// pushed.
// Attachments ride inline (base64): daemon state, not repo content, so the mirror's git sync can't carry them.

// Sync lines go to the log, not the transcript: they are operations plumbing (clone progress, per-repo acks), and the
// transcript's own worktree frame already tells the user where things stand.
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

// Repo id, workspace-relative dir ("" for the root), and each repo's own main branch, read from the parent's checkout
// since the parent is the origin.
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

// Hard-resets each repo whose incoming ref moved, the sanctioned way to move a checked-out branch, so diff, standing
// and land read a runner's work like a local turn's. Best-effort: one repo's failure must not hide another's delivery.
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

    // Stop must reach the runner explicitly: closing the stream alone races the provider, still spending unseen.
    const interrupt = (): void => {
        void client.interrupt({ conversationId: input.conversationId }).catch(() => undefined);
    };
    // A Stop during the sync round trip lands on an already-aborted signal a bare listener misses.
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
            // Ties an answer back to where its card came from (runner-requests.ts); `resolved` is the card's last word.
            const requestId = (event as { requestId?: unknown }).requestId;
            if (typeof requestId === "string" && requestId !== "") {
                if (event.kind === "resolved") {
                    forgetRemoteRequest(requestId);
                } else {
                    noteRemoteRequest(requestId, { runnerId, conversationId: input.conversationId });
                }
            }
            yield event;
        }
    } finally {
        unwatchAbort();
        // The turn is over: nothing it raised can still be answered, so a stale id must not outlive it.
        forgetRemoteRequestsOf(input.conversationId);
        // Best-effort: a failed push leaves the branch on the runner for the next pull to reconcile, never lost.
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
