import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Anchor, QueryCase } from "./schema.js";

// A def/sym case's ground truth is wherever the checkout declares that symbol, derived rather than hand-typed: a
// hard-coded line decays as the file changes and then fails silently, scoring zero everywhere rather than flagging a
// broken label. q/find/refs answers stay hand-written in the dataset.

// One declaration, in either corpus language. Anchored at line start so a call, import or comment mention cannot pass
// for the definition.
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
                ? `iq-bench: "${symbol}" is not declared in ${file}, the dataset anchor names the wrong file, or the symbol was renamed`
                : `iq-bench: "${symbol}" is declared ${found.length}× in ${file} (lines ${found.join(", ")}), the anchor cannot say which one is meant`,
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
        // Declaration line is exact; the window only absorbs iq landing on a decorator or leading doc line instead.
        tolerance: RESOLVED_TOLERANCE,
    }));
};
