import type { CredentialGateKind, CredentialLane, CredentialOffer } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, type LiveCard, raiseRequest, whyOf } from "../../guard/card-offers.js";
import { credentialUse } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { type HeldAnswer, type HoldDeps, createHeldAsks } from "../../guard/held-asks.js";
import { wakeWords } from "../../guard/held-cards.js";
import type { CredentialGatesStore } from "../credential-gates.js";
import type { CredentialGrants } from "../credential-grants.js";

// The single choke point every credential-spending exit routes through, so the rule and its refusal wording exist once.
// Addressed to a named, verified approver list, not the owner, and fails closed rather than holds when nobody can be
// asked. Not a lock on the vault: a wall on when an agent's own judgment may decide to spend. Its card waits for an
// approver however long that takes (guard/held-asks.ts): a caller that stops waiting leaves it up, held for the turn's
// close, and a release given after that wakes the conversation to make the same call again.

// Max length of the card's location line: enough to recognize a command or host, short enough to stay a card.
const DETAIL_MAX = 80;

export interface CredentialGateDeps extends CardDeps {
    readonly gates: CredentialGatesStore;
    readonly grants: CredentialGrants;
    readonly hold: HoldDeps;
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

type Gate = Awaited<ReturnType<CredentialGatesStore["list"]>>[number];

// What a call that stopped waiting reads: the card is still up, and how to collect its answer.
const stillWaiting = (subject: string, approvers: string): CredentialVerdict => ({
    allow: false,
    reason:
        `Still waiting for ${approvers} to release "${subject}": a card asks them, and it has not been used yet. The card stays up until they answer. ` +
        `Make exactly the same call again to collect the answer, or carry on with other work and end your turn: if they release it after, you are woken to make the call again.`,
});

// Raises the card and settles with the approver's answer; `ended` settles it unanswered (the turn is over or stopped).
const askApprovers = async (
    deps: CredentialGateDeps,
    card: LiveCard,
    gate: Gate,
    input: CredentialCheck,
    ended: AbortSignal,
): Promise<HeldAnswer<CredentialVerdict>> => {
    const now = deps.now ?? Date.now;
    const approvers = nameApprovers(gate.approvers);
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
    const raised = await raiseRequest(deps, card, {
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
        approves: (reply) => reply.approve,
        signal: ended,
    });
    const { caller } = raised;
    const receipt = (outcome: "released" | "refused", approvedBy?: string): void =>
        raised.say({ kind: "credential_receipt", requestId: raised.requestId, outcome, ...(approvedBy !== undefined ? { approvedBy } : {}) });
    if (raised.decision === "unanswered") {
        return {
            answer: {
                allow: false,
                reason:
                    `The turn ended before anyone released "${gate.subject}": it was not used. Only ${approvers} can release it. ` +
                    `Continue without it and say what you left undone; ask again only if one of them is around.`,
            },
            outcome: { decision: "unanswered" },
        };
    }
    if (raised.decision === "declined") {
        // Only a real decline writes a receipt, since the feature is about attributing a decision to a person.
        receipt("refused", caller?.email);
        return {
            answer: {
                allow: false,
                reason: `${caller?.email ?? "The approver"} declined to release "${gate.subject}": it was not used. Do not retry: continue without it and say what you left undone.`,
            },
            outcome: { decision: "declined" },
        };
    }
    // Cannot happen in practice (`mayAnswer` refuses an unidentified reply), but guards the receipt: a row reading
    // "released by undefined" is worse than a refusal.
    if (caller === undefined) {
        return {
            answer: {
                allow: false,
                reason:
                    `The release of "${gate.subject}" arrived without a verified identity behind it, so it was refused. ` +
                    `Do not retry: only ${approvers} can release it, from a signed-in session.`,
            },
            outcome: { decision: "declined" },
        };
    }
    // Grants against the conversation the card went up in (`card.conversationId`), never the caller's claimed one.
    if (gate.scope === "conversation") {
        deps.grants.grant(card.conversationId, gate.subject, { approvedBy: caller.email, at: now() });
    }
    receipt("released", caller.email);
    return { answer: { allow: true, approvedBy: caller.email }, outcome: { decision: "approved" } };
};

// Where the card says the credential would go, quoted in a wake when there is anything to quote.
const whereOf = (detail: string | undefined): { readonly call?: string } => {
    const where = clipped(detail);
    return where === undefined ? {} : { call: where };
};

export const createCredentialGate = (deps: CredentialGateDeps): CredentialGate => {
    // Cards still up, or answered and not yet collected, by the exact call that raised them.
    const asks = createHeldAsks<CredentialVerdict>();
    return {
        check: async (input) => {
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

            // A release this conversation already holds; only a conversation-scoped gate ever records one. Read once the
            // stored releases are in, so a yes from before a restart is honoured rather than asked again.
            await deps.grants.ready;
            const held = input.conversationId === undefined ? undefined : deps.grants.has(input.conversationId, gate.subject);

            const card = cardRun(deps, input.conversationId);
            const verdict = guard(credentialUse, {
                gated: true,
                granted: held !== undefined,
                canPark: card !== undefined,
            });
            if (verdict.effect === "allow") {
                return held === undefined ? { allow: true } : { allow: true, approvedBy: held.approvedBy };
            }
            if (verdict.effect === "deny" || card === undefined) {
                // Reuses the verdict's own reason: no live conversation to ask in. `card === undefined` here only narrows
                // the type; the guard already denied on it.
                return {
                    allow: false,
                    reason:
                        `"${gate.subject}" needs a named person to release it (${approvers}), and ${verdict.reason}. ` +
                        `Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
                };
            }

            const asked = {
                conversationId: card.conversationId,
                key: `${gate.kind}\u0000${gate.subject}\u0000${input.lane}\u0000${input.detail ?? ""}`,
                waiting: () => stillWaiting(gate.subject, approvers),
                signal: input.signal,
            };
            // The same call again, while its card is up or its answer uncollected: no second card.
            return (
                asks.reattach(asked) ??
                asks.ask(asked, {
                    raise: (ended) => askApprovers(deps, card, gate, input, ended),
                    told: wakeWords({
                        who: approvers,
                        doing: `releasing "${gate.subject}"`,
                        ...whereOf(input.detail),
                        notYet: "It has not been used yet",
                        again: "Make exactly the same call again now.",
                        declinedSo: "it was not used",
                        refrain: "Do not retry: continue without it and say what you left undone.",
                    }),
                    held: deps.hold.held,
                    finished: deps.hold.finished(card.conversationId),
                })
            );
        },
    };
};
