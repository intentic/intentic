import { opt } from "../opt.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentTurn, RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { canonicalHarness } from "@intentic/sandbox-contract/models/agent-catalog";
import { type RunnerSync, type RunnerSyncLine, type RunnerTurn, runnerIncomingRef } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { defaultGit } from "@intentic/base/git";
import { whenAborted } from "@intentic/base/async";
import { mainBranchOf } from "../git/agent-refs.js";
import type { ConversationWorktree,AgentWorktrees } from "../conversations/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import type { RunnerHub } from "./runner-peer.js";
import { forgetRemoteRequest, forgetRemoteRequestsOf, noteRemoteRequest } from "./runner-requests.js";
import { openRunnerTurn } from "./ownership/account-holds.js";
import { collectHeld, payOwedStop, type RelayContext, relayTurn, stopRemoteTurn } from "./held-turns/runner-relay.js";

// One turn executed on a runner, the parent's side of the dispatch: mirrors the
// isolated arm's local shape, station for station.
// sync pull: the runner brings its mirror of each repo and the conversation's branch up to date.
// runTurn: re-yields the frames a local turn would have produced, persisted and published the same way.
// sync push: delivers to refs/runner-incoming/<id>; run in a finally, so an aborted turn still delivers what was
// pushed. A dropped link mid-turn is read through (runner-relay.ts): the runner finishes the turn either way, and the
// relay reads on from the frame it last had once the runner is back.
// Attachments ride inline (base64): daemon state, not repo content, so the mirror's git sync can't carry them.

// What a dispatch reads of the daemon: the runner's socket, the checkouts it mirrors, and the log.
export interface DispatchServices {
    readonly runnerHub: Pick<RunnerHub, "client" | "reconnected">;
    readonly logger: Services["logger"];
    readonly agentWorktrees: Pick<AgentWorktrees, "mainDir" | "worktreeDir">;
    readonly workspace: Pick<Services["workspace"], "root">;
}

