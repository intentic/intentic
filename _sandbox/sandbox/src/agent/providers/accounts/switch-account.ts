import { headroomState, type SwitchAccount, withRuntimeDefaults } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";

// The one command that moves a conversation to another account (routing.ts reads where it points from then on). Asked to
// `run`, a turn a spent allowance or a stop is holding runs again at once on the account named, which is how "continue on
// another account" is pressed. Without it the move starts nothing, held turn or not (a pick in the model picker is a
// choice, never a press): the conversation's profile is re-pointed, and without `carry` its session retired, so the next
// turn opens fresh on the new account instead of replaying a session another account minted.
//
// A person's pick is also the one moment a seat-marked Claude account is re-tested at once (claude-seat-check.ts), off
// this command's clock: the pick is an attempt on the account, and the editor names it on the next turn as well.
//
// A pick while a spent allowance holds the turn re-points that hold too: its booked re-run goes on the picked account, at
// that account's reopen, and the card's reset says so. Left alone, the pass fired at the refused account's reset on the
// refused account, the one thing the person had just said not to do, while the card showed the old clock beside a
// composer counting down to the new one.

// When the picked account lets the held turn through, in epoch seconds: its reset while it reads spent (absent when it
// names none), now while it has room or no reading. `shown` is what the card states: only a real wait gets a clock.
const reopeningOf = async (
    services: Pick<Services, "accountUsage">,
    account: string,
    model: string | undefined,
    now: number,
): Promise<{ readonly reopensAt?: number; readonly shown?: number }> => {
    const usage = await services.accountUsage.read().catch(() => undefined);
    const state = headroomState(usage?.[account], model === undefined || model === "" ? undefined : { id: model });
    if (state.kind !== "spent") {
        return { reopensAt: Math.ceil(now / 1000) };
    }
    return state.reopensAt === undefined ? {} : { reopensAt: state.reopensAt, shown: state.reopensAt };
};

export type AccountSwitch =
    | { readonly kind: "moved"; readonly run?: string }
    // No such conversation.
    | { readonly kind: "unknown" }
    // A turn is running (parked on a card included): its credential is already spent on it, its session frame would write
    // the old account back over the new one, and retiring the session would pull it out from under the turn.
    | { readonly kind: "busy" };

export const switchAccount = async (
    services: Pick<Services, "accountUsage" | "agents" | "claudeSeatCheck" | "conversations" | "turns">,
    input: SwitchAccount,
    now: number = Date.now(),
): Promise<AccountSwitch> => {
    const { conversationId, account, carry, run: rerun } = input;
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
        const routing = { agent, harness, account, ...(carry === true ? { carry } : {}) };
        // A person's press: a conversation archived since the turn was held reopens, as their words would reopen it.
        await services.agents.clearArchived([conversationId]);
        const run = await services.turns.resume(conversationId, routing);
        if (run !== undefined) {
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
        const reopening = await reopeningOf(services, account, limitHold.input.model, now);
        services.conversations.send(conversationId, {
            kind: "held-repointed",
            account,
            carry: carry === true,
            ...(reopening.reopensAt === undefined ? {} : { reopensAt: reopening.reopensAt }),
        });
        await services.agents.switchAccount(conversationId, account, reopening.shown === undefined ? {} : { resetsAt: reopening.shown });
    }
    if (entry.profile.account !== account && carry !== true) {
        await services.conversations.send(conversationId, { kind: "session-cleared" }).settled;
    }
    return { kind: "moved" };
};

