import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { BoundedMap } from "@intentic/base/held";
import type { CoinedCall } from "./shield-types.js";

// Tool calls the model made with tokens it was never given: it made them up, so nothing can turn them back into values,
// and run as they are they would write `⟦PERSON_25⟧` into a file. The gateway finds them as it restores a response
// (masker.ts RestoreScope) and the harness's hook refuses the call before it runs. The two are seams of one process
// that share nothing but the call's id, which is unique, so they meet here by it.

// A refused call is taken off as it is refused, and a call no hook asks about (another runtime's) ages out.
const HELD_CALLS = 512;
const calls = new BoundedMap<string, readonly string[]>(HELD_CALLS);

export const noteCoinedCall: CoinedCall = (id, tokens) => {
    if (tokens.length > 0) {
        calls.set(id, [...new Set(tokens)]);
    }
};

// The tokens a call was found to carry, taken off: asked once, as the call is about to run.
export const takeCoinedCall = (id: string): readonly string[] | undefined => {
    const tokens = calls.get(id);
    calls.delete(id);
    return tokens;
};

const listed = (tokens: readonly string[]): string =>
    tokens.length === 1 ? (tokens[0] ?? "") : `${tokens.slice(0, -1).join(", ")} and ${tokens.at(-1) ?? ""}`;

const coinedRefusal = (tokens: readonly string[]): string =>
    `This call was not run: it holds ${listed(tokens)}, which ${tokens.length === 1 ? "is not a token" : "are not tokens"} you were given, so nothing can turn ${tokens.length === 1 ? "it" : "them"} back into a value and the call would use ${tokens.length === 1 ? "it" : "them"} as written. ` +
    "Tokens stand only for personal data the privacy shield gave you. Write values you make up yourself (example or test data, fictional people, companies and addresses) out in full, use only the tokens you were given, exactly as given, and make the call again.";

// The Claude harness's half: a call whose input held a made-up token is refused with the sentence above. On every tool,
// subagents' included, since the gateway restores their responses too.
export const coinedTokenHooks = () =>
    ({
        PreToolUse: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PreToolUse") {
                            return {};
                        }
                        const tokens = takeCoinedCall(input.tool_use_id);
                        return tokens === undefined
                            ? {}
                            : {
                                  hookSpecificOutput: {
                                      hookEventName: "PreToolUse" as const,
                                      permissionDecision: "deny" as const,
                                      permissionDecisionReason: coinedRefusal(tokens),
                                  },
                              };
                    },
                ],
            },
        ],
    }) satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;
