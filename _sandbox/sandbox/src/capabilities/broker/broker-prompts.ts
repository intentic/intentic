import { type CardDeps, cardRun, OFFER_DEADLINE_MS, raiseRequest } from "../../guard/card-offers.js";
import type { GatewayAnswer, RuleAsk, RulePrompts } from "./broker-gateway.js";

// The person behind a card's `ask` rules: a permission card in the conversation the request's address was minted for,
// and the "allow this in this conversation" it can leave behind. A pass lasts this daemon's life, like a conversation-
// scoped release (credential-grants.ts): a restart asks again rather than trusting a yes nobody can see any more.

export interface RulePromptDeps extends CardDeps {
    readonly deadlineMs?: number;
}

const passKey = (conversationId: string, capability: string, rule: number): string => `${conversationId}\u0000${capability}\u0000${String(rule)}`;

const titleOf = (input: RuleAsk): string => `Let the agent send ${input.method} ${input.target} with ${input.name}?`;

const explainOf = (input: RuleAsk): string =>
    `${input.name}'s rules ask a person before ${input.method} requests like this one${input.why === undefined ? "" : `: ${input.why}`}. ` +
    "The credential gateway holds the request until you answer; the agent never sees the credential either way.";

export const createRulePrompts = (deps: RulePromptDeps): RulePrompts & { readonly forget: (conversationId: string) => void } => {
    const passes = new Set<string>();
    return {
        canPark: (conversationId) => cardRun(deps, conversationId) !== undefined,
        passed: (conversationId, capability, rule) => conversationId !== undefined && passes.has(passKey(conversationId, capability, rule)),
        forget: (conversationId) => {
            for (const key of passes) {
                if (key.startsWith(`${conversationId}\u0000`)) {
                    passes.delete(key);
                }
            }
        },
        ask: async (input): Promise<GatewayAnswer> => {
            const card = cardRun(deps, input.conversationId);
            if (card === undefined) {
                return {
                    allow: false,
                    reason: `${input.name}'s rules ask a person before this request, and there is no live conversation to ask in. Do not retry.`,
                };
            }
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
                signal: input.signal,
                deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
            });
            if (raised.decision === "approved") {
                if (raised.reply.decision === "always" || raised.reply.decision === "everything") {
                    passes.add(passKey(card.conversationId, input.capability, input.rule));
                }
                return raised.caller === undefined ? { allow: true } : { allow: true, approvedBy: raised.caller.email };
            }
            return {
                allow: false,
                reason:
                    raised.decision === "declined"
                        ? `The owner declined ${input.method} ${input.target} with ${input.name}: it was not sent. Do not retry it; say what you left undone.`
                        : `Nobody answered the card for ${input.method} ${input.target} with ${input.name}, so it was not sent. Say what you left undone.`,
            };
        },
    };
};
