import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { CheckoutState } from "@intentic/sandbox-contract/schemas/metrics";
// Type only: a value import from system/ would close a cycle between the subsystems (daemon-boundaries).
import type { CheckoutFacts } from "../../system/resources/storage/checkout-usage.js";
import { overlaysDir } from "../worktrees/isolation.js";
import { leftoverRefusal, type OrphanCheckoutsDeps } from "../worktrees/orphan-checkouts.js";
import { type AgentArchiveDeps, buildOutputsReapable, checkoutReleaseRefusal, type RunningJobs, stillWorking } from "./archive.js";

// Where each measured checkout's conversation stands now, for the Storage card's per-conversation rows
// (system/resources/storage/checkout-usage.ts): read from the registry and the conversations, never from the disk scan.

export interface CheckoutStandingDeps {
    readonly archive: AgentArchiveDeps;
    readonly runningJobs: RunningJobs;
    readonly leftovers: Pick<OrphanCheckoutsDeps, "registry" | "owners" | "logger" | "historyRoot" | "worktreesRoot">;
    readonly now?: () => number;
}

// Statuses a turn or a land is under way in; the rest are settled (archive.ts SETTLED).
const BUSY: ReadonlySet<AgentSummary["status"]> = new Set(["running", "awaiting", "stopping", "dismissing", "resuming", "landing"]);
const HELD: ReadonlySet<AgentSummary["status"]> = new Set(["ready", "conflict", "error", "interrupted"]);

const stateOf = (deps: CheckoutStandingDeps, agent: AgentSummary): CheckoutState => {
    if (agent.archivedAt !== undefined) {
        return "archived";
    }
    if (deps.archive.conversations.running(agent.id) || BUSY.has(agent.status) || stillWorking(deps.archive, deps.runningJobs, agent.id) !== undefined) {
        return "working";
    }
    if (agent.status === "landed") {
        return "landed";
    }
    return HELD.has(agent.status) ? "held" : "idle";
};

export const checkoutStanding = async (deps: CheckoutStandingDeps, id: string): Promise<CheckoutFacts | undefined> => {
    const { historyRoot, worktreesRoot } = deps.leftovers;
    const standing = (await pathExists(join(worktreesRoot, id))) || (await pathExists(overlaysDir(historyRoot, id)));
    if (!standing) {
        return undefined;
    }
    const agent = deps.archive.agents.list().find((card) => card.id === id);
    if (agent === undefined) {
        return { state: "leftover", reapable: false, releasable: false, trashable: leftoverRefusal(deps.leftovers, id) === undefined };
    }
    const title = deps.archive.agents.entry(id)?.social.title?.text;
    return {
        state: stateOf(deps, agent),
        ...(title === undefined ? {} : { title }),
        updatedAt: agent.updatedAt,
        reapable: buildOutputsReapable(deps.archive, deps.runningJobs, agent, (deps.now ?? Date.now)()),
        releasable: checkoutReleaseRefusal(deps.archive, deps.runningJobs, id) === undefined,
        trashable: false,
    };
};
