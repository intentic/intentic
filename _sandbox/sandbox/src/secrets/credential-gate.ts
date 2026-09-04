import type { AgentEvent, CredentialGateKind, CredentialLane, CredentialOffer } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import { credentialUse } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../platform/leftovers.js";
import type { CredentialGatesStore } from "./credential-gates.js";
import type { CredentialGrants } from "./credential-grants.js";

/* THE RELEASE GATE: the one place a gated credential's "not yet" becomes "yes, released by Bob".
 *
 * Every exit that can spend a stored value comes through here — the shell and JS reference resolvers, the
 * browser's type_secret, the per-call account exits, the OTP route, and the mount filter's own door
 * (`secrets request`). One consult, so the rule cannot be enforced at three doors and forgotten at the
 * fourth, and one set of refusal sentences, so the model reads the same explanation whichever door it hit.
 *
 * MODELLED ON THE PAYMENT GATE (wallet/payment-offer.ts) down to the frame pushing, because the shape of the
 * problem is identical: a decision that must be a person's, reached from code running deep inside a turn
 * rather than from the turn generator. So the card is pushed into the LIVE RUN's frame log and mirrored to
 * the registry by hand, and it is deliberately not journalled for restore — its waiter is a held PreToolUse
 * hook or a held CLI connection, both of which die with the daemon, and a restored card would offer buttons
 * with nothing behind them. After a restart the next use simply asks again.
 *
 * WHERE IT DIFFERS, and it is the whole point of the feature: the payment card is addressed to THE OWNER, and
 * this one is addressed to a NAMED LIST. So the card carries its approvers, the waiter carries a `mayAnswer`
 * that the reply route consults against the verified identity on the request (agent/agent-requests.ts), and a
 * click from anybody else is refused with the card left standing. The owner is on that list only if the owner
 * put themselves on it.
 *
 * IT FAILS CLOSED, FOUR WAYS, and each is a refusal rather than a hold because each means there is nobody to
 * ask rather than nobody who has answered yet: an unreadable policy (a gate we cannot read is a gate we must
 * assume), an unattended turn, a turn with no live conversation to draw the card in, and a released reply
 * that somehow carries no verified approver. Every refusal names who could have released it and tells the
 * model not to retry, the command gate's own wording (guard/command-gate.ts cannotAsk), because a turn that
 * works around a refusal it was just given is the failure these sentences exist to prevent.
 *
 * WHAT IT IS NOT. Not a second lock on the vault: the value was always readable by this container, and a
 * shell here runs as the owner of both the vault and the policy (SECURITY.md). It is a wall against the
 * AGENT's own judgment being the last word on WHEN a credential is spent. */

const OFFER_DEADLINE_MS = 10 * 60_000;
const WHY_MAX = 280;
// The card's "where it would go" line. Long enough to recognize a command or a host, short enough that the
// card stays a card; the use ledger's own DETAIL_MAX, for the same reason.
const DETAIL_MAX = 80;

export interface CredentialGateDeps {
    readonly gates: CredentialGatesStore;
    readonly grants: CredentialGrants;
    // The live turn the card lands in, the payment gate's own seam, verbatim.
    readonly liveRun: (
        conversationId: string | undefined,
    ) => { readonly conversationId: string; readonly push: (event: AgentEvent) => void } | undefined;
    readonly observe: (conversationId: string, event: AgentEvent) => void;
    /* Buzz the owner's devices when the card goes up, the one offer card that does (push/notifications.ts
     * argues why: this one waits for somebody who may not know a turn is running). Optional so the gate's
     * tests need no push stack, and fire-and-forget for the observer's reason — a notification that fails
     * must never fail the release. */
    readonly notify?: (conversationId: string) => void;
    readonly deadlineMs?: number;
    readonly now?: () => number;
}

