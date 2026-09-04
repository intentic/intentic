#!/usr/bin/env node
/* `node _tools/nav/run.mjs` — WHAT THIS CODEBASE COSTS AN AGENT TO WORK IN, as opposed to what it costs the CPU.
 *
 * Four verbs:
 *
 *   measure [--ref R]     the full picture of one tree, written to JSON and printed. `--ref` measures any git
 *                         ref without checking it out, which is how a baseline is captured while you keep
 *                         working in the tree.
 *   targets [--top N]     the ranked list a decomposition round should actually attack, ordered by the tokens
 *                         the whole tree burns on each file rather than by file size. A 40k-token module
 *                         nobody imports from is not a problem; a 9k-token one imported 300 times is.
 *   compare A B           two measurements, as a delta table. Prints the counter-movers next to the wins and
 *                         refuses to compare runs made with different tokenizers.
 *   calibrate             sanity-checks the token estimator against the band real code BPE lands in.
 *
 * WHY IT IS BUILT THIS WAY. A refactor campaign needs a number that cannot be argued with afterwards, captured
 * BEFORE anything moves. Everything here is offline, deterministic, and makes no model calls, so the same tree
 * always produces the same file and two people get the same answer. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";
import { runBench } from "./bench.mjs";
import { estimateTokens, tokenCounter } from "./lib/tokens.mjs";
import { makeResolver } from "./lib/resolve.mjs";
import { buildTree } from "./lib/tree.mjs";
import { runLookupSim } from "./lookup.mjs";
import { measureShape } from "./metrics.mjs";

const root = repoRoot(import.meta.url);

const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
};

const n = (value) => (typeof value === "number" ? value.toLocaleString("en-US") : String(value));
const pct = (before, after) => {
    if (!before) {
        return "—";
    }
    const delta = ((after - before) / before) * 100;
    const sign = delta > 0 ? "+" : "";
    return `${sign}${delta.toFixed(1)}%`;
};

const measure = async () => {
    const ref = arg("ref", undefined);
    const sample = Number(arg("sample", "4000"));
    const { count, label } = await tokenCounter();

    process.stderr.write(`nav: parsing ${ref ?? "working tree"}…\n`);
    const tree = buildTree(root, ref, count, (done, total) => {
        process.stderr.write(`\r     ${done}/${total} files`);
    });
    process.stderr.write("\rnav: measuring shape…                    \n");
    const shape = measureShape(tree);

    process.stderr.write("nav: resolving the test suite's imports…\n");
    const resolver = makeResolver(tree);
    const bench = runBench(tree, count, resolver);

    process.stderr.write("nav: simulating skilled lookups…\n");
    const lookup = runLookupSim(tree, count, { sample });

    const report = {
        generatedAt: new Date().toISOString(),
        ref: tree.ref,
        head: gitHead(ref),
        tokenizer: label,
        shape,
        bench,
        lookup,
    };

    const out = arg("out", join(root, "_tools/nav/baselines", `${arg("label", "head").replace(/[^\w.-]/g, "_")}.json`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    printReport(report);
    process.stderr.write(`\nnav: written to ${out}\n`);
};

const gitHead = (ref) => {
    try {
        return execFileSync("git", ["rev-parse", "--short", ref ?? "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
        return "unknown";
    }
};

const printReport = (report) => {
    const { shape, bench, lookup } = report;
    const line = (label, value) => console.log(`  ${label.padEnd(42)} ${n(value)}`);

    console.log(`\n=== nav: ${report.ref} @ ${report.head} · tokenizer ${report.tokenizer} ===`);

    console.log("\nSIZE — three ways, because a comment pass and a code pass are not the same claim");
    line("source files", shape.files.source);
    line("physical lines", shape.lines.physical);
    line("code lines (no comments/blanks)", shape.lines.code);
    line("comment + blank lines", shape.lines.commentAndBlank);
    line("tokens", shape.tokens.total);
    line("tokens per line", shape.tokens.perLine);
    line("test files / test lines", `${n(shape.files.test)} / ${n(shape.files.testLines)}`);

    console.log("\nCAN AN AGENT LOAD IT AT ALL");
    line("files over 32k tokens", shape.contextFit.over32kTokens);
    line("files over 128k tokens", shape.contextFit.over128kTokens);
    line("largest file (tokens)", shape.contextFit.largestFileTokens);

    console.log("\nSHAPE");
    line("files over 500 / 1k / 2k lines", `${shape.fileSize.over500} / ${shape.fileSize.over1000} / ${shape.fileSize.over2000}`);
    line("function lines p50 / p95 / max", `${shape.functions.p50} / ${shape.functions.p95} / ${shape.functions.max}`);
    line("functions over 100 / 300 lines", `${shape.functions.over100} / ${shape.functions.over300}`);
    line("complexity mean / p95 / max", `${shape.complexity.mean} / ${shape.complexity.p95} / ${shape.complexity.max}`);
    line("blocks with complexity > 30 / > 50", `${shape.complexity.over30} / ${shape.complexity.over50}`);
    line("longest if/else-if chain", shape.controlFlow.longestIfChain);
    line("max nesting depth", shape.controlFlow.maxNesting);

    console.log("\nNAIVE LOOKUP — open the defining file and read it");
    line("tasks (real imports from tests)", bench.tasks);
    line("  unresolved / external", `${n(bench.unresolved)} / ${n(bench.external)}`);
    line("defining file tokens p50 / p90 / max", `${n(bench.fileTokens.p50)} / ${n(bench.fileTokens.p90)} / ${n(bench.fileTokens.max)}`);
    line("overhead beyond the symbol (p50)", bench.overhead.p50);
    line("lookups whose file exceeds 32k", bench.over32k);
    line("lookups whose file exceeds 128k", bench.over128k);
    line("unrelated siblings in the file (mean)", bench.siblings.mean);
    line("total tokens if each read its file", bench.totalTokensIfReadWhole);

    console.log("\nSKILLED LOOKUP — grep, then read a window (the check on the number above)");
    line("sampled symbols", lookup.sampled);
    line("tokens returned p50 / mean / p90", `${n(lookup.tokensReturned.p50)} / ${n(lookup.tokensReturned.mean)} / ${n(lookup.tokensReturned.p90)}`);
    line("tool calls (mean)", lookup.toolCalls.mean);
    line("lookups needing an extra window", lookup.needingExtraWindow);

    console.log("\nWHAT SPLITTING COSTS — reported whichever way it moved");
    line("modules", shape.cost.modules);
    line("first-party import edges", shape.cost.importEdges);
    line("mean fan-out", shape.cost.meanFanOut);
    line("import cycles / largest", `${shape.cost.cycles} / ${shape.cost.largestCycle}`);
};

const targets = async () => {
    const top = Number(arg("top", "20"));
    const { count } = await tokenCounter();
    const tree = buildTree(root, arg("ref", undefined), count);
    const resolver = makeResolver(tree);
    const bench = runBench(tree, count, resolver);

    console.log("\nRanked by tokens the tree burns on this file across every lookup that lands in it.");
    console.log("Not by file size: a huge module nobody imports from is not the problem.\n");
    console.log("  burn(tok)   lookups  file(tok)  siblings  path");
    for (const entry of bench.worstFiles.slice(0, top)) {
        console.log(
            `  ${String(entry.burn).padStart(10)}  ${String(entry.lookups).padStart(7)}  ${String(entry.fileTokens).padStart(9)}  ${String(entry.siblings).padStart(8)}  ${entry.path}`,
        );
    }
    console.log("\nA good round takes the top few, splits each along topic lines, and re-measures.");
};

const compare = () => {
    const [, , , beforePath, afterPath] = process.argv;
    if (!beforePath || !afterPath) {
        console.error("usage: run.mjs compare <before.json> <after.json>");
        process.exit(2);
    }
    const before = JSON.parse(readFileSync(beforePath, "utf8"));
    const after = JSON.parse(readFileSync(afterPath, "utf8"));

    if (before.tokenizer !== after.tokenizer) {
        console.error(`refusing to compare: '${before.tokenizer}' vs '${after.tokenizer}'. Re-measure both with the same one.`);
        process.exit(2);
    }

    const row = (label, a, b) => {
        const moved = b - a;
        const good = moved === 0 ? " " : moved < 0 ? "✓" : "✗";
        console.log(`  ${good} ${label.padEnd(40)} ${n(a).padStart(12)} → ${n(b).padStart(12)}  ${pct(a, b).padStart(8)}`);
    };

    /* A price, not a score, and therefore printed WITHOUT a verdict glyph. Module count and import edges going
     * up is what buying a decomposition costs; marking that growth ✓ would read as "we did well" and marking it
     * ✗ as "we did badly", and neither is true. The number is the whole message: it is here so the reader can
     * decide whether the price was worth the win above it. */
    const costRow = (label, a, b) => {
        console.log(`  · ${label.padEnd(40)} ${n(a).padStart(12)} → ${n(b).padStart(12)}  ${pct(a, b).padStart(8)}`);
    };

    console.log(`\n=== ${before.ref} @ ${before.head}  →  ${after.ref} @ ${after.head} ===`);
    provenance(before, after);

    console.log("\nSIZE (read all three rows or none)");
    row("physical lines", before.shape.lines.physical, after.shape.lines.physical);
    row("code lines", before.shape.lines.code, after.shape.lines.code);
    row("comment + blank lines", before.shape.lines.commentAndBlank, after.shape.lines.commentAndBlank);
    const physicalDrop = before.shape.lines.physical - after.shape.lines.physical;
    const codeDrop = before.shape.lines.code - after.shape.lines.code;
    if (physicalDrop > 0) {
        const share = ((physicalDrop - codeDrop) / physicalDrop) * 100;
        console.log(`    → ${share.toFixed(0)}% of the line reduction was comments and blanks, not code.`);
    }

    console.log("\nAGENT COST");
    row("naive: defining file tokens (p50)", before.bench.fileTokens.p50, after.bench.fileTokens.p50);
    row("naive: defining file tokens (p90)", before.bench.fileTokens.p90, after.bench.fileTokens.p90);
    row("naive: lookups over 128k tokens", before.bench.over128k, after.bench.over128k);
    row("naive: total tokens if read whole", before.bench.totalTokensIfReadWhole, after.bench.totalTokensIfReadWhole);
    row("skilled: tokens returned (mean)", before.lookup.tokensReturned.mean, after.lookup.tokensReturned.mean);
    row("skilled: tokens returned (p50)", before.lookup.tokensReturned.p50, after.lookup.tokensReturned.p50);
    pairedLookup(before, after);

    console.log("\nSHAPE");
    row("files over 2000 lines", before.shape.fileSize.over2000, after.shape.fileSize.over2000);
    row("functions over 100 lines", before.shape.functions.over100, after.shape.functions.over100);
    row("worst complexity", before.shape.complexity.max, after.shape.complexity.max);
    row("longest if/else-if chain", before.shape.controlFlow.longestIfChain, after.shape.controlFlow.longestIfChain);

    console.log("\nWHAT IT COST — these are SUPPOSED to get worse; the question is how much");
    costRow("modules", before.shape.cost.modules, after.shape.cost.modules);
    costRow("import edges", before.shape.cost.importEdges, after.shape.cost.importEdges);
    costRow("mean fan-out", before.shape.cost.meanFanOut, after.shape.cost.meanFanOut);
    costRow("largest import cycle", before.shape.cost.largestCycle, after.shape.cost.largestCycle);
    console.log("");
};

