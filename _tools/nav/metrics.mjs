// 1. Lines report physical, code, and comment+blank together; compacting comments moves physical but not code.
// 2. Tests are excluded from every shape number; deleting tests must not move the headline.
// 3. Counter-movers (module count, import edges, largest cycle) are reported alongside the wins, not hidden.
import { mean, percentile, sum } from "./lib/files.mjs";
import { resolveSpecifier } from "./lib/resolve.mjs";

// Tarjan's algorithm, iterative: a recursive version blows the stack on a large import graph.
const stronglyConnected = (nodes, edgesOf) => {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const components = [];
    let counter = 0;

    // Discovers a node: assigns it an index and pushes a work frame.
    const discover = (node, work) => {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
        work.push({ node, edges: edgesOf(node), position: 0 });
    };

    // Unwinding one completed root: everything above it on the stack is its component.
    const popComponent = (node) => {
        const component = [];
        let popped;
        do {
            popped = stack.pop();
            onStack.delete(popped);
            component.push(popped);
        } while (popped !== node);
        return component;
    };

    const step = (frame, work) => {
        if (frame.position < frame.edges.length) {
            const next = frame.edges.at(frame.position);
            frame.position += 1;
            if (!index.has(next)) {
                discover(next, work);
            } else if (onStack.has(next)) {
                low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
            }
            return;
        }

        work.pop();
        const parent = work.at(-1);
        if (parent) {
            low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
            components.push(popComponent(frame.node));
        }
    };

    for (const root of nodes) {
        if (index.has(root)) {
            continue;
        }
        const work = [];
        discover(root, work);
        while (work.length > 0) {
            step(work.at(-1), work);
        }
    }
    return components;
};

const distribution = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.at(-1) ?? 0,
        mean: Number(mean(sorted).toFixed(2)),
    };
};

export const measureShape = (tree) => {
    const sourceFiles = tree.source.map((path) => tree.files.get(path)).filter(Boolean);
    const testFiles = tree.tests.map((path) => tree.files.get(path)).filter(Boolean);

    const physical = sum(sourceFiles.map((file) => file.lines.physical));
    const code = sum(sourceFiles.map((file) => file.lines.code));
    const comment = sum(sourceFiles.map((file) => file.lines.comment));
    const blank = sum(sourceFiles.map((file) => file.lines.blank));
    const tokens = sum(sourceFiles.map((file) => file.tokens));

    const fileLines = sourceFiles.map((file) => file.lines.physical);
    const functions = sourceFiles.flatMap((file) => file.functions);
    const functionLines = functions.map((fn) => fn.lines);
    const complexities = functions.map((fn) => fn.complexity);

    // Import graph, first-party edges only; a dependency edge isn't a navigability cost this tree owns.
    const edges = new Map();
    let edgeCount = 0;
    const fanIn = new Map();
    for (const path of tree.source) {
        const targets = [];
        for (const entry of tree.facts.get(path)?.imports ?? []) {
            if (entry.typeOnly) {
                continue;
            }
            const target = resolveSpecifier(path, entry.specifier, tree.known, tree.packages);
            if (target && target !== path) {
                targets.push(target);
                fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
                edgeCount += 1;
            }
        }
        edges.set(path, targets);
    }
    const cycles = stronglyConnected(tree.source, (node) => edges.get(node) ?? []).filter((c) => c.length > 1);
    const largestCycle = cycles.reduce((best, c) => Math.max(best, c.length), 0);

    const overSized = (limit) => sourceFiles.filter((file) => file.lines.physical > limit).length;
    const contextBusting = (limit) => sourceFiles.filter((file) => file.tokens > limit).length;

    return {
        files: {
            source: sourceFiles.length,
            test: testFiles.length,
            testLines: sum(testFiles.map((file) => file.lines.physical)),
        },
        lines: {
            physical,
            code,
            comment,
            blank,
            commentAndBlank: comment + blank,
        },
        tokens: {
            total: tokens,
            perLine: Number((tokens / Math.max(1, physical)).toFixed(2)),
            charsPerToken: Number((sum(sourceFiles.map((file) => file.text.length)) / Math.max(1, tokens)).toFixed(2)),
        },
        fileSize: {
            ...distribution(fileLines),
            over500: overSized(500),
            over1000: overSized(1000),
            over2000: overSized(2000),
            over5000: overSized(5000),
        },
        contextFit: {
            over32kTokens: contextBusting(32_000),
            over128kTokens: contextBusting(128_000),
            largestFileTokens: sourceFiles.reduce((best, file) => Math.max(best, file.tokens), 0),
        },
        functions: {
            ...distribution(functionLines),
            over100: functionLines.filter((n) => n > 100).length,
            over300: functionLines.filter((n) => n > 300).length,
        },
        complexity: {
            ...distribution(complexities),
            over30: complexities.filter((n) => n > 30).length,
            over50: complexities.filter((n) => n > 50).length,
            worst: (() => {
                const worst = functions.reduce((best, fn) => (fn.complexity > (best?.complexity ?? 0) ? fn : best), undefined);
                return worst ? { name: worst.name, complexity: worst.complexity, lines: worst.lines } : undefined;
            })(),
        },
        controlFlow: {
            maxNesting: sourceFiles.reduce((best, file) => Math.max(best, file.maxNesting), 0),
            filesNestedOver5: sourceFiles.filter((file) => file.maxNesting > 5).length,
            longestIfChain: sourceFiles.reduce((best, file) => Math.max(best, file.longestChain), 0),
            filesWithChainOver4: sourceFiles.filter((file) => file.longestChain >= 4).length,
        },
        // Counter-movers: splitting improves the numbers above by making these worse; kept in the same object.
        cost: {
            modules: sourceFiles.length,
            importEdges: edgeCount,
            meanFanOut: Number((edgeCount / Math.max(1, sourceFiles.length)).toFixed(2)),
            maxFanIn: Math.max(0, ...fanIn.values()),
            cycles: cycles.length,
            largestCycle,
        },
    };
};
