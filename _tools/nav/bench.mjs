// What an agent pays to see one definition, over every real first-party import in the test suite (not a curated
// sample). Charges the naive cost (open the file, read it) as lookup.mjs charges the skilled one (grep then a window);
// report both or neither. over128k (files that can't fit a context window at all) matters more than the median.
import { mean, percentile } from "./lib/files.mjs";

const READ_WINDOW_LINES = 2000;

const declarationText = (file, declaration) =>
    file.text
        .split("\n")
        .slice(declaration.startLine - 1, declaration.endLine)
        .join("\n");

// Tells a resolver limitation (first-party, unresolved) apart from an ordinary dependency import; that split is what
// makes `unresolved` trustworthy.
const isFirstParty = (tree, specifier) => specifier.startsWith(".") || [...tree.packages.keys()].some((name) => specifier.startsWith(name));

// One imported name → one measured task, or a reason it is not one.
const taskFor = (tree, countTokens, resolver, testPath, entry, imported) => {
    const home = resolver(testPath, entry.specifier, imported);
    if (!home) {
        // Leaving the tree (external) isn't the same failure as should-have-resolved-and-didn't (unresolved).
        return { miss: isFirstParty(tree, entry.specifier) ? "unresolved" : "external" };
    }

    const file = tree.files.get(home);
    const declaration = file?.declarations.find((candidate) => candidate.name === imported);
    if (!file || !declaration) {
        return { miss: "unresolved" };
    }

    const symbolTokens = countTokens(declarationText(file, declaration));
    return {
        task: {
            from: testPath,
            symbol: imported,
            home,
            fileTokens: file.tokens,
            symbolTokens,
            overhead: file.tokens - symbolTokens,
            definitionLines: declaration.endLine - declaration.startLine + 1,
            windows: Math.ceil(file.lines.physical / READ_WINDOW_LINES),
            siblings: file.declarations.length - 1,
            complexity: declaration.complexity,
            fits32k: file.tokens <= 32_000,
            fits128k: file.tokens <= 128_000,
        },
    };
};

export const runBench = (tree, countTokens, resolver) => {
    const tasks = [];
    const misses = { unresolved: 0, external: 0 };

    for (const testPath of tree.tests) {
        const entries = (tree.facts.get(testPath)?.imports ?? []).filter((entry) => !entry.typeOnly);
        for (const entry of entries) {
            const wanted = entry.names.filter(({ imported }) => imported !== "default");
            for (const { imported } of wanted) {
                const result = taskFor(tree, countTokens, resolver, testPath, entry, imported);
                if (result.task) {
                    tasks.push(result.task);
                } else {
                    misses[result.miss] += 1;
                }
            }
        }
    }
    const { unresolved, external } = misses;

    const stat = (pick) => {
        const sorted = tasks.map(pick).sort((a, b) => a - b);
        return {
            p50: percentile(sorted, 50),
            p90: percentile(sorted, 90),
            max: sorted.at(-1) ?? 0,
            mean: Number(mean(sorted).toFixed(1)),
        };
    };

    return {
        tasks: tasks.length,
        unresolved,
        external,
        fileTokens: stat((task) => task.fileTokens),
        symbolTokens: stat((task) => task.symbolTokens),
        overhead: stat((task) => task.overhead),
        definitionLines: stat((task) => task.definitionLines),
        siblings: stat((task) => task.siblings),
        complexity: stat((task) => task.complexity),
        windows: { mean: Number(mean(tasks.map((task) => task.windows)).toFixed(2)) },
        over32k: tasks.filter((task) => !task.fits32k).length,
        over128k: tasks.filter((task) => !task.fits128k).length,
        totalTokensIfReadWhole: tasks.reduce((total, task) => total + task.fileTokens, 0),
        // Ranked by tokens burned across all lookups, not size: a small file imported often outweighs a big unused one.
        worstFiles: rankFiles(tasks),
    };
};

const rankFiles = (tasks) => {
    const byFile = new Map();
    for (const task of tasks) {
        const current = byFile.get(task.home) ?? { path: task.home, lookups: 0, fileTokens: task.fileTokens, siblings: task.siblings };
        current.lookups += 1;
        byFile.set(task.home, current);
    }
    return [...byFile.values()]
        .map((entry) => ({ ...entry, burn: entry.lookups * entry.fileTokens }))
        .sort((a, b) => b.burn - a.burn)
        .slice(0, 40);
};