/* HOW MANY COMMITS THIS DELTA IS ACTUALLY MEASURING.
 *
 * A comparison silently attributes every change between the two refs to whoever is reading it. Re-use a
 * baseline captured last month and the campaign gets credited with a month of everyone else's work — the exact
 * flavour of dishonesty this harness exists to make hard, and the easiest one to commit by accident, because
 * nothing looks wrong. So say the number out loud: how many commits separate the two, and how many of them
 * touched source. If that count is much larger than the number of slices in the round, the delta is not the
 * round's. */
const provenance = (before, after) => {
    const span = (args) => {
        try {
            return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
        } catch {
            return "";
        }
    };
    if (before.head === "unknown" || after.head === "unknown" || before.head === after.head) {
        return;
    }
    const commits = span(["rev-list", "--count", `${before.head}..${after.head}`]);
    if (commits === "") {
        console.log("    ! could not compare the two refs in git — the delta may include unrelated work.");
        return;
    }
    const touching = span(["rev-list", "--count", `${before.head}..${after.head}`, "--", "*.ts", "*.vue", "*.mjs"]);
    console.log(`    ${commits} commit(s) between these refs, ${touching || "?"} touching source. Everything below is ALL of them, not just yours.`);
};

/* The genuinely paired number: only symbols present in BOTH samples, compared to themselves. Two independent
 * random draws differ by a few percent on their own, which is more than enough to manufacture a result. */
