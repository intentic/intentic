import { opt } from "../opt.js";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { AgentTurn, RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { canonicalHarness } from "@intentic/sandbox-contract/models/agent-catalog";
import { type RunnerSync, type RunnerSyncLine, type RunnerTurn, runnerIncomingRef } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { defaultGit } from "@intentic/base/git";
import { whenAborted } from "@intentic/base/async";
import { mainBranchOf } from "../git/agent-refs.js";
import type { ConversationWorktree,AgentWorktrees } from "../conversations/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import type { RunnerHub } from "./runner-peer.js";
import { hostAnswering } from "../hosts/host-room.js";
import { forgetRemoteRequest, forgetRemoteRequestsOf, noteRemoteRequest } from "./runner-requests.js";
import { openRunnerTurn } from "./ownership/account-holds.js";
import { collectHeld, payOwedStop, type RelayContext, type RelayFrame, relayTurn, stopRemoteTurn } from "./held-turns/runner-relay.js";
import { bringPageHome } from "./held-turns/runner-pages.js";
import { bringPicturesHome } from "./held-turns/runner-pictures.js";
import { inlineFiles } from "./files/runner-files.js";
import { sweepArtifactsHome } from "./held-turns/runner-artifacts.js";

// One turn executed on a runner, the parent's side of the dispatch: mirrors the
// isolated arm's local shape, station for station.
// sync pull: the runner brings its mirror of each repo and the conversation's branch up to date.
// runTurn: re-yields the frames a local turn would have produced, persisted and published the same way.
// sync push: delivers to refs/runner-incoming/<id> as the turn's `done` arrives, before it is relayed, and again in a
// finally, so an aborted turn still delivers what was pushed. A dropped link mid-turn is read through (runner-relay.ts): the runner finishes the turn either way, and the
// relay reads on from the frame it last had once the runner is back.
// Attachments ride inline (base64): daemon state, not repo content, so the mirror's git sync can't carry them. For the
// same reason a page the turn shows (with its video and audio), and a picture a tool card shows (a screenshot, or a file
// the turn Read from its checkout), are fetched from the runner before their frame is relayed (held-turns/runner-pages.ts,
// held-turns/runner-pictures.ts), and whatever else the turn left in its artifacts folder before its `done`
// (held-turns/runner-artifacts.ts).

// What a dispatch reads of the daemon: the runner's socket, the checkouts it mirrors, and the log.
export interface DispatchServices {
    readonly runnerHub: Pick<RunnerHub, "client" | "reconnected">;
    // The machine each runner runs on and that machine's heartbeats, so a runner gone quiet on an awake machine is told
    // from one asleep with it (held-turns/runner-relay.ts); absent, a dropped runner is waited for the whole day.
    readonly runners?: Pick<Services["runners"], "list">;
    readonly hostHub?: Pick<Services["hostHub"], "state">;
    // How long a dropped runner may stay away while its machine answers; the relay's own line unless a test says.
    readonly runnerDownAfterMs?: number;
    readonly logger: Services["logger"];
    readonly agentWorktrees: Pick<AgentWorktrees, "mainDir" | "worktreeDir">;
    readonly workspace: Pick<Services["workspace"], "root">;
    // Where this sandbox keeps the key it re-signs a runner's page media with (runner-pages.ts).
    readonly config: Pick<Services["config"], "historyRoot">;
    // How long a turn's `done` waits for its branch; DONE_DELIVERY_MS unless a test says.
    readonly doneDeliveryMs?: number;
}

// How far before the dispatch a sweep of the runner's artifacts reaches back: a file written as the turn opened, and a
// little latency between the two machines, still count as the turn's.
const SWEEP_SLACK_MS = 60_000;

// How far back the sweep for a collected turn reaches: the runner says nothing of when that turn opened, so as far as it
// keeps one, a day after it ended (held-turns/remote-turns.ts, its retention), and a day before that. The sweep's own
// limits (per file, per turn) bound what such a window can bring, and a file already here byte for byte costs nothing.
const COLLECTED_SWEEP_MS = 2 * 24 * 60 * 60 * 1000;

// How long a turn's `done` waits for its branch: the push queues behind the runner's other git work. Past it `done` goes
// on, and the backstop push in the dispatch's `finally` delivers once the first one is through.
const DONE_DELIVERY_MS = 120_000;

// Asks, when a dropped runner has been away long enough to wonder, whether the machine it runs on still answers.
const hostAnsweringOf = (services: DispatchServices, runnerId: string): RelayContext["hostAnswering"] => {
    const { runners, hostHub } = services;
    if (runners === undefined || hostHub === undefined) {
        return undefined;
    }
    return async () => {
        const host = (await runners.list()).find((runner) => runner.id === runnerId)?.host;
        return hostAnswering(host, (door) => hostHub.state(door).pinged, Date.now());
    };
};

const relayContextOf = (services: DispatchServices, runnerId: string, conversationId: string, signal: AbortSignal | undefined): RelayContext => ({
    hub: services.runnerHub,
    logger: services.logger,
    runnerId,
    conversationId,
    signal,
    hostAnswering: hostAnsweringOf(services, runnerId),
    downAfterMs: services.runnerDownAfterMs,
});

// Waits for `work` (whose own failures it reports itself) at most `ms`.
const within = async (work: Promise<void>, ms: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    } finally {
        clearTimeout(timer);
    }
};

