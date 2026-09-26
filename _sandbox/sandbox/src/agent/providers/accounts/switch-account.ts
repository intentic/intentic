import { type SwitchAccount, withRuntimeDefaults } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";

// The one command that moves a conversation to another account (routing.ts reads where it points from then on). A turn
// a spent allowance or a stop is holding runs again at once on the account named, which is how "continue on another
// account" is pressed; otherwise the conversation's profile is re-pointed, and without `carry` its session retired, so the
// next turn opens fresh on the new account instead of replaying a session another account minted.
//
// A person's pick is also the one moment a seat-marked Claude account is re-tested at once (claude-seat-check.ts), off
// this command's clock: the pick is an attempt on the account, and the editor names it on the next turn as well.

export type AccountSwitch =
    | { readonly kind: "moved"; readonly run?: string }
    // No such conversation.
    | { readonly kind: "unknown" }
    // A turn is running (parked on a card included): its credential is already spent on it, its session frame would write
    // the old account back over the new one, and retiring the session would pull it out from under the turn.
    | { readonly kind: "busy" };

export const switchAccount = async (
    services: Pick<Services, "agents" | "claudeSeatCheck" | "conversations" | "turns">,
    input: SwitchAccount,
): Promise<AccountSwitch> => {
    const { conversationId, account, carry } = input;
    const entry = services.agents.entry(conversationId);
    if (entry === undefined) {
        return { kind: "unknown" };
    }
    if (entry.profile.provider === "claude") {
        void services.claudeSeatCheck.recheck(account, { force: true });
    }
    const state = services.conversations.state(conversationId);
    const held = state?.resume.held;
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
    await services.agents.switchAccount(conversationId, account);
    if (entry.profile.account !== account && carry !== true) {
        await services.conversations.send(conversationId, { kind: "session-cleared" }).settled;
    }
    return { kind: "moved" };
};

