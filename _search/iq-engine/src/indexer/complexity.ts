import type { SgNode } from "@ast-grep/napi";
import { NON_CODE, parseLang } from "./languages.js";
import { scriptBlocksOf } from "./sfc.js";

// Per-file branch-point count, the "how tangled" half of `iq hotspots` (churn is the other half). Computed
// once per file during indexing, beside symbol extraction, so a query costs one SQL read and the existing
// per-hash revalidation keeps it current.
//
// This is a decision-point count in the cyclomatic tradition, NOT a certified McCabe number and NOT a composite
// "maintainability score", those aren't comparable across projects and can't be checked against the file. A
// count can: open the file and you can recount it.

// ONE flat set across every grammar rather than a per-language table. Tree-sitter kind names differ between
// grammars (rust says `if_expression` where TS says `if_statement`), and per-language tables are exactly the
// kind of thing that drifts silently when a grammar is upgraded. One set plus a pinning test per language means
// a rename breaks a test instead of quietly deflating every score.
const BRANCH_KINDS = new Set([
    // conditionals, `else` is not its own decision point, only `else if` (which nests an if_*).
    "if_statement",
    "if_expression",
    "elif_clause",
    "conditional_expression",
    "ternary_expression",
    // loops
    "for_statement",
    "for_in_statement",
    "enhanced_for_statement",
    "for_expression",
    "while_statement",
    "while_expression",
    "do_statement",
    "loop_expression",
    // switch/match arms, the arms branch, the switch itself does not. TS names `default:` separately
    // (switch_default, excluded here); Java's grammar calls both `switch_label`, so a Java switch with a
    // default reads one point high. Acceptable drift in a ranking signal, not worth a per-language special case.
    "switch_case",
    "switch_label",
    "expression_case",
    "type_case",
    "case_clause",
    "match_arm",
    // error paths
    "catch_clause",
    "except_clause",
]);

// Short-circuiting operators each add a path. The `operator` field is named consistently across all the
// grammars we load (binary_expression in ts/go/rust/java, boolean_operator in python).
const LOGICAL_OPERATORS = new Set(["&&", "||", "??", "and", "or"]);

const walk = (node: SgNode): number => {
    // kind() is typed against ast-grep's per-grammar kind map; these kinds span grammars, so it's read as a name.
    let count = BRANCH_KINDS.has(node.kind() as string) ? 1 : 0;
    if (LOGICAL_OPERATORS.has(node.field("operator")?.text() ?? "")) {
        count++;
    }
    for (const child of node.children()) {
        count += walk(child);
    }
    return count;
};

// No grammar for this extension: count the same decision points lexically. Crude (it sees keywords inside
// strings and comments) but it keeps every file comparable instead of scoring unparseable languages at zero.
const LEXICAL_BRANCHES = /\b(?:if|elif|for|while|case|when|catch|except|rescue)\b|&&|\|\||\?\?/g;

const lexicalComplexity = (content: string): number => content.match(LEXICAL_BRANCHES)?.length ?? 0;

export const fileComplexity = (path: string, lang: string | undefined, content: string): number => {
    if (NON_CODE.test(path)) {
        return 0;
    }
    // An SFC's decisions live in its <script> blocks, the template's v-if is markup, not a code path a reader
    // has to hold in their head.
    if (lang === "vue") {
        return scriptBlocksOf(content).reduce((total, block) => total + fileComplexity(path, block.lang, block.content), 0);
    }
    const root = lang === undefined ? undefined : parseLang(lang, content)?.root();
    return root === undefined ? lexicalComplexity(content) : walk(root);
};