/** How a turn whose runner could not prepare its workspace ends, nothing having run there: a spawned child placed on the
 *  runner by the sandbox runs here instead on reading it (children.ts). */
export const RUNNER_PREP_FAILED = "Preparing the runner's workspace failed";

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
// bytes (runner-files.ts).
// An attachment escaping the workspace is left behind (the turn names it; nothing of it crosses).
const inlineAttachments = async (services: DispatchServices, turn: AgentTurn): Promise<RunnerTurn["attachments"]> => {
    const inlined = await inlineFiles(services.workspace.root, services.logger, { mentions: [...(turn.attachments ?? []), ...(turn.mentions ?? [])] });
    return inlined.files;
};

// Hard-resets each repo whose incoming ref moved, the sanctioned way to move a checked-out branch, so diff, standing
// and land read a runner's work like a local turn's. Best-effort: one repo's failure must not hide another's delivery.
// `applied` holds, per repo, the tip this dispatch already moved the mirror onto.
const advanceMirror = async (services: DispatchServices, conversationId: string, worktree: ConversationWorktree, applied: Map<string, string>): Promise<void> => {
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
        const checkout = services.agentWorktrees.worktreeDir(conversationId, repo);
        try {
            // The very tip this dispatch already applied (the turn's `done` delivered it, and this is the backstop's second
            // push) is left as it is: a reset would only throw away whatever moved the mirror on since. Any other tip is
            // applied, a rewind on the runner included: an older tip is the runner's history now, not a stale copy.
            if (applied.get(repo) !== delivered) {
                await defaultGit(checkout, ["reset", "--hard", delivered]);
                applied.set(repo, delivered);
            }
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
const deliverBranch = async (
    services: DispatchServices,
    runnerId: string,
    sync: RunnerSync,
    worktree: ConversationWorktree,
    applied: Map<string, string>,
): Promise<void> => {
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
    await advanceMirror(services, sync.conversationId, worktree, applied);
};

// What the runner is handed for this turn: the dispatch's residue, attachments inline.
const runnerTurnOf = async (
    services: DispatchServices,
    input: RoutedAgentTurn & { conversationId: string },
    branch: string,
    childNote: (() => Promise<TurnNote | undefined>) | undefined,
): Promise<RunnerTurn> => {
    const [attachments, note] = await Promise.all([inlineAttachments(services, input), childNote?.()]);
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
        ...opt("childNote", note),
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
    // A spawned child's opening note, written here where its record is (stream-agent.ts runnerChildNote).
    childNote?: () => Promise<TurnNote | undefined>,
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
    const context = relayContextOf(services, runnerId, conversationId, signal);
    const home = { hub: services.runnerHub, logger: services.logger, runnerId, workspaceRoot: services.workspace.root, historyRoot: services.config.historyRoot, conversationId };
    const openedAt = Date.now();
    // The tips this dispatch moved the mirror onto, per repo, and the delivery `done` started, which the backstop waits for.
    const applied = new Map<string, string>();
    let atDone: Promise<void> | undefined;
    const cards = noteCards(runnerId, conversationId);
    const relayed: RelayFrame = async (frame) => {
        // A terminal or a browser the turn used is the runner's: the editor opens it through `runners.openView`.
        const event = frame.kind === "terminal" || frame.kind === "browser" ? { ...frame, runner: runnerId } : frame;
        await bringPageHome(home, event);
        return cards(await bringPicturesHome(home, event));
    };
    // The live turn's `done` waits for its branch and for what it left in the runner's artifacts folder: the editor reads
    // Changes, diffs and the checkout's pictures off the mirror the moment the turn ends, and caches what it could not
    // find for the session. The `finally` push stays as the backstop for a turn that never said `done` here.
    const relayedLive: RelayFrame = async (event) => {
        if (event.kind !== "done") {
            return relayed(event);
        }
        atDone = deliverBranch(services, runnerId, sync("push"), worktree, applied);
        await within(atDone, services.doneDeliveryMs ?? DONE_DELIVERY_MS);
        const notices = await sweepArtifactsHome(home, Date.now() - openedAt + SWEEP_SLACK_MS);
        return [...notices, ...(await relayed(event))];
    };

    // Stop must reach the runner explicitly: closing the stream alone races the provider, still spending unseen. A
    // Stop during the sync round trip lands on an already-aborted signal a bare listener misses.
    const unwatchAbort = whenAborted(signal, () => stopRemoteTurn(context));
    // Every Claude account the runner borrows while this turn is open is held here, so no rotation revokes it under the
    // turn (runners/ownership/account-holds.ts).
    const closeHolds = openRunnerTurn(runnerId);
    try {
        await payOwedStop(context, client);
        // A turn the runner still holds from before (one this sandbox lost) comes home first: a pull would reset it.
        const earlier = yield* collectHeld(context, client, relayed);
        if (earlier.collected) {
            await deliverBranch(services, runnerId, sync("push"), worktree, applied);
            // Its files too, before the live turn's own window starts after it: its pictures came with their cards, but
            // a PDF, a video or an evidence file it left would otherwise never come home.
            yield* await sweepArtifactsHome(home, COLLECTED_SWEEP_MS);
        }
        if (earlier.end !== undefined && earlier.end.outcome !== "done") {
            yield { kind: "done" };
            return;
        }
        const live = services.runnerHub.client(runnerId) ?? client;
        const pulled = await drainSync(services, await live.syncWorkspace(sync("pull")));
        if (pulled !== undefined) {
            // Said so whoever placed it can act: the runner's copy is the runner's to repair, and the same task runs here
            // meanwhile (the shinobi-society audit, 2026-11-17: four children failed on a runner with no way on). A spawned
            // child goes on here by itself (children.ts).
            yield {
                kind: "error",
                message: `${RUNNER_PREP_FAILED}: ${pulled}. Nothing ran there. To run this task anyway, run it here, in this sandbox.`,
            };
            yield { kind: "done" };
            return;
        }
        const turn = await runnerTurnOf(services, input, worktree.branch, childNote);
        const end = yield* relayTurn(
            context,
            { client: live, open: (current) => current.runTurn(turn, signal === undefined ? {} : { signal }) },
            relayedLive,
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
        await atDone;
        await deliverBranch(services, runnerId, sync("push"), worktree, applied);
    }
}
