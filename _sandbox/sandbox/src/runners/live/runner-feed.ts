import type { RunnerFeedCard, RunnerFeedFrame } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { AgentJob, AgentWatch } from "@intentic/sandbox-contract/schemas/agents";
import type { Services } from "../../composition.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import type { RunnerClient } from "../runner-peer.js";
import { olderRunner } from "./runner-calls.js";
import { runnerOf } from "./runner-stops.js";

/* THE PARENT'S HALF OF A RUNNER'S FEED (2026-11-23). The background jobs and armed watches of a conversation that runs on
   a runner live in the runner's actors, so the parent's card would list none of them and its footer would show nothing
   to stop. Each time a runner connects the parent opens the runner's `feed` (runner-live-doors.ts) and files what it says
   on the card of each conversation placed on that runner (the actor's `runner-shown`, beside its own `jobs-shown`, which
   it never replaces), and a word that the runner's browsers or desktop changed is announced to the editors as this
   sandbox's own change, which re-reads `system.browsers` and `system.desktop` with the runner's merged in. When the feed
   ends (the socket went), what it filed is cleared: the runner says it again when it is back. A runner older than the
   feed answers NOT_FOUND, and its conversations show nothing of the kind, as before. */

export interface RunnerFeedDeps {
    readonly agents: Pick<Services["agents"], "entry">;
    readonly conversations: Pick<Services["conversations"], "send">;
    readonly logger: Pick<Services["logger"], "info">;
}

// Which feed is current per runner, so one a reconnect replaced clears nothing of its successor's.
const current = new Map<string, symbol>();
// What each runner's feed filed, by conversation, to clear when it ends.
const filed = new Map<string, Set<string>>();

const show = (deps: RunnerFeedDeps, conversationId: string, jobs: readonly AgentJob[], watches: readonly AgentWatch[]): void => {
    deps.conversations.send(conversationId, { kind: "runner-shown", jobs, watches });
};

// Files one conversation's card when it is placed on this runner; anything else the runner says is not its to say.
const fileCard = (deps: RunnerFeedDeps, runner: string, card: RunnerFeedCard): void => {
    const entry = deps.agents.entry(card.conversationId);
    if (entry === undefined || runnerOf(entry) !== runner) {
        return;
    }
    const mine = filed.get(runner) ?? new Set<string>();
    filed.set(runner, mine);
    if (card.jobs.length === 0 && card.watches.length === 0) {
        mine.delete(card.conversationId);
    } else {
        mine.add(card.conversationId);
    }
    show(deps, card.conversationId, card.jobs, card.watches);
};

const clearRunner = (deps: RunnerFeedDeps, runner: string, keep: ReadonlySet<string> = new Set()): void => {
    const mine = filed.get(runner);
    for (const id of mine ?? []) {
        if (!keep.has(id)) {
            mine?.delete(id);
            show(deps, id, [], []);
        }
    }
};

const applyFeedFrame = (deps: RunnerFeedDeps, runner: string, frame: RunnerFeedFrame): void => {
    switch (frame.kind) {
        case "cards": {
            // The whole of what the runner holds now: whatever an earlier feed filed and this one does not name is gone.
            clearRunner(deps, runner, new Set(frame.cards.map((card) => card.conversationId)));
            for (const card of frame.cards) {
                fileCard(deps, runner, card);
            }
            return;
        }
        case "card": {
            fileCard(deps, runner, frame.card);
            return;
        }
        case "changed": {
            publishRuntimeChange(frame.domain);
        }
    }
};

/** Follows a runner's feed from its connect to its socket's end; fire-and-forget, never throws. */
export const followRunnerFeed = async (deps: RunnerFeedDeps, runner: string, client: Pick<RunnerClient, "feed">): Promise<void> => {
    const mine = Symbol(runner);
    current.set(runner, mine);
    try {
        for await (const frame of await client.feed()) {
            if (current.get(runner) !== mine) {
                return;
            }
            applyFeedFrame(deps, runner, frame);
        }
    } catch (error) {
        if (!(error instanceof Error && olderRunner(error))) {
            deps.logger.info({ err: error, runner }, "runner feed ended");
        }
    } finally {
        if (current.get(runner) === mine) {
            current.delete(runner);
            clearRunner(deps, runner);
            // Its windows and desktop leave the lists with it.
            publishRuntimeChange("browsers", "desktop");
        }
    }
};
