/* WHAT AN AGENT PAYS TO SEE ONE DEFINITION — the headline number, and the only one here worth optimising.
 *
 * THE WORKLOAD IS NOT CHOSEN. Every named import of a first-party symbol in every test file, resolved through
 * re-exports to the module that actually defines it. On this repository that is tens of thousands of real
 * "locate X" tasks that nobody hand-picked and nobody can quietly curate: they are the symbols the test suite
 * genuinely reaches for. A benchmark whose workload its author selected measures the author.
 *
 * WHAT IS CHARGED. The naive cost: open the file that holds the definition and read it. That is what an agent
 * does when it does not already know where inside a 2,000-line module to look, and it is the number that
 * collapses when a god file is split, because the definition stops arriving wrapped in ninety unrelated
 * neighbours. `lookup.mjs` charges the SKILLED cost — grep first, read a window — and the two move differently
 * on purpose. Report both or neither.
 *
 * THE NUMBER THAT MATTERS MOST is not the median. It is `over128k`: lookups whose defining file cannot be
 * loaded into a context window at all, where the agent is not paying more, it is failing. Driving that to zero
 * is worth more than any percentage.
 *
 * UNRESOLVED IS REPORTED, NEVER GUESSED. A name the resolver cannot follow is counted and excluded, not
 * attributed to a plausible file. See the header of `lib/resolve.mjs` for why that rule is not negotiable. */
import { mean, percentile } from "./lib/files.mjs";

const READ_WINDOW_LINES = 2000;

const declarationText = (file, declaration) =>
    file.text
        .split("\n")
        .slice(declaration.startLine - 1, declaration.endLine)
        .join("\n");

// Is a specifier this tree's own? Only used to tell a resolver limitation apart from a dependency import, and
// that distinction is the reason `unresolved` is trustworthy as a quality signal on the resolver itself.
const isFirstParty = (tree, specifier) => specifier.startsWith(".") || [...tree.packages.keys()].some((name) => specifier.startsWith(name));

// One imported name → one measured task, or a reason it is not one.
const taskFor = (tree, countTokens, resolver, testPath, entry, imported) => {
    const home = resolver(testPath, entry.specifier, imported);
    if (!home) {
        // "Leaves the tree" (correct, uninteresting) is not the same as "should have resolved and did not"
        // (a resolver limitation that has to stay visible).
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
        // The worst offenders, which is what a campaign's first round should actually target. Ranked by the
        // total tokens the tree burns on this file across every lookup that lands in it — a 40k-token file
        // nobody imports from is not the problem a 9k-token file imported 300 times is.
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
