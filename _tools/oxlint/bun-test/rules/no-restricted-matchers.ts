import { defineRule } from "@oxlint/plugins";

import type { Options } from "@oxlint/plugins";

import { importsBunTest, isExpectCall, isOptionRecord, isOptionString, matcherChain } from "../shared/bun-test.ts";

function restrictions(options: Readonly<Options>): Map<string, string> {
    const configured = new Map<string, string>();
    const option = options[0];
    if (option === undefined || !isOptionRecord(option)) {
        return configured;
    }
    for (const [chain, message] of Object.entries(option)) {
        if (isOptionString(message)) {
            configured.set(chain, message);
        }
    }
    return configured;
}

/** A restriction names a whole chain, so `toBeTruthy` leaves `not.toBeTruthy` alone and `resolves.not.toThrow` matches only itself. */
function matches(chain: string, restriction: string): boolean {
    if (!chain.startsWith(restriction)) {
        return false;
    }
    const rest = chain.slice(restriction.length);
    return rest === "" || rest.startsWith(".");
}

/** Reject the matcher chains a config names, with the reason that config gives. */
export const noRestrictedMatchersRule = defineRule({
    meta: {
        type: "problem",
        docs: { description: "Disallow the `expect` matcher chains a config names." },
        schema: [{ type: "object", additionalProperties: { type: "string" } }],
    },
    createOnce(context) {
        let configured = new Map<string, string>();
        let suite = false;
        return {
            Program(node) {
                configured = restrictions(context.options);
                suite = importsBunTest(node);
            },
            CallExpression(node) {
                if (!suite || configured.size === 0) {
                    return;
                }
                if (!isExpectCall(context.sourceCode, node)) {
                    return;
                }
                const chain = matcherChain(node);
                if (chain === null) {
                    return;
                }
                const joined = chain.names.join(".");
                for (const [restriction, message] of configured) {
                    if (!matches(joined, restriction)) {
                        continue;
                    }
                    context.report({
                        loc: { start: context.sourceCode.getLoc(chain.first).start, end: context.sourceCode.getLoc(chain.last).end },
                        message: `Use of \`${joined}\` is disallowed. ${message}`,
                    });
                    return;
                }
            },
        };
    },
});
