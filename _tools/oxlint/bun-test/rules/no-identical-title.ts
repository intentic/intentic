import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { bunTestCall, importsBunTest, literalTitle, titleScope } from "../shared/bun-test.ts";

type SeenTitles = { readonly describes: Set<string>; readonly tests: Set<string> };

/** Reject a suite or test title already used by a sibling in the same describe body. */
export const noIdenticalTitleRule = defineRule({
    meta: {
        type: "problem",
        docs: { description: "Disallow two bun:test suites or two tests sharing a title within one block." },
        messages: {
            duplicateSuite: "Two suites in this block have this title, so a failure names a suite the file contains twice.",
            duplicateTest: "Two tests in this block have this title, so a failure names a test the file contains twice.",
        },
    },
    createOnce(context) {
        const seen = new Map<ESTree.Node, SeenTitles>();
        let suite = false;
        return {
            Program(node) {
                seen.clear();
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
                const title = literalTitle(node);
                if (title === null) {
                    return;
                }
                const scope = titleScope(context.sourceCode, node);
                let titles = seen.get(scope);
                if (titles === undefined) {
                    titles = { describes: new Set<string>(), tests: new Set<string>() };
                    seen.set(scope, titles);
                }
                const bucket = call.kind === "describe" ? titles.describes : titles.tests;
                if (!bucket.has(title.text)) {
                    bucket.add(title.text);
                    return;
                }
                context.report({ node: title.node, messageId: call.kind === "describe" ? "duplicateSuite" : "duplicateTest" });
            },
        };
    },
});
