import { defineRule } from "@oxlint/plugins";

import { bunTestCall, importsBunTest, modifier } from "../shared/bun-test.ts";

/** Reject unconditional `.skip` and `.todo`; the conditional forms state the condition and are allowed. */
export const noDisabledTestsRule = defineRule({
    meta: {
        type: "problem",
        docs: { description: "Disallow `.skip` and `.todo` on a bun:test suite or test." },
        messages: {
            disabledSuite:
                "A suite disabled with no condition is a requirement nobody checks. Delete it, or say what it waits on with `describe.skipIf(condition)`.",
            disabledTest:
                "A test disabled with no condition is a requirement nobody checks. Delete it, or say what it waits on with `test.skipIf(condition)`.",
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
                const disabled = modifier(call, "skip") ?? modifier(call, "todo");
                if (disabled === undefined) {
                    return;
                }
                context.report({ node: disabled, messageId: call.kind === "describe" ? "disabledSuite" : "disabledTest" });
            },
        };
    },
});
