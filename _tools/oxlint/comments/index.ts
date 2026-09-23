import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

type Comment = { type: string; value: string; range: [number, number]; loc: { start: { line: number }; end: { line: number } } };

// Syntax that rides in comment form: a triple-slash reference, a lint or type-check directive.
const DIRECTIVE = /^\s*(\/\s*<reference|(eslint|oxlint)-(disable|enable)|@ts-|prettier-ignore)/;

const ownLine = (text: string, comment: Comment): boolean => /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", comment.range[0] - 1) + 1, comment.range[0]));

// Consecutive own-line `//` comments are one comment; a block comment is one on its own.
const runsOf = (comments: readonly Comment[], text: string): Comment[][] => {
    const runs: Comment[][] = [];
    for (const comment of comments.filter((each) => ownLine(text, each) && !DIRECTIVE.test(each.value))) {
        const last = runs.at(-1)?.at(-1);
        const joins = last !== undefined && last.type === "Line" && comment.type === "Line" && comment.loc.start.line === last.loc.end.line + 1;
        if (joins) {
            runs.at(-1)?.push(comment);
        } else {
            runs.push([comment]);
        }
    }
    return runs;
};

const oneLineRule = defineRule({
    meta: {
        type: "suggestion",
        docs: { description: "A comment is one line." },
        messages: {
            long: "A {{lines}}-line comment. A comment is ONE line stating what the code cannot say (an invariant, a unit, a rule): no history, no restatement, no rhetoric (AGENTS.md).",
        },
    },
    createOnce(context) {
        return {
            Program() {
                const text = context.sourceCode.text;
                for (const run of runsOf(context.sourceCode.getAllComments() as Comment[], text)) {
                    const first = run[0];
                    const last = run.at(-1);
                    const lines = first === undefined || last === undefined ? 0 : last.loc.end.line - first.loc.start.line + 1;
                    if (first !== undefined && lines > 1) {
                        context.report({ loc: first.loc, messageId: "long", data: { lines: String(lines) } });
                    }
                }
            },
        };
    },
});

/** The comment rule AGENTS.md states, held against what an agent writes. */
export default eslintCompatPlugin({ meta: { name: "comments" }, rules: { "one-line": oneLineRule } });
