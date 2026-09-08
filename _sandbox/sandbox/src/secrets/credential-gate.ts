import type { CredentialGateKind, CredentialLane, CredentialOffer } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, OFFER_DEADLINE_MS, raiseCard, whyOf } from "../agent/run/offer-card.js";
import { credentialUse } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import type { CredentialGatesStore } from "./credential-gates.js";
import type { CredentialGrants } from "./credential-grants.js";

// The single choke point every credential-spending exit routes through, so the rule and its refusal wording exist once.
// Addressed to a named, verified approver list, not the owner, and fails closed rather than holds when nobody can be
// asked. Not a lock on the vault: a wall on when an agent's own judgment may decide to spend.

// Max length of the card's location line: enough to recognize a command or host, short enough to stay a card.
const DETAIL_MAX = 80;

export interface CredentialGateDeps extends CardDeps {
    readonly gates: CredentialGatesStore;
    readonly grants: CredentialGrants;
    // Notifies the owner's devices when the card goes up; optional (tests need no push stack) and fire-and-forget.
    readonly notify?: (conversationId: string) => void;
    readonly deadlineMs?: number;
    readonly now?: () => number;
}

export interface CredentialCheck {
    // An env/generated key or capability id; derived from a registry name by `gateTargetOf` (credential-gates.ts).
    readonly subject: string;
    readonly kind: CredentialGateKind;
    readonly lane: CredentialLane;
    // Where it would go, in reader's terms; reference-form on secret lanes since the value is not substituted yet.
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

// Formats approvers as "alice@corp.com or bob@corp.com", written out rather than counted, since "one of 2 approvers"
// gives the model nothing to act on.
const nameApprovers = (approvers: readonly string[]): string => {
    if (approvers.length === 1) {
        return approvers[0] ?? "";
    }
    return `${approvers.slice(0, -1).join(", ")} or ${approvers.at(-1) ?? ""}`;
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
        // The store throws for a policy that exists but cannot be read rather than answering "nothing is gated"; this
        // catch keeps a corrupt policy file closed instead of open.
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

        // A release this conversation already holds; only a conversation-scoped gate ever records one.
        const held = input.conversationId === undefined ? undefined : deps.grants.has(input.conversationId, gate.subject);

        const card = cardRun(deps, input.conversationId);
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
            // Reuses the verdict's own reason so the model knows which wall it hit: unattended turn, or no live
            // conversation. `card === undefined` here only narrows the type; the guard already denied on it.
            return {
                allow: false,
                reason:
                    `"${gate.subject}" needs a named person to release it (${approvers}), and ${verdict.reason}. ` +
                    `Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
            };
        }

        // `approve: false` in the abort stand-in reads an aborted turn as "not released", not as a release nobody gave.
        const offer: CredentialOffer = {
            subject: gate.subject,
            kind: gate.kind,
            lane: input.lane,
            ...(clipped(input.detail) !== undefined ? { detail: clipped(input.detail) as string } : {}),
            ...whyOf(input.why),
            approvers: gate.approvers,
            scope: gate.scope,
        };
        const raised = await raiseCard(deps, card, {
            kind: "credential_offer",
            onAbort: { kind: "credential_offer", requestId: "", approve: false },
            raised: (requestId) => ({ kind: "credential_offer", requestId, offer }),
            // Checked against the identity verified server-side on the reply. Lowercased both sides: a Google `email`
            // claim is not guaranteed lowercase, and the roster normalizes on write.
            mayAnswer: (caller) => {
                if (caller === undefined) {
                    return `Only ${approvers} can release "${gate.subject}", and this request carries no signed-in identity.`;
                }
                return gate.approvers.some((approver) => approver.toLowerCase() === caller.email.toLowerCase())
                    ? undefined
                    : `Only ${approvers} can release "${gate.subject}".`;
            },
            ...(deps.notify === undefined ? {} : { notify: deps.notify }),
            signal: input.signal,
            deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
        });
        const { reply, caller } = raised;
        const receipt = (outcome: "released" | "refused", approvedBy?: string): void =>
            raised.say({ kind: "credential_receipt", requestId: raised.requestId, outcome, ...(approvedBy !== undefined ? { approvedBy } : {}) });
        if (!reply.approve) {
            // Told apart by whether a person answered; only a real decline writes a receipt, since the feature is about
            // attributing a decision to a person.
            if (!raised.answered) {
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
        // Cannot happen in practice (`mayAnswer` refuses an unidentified reply), but guards the receipt: a row reading
        // "released by undefined" is worse than a refusal.
        if (caller === undefined) {
            return {
                allow: false,
                reason:
                    `The release of "${gate.subject}" arrived without a verified identity behind it, so it was refused. ` +
                    `Do not retry: only ${approvers} can release it, from a signed-in session.`,
            };
        }
        // Grants against the conversation the card went up in (`card.conversationId`), never the caller's claimed one.
        if (gate.scope === "conversation") {
            deps.grants.grant(card.conversationId, gate.subject, { approvedBy: caller.email, at: now() });
        }
        receipt("released", caller.email);
        return { allow: true, approvedBy: caller.email };
    },
});
