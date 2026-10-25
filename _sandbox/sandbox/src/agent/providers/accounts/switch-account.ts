import type { SwitchAccount } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { type AgentHarness, type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../composition.js";
import { allowanceWall, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import { opt } from "../../../opt.js";

// Repoint a conversation's account; run resumes a held turn immediately, while a plain picker change starts nothing.
// Retire the previous account's session unless carry is set, and reroute usage holds plus held/queued/booked messages to the chosen account.
// Recompute the hold's reopen time; a person's pick also triggers a seat-marked Claude account's async recheck.

// When the picked account lets the held turn through, in epoch seconds: its reset while it reads spent (absent when it
// names none), now while it has room or no reading. `shown` is what the card states: only a real wait gets a clock.
//
// Judged by the one allowance wall (serviceability.ts allowanceWall) that the allowance gate and the resume pass read
// too, never by the polled reading alone. Every Claude reading is rounded, and a rounded pool at 100 is "at the line",
// not spent: only a refusal on file proves it spent. Read bare, every spent Claude account looked open, so a pick from one
// spent account to another re-timed the held turn to now and the next pass sent it, to be refused within seconds, while
// the composer counted down to the real reopen (2026-10-19).
const reopeningOf = async (
    services: ServiceabilityDeps,
    on: { readonly provider: AgentProvider; readonly account: string; readonly model: string | undefined },
    now: number,
): Promise<{ readonly reopensAt?: number; readonly shown?: number }> => {
    const { provider, account, model } = on;
    const wall = await allowanceWall(services, provider, account, model === undefined || model === "" ? undefined : { id: model }, now).catch((cause: unknown) => {
        services.logger?.warn({ err: cause, provider, account }, "account switch: could not read the picked account's allowance, its held turn is due now");
        return undefined;
    });
    if (wall === undefined) {
        return { reopensAt: Math.ceil(now / 1000) };
    }
    return wall.reopensAt === undefined ? {} : { reopensAt: wall.reopensAt, shown: wall.reopensAt };
};

export type AccountSwitch =
    | { readonly kind: "moved"; readonly run?: string }
    // No such conversation.
    | { readonly kind: "unknown" }
    // A turn is running (parked on a card included): its credential is already spent on it, its session frame would write
    // the old account back over the new one, and retiring the session would pull it out from under the turn.
    | { readonly kind: "busy" };

export const switchAccount = async (
    services: Pick<Services, "agents" | "claudeSeatCheck" | "conversations" | "sandboxSettings" | "turns"> & ServiceabilityDeps,
    input: SwitchAccount,
    now: number = Date.now(),
): Promise<AccountSwitch> => {
    const { conversationId, account, run: rerun, handoff } = input;
    // A trimmed copy is cut from the session as well, so it is kept whenever the hand-off carries or trims it.
    const carry = handoff === undefined ? input.carry === true : handoff === "carry" || handoff === "trim";
    const entry = services.agents.entry(conversationId);
    if (entry === undefined) {
        return { kind: "unknown" };
    }
    if (entry.profile.provider === "claude") {
        void services.claudeSeatCheck.recheck(account, { force: true });
    }
    const state = services.conversations.state(conversationId);
    const held = rerun === true ? state?.resume.held : undefined;
    if (held !== undefined) {
        const { agent, harness } = withRuntimeDefaults(held.input);
        const routing = { agent, harness, account, ...(carry ? { carry } : {}), ...(handoff === undefined ? {} : { handoff }) };
        // A person's press: a conversation archived since the turn was held reopens, as their words would reopen it.
        await services.agents.clearArchived([conversationId]);
        const run = await services.turns.resume(conversationId, routing);
        if (run !== undefined) {
            followPick(services, conversationId, routing);
            return { kind: "moved", run: run.id };
        }
        // A hold a press does not answer (an outage, a credential being re-minted) still takes the new account.
    }
    if (state?.phase.kind === "running") {
        return { kind: "busy" };
    }
    const limitHold = state?.resume.held?.reason === "limit" && !state.resume.held.fired ? state.resume.held : undefined;
    if (limitHold === undefined) {
        await services.agents.switchAccount(conversationId, account);
    } else {
        const reopening = await reopeningOf(services, { provider: withRuntimeDefaults(limitHold.input).agent, account, model: limitHold.input.model }, now);
        services.conversations.send(conversationId, {
            kind: "held-repointed",
            account,
            carry,
            ...opt("reopensAt", reopening.reopensAt),
        });
        // A way on named with the pick is the person's pick for the booked re-run too.
        if (handoff !== undefined) {
            services.conversations.send(conversationId, { kind: "handoff-chosen", handoff });
        }
        // The card's `next` reads the re-pointed hold, so the switch's own broadcast already says when the turn now goes.
        await services.agents.switchAccount(conversationId, account, opt("resetsAt", reopening.shown));
    }
    followPick(services, conversationId, { ...withRuntimeDefaults({ agent: entry.profile.provider, harness: entry.profile.harness }), account });
    if (entry.profile.account !== account && !carry) {
        await services.conversations.send(conversationId, { kind: "session-cleared" }).settled;
    }
    return { kind: "moved" };
};

// What a person's words wait with goes on the account picked: same provider and loop, its own model kept.
const followPick = (
    services: Pick<Services, "conversations">,
    conversationId: string,
    routing: { readonly agent: AgentProvider; readonly harness: AgentHarness; readonly account: string },
): void => {
    services.conversations.send(conversationId, { kind: "queue-rerouted", routing: { agent: routing.agent, harness: routing.harness, account: routing.account } });
};
