import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ResumeReason } from "@intentic/sandbox-contract/events/resume";
import { loopLabel, loopOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { SwitchSegment } from "@intentic/sandbox-contract/schemas/providers/switched";
import type { Services } from "../../../composition.js";
import { type Holding, liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import type { PersistedAgent, StoredProfile } from "../../../conversations/registry/agents-store.js";
import { routingFor, sameLoop } from "../../../conversations/registry/routing.js";
import { accountFactsOf, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import { opt } from "../../../opt.js";

/* WHETHER A TURN SWITCHED WHAT ITS CONVERSATION RUNS ON (schemas/providers/switched.ts), told once as the turn starts so
   the record keeps it as a row. Read off the conversation's own record on either side of the turn's `begin`, which
   rewrites its profile (agents-registry.ts openedEntry): the record is what the turn runs on, never what a window last
   painted. Provider first, then account, then loop, else model; effort, thinking and fast mode are no switch.

   Said only where the record proves it: a conversation that has run no turn has nothing to switch from, and an account
   or model only one side names (the sandbox's pick before the session latched it, the provider's default model) cannot
   be said to have changed. */

/** What moved, and what the turn now runs on as `begin` left the record. */
export interface TurnSwitch {
    readonly segment: SwitchSegment;
    readonly profile: StoredProfile;
    // Whether the turn opens a fresh session seeded from the record rather than going on in the one before.
    readonly fresh: boolean;
}

/** The turn's own say: the session it resumes (none opens a fresh one) and the re-run it is, if one (turn-resume.ts). */
export interface SwitchingTurn {
    readonly sessionId?: string | undefined;
    readonly resume?: ResumeReason | undefined;
}

const named = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value);

const changed = (before: string | undefined, after: string | undefined): boolean => {
    const was = named(before);
    const is = named(after);
    return was !== undefined && is !== undefined && was !== is;
};

const segmentOf = (before: StoredProfile, after: StoredProfile): SwitchSegment | undefined => {
    if (before.provider !== after.provider) {
        return "provider";
    }
    if (changed(before.account, after.account)) {
        return "account";
    }
    if (!sameLoop(before, after.harness)) {
        return "loop";
    }
    return changed(before.model, after.model) ? "model" : undefined;
};

// The re-runs whose own row already says they went on another account (events/resume.ts): told once, by that row.
const TOLD_BY_RESUME: ReadonlySet<ResumeReason> = new Set<ResumeReason>(["switched", "carried"]);

/**
 * The switch a turn makes: `previous` is the conversation's record as it stood before the turn's `begin`, `current` as
 * `begin` left it. Undefined where nothing a switch names changed, or the conversation has not run a turn before.
 */
export const turnSwitchOf = (
    previous: Pick<PersistedAgent, "profile" | "sessionId" | "totals"> | undefined,
    current: Pick<PersistedAgent, "profile"> | undefined,
    turn: SwitchingTurn,
): TurnSwitch | undefined => {
    if (previous === undefined || current === undefined || previous.totals.turns === 0) {
        return undefined;
    }
    const segment = segmentOf(previous.profile, current.profile);
    if (segment === undefined || (segment === "account" && turn.resume !== undefined && TOLD_BY_RESUME.has(turn.resume))) {
        return undefined;
    }
    const { provider, harness, account } = current.profile;
    const { continues } = routingFor(previous.profile, { agent: provider, harness, account });
    return { segment, profile: current.profile, fresh: !continues || previous.sessionId === undefined || turn.sessionId === undefined };
};

// What the account is called in the sandbox, as its account rows name it; undefined where nothing names it, or the rows
// could not be read: the notice goes without a name rather than with a guess.
const accountNameOf = async (deps: ServiceabilityDeps & Pick<Services, "logger">, provider: string, account: string): Promise<string | undefined> => {
    try {
        return named((await accountFactsOf(deps, provider)).find((facts) => facts.account === account)?.label);
    } catch (error) {
        deps.logger.warn({ err: error, provider }, "turn switch: the account's name could not be read, so the notice goes without it");
        return undefined;
    }
};

/** The frame a switch is told as, its account and loop named as a person sees them. */
export const switchedFrame = async (
    deps: ServiceabilityDeps & Pick<Services, "logger">,
    change: TurnSwitch,
): Promise<Extract<AgentEvent, { kind: "switched" }>> => {
    const { provider, harness, model, account } = change.profile;
    const name = account === undefined ? undefined : await accountNameOf(deps, provider, account);
    return {
        kind: "switched",
        segment: change.segment,
        provider,
        ...opt("model", named(model)),
        ...opt("account", name),
        loop: loopLabel(provider, loopOf(provider, harness)),
        fresh: change.fresh,
    };
};

/**
 * The switch this turn makes, told once. A runner's mirror tells nothing: the parent that dispatched the turn reads its
 * own record and tells it there.
 */
export async function* switchFrames(
    services: ServiceabilityDeps & Pick<Services, "agents" | "logger" | "runnerParent">,
    conversationId: string,
    previous: PersistedAgent | undefined,
    turn: SwitchingTurn,
): AsyncGenerator<AgentEvent> {
    if (services.runnerParent.current !== undefined) {
        return;
    }
    const change = turnSwitchOf(previous, services.agents.entry(conversationId), turn);
    if (change !== undefined) {
        yield await switchedFrame(services, change);
    }
}

// A run the door turned away is never written (turn-runs.ts writeSettled), its switch row with it, though its `begin`
// already rewrote the record: what the record stood at before it is what the next turn is measured against, held here
// until a run that is written; `record` undefined where nothing was on it yet. Kept in memory only, so a restart measures
// from the record as it is.
const SWITCH_BASELINES: Holding<{ readonly record: PersistedAgent | undefined }> = { name: "switch baselines" };

/**
 * The placed turn, told first what it switched to since the last turn on the record: `previous` is the conversation's
 * record as it stood before this turn's `begin`, unless a run the door turned away came between.
 */
export async function* withSwitchTold(
    services: ServiceabilityDeps & Pick<Services, "agents" | "conversations" | "logger" | "runnerParent">,
    conversationId: string,
    previous: PersistedAgent | undefined,
    turn: SwitchingTurn,
    placed: AsyncIterable<AgentEvent>,
): AsyncGenerator<AgentEvent> {
    const baselines = services.conversations.holdings(SWITCH_BASELINES);
    const held = baselines.get(conversationId);
    const baseline = held === undefined ? previous : held.record;
    try {
        yield* switchFrames(services, conversationId, baseline, turn);
        yield* placed;
    } finally {
        // Read before the run finishes: every frame this turn made is folded by now, and the run is still this one.
        if (liveRunOf(services.conversations, conversationId)?.ranNothing === true) {
            baselines.hold(conversationId, conversationId, { record: baseline });
        } else {
            baselines.drop(conversationId);
        }
    }
}
