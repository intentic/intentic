import type { SgNode } from "@ast-grep/napi";
import { NON_CODE, parseLang } from "./languages.js";
import { scriptBlocksOf } from "./sfc.js";

// Per-file branch-point count, the tangled half of `iq hotspots` (churn is the other half); computed once during
// indexing beside symbol extraction. A decision-point count in the cyclomatic tradition, not a certified McCabe number
// or maintainability score: it can be recounted by opening the file.

// One flat set across grammars, not a per-language table, so a kind rename breaks a test, not the score.
const BRANCH_KINDS = new Set([
    // conditionals; `else` is not its own decision point, only `else if` (which nests an if_*).
    "if_statement",
    "if_expression",
    "elif_clause",
    "conditional_expression",
    "ternary_expression",
    "for_statement",
    "for_in_statement",
    "enhanced_for_statement",
    "for_expression",
    "while_statement",
    "while_expression",
    "do_statement",
    "loop_expression",
    // Arms branch, the switch doesn't; Java's grammar reuses `switch_label` for default too, one point high.
    "switch_case",
    "switch_label",
    "expression_case",
    "type_case",
    "case_clause",
    "match_arm",
    "catch_clause",
    "except_clause",
]);

// Short-circuiting operators each add a path; `operator` is named consistently across every grammar loaded.
const LOGICAL_OPERATORS = new Set(["&&", "||", "??", "and", "or"]);

const walk = (node: SgNode): number => {
    // kind() is typed per-grammar; these kinds span grammars, so it's read here as a plain string name.
    let count = BRANCH_KINDS.has(node.kind() as string) ? 1 : 0;
    if (LOGICAL_OPERATORS.has(node.field("operator")?.text() ?? "")) {
        count++;
    }
    for (const child of node.children()) {
        count += walk(child);
    }
    return count;
};

// No grammar for this extension: counts decisions lexically instead, crude but keeps files comparable.
const LEXICAL_BRANCHES = /\b(?:if|elif|for|while|case|when|catch|except|rescue)\b|&&|\|\||\?\?/g;

const lexicalComplexity = (content: string): number => content.match(LEXICAL_BRANCHES)?.length ?? 0;

export const fileComplexity = (path: string, lang: string | undefined, content: string): number => {
    if (NON_CODE.test(path)) {
        return 0;
    }
    // An SFC's decisions live in its <script> blocks; a template's v-if is markup, not code to hold in your head.
    if (lang === "vue") {
        return scriptBlocksOf(content).reduce((total, block) => total + fileComplexity(path, block.lang, block.content), 0);
    }
    const root = lang === undefined ? undefined : parseLang(lang, content)?.root();
    return root === undefined ? lexicalComplexity(content) : walk(root);
};
