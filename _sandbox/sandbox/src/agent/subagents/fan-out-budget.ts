import type { Services } from "../../composition.js";
import { type BudgetClaim, claimBudget } from "../run/spend/budget-planner.js";
import { budgetHeldWords, budgetPlacedWords } from "../run/spend/budget-words.js";
import type { ChildSpawnResult, ChildSpawnSpec } from "./children.js";
import { laneHeldNote } from "./child-words.js";
import { FAN_OUT, type HeldWait, type Lane, siblingNewsWords } from "./fan-out-governor.js";
import { noteSpawnedChild } from "./subagents.js";
import { factsOf } from "./spawn-catalog.js";

/* WHAT THE FAN-OUT BUDGET SAYS OF ONE CHILD ABOUT TO START, as children.ts asks it: at the start its lane let through,
   and again each time the governor releases a held one. The planner (agent/run/spend/budget-planner.ts) places it on an
   account or holds it; this reads the accounts for it and puts the answer in the words its parent and its row read. */

// A claim on the provider's accounts. A child its spec already names an account for is judged on that account alone, and
// kept there. A provider whose accounts read no figure goes as it always did; so does a claim that fails, since a budget
// is advice.
const claimFor = async (services: Services, childId: string, spec: ChildSpawnSpec): Promise<BudgetClaim> => {
    try {
        const all = await factsOf(services, spec.provider);
        const readings = spec.account === undefined ? all : all.filter((reading) => reading.account === spec.account);
        if (readings.length === 0) {
            return { go: true };
        }
        // The child itself was counted as running by its lane's admission a moment ago.
        const childrenRunning = Math.max(0, FAN_OUT.runningOn(spec.provider) - 1);
        return await claimBudget(services, { provider: spec.provider, model: spec.model, readings, childId, childrenRunning });
    } catch (error) {
        services.logger.warn({ err: error, childId, provider: spec.provider }, "subagents: the fan-out budget could not be read, the child starts unplanned");
        return { go: true };
    }
};

/** A start the budget let go: its spec with the account it was placed on, and what its parent hears of the placement. */
export interface Placed {
    readonly spec: ChildSpawnSpec;
    readonly note: string | undefined;
}

/** A start the budget holds: why, in the words its row and its parent read, and when the window that holds it reopens. */
export interface BudgetHeld {
    readonly held: string;
    readonly retryAt: number | undefined;
}

// The budget's answer for a child its lane let through; one it holds no longer counts as running on its provider.
const budgetGate = async (services: Services, childId: string, spec: ChildSpawnSpec, lane: Lane): Promise<Placed | BudgetHeld> => {
    const claim = await claimFor(services, childId, spec);
    if (!claim.go) {
        FAN_OUT.retract(childId);
        return { held: budgetHeldWords(claim, lane), retryAt: claim.retryAt };
    }
    const placed = claim.account === undefined || spec.account !== undefined ? spec : { ...spec, account: claim.account };
    return { spec: placed, note: budgetPlacedWords(claim) };
};

/** A start as it is first asked: by its lane (a canary still unanswered holds it), then by the budget. */
export const startGate = async (services: Services, childId: string, spec: ChildSpawnSpec, lane: Lane): Promise<Placed | BudgetHeld> => {
    const admission = FAN_OUT.admit(childId, lane);
    return admission.go ? budgetGate(services, childId, spec, lane) : { held: admission.reason, retryAt: undefined };
};

/** A held start the governor released, asked of the budget again: placed, or still waiting, its row saying why. */
export const releasedGate = async (services: Services, childId: string, spec: ChildSpawnSpec, lane: Lane): Promise<Placed | HeldWait> => {
    const gate = await budgetGate(services, childId, spec, lane);
    if (!("held" in gate)) {
        return gate;
    }
    noteSpawnedChild(services.conversations, childId, { status: "pending", summary: `Held: ${gate.held}.` });
    return { wait: true, retryAt: gate.retryAt };
};

/** A held start's spawn result: why it waits, and what its siblings on the provider just ran into. */
export const heldResult = (id: string, reason: string, lane: Lane): ChildSpawnResult => {
    const news = siblingNewsWords(FAN_OUT.news(lane.provider));
    return { ok: true, id, held: true, note: [laneHeldNote(id, reason), news].filter((part) => part !== undefined).join(" ") };
};
