import { type CardDeps, cardRun, type LiveCard, raiseRequest } from "../../guard/card-offers.js";
import { type HeldAnswer, type HoldDeps, createHeldAsks } from "../../guard/held-asks.js";
import { wakeWords } from "../../guard/held-cards.js";
import type { ConversationGrants } from "../../personas/conversation-grants.js";
import type { GatewayAnswer, RuleAsk, RulePrompts } from "./broker-gateway.js";

// The person behind a card's `ask` rules: a permission card in the conversation the request's address was minted for,
// and the "allow requests like this in this conversation" it can leave behind. A pass is a person's yes, so it is kept
// as every other one is (personas/conversation-grants.ts `rules`): it survives a restart, it is listed on Needs you →
// What you have allowed, and taking it back there asks again from the next request. 2026-10-12: passes lived in a Set
// for the daemon's life, so a restart dropped a yes the owner could not see or take back; rejected for that.
//
// The card waits for its answer however long that takes (guard/held-asks.ts): a request whose client gives up leaves
// it up, held for the turn's close, and a yes given after that wakes the conversation to send the same request again.

export interface RulePromptDeps extends CardDeps {
    readonly grants: Pick<ConversationGrants, "all" | "of" | "allowRule" | "onChange">;
    readonly hold: HoldDeps;
    // Where a pass file that could not be read is said; the gateway then asks, as it would with no pass.
    readonly warn: (message: string, cause?: unknown) => void;
}

const passKey = (capability: string, rule: string): string => `${capability}\u0000${rule}`;

const titleOf = (input: RuleAsk): string => `Let the agent send ${input.method} ${input.target} with ${input.name}?`;

const explainOf = (input: RuleAsk): string =>
    `${input.name}'s rules ask a person before ${input.method} requests like this one${input.why === undefined ? "" : `: ${input.why}`}. ` +
    "The credential gateway holds the request until you answer; the agent never sees the credential either way.";

// The words the Allowed list shows for a pass: what the person said yes to, and with which credential.
const saidOf = (input: RuleAsk): string => `${input.method} ${input.target} with ${input.name}`;

// Raises the card and settles with the person's answer, keeping a pass when they chose one; `ended` settles it
// unanswered.
const askPerson = async (
    deps: RulePromptDeps,
    card: LiveCard,
    input: RuleAsk,
    ended: AbortSignal,
    keep: () => void,
): Promise<HeldAnswer<GatewayAnswer>> => {
    const raised = await raiseRequest(deps, card, {
        kind: "permission",
        // `deny` in the abort stand-in reads a stopped turn as "not sent", never as a yes nobody gave.
        onAbort: { kind: "permission", requestId: "", decision: "deny" },
        raised: (requestId) => ({
            kind: "permission",
            requestId,
            toolName: "credential-gateway",
            title: titleOf(input),
            displayName: "Use credential",
            explain: explainOf(input),
            alwaysLabel: `Allow requests like this with ${input.name} in this conversation`,
        }),
        approves: (reply) => reply.decision !== "deny",
        signal: ended,
    });
    if (raised.decision === "approved") {
        if (raised.reply.decision === "always" || raised.reply.decision === "everything") {
            keep();
            // Kept before the request goes, so the very next one reads it; a write that fails costs only a second card.
            await deps.grants
                .allowRule(card.conversationId, { capability: input.capability, rule: input.rule, said: saidOf(input) }, raised.caller?.email)
                .catch((cause: unknown) => deps.warn("credential gateway: a pass could not be kept, so the next request asks again", cause));
        }
        return {
            answer: raised.caller === undefined ? { allow: true } : { allow: true, approvedBy: raised.caller.email },
            outcome: { decision: "approved" },
        };
    }
    if (raised.decision === "declined") {
        return {
            answer: {
                allow: false,
                reason: `The owner declined ${input.method} ${input.target} with ${input.name}: it was not sent. Do not retry it; say what you left undone.`,
            },
            outcome: { decision: "declined" },
        };
    }
    return {
        answer: {
            allow: false,
            reason: `The turn ended before anyone answered the card for ${input.method} ${input.target} with ${input.name}, so it was not sent. Say what you left undone.`,
        },
        outcome: { decision: "unanswered" },
    };
};

export const createRulePrompts = (deps: RulePromptDeps): RulePrompts & { readonly forget: (conversationId: string) => void } => {
    // The gateway's verdict reads passes synchronously (broker-gateway.ts `passed`), so they are mirrored here from the
    // kept grants: read once at boot, and again for a conversation whenever its grants change, which is how a pass taken
    // back on the Allowed list stops answering for it.
    const passes = new Map<string, ReadonlySet<string>>();
    const mirror = (conversationId: string, rules: readonly { readonly capability: string; readonly rule: string }[] | undefined): void => {
        if (rules === undefined || rules.length === 0) {
            passes.delete(conversationId);
            return;
        }
        passes.set(conversationId, new Set(rules.map((pass) => passKey(pass.capability, pass.rule))));
    };
    const unreadable = (cause: unknown): void =>
        deps.warn("credential gateway: the kept passes could not be read, so their requests ask again", cause);
    void deps.grants.all().then((all) => {
        for (const [conversationId, grant] of Object.entries(all)) {
            mirror(conversationId, grant.rules);
        }
    }, unreadable);
    deps.grants.onChange((conversationId) => {
        void deps.grants.of(conversationId).then((grant) => mirror(conversationId, grant?.rules), unreadable);
    });
    const asks = createHeldAsks<GatewayAnswer>();
    return {
        canPark: (conversationId) => cardRun(deps, conversationId) !== undefined,
        passed: (conversationId, capability, rule) =>
            conversationId !== undefined && passes.get(conversationId)?.has(passKey(capability, rule)) === true,
        // The kept grants go with the conversation through conversation-grants.ts `forget`; this drops the mirror now,
        // rather than when that write is heard.
        forget: (conversationId) => {
            passes.delete(conversationId);
        },
        ask: async (input): Promise<GatewayAnswer> => {
            const card = cardRun(deps, input.conversationId);
            if (card === undefined) {
                return {
                    allow: false,
                    reason: `${input.name}'s rules ask a person before this request, and there is no live conversation to ask in. Do not retry.`,
                };
            }
            // Mirrored at once, so a request right behind this one passes before the kept write is heard back.
            const keep = (): void => {
                const kept = passes.get(card.conversationId) ?? new Set<string>();
                passes.set(card.conversationId, new Set([...kept, passKey(input.capability, input.rule)]));
            };
            const asked = {
                conversationId: card.conversationId,
                key: [input.capability, input.rule, input.method, input.target].join("\u0000"),
                waiting: (): GatewayAnswer => ({
                    allow: false,
                    reason:
                        `Still waiting for a person to answer the card for ${input.method} ${input.target} with ${input.name}: it was not sent yet. ` +
                        "The card stays up until it is answered. Send exactly the same request again to collect the answer, or carry on with other work and end your turn: if it is allowed after, you are woken to send it again.",
                }),
                signal: input.signal,
            };
            return (
                asks.reattach(asked) ??
                asks.ask(asked, {
                    raise: (ended) => askPerson(deps, card, input, ended, keep),
                    told: wakeWords({
                        doing: `sending ${saidOf(input)}`,
                        notYet: "It has not been sent yet",
                        again: "Send exactly the same request again now.",
                        declinedSo: "it was not sent",
                        refrain: "Do not retry it; say what you left undone.",
                    }),
                    held: deps.hold.held,
                    finished: deps.hold.finished(card.conversationId),
                })
            );
        },
    };
};