export interface CredentialCheck {
    // The gate's subject: an env/generated key, or a capability id. Derived from a registry name by
    // `gateTargetOf` (credential-gates.ts), which is the one place the name→subject rule lives.
    readonly subject: string;
    readonly kind: CredentialGateKind;
    readonly lane: CredentialLane;
    // Where it would go, in the reader's terms. Reference-form by construction on the secret lanes: the value
    // has not been substituted at the moment this is called, which is what makes the card safe to show.
    readonly detail?: string;
    // The agent's own line of rationale, where a door collects one (`secrets request --why`).
    readonly why?: string;
    readonly conversationId: string | undefined;
    readonly unattended: boolean;
    readonly signal: AbortSignal;
}

export type CredentialVerdict = { readonly allow: true; readonly approvedBy?: string } | { readonly allow: false; readonly reason: string };

export interface CredentialGate {
    readonly check: (input: CredentialCheck) => Promise<CredentialVerdict>;
}

// "alice@corp.com or bob@corp.com", the way every refusal here names who could have said yes. Written out
// rather than counted, because "one of 2 approvers" tells the model nothing it can act on.
const nameApprovers = (approvers: readonly string[]): string => {
    if (approvers.length === 1) {
        return approvers[0] ?? "";
    }
    return `${approvers.slice(0, -1).join(", ")} or ${approvers[approvers.length - 1] ?? ""}`;
};

const clipped = (text: string | undefined): string | undefined => {
    if (text === undefined || text === "") {
        return undefined;
    }
    const flat = text.trim().replaceAll(/\s+/g, " ");
    return flat.length <= DETAIL_MAX ? flat : `${flat.slice(0, DETAIL_MAX)}…`;
};