const pairedLookup = (before, after) => {
    const shared = Object.keys(before.lookup.perSymbol).filter((name) => name in after.lookup.perSymbol);
    if (shared.length < 50) {
        console.log(`    → only ${shared.length} symbols in both samples; paired delta omitted as unreliable.`);
        return;
    }
    const b = shared.reduce((total, name) => total + before.lookup.perSymbol[name], 0) / shared.length;
    const a = shared.reduce((total, name) => total + after.lookup.perSymbol[name], 0) / shared.length;
    console.log(`    → paired on ${n(shared.length)} symbols present in both: ${b.toFixed(0)} → ${a.toFixed(0)} tokens (${pct(b, a)})`);
};

/* THE ONLY CALIBRATION THAT MEANS ANYTHING is the whole-tree ratio. Individual lines legitimately range from
 * about 1.8 characters per token (punctuation soup, where nearly every character is its own token in a real
 * vocabulary too) to about 4.8 (English prose in a comment). Asserting a narrow band per line would fail on
 * correct output, which is worse than not checking: a check that cries wolf gets switched off. Averaged over a
 * few hundred thousand lines of real source, code BPE reliably lands at 3.2–4.2, so that is the assertion, and
 * the per-shape rows below are printed as information with the range each one is actually expected in. */
const calibrate = async () => {
    const shapes = [
        [
            "identifier-dense TS",
            "export const buildTurnPlanForConversation = (conversationId: string): TurnPlan => ({ id: conversationId });",
            3.0,
            4.6,
        ],
        ["punctuation-dense", "const x = a?.b?.c ?? (d && e) || [f, g].map((h) => h * 2);", 1.5, 2.8],
        ["prose comment", "// The marker that identifies the monorepo root, rather than counting directories upward from here.", 3.8, 5.2],
    ];
    console.log("\nPer-shape ratios (information — each shape has its own honest range):\n");
    for (const [label, text, low, high] of shapes) {
        const ratio = text.length / estimateTokens(text);
        const ok = ratio >= low && ratio <= high;
        console.log(`  ${ok ? "ok  " : "off "} ${label.padEnd(22)} ${ratio.toFixed(2)} chars/token  (expected ${low}–${high})`);
    }

    console.log("\nWhole-tree ratio — this is the assertion:\n");
    const { count } = await tokenCounter();
    const tree = buildTree(root, arg("ref", undefined), count);
    const files = tree.source.map((path) => tree.files.get(path)).filter(Boolean);
    const chars = files.reduce((total, file) => total + file.text.length, 0);
    const tokens = files.reduce((total, file) => total + file.tokens, 0);
    const ratio = chars / Math.max(1, tokens);
    const ok = ratio >= 3.2 && ratio <= 4.2;
    console.log(`  ${ok ? "ok  " : "BAD "} ${n(files.length)} source files  ${ratio.toFixed(2)} chars/token  (expected 3.2–4.2)`);
    if (!ok) {
        console.log("\n  Outside the band means a bug in lib/tokens.mjs, not a finding about the code.");
    }
    process.exit(ok ? 0 : 1);
};

const verb = process.argv[2] ?? "measure";
const verbs = { measure, targets, compare, calibrate };
if (!verbs[verb]) {
    console.error(`unknown verb '${verb}'. one of: ${Object.keys(verbs).join(", ")}`);
    process.exit(2);
}
await verbs[verb]();
