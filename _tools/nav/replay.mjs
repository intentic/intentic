import { runLookupSim } from "./lookup.mjs";

// Stable symbols keep the same session tasks comparable when their owning files move or private helpers become imports.
export const runReplay = (tree, countTokens, tasks) => {
    const symbols = tasks.map(({ symbol }) => symbol);
    const lookup = runLookupSim(tree, countTokens, { symbols, sample: symbols.length });
    return tasks.map(({ task, symbol, session, guessedPaths = [] }) => {
        const homes = tree.source.flatMap((path) =>
            (tree.files.get(path)?.declarations ?? []).filter(({ name }) => name === symbol).map((declaration) => ({ path, declaration })),
        );
        if (homes.length !== 1) {
            throw new Error(`nav replay: ${symbol} has ${homes.length} definitions; choose an unambiguous task symbol`);
        }
        const { path, declaration } = homes[0];
        const matches = (paths) =>
            paths.flatMap((filePath) =>
                tree.files.get(filePath).text.split("\n")
                    .flatMap((line, index) => line.includes(symbol) ? [`${filePath}:${index + 1}:${line}`] : []),
            );
        const sourceHits = matches(tree.source);
        const testHits = matches(tree.tests);
        return {
            task,
            symbol,
            session,
            home: path,
            line: declaration.startLine,
            fileTokens: tree.files.get(path).tokens,
            lookupTokens: lookup.perSymbol[symbol],
            sourceSearchChars: sourceHits.join("\n").length,
            sourceSearchHits: sourceHits.length,
            testSearchHits: testHits.length,
            recordedPathMisses: guessedPaths.filter((guessed) => !tree.known.has(guessed)),
        };
    });
};
