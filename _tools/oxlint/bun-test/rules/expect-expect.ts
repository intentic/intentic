import { defineRule } from "@oxlint/plugins";

import type { ESTree, Options } from "@oxlint/plugins";

import { bunTestCall, callbackArgument, importsBunTest, isFunctionLiteral, isOptionRecord, isOptionString } from "../shared/bun-test.ts";

const DEFAULT_NAMES = ["expect"];

function assertFunctionNames(options: Readonly<Options>): string[] {
    const option = options[0];
    if (option === undefined || !isOptionRecord(option)) {
        return DEFAULT_NAMES;
    }
    const configured = option["assertFunctionNames"];
    if (!Array.isArray(configured)) {
        return DEFAULT_NAMES;
    }
    const names = configured.filter(isOptionString);
    return names.length === 0 ? DEFAULT_NAMES : names;
}

/** The dotted name a callee spells out, or null when a call in the middle of it puts the name out of reach. */
function calleeName(expression: ESTree.Node): string | null {
    if (expression.type === "Identifier") {
        return expression.name;
    }
    if (expression.type !== "MemberExpression" || expression.computed) {
        return null;
    }
    const property = expression.property;
    if (property.type !== "Identifier") {
        return null;
    }
    const object = calleeName(expression.object);
    return object === null ? null : `${object}.${property.name}`;
}

/** `expect.soft(…)` asserts through `expect`, and `expectOrpcCode(…)` is its own name. */
function isAssertion(name: string, names: readonly string[]): boolean {
    return names.some((listed) => name === listed || name.startsWith(`${listed}.`));
}

/** Reject a bun:test test whose callback asserts nothing, so it can only fail by throwing. */
export const expectExpectRule = defineRule({
    meta: {
        type: "problem",
        docs: { description: "Require a bun:test test to call one of the configured assertion functions." },
        messages: {
            noAssertions: "This test asserts nothing, so it passes for as long as its body does not throw. Assert the outcome it is named after.",
        },
        schema: [
            {
                type: "object",
                properties: { assertFunctionNames: { type: "array", items: { type: "string" } } },
                additionalProperties: false,
            },
        ],
    },
    createOnce(context) {
        let names = DEFAULT_NAMES;
        let suite = false;
        const tests: { readonly callee: ESTree.Node; readonly body: ESTree.Node }[] = [];
        const asserted = new Set<ESTree.Node>();
        return {
            Program(node) {
                names = assertFunctionNames(context.options);
                suite = importsBunTest(node);
                tests.length = 0;
                asserted.clear();
            },
            CallExpression(node) {
                if (!suite) {
                    return;
                }
                const call = bunTestCall(context.sourceCode, node);
                if (call?.kind === "test") {
                    const callback = callbackArgument(node);
                    if (callback !== null) {
                        tests.push({ callee: node.callee, body: callback });
                    }
                }
                const name = calleeName(node.callee);
                if (name === null || !isAssertion(name, names)) {
                    return;
                }
                let current: ESTree.Node | null = node.parent;
                while (current !== null && !asserted.has(current)) {
                    if (isFunctionLiteral(current)) {
                        asserted.add(current);
                    }
                    current = current.parent;
                }
            },
            "Program:exit"() {
                for (const test of tests) {
                    if (!asserted.has(test.body)) {
                        context.report({ node: test.callee, messageId: "noAssertions" });
                    }
                }
            },
        };
    },
});
