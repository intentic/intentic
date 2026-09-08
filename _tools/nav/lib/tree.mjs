// One parse of a tree (working directory or a git ref), shared by every measurement, so the three numbers describe the
// same tree instead of two racing passes disagreeing.
import { classifyLines, listFiles, listTracked, readAt } from "./files.mjs";
import { declarationsOf, functionsOf, longestChain, moduleFactsOf, nestingOf, parseFile } from "./parse.mjs";
import { packageMap } from "./resolve.mjs";

export const buildTree = (root, ref, countTokens, onProgress) => {
    const { source, tests } = listFiles(root, ref);
    const packages = packageMap(root, listTracked(root, ref), (r, p) => readAt(r, p, ref));
    const known = new Set([...source, ...tests]);

    const files = new Map();
    const facts = new Map();
    const defines = new Map();
    const total = source.length + tests.length;
    let done = 0;

    for (const path of [...source, ...tests]) {
        const text = readAt(root, path, ref);
        const lines = classifyLines(text);
        const tokens = countTokens(text);

        let parsed;
        try {
            parsed = parseFile(path, text);
        } catch {
            // A file the parser rejects still counts toward size; shape metrics are skipped and `parseFailed` is set,
            // rather than dropping the file and shrinking the tree.
            files.set(path, {
                path,
                text,
                lines,
                tokens,
                declarations: [],
                functions: [],
                maxNesting: 0,
                longestChain: 0,
                parseFailed: true,
            });
            facts.set(path, { imports: [], reexports: [], stars: [], localExports: [] });
            defines.set(path, new Set());
            done += 1;
            continue;
        }

        const declarations = declarationsOf(parsed);
        files.set(path, {
            path,
            text,
            lines,
            tokens,
            declarations,
            functions: functionsOf(parsed),
            maxNesting: nestingOf(parsed),
            longestChain: longestChain(parsed),
            parseFailed: false,
        });
        facts.set(path, moduleFactsOf(parsed));
        defines.set(path, new Set(declarations.map((declaration) => declaration.name)));

        done += 1;
        if (onProgress && done % 500 === 0) {
            onProgress(done, total);
        }
    }

    return { root, ref: ref ?? "(working tree)", source, tests, files, facts, defines, known, packages };
};
