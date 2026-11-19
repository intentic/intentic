import type { SwitchAccount } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { type AgentHarness, type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import { endpointIdOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { HeldReading } from "../../../conversations/actor/limit-booking.js";
import type { WallDeps } from "../../run/turn/holds/allowance-gate.js";
import { pickedReading } from "../../run/turn/holds/held-verdict.js";

// Repoint a conversation's account; run resumes a held turn immediately, while a plain picker change starts nothing.
// Carry the session to the chosen account unless `carry: false` or a summary hand-off says otherwise, and reroute usage
// holds plus held/queued/booked messages to it. A person's pick also triggers a seat-marked Claude account's async recheck.

/* WHEN A PICKED ACCOUNT LETS THE HELD TURN THROUGH is read, not decided here: the pick reads the picked account's wall by
   the one reading the resume pass judges every hold with (held-verdict.ts pickedReading, over allowance-gate.ts
   wallAhead), puts it on the re-pointed hold, and states its reopen on the card only where it is a real wait. The pass
   reads it again on every beat after, so a picked account that reopens early, or is spent after the pick, moves the
   booking with it. Read off the polled reading alone, every spent Claude account looked open (each reading is rounded,
   and only a refusal on file proves one spent), so a pick from one spent account to another booked the held turn for
   now and the next pass sent it to be refused within seconds (2026-10-19); until 2026-11-19 the pick's instant was then
   kept on the hold and only ever pushed later. */

// The reopen the card states for the pick: one still ahead, a real wait; none where the picked account has room.
const shownReset = (reading: HeldReading, now: number): number | undefined =>
    reading.at !== undefined && reading.at > now ? reading.reopensAt : undefined;

/**
 * Whether the session goes with the switch, unless the switch says otherwise. The move stays inside the provider's own
 * runtime, and the session is the conversation's, not the account's, so the model keeps everything and re-reads it once
 * on the other account. Only the cache is lost, and a cold cache is lost already. A fresh session opened from the record
 * keeps far less: on the hand-off bench the record alone answered 50% of probe questions, against 93% for the carried
 * session (limit-handoff.ts). On 2026-10-28 a pick away from a refused account opened that fresh session, after fifteen
 * idle hours in which the cache had long expired. A trimmed copy is cut from the session as well, so it is kept whenever
 * the hand-off carries or trims it. A spent allowance's held turn that offers a choice of ways on is the exception: left
 * unasked, the way its offer suggests for the session's size decides (handoff-way.ts handoffFor), so a session too large
 * to re-read whole is trimmed or summarised rather than carried by default.
 */
const carriesSession = (input: Pick<SwitchAccount, "carry" | "handoff">, state: ReturnType<Services["conversations"]["state"]>): boolean => {
    if (input.handoff !== undefined) {
        return input.handoff === "carry" || input.handoff === "trim";
    }
    const offered = state?.resume.held?.reason === "limit" && state.resume.held.handoff !== undefined;
    return input.carry ?? !offered;
};

export type AccountSwitch =
    | { readonly kind: "moved"; readonly run?: string }
    // No such conversation.
    | { readonly kind: "unknown" }
    // A turn is running (parked on a card included): its credential is already spent on it, its session frame would write
    // the old account back over the new one, and retiring the session would pull it out from under the turn.
    | { readonly kind: "busy" }
    // The conversation runs on an API key (an endpoint), which has no accounts to move between: the account belongs to
    // another provider, which only a turn on that provider can move it to.
    | { readonly kind: "keyed" };

export const switchAccount = async (
    services: Pick<Services, "agents" | "claudeSeatCheck" | "conversations" | "sandboxSettings" | "turns"> & WallDeps,
    input: SwitchAccount,
    now: number = Date.now(),
): Promise<AccountSwitch> => {
    const { conversationId, account, run: rerun, handoff } = input;
    const entry = services.agents.entry(conversationId);
    if (entry === undefined) {
        return { kind: "unknown" };
    }
    // An account moved onto a conversation that runs on a key wrote a chimera: the key's provider with a sign-in's account
    // pinned (2026-11-07, a model picked from another provider through "Choose another model"). Its booked Continue then
    // waited for the sign-in's reopen and would have gone on the key whose credit had run out.
    if (endpointIdOf(entry.profile.provider) !== undefined) {
        return { kind: "keyed" };
    }
    const state = services.conversations.state(conversationId);
    const carry = carriesSession(input, state);
    if (entry.profile.provider === "claude") {
        void services.claudeSeatCheck.recheck(account, { force: true });
    }
    const held = rerun === true ? state?.resume.held : undefined;
    if (held !== undefined) {
        const { agent, harness } = withRuntimeDefaults(held.input);
        // A person's pick on the held turn: it goes on the account picked even where the records call it spent
        // (turn-facts.ts accountRouteOf), and the provider's own answer decides.
        const routing = { agent, harness, account, accountPicked: true, ...(carry ? { carry } : {}), ...(handoff === undefined ? {} : { handoff }) };
        // A person's press: a conversation archived since the turn was held reopens, as their words would reopen it.
        await services.agents.clearArchived([conversationId]);
        const run = await services.turns.resume(conversationId, routing);
        if (run !== undefined) {
            followPick(services, conversationId, routing);
            // The pick is the person's, so it holds while the cache is cold (account-placement.ts); the session frame
            // that binds the account keeps a pin on the account it binds.
            await services.agents.switchAccount(conversationId, account, undefined, { at: now });
            return { kind: "moved", run: run.id };
        }
        // A hold a press does not answer (an outage, a credential being re-minted) still takes the new account.
    }
    if (state?.phase.kind === "running") {
        return { kind: "busy" };
    }
    const limitHold = state?.resume.held?.reason === "limit" && !state.resume.held.fired ? state.resume.held : undefined;
    // Every switch through here is a person's pick: it pins the conversation to the account (agents-store.ts accountPin).
    const pin = { at: now };
    if (limitHold === undefined) {
        await services.agents.switchAccount(conversationId, account, undefined, pin);
    } else {
        const on = { provider: withRuntimeDefaults(limitHold.input).agent, account, model: limitHold.input.model };
        // A pick of the account it already goes on keeps the reading's start, so a child's spread holds still.
        const reading = await pickedReading(services, on, limitHold.onto?.account === account ? limitHold.reading : undefined, now);
        services.conversations.send(conversationId, { kind: "held-repointed", account, carry, reading });
        // A way on named with the pick is the person's pick for the booked re-run too.
        if (handoff !== undefined) {
            services.conversations.send(conversationId, { kind: "handoff-chosen", handoff });
        }
        // The card's `next` reads the re-pointed hold, so the switch's own broadcast already says when the turn now goes.
        await services.agents.switchAccount(conversationId, account, opt("resetsAt", shownReset(reading, now)), pin);
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
