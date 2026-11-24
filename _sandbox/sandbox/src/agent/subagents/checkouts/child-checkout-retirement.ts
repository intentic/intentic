import { isIsolated, worktreeOf } from "../../../conversations/registry/agents-store.js";
import type { Services } from "../../../composition.js";
import { runningJobsOf } from "../../tools/jobs/background-jobs.js";
import { CHILDREN } from "../child-records.js";
import { ROSTER } from "../../../conversations/actor/subagent-roster.js";
import type { PressureRelief } from "../../../system/resources/storage/disk-pressure.js";
import { boardCard } from "../../../conversations/registry/board-card.js";

/** A child keeps its checkout warm for this long after its last turn, so a quick follow-up avoids a fresh checkout. */
export const CHILD_CHECKOUT_IDLE_GRACE_MS = 20 * 60_000;

type RetirementServices = Pick<Services, "agents" | "conversations" | "agentWorktrees" | "logger">;
type Candidate = { readonly id: string; readonly endedAt: number };

const settled = new Set(["completed", "failed", "killed"]);
const safeStanding = new Set(["idle", "landed", "conflict"]);

const stillSafe = (services: RetirementServices, id: string): boolean => {
    const kid = services.conversations.holdings(CHILDREN).get(id);
    const row = services.conversations.holdings(ROSTER).get(id);
    const entry = services.agents.entry(id);
    const card = boardCard(services.agents, id);
    if (
        kid === undefined ||
        (row !== undefined && !settled.has(row.status)) ||
        kid.running ||
        kid.queued ||
        kid.held !== undefined ||
        kid.startHold !== undefined ||
        kid.paused !== undefined ||
        kid.pending !== undefined ||
        services.conversations.running(id) ||
        runningJobsOf(services.conversations, id).length > 0 ||
        (card?.queue?.items.length ?? 0) > 0 ||
        entry === undefined ||
        !isIsolated(entry) ||
        !safeStanding.has(services.agents.standingOf(id))
    ) {
        return false;
    }
    return true;
};

const candidates = (services: RetirementServices, now: number, graceMs: number): Candidate[] =>
    services.conversations
        .holdings(CHILDREN)
        .entries()
        .flatMap(([id]) => {
            const row = services.conversations.holdings(ROSTER).get(id);
            const entry = services.agents.entry(id);
            const endedAt = row?.endedAt ?? entry?.updatedAt;
            return endedAt !== undefined && now - endedAt >= graceMs && stillSafe(services, id) ? [{ id, endedAt }] : [];
        })
        .toSorted((left, right) => left.endedAt - right.endedAt);

const retireOne = async (services: RetirementServices, id: string): Promise<boolean> => {
    // The land lease serializes this decision with a land already underway. Recheck inside it: a send, question, or
    // land may have started while the candidate was waiting for its turn in the sweep.
    return services.conversations.withLandLease(id, async () => {
        if (!stillSafe(services, id)) {
            return false;
        }
        const entry = services.agents.entry(id);
        const composition = worktreeOf(entry);
        if (entry === undefined || composition === undefined || (await services.agentWorktrees.presence(id)) !== "present") {
            return false;
        }
        await services.agentWorktrees.retire(id, composition.repos, entry.social.title?.text);
        return true;
    });
};

/** Retires old, settled child checkouts; used by the periodic housekeeper and by disk-pressure relief. */
export const retireIdleChildCheckouts = async (
    services: RetirementServices,
    options: { readonly now: number; readonly graceMs: number; readonly enough?: () => Promise<boolean> },
): Promise<number> => {
    let retired = 0;
    for (const { id } of candidates(services, options.now, options.graceMs)) {
        if (await options.enough?.()) {
            break;
        }
        try {
            if (await retireOne(services, id)) {
                retired += 1;
            }
        } catch (error) {
            services.logger.warn({ err: error, id }, "subagents: idle child checkout retirement failed; left for the next sweep");
        }
    }
    return retired;
};

/** Settled child branches can be restored later, so reclaim them before deleting caches or other stored artifacts. */
export const idleChildCheckoutsRelief = (
    services: RetirementServices,
): PressureRelief => ({
    name: "idle child checkouts",
    free: (enough) => retireIdleChildCheckouts(services, { now: Date.now(), graceMs: 0, enough }),
});
