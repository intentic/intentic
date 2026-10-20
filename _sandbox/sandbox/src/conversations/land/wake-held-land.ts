import type { Services } from "../../composition.js";
import { decideLanding, performLandingWrites } from "./turn-landing.js";
import { awaitingWake, type ConversationState } from "../actor/conversation-state.js";
import { isIsolated } from "../registry/agents-store.js";
import { landByHandLeased, type LandByHandDeps } from "./land-by-hand.js";
import { landTargetOf } from "./land-target.js";
import { takeLandHeldForWake } from "./wake-held.js";

// THE LAND A WAKE HELD, run once the wake goes away without firing. A turn that ends while the conversation will run
// again by itself (a watch it armed, a job its ending handed to one) skips its land: the turn that wakes finishes the
// work (turn-close.ts step 4). A wake that never comes leaves that work on its branch, and the card in Active until a
// person stops what it waits on and then lands it by hand: on 2026-10-12 a finished conversation sat 38 minutes behind
// a demo server its turn had left running, and landed only on the second press. Stopping the wait is now the whole of
// it: the skipped land runs here, deciding as the close would have (the rules, the turn's own answer to landing by
// itself) and landing as a person's press does (land-by-hand.ts).

export type WakeHeldLandDeps = LandByHandDeps & Pick<Services, "sandboxSettings" | "activity" | "ruleFirings">;

// Whether the held land is not this moment's to run: a turn or a land is under way, or the conversation still waits on
// another wake, whose turn's own close decides the land again.
const notYet = (state: ConversationState | undefined): boolean =>
    state === undefined || state.phase.kind !== "idle" || state.turn.resuming || state.turn.landing || awaitingWake(state);

// Why a conversation at rest lands nothing of what its last close held, or undefined when it may: a message waiting,
// whose turn lands its own; a last turn that failed or was stopped, which never lands by itself; or no work held on its
// branch any more (a person landed or discarded it meanwhile).
const unlandable = (services: WakeHeldLandDeps, conversationId: string): string | undefined => {
    if (services.conversations.queued(conversationId).items.length > 0) {
        return "a message waits for its next turn";
    }
    if (services.agents.entry(conversationId)?.ending.kind !== "idle") {
        return "its last turn did not end clean";
    }
    return services.agents.standingOf(conversationId) === "ready" ? undefined : "nothing is held on its branch";
};

/**
 * Lands what the conversation's last close held for a wake that is now gone, once it is at rest and waits on nothing
 * else; called whenever a wake is disarmed without firing (watchers.ts). Nothing at all for a conversation whose close
 * held nothing, or that still waits on another wake: its held land stays for that wake's turn, whose own close decides
 * again. Never throws: a disarm must not fail on it, and a land that broke stays on the card as a pressed one does.
 */
export const landHeldForWake = async (services: WakeHeldLandDeps, conversationId: string, land: typeof landByHandLeased = landByHandLeased): Promise<void> => {
    if (notYet(services.conversations.state(conversationId))) {
        return;
    }
    // Off the record, so a wake a restart brought back (watchers.ts) still lands what its close held.
    const held = await takeLandHeldForWake(services, conversationId);
    const entry = services.agents.entry(conversationId);
    if (held === undefined || entry === undefined || !isIsolated(entry) || entry.archivedAt !== undefined) {
        return;
    }
    const why = unlandable(services, conversationId);
    if (why !== undefined) {
        services.logger.info({ conversationId, why }, "agents: the wake its land waited on went away, and nothing lands");
        return;
    }
    try {
        const span = entry.placement.repos.map(({ repo, base, landedTip }) => ({ repo, from: landedTip ?? base, dir: services.agentWorktrees.worktreeDir(conversationId, repo) }));
        const target = await landTargetOf(services, entry);
        const decision = await decideLanding(services, target, entry, held.autoLand, span);
        performLandingWrites(services, conversationId, decision.writes);
        if (decision.mode !== "check") {
            services.logger.info({ conversationId }, "agents: the wake its land waited on went away, and the rules hold the work on its branch");
            return;
        }
        const landed = await land(services, entry, "check", "outstanding");
        services.logger.info({ conversationId, landed: landed.landed, changed: landed.changed }, "agents: the wake its land waited on went away, and the land it held ran");
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "agents: the land a wake held could not run, the work waits on its branch");
    }
};
