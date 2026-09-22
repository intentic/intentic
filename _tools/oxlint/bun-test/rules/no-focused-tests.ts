import { defineRule } from "@oxlint/plugins";

import { bunTestCall, importsBunTest, modifier } from "../shared/bun-test.ts";

/** Reject `.only` on a bun:test describe/it/test, in every shape it can be chained. */
export const noFocusedTestsRule = defineRule({
    meta: {
        type: "problem",
        docs: { description: "Disallow `.only` on a bun:test suite or test." },
        messages: {
            focused:
                "`.only` runs this and silences every other test in the file, so the suite reports green on one test. Remove it before this lands.",
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
                const call = bunTestCall(context.sourceCode, node);
                if (call === null || call.kind === "hook") {
                    return;
                }
                const only = modifier(call, "only");
                if (only !== undefined) {
                    context.report({ node: only, messageId: "focused" });
                }
            },
        };
    },
});
