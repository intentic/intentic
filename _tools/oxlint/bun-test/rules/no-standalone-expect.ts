import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { bunTestCall, importsBunTest, isExpectCall, isFunctionLiteral } from "../shared/bun-test.ts";

/** Whether an assertion is reached by a test or hook callback rather than by suite collection. */
function insideTestOrHook(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
    let current: ESTree.Node | null = node.parent;
    while (current !== null) {
        if (isFunctionLiteral(current)) {
            const parent = current.parent;
            // A function reached by name runs whenever its caller runs, which is the caller's business, not this rule's.
            if (parent.type !== "CallExpression") {
                return true;
            }
            if (parent.arguments.includes(current)) {
                const call = bunTestCall(sourceCode, parent);
                if (call !== null) {
                    return call.kind !== "describe";
                }
            }
        }
        current = current.parent;
    }
    return false;
}

/** Reject an assertion that runs while bun collects the suite instead of while a test runs. */
export const noStandaloneExpectRule = defineRule({
    meta: {
        type: "problem",
        docs: { description: "Disallow a bun:test `expect` outside a test or hook callback." },
        messages: {
            standalone:
                "This assertion runs while bun collects the file, so its failure is a load error with no test attached to it. Move it into a test or a hook.",
        },
    },
    createOnce(context) {
        let suite = false;
        return {
            Program(node) {
                suite = importsBunTest(node);
            },
            CallExpression(node) {
                if (!suite) {
                    return;
                }
                if (!isExpectCall(context.sourceCode, node)) {
                    return;
                }
                if (insideTestOrHook(context.sourceCode, node)) {
                    return;
                }
                context.report({ node: node.callee, messageId: "standalone" });
            },
        };
    },
});
