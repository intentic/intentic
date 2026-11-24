import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { newRowId } from "@intentic/sandbox-contract/ids/row-ids";
import type { RunnerHeldTurn } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import type { AgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import { workNotice } from "../held-turns/runner-work-notices.js";
import { outdatedRunner, pushHome, type RunnerSyncDoor, syncRepos } from "../runner-dispatch.js";
import type { RunnerHub } from "../runner-peer.js";

/* MOVING A CONVERSATION OFF ITS RUNNER (2026-11-24). A conversation's machine latches with its first turn, so one whose
   runner could not go on (an outdated build the dispatch now refuses, a machine that keeps failing) had no way forward
   but a new conversation told to "pick up the work of" the old one. zipper-a6t4 did that for ginger-v2nz: it read the
   transcript, found the work on the runner's disk by hand, exported it as patches through Windows, applied them and
   rebuilt, and went on without the session. Here the same conversation comes home: the runner pushes what it holds (its
   last turn's leftovers committed, any snapshot an older build set aside), the mirror moves onto it, the conversation
   is taken off the runner (`placeHere`, as a spawned child whose runner could not prepare is), and its session, which
   lives on the runner, is let go, so its next turn here opens one seeded from its record. */

const MOVE_HERE_BUSY = "the conversation's turn is running, wait for it to finish (or stop it), then move it";

// The doors of a runner a move uses.
interface MoveDoor extends RunnerSyncDoor {
    readonly heldTurn: (input: { readonly conversationId: string }) => Promise<RunnerHeldTurn>;
}

/** What a move reads and does, each the daemon's own (moveHereDeps). */
export interface MoveHereDeps {
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly placeHere: (id: string) => Promise<void>;
    readonly runnerHub: { readonly client: (id: string) => MoveDoor | undefined; readonly state: RunnerHub["state"] };
    readonly logger: Services["logger"];
    readonly agentWorktrees: Pick<AgentWorktrees, "mainDir" | "worktreeDir">;
    // Runs `work` while no turn or rewind holds the conversation; undefined when one does.
    readonly withRewindLease: <T>(id: string, work: () => Promise<T>) => Promise<T | undefined>;
    // Lets go of the conversation's runtime session, so its next turn opens one seeded from its record.
    readonly clearSession: (id: string) => Promise<void>;
    readonly note: (id: string, rows: readonly TranscriptRow[]) => Promise<void>;
}

export const moveHereDeps = (services: Pick<Services, "agents" | "runnerHub" | "logger" | "agentWorktrees" | "conversations" | "transcripts">): MoveHereDeps => ({
    entry: (id) => services.agents.entry(id),
    placeHere: async (id) => {
        await services.agents.placeHere(id);
    },
    runnerHub: services.runnerHub,
    logger: services.logger,
    agentWorktrees: services.agentWorktrees,
    withRewindLease: (id, work) => services.conversations.withRewindLease(id, work),
    clearSession: async (id) => {
        await services.conversations.send(id, { kind: "session-cleared" }).settled;
    },
    note: async (id, rows) => {
        await services.transcripts.append({ id }, [...rows]);
    },
});

// Drawn at its level, as the dispatch's own notices of a runner's work are (agent_notice frames).
const notice = (text: string, level: "info" | "warning"): TranscriptRow => ({ role: "notice", text, rowId: newRowId(), agentNotice: { level } });

// What the runner holds of the conversation's turns that would be lost by moving now; undefined when nothing.
const heldBack = async (client: MoveDoor, conversationId: string, runner: string): Promise<string | undefined> => {
    // allow(silent-catch): a runner too old to say holds nothing it could hand over, as the dispatch reads it (runner-relay.ts).
    const held = await client.heldTurn({ conversationId }).catch(() => undefined);
    if (held?.state === "live") {
        return `its turn is still running on the runner "${runner}": stop it first, then move it`;
    }
    if (held?.state === "finished" && held.events > held.acked) {
        return `the runner "${runner}" still holds a turn of it this sandbox has not shown yet: send it any message, which brings that turn here first, then move it`;
    }
    return undefined;
};

/** Brings a runner conversation's work home and takes it off the runner; refused (CONFLICT) while that would leave work
 *  behind: a turn running, a runner out of reach, a push that failed. Answers with the runner it was on. */
export const moveConversationHere = async (services: MoveHereDeps, conversationId: string): Promise<{ readonly from: string }> => {
    const entry = services.entry(conversationId);
    const placement = entry?.placement.kind === "worktree" ? entry.placement : undefined;
    const runner = placement?.runner;
    if (placement === undefined || runner === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "this conversation already runs in this sandbox" });
    }
    const client = services.runnerHub.client(runner);
    if (client === undefined) {
        throw new ORPCError("CONFLICT", {
            message: `the runner "${runner}" is offline, so what its last turn left there cannot come here yet: wake its machine, then move it`,
        });
    }
    const moved = await services.withRewindLease(conversationId, async () => {
        const held = await heldBack(client, conversationId, runner);
        if (held !== undefined) {
            throw new ORPCError("CONFLICT", { message: held });
        }
        const sync = { op: "push" as const, conversationId, branch: placement.branch, repos: await syncRepos(services, placement) };
        const pushed = await pushHome(services, client, sync, placement, new Map());
        if (pushed.failure !== undefined) {
            throw new ORPCError("CONFLICT", { message: `the runner "${runner}" could not send this conversation's work here (${pushed.failure}), so it stays on the runner` });
        }
        await services.placeHere(conversationId);
        // The runtime's session is on the runner's disk: the next turn here opens one seeded from the record.
        await services.clearSession(conversationId);
        const outdated = outdatedRunner(services, runner) !== undefined;
        const rows = [
            notice(
                `Moved here from the runner "${runner}" with its work. The next message runs in this sandbox, in the same checkout, with a fresh session that starts from this conversation's record.${ 
                    outdated ? ` That runner runs an older build, which sends a branch's commits only: anything its last turn left uncommitted there is still on it.` : ""}`,
                outdated ? "warning" : "info",
            ),
            ...pushed.works.map((work) => {
                const said = workNotice(work, runner);
                return notice(said.text, said.level);
            }),
        ];
        await services.note(conversationId, rows);
        return true;
    });
    if (moved === undefined) {
        throw new ORPCError("CONFLICT", { message: MOVE_HERE_BUSY });
    }
    services.logger.info({ id: conversationId, runner }, "runners: moved a conversation off its runner");
    return { from: runner };
};
