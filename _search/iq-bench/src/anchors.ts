import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Anchor, QueryCase } from "./schema.js";

/* A `def`/`sym` case names a symbol, so its ground truth is wherever the tree declares that symbol, a fact the
 * checkout already carries, and therefore one the dataset must not repeat. Repeating it made every such anchor
 * decay with the file: the intentic corpus IS this monorepo, and three of its seven def/sym anchors had already
 * slid off their recorded line (one of them clean out of its tolerance window). A stale anchor scores zero for
 * every config at once, which reads as a hard case rather than as a broken label, the failure is silent where
 * it matters most. Resolving instead reproduced all twelve hand-picked lines in the SHA-pinned repos exactly,
 * so nothing is lost by deriving what was previously typed in.
 *
 * Where the answer to a `q`/`find`/`refs` case is written stays a judgement call and stays in the dataset.
 */

// One declaration, in either language the corpora use. Anchored at the line start so a call, an import or a
// mention inside a comment cannot pass for the definition.
const declarationOf = (symbol: string): RegExp =>
    new RegExp(
        String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|def)\s+${symbol}\b`,
    );

export const RESOLVED_TOLERANCE = 2;

export const resolveDeclaration = (root: string, file: string, symbol: string): number => {
    const declaration = declarationOf(symbol);
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    const found = lines.flatMap((text, index) => (declaration.test(text) ? [index + 1] : []));
    if (found.length !== 1) {
        throw new Error(
            found.length === 0
                ? `iq-bench: "${symbol}" is not declared in ${file} — the dataset anchor names the wrong file, or the symbol was renamed`
                : `iq-bench: "${symbol}" is declared ${found.length}× in ${file} (lines ${found.join(", ")}) — the anchor cannot say which one is meant`,
        );
    }
    return found[0]!;
};

// The anchors to score a case against: derived for def/sym, as authored for every other verb.
export const anchorsOf = (queryCase: QueryCase, root: string): readonly Anchor[] => {
    if (queryCase.verb !== "def" && queryCase.verb !== "sym") {
        return queryCase.expected;
    }
    return queryCase.expected.map((anchor) => ({
        ...anchor,
        line: resolveDeclaration(root, anchor.file, queryCase.query),
        // The declaration line is exact, so the window only has to absorb iq pointing at a decorator or a
        // leading doc line rather than at the signature itself.
        tolerance: RESOLVED_TOLERANCE,
    }));
};