// Sync lines go to the log, not the transcript: they are operations plumbing (clone progress, per-repo acks), and the
// transcript's own worktree frame already tells the user where things stand.
const drainSync = async (services: Pick<DispatchServices, "logger">, stream: AsyncIterable<RunnerSyncLine>): Promise<string | undefined> => {
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
const syncRepos = async (services: DispatchServices, worktree: ConversationWorktree): Promise<RunnerSync["repos"]> => {
    const repos: { repo: string; dir: string; mainBranch: string }[] = [];
    for (const { repo } of worktree.repos) {
        const mainBranch = (await mainBranchOf(services.agentWorktrees.mainDir(repo), defaultGit).catch(() => undefined)) ?? "main";
        repos.push({ repo, dir: repo === "root" ? "" : repo, mainBranch });
    }
    return repos;
};

// Chips and mentions alike: the runner resolves no path of the parent's, so everything the prompt points at ships as
// bytes.
const inlineAttachments = async (services: DispatchServices, turn: AgentTurn): Promise<RunnerTurn["attachments"]> => {
    const paths = [...(turn.attachments ?? []), ...(turn.mentions ?? [])];
    if (paths.length === 0) {
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
const advanceMirror = async (services: DispatchServices, conversationId: string, worktree: ConversationWorktree): Promise<void> => {
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

// The turn's branch back from the runner, over whichever socket it holds now (the one the turn started on may be long
// gone), then the mirror moved onto it. A runner out of reach keeps the branch: the next dispatch on this conversation
// collects its turn and delivers it before pulling (runner-relay.ts collectHeld), and a pull keeps anything it never
// delivered before it resets (runner-sync.ts).
const deliverBranch = async (services: DispatchServices, runnerId: string, sync: RunnerSync, worktree: ConversationWorktree): Promise<void> => {
    const client = services.runnerHub.client(runnerId);
    if (client === undefined) {
        services.logger.info({ id: sync.conversationId, runner: runnerId }, "runner dispatch: the runner is out of reach, so its branch comes back with the next turn here");
        return;
    }
    try {
        const pushed = await drainSync(services, await client.syncWorkspace(sync));
        if (pushed !== undefined) {
            services.logger.warn({ id: sync.conversationId, reason: pushed }, "runner dispatch: push after the turn failed");
        }
    } catch (error) {
        services.logger.warn({ err: error, id: sync.conversationId }, "runner dispatch: push after the turn failed");
    }
    await advanceMirror(services, sync.conversationId, worktree);
};

// What the runner is handed for this turn: the dispatch's residue, attachments inline.
const runnerTurnOf = async (services: DispatchServices, input: RoutedAgentTurn & { conversationId: string }, branch: string): Promise<RunnerTurn> => {
    const attachments = await inlineAttachments(services, input);
    return {
        conversationId: input.conversationId,
        branch,
        prompt: input.prompt,
        provider: input.agent,
        // Spelled canonically, so a turn on its provider's default loop reads `native` to the runner. Only Claude
        // Code turns travel unasked (credentialsTravel), and those spell `native` or `claude-code`, which every
        // runner build knows; a newer loop named on a runner placed by hand is refused there as one to update for.
        harness: canonicalHarness(input.agent, input.harness),
        ...opt("model", input.model),
        ...opt("effort", input.effort),
        ...opt("thinking", input.thinking),
        ...opt("fast", input.fast),
        ...opt("account", input.account),
        ...opt("sessionId", input.sessionId),
        ...opt("attachments", attachments),
    };
};

// Ties an answer back to where its card came from (runner-requests.ts); `resolved` is the card's last word.
const noteCards = (runnerId: string, conversationId: string) => (event: AgentEvent): readonly AgentEvent[] => {
    const requestId = (event as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && requestId !== "") {
        if (event.kind === "resolved") {
            forgetRemoteRequest(requestId);
        } else {
            noteRemoteRequest(requestId, { runnerId, conversationId });
        }
    }
    return [event];
};

export async function* dispatchRemoteTurn(
    services: DispatchServices,
    input: RoutedAgentTurn & { conversationId: string },
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
    const { conversationId } = input;
    const repos = await syncRepos(services, worktree);
    const sync = (op: "pull" | "push"): RunnerSync => ({ op, conversationId, branch: worktree.branch, repos });
    const context: RelayContext = { hub: services.runnerHub, logger: services.logger, runnerId, conversationId, signal };

    // Stop must reach the runner explicitly: closing the stream alone races the provider, still spending unseen. A
    // Stop during the sync round trip lands on an already-aborted signal a bare listener misses.
    const unwatchAbort = whenAborted(signal, () => stopRemoteTurn(context));
    // Every Claude account the runner borrows while this turn is open is held here, so no rotation revokes it under the
    // turn (runners/ownership/account-holds.ts).
    const closeHolds = openRunnerTurn(runnerId);
    try {
        await payOwedStop(context, client);
        // A turn the runner still holds from before (one this sandbox lost) comes home first: a pull would reset it.
        const earlier = yield* collectHeld(context, client, noteCards(runnerId, conversationId));
        if (earlier.collected) {
            await deliverBranch(services, runnerId, sync("push"), worktree);
        }
        if (earlier.end !== undefined && earlier.end.outcome !== "done") {
            yield { kind: "done" };
            return;
        }
        const live = services.runnerHub.client(runnerId) ?? client;
        const pulled = await drainSync(services, await live.syncWorkspace(sync("pull")));
        if (pulled !== undefined) {
            yield { kind: "error", message: `Preparing the runner's workspace failed: ${pulled}` };
            yield { kind: "done" };
            return;
        }
        const turn = await runnerTurnOf(services, input, worktree.branch);
        const end = yield* relayTurn(
            context,
            { client: live, open: (current) => current.runTurn(turn, signal === undefined ? {} : { signal }) },
            noteCards(runnerId, conversationId),
        );
        if (end.outcome !== "done") {
            // The relay said why it stopped following; the turn still closes here.
            yield { kind: "done" };
        }
    } finally {
        unwatchAbort();
        closeHolds();
        // The turn is over: nothing it raised can still be answered, so a stale id must not outlive it.
        forgetRemoteRequestsOf(conversationId);
        await deliverBranch(services, runnerId, sync("push"), worktree);
    }
}