export const createCredentialGate = (deps: CredentialGateDeps): CredentialGate => ({
    check: async (input) => {
        const now = deps.now ?? Date.now;
        /* THE POLICY READ, and the one place this module's fail-closed posture is visible as code. The store
         * throws on a policy that exists and cannot be read rather than answering "nothing is gated"
         * (credential-gates.ts says why), so this catch is the difference between a corrupt byte unlocking
         * every gated credential in the sandbox and a corrupt byte refusing them. */
        let gate;
        try {
            const gates = await deps.gates.list();
            gate = gates.find((entry) => entry.kind === input.kind && entry.subject === input.subject);
        } catch {
            return {
                allow: false,
                reason:
                    `"${input.subject}" could not be used: the owner's credential approval policy could not be read, so it was refused rather than released on a guess. ` +
                    `Do not retry: tell the owner their credential gate policy is unreadable.`,
            };
        }
        if (gate === undefined) {
            return { allow: true };
        }
        const approvers = nameApprovers(gate.approvers);

        /* A RELEASE THIS CONVERSATION ALREADY HOLDS. Only ever recorded for a gate whose owner said "the rest
         * of this conversation" (the per-use gate never writes one), so consulting it unconditionally is
         * safe and says the rule once: a grant is a grant. */
        const held = input.conversationId === undefined ? undefined : deps.grants.has(input.conversationId, gate.subject);

        const named = input.conversationId === DAEMON_OWNER || input.conversationId === ONE_SHOT_OWNER ? undefined : input.conversationId;
        const card = deps.liveRun(named);
        const verdict = guard(credentialUse, {
            gated: true,
            granted: held !== undefined,
            unattended: input.unattended,
            canPark: card !== undefined,
        });
        if (verdict.effect === "allow") {
            return held === undefined ? { allow: true } : { allow: true, approvedBy: held.approvedBy };
        }
        if (verdict.effect === "deny" || card === undefined) {
            /* THE TWO "NOBODY TO ASK" REFUSALS, worded from the verdict's own reason so the model is told
             * which wall it hit: an unattended turn is a scheduling problem the owner can fix by running the
             * work in a chat, and no live conversation is a detached CLI. `card === undefined` is re-checked
             * only to narrow the type; the guard already denied on it. */
            return {
                allow: false,
                reason:
                    `"${gate.subject}" needs a named person to release it (${approvers}), and ${verdict.reason}. ` +
                    `Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
            };
        }

        /* THE CARD. `requestId: ""` in the abort stand-in is the registry's convention (it fills in the real
         * id), and `approve: false` is what makes an aborted turn read as "not released" rather than as a
         * release nobody gave. */
        const offer: CredentialOffer = {
            subject: gate.subject,
            kind: gate.kind,
            lane: input.lane,
            ...(clipped(input.detail) !== undefined ? { detail: clipped(input.detail) as string } : {}),
            ...(input.why !== undefined && input.why !== "" ? { why: input.why.slice(0, WHY_MAX) } : {}),
            approvers: gate.approvers,
            scope: gate.scope,
        };
        const { id, wait } = createRequest("credential_offer", { kind: "credential_offer", requestId: "", approve: false }, card.conversationId, {
            /* WHO MAY CLICK, checked server-side against the identity the daemon verified on the reply's own
             * request. Lowercased both sides for the roster's own reason (auth/auth.ts): a Google `email`
             * claim is not guaranteed lowercase and every write to the roster normalizes, so an exact match
             * would refuse a Workspace domain that preserves case. */
            mayAnswer: (caller) => {
                if (caller === undefined) {
                    return `Only ${approvers} can release "${gate.subject}", and this request carries no signed-in identity.`;
                }
                return gate.approvers.some((approver) => approver.toLowerCase() === caller.email.toLowerCase())
                    ? undefined
                    : `Only ${approvers} can release "${gate.subject}".`;
            },
        });
        const raised: AgentEvent = { kind: "credential_offer", requestId: id, offer };
        card.push(raised);
        deps.observe(card.conversationId, raised);
        deps.notify?.(card.conversationId);
        const { reply, resolved, caller } = await wait(AbortSignal.any([input.signal, AbortSignal.timeout(deps.deadlineMs ?? OFFER_DEADLINE_MS)]));
        card.push(resolved);
        deps.observe(card.conversationId, resolved);
        const receipt = (outcome: "released" | "refused", approvedBy?: string): void => {
            const frame: AgentEvent = { kind: "credential_receipt", requestId: id, outcome, ...(approvedBy !== undefined ? { approvedBy } : {}) };
            card.push(frame);
            deps.observe(card.conversationId, frame);
        };
        if (!reply.approve) {
            /* TWO DIFFERENT NO'S, told apart the payment gate's way: a resolved frame with no reply is the
             * deadline or a dead turn, and reading that as "declined" would put words in an approver's mouth
             * — which matters more here than anywhere else, because the whole feature is about attributing a
             * decision to a person. So only a real decline writes a receipt. */
            if (resolved.reply === undefined) {
                return {
                    allow: false,
                    reason:
                        `The request to release "${gate.subject}" went unanswered and expired: it was not used. Only ${approvers} can release it. ` +
                        `Continue without it and say what you left undone; ask again only if one of them is around.`,
                };
            }
            receipt("refused", caller?.email);
            return {
                allow: false,
                reason: `${caller?.email ?? "The approver"} declined to release "${gate.subject}": it was not used. Do not retry: continue without it and say what you left undone.`,
            };
        }
        /* AN APPROVAL WITH NOBODY BEHIND IT cannot happen — `mayAnswer` refuses a reply with no identity, so
         * a settled `approve` came from a verified approver — but the audit row and the receipt frame are
         * built from this name, and a row that says "released by undefined" is worse than a refusal. */
        if (caller === undefined) {
            return {
                allow: false,
                reason:
                    `The release of "${gate.subject}" arrived without a verified identity behind it, so it was refused. ` +
                    `Do not retry: only ${approvers} can release it, from a signed-in session.`,
            };
        }
        // A conversation-scoped release is remembered for the conversation the card went up in, never for the
        // one the caller claimed: `card.conversationId` is the live run's own id.
        if (gate.scope === "conversation") {
            deps.grants.grant(card.conversationId, gate.subject, { approvedBy: caller.email, at: now() });
        }
        receipt("released", caller.email);
        return { allow: true, approvedBy: caller.email };
    },
});
