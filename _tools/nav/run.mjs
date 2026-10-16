#!/usr/bin/env node
// What this costs an agent to work in, not the CPU; deterministic and offline, so results are reproducible.
// - measure [--ref R] [--label L | --out PATH]: full picture of one tree, written to baselines/L.json or PATH.
// - targets [--top N]: files ranked by tokens the tree burns on each, not by size.
// - compare A B: delta table between two measurements; refuses to mix tokenizers.
// - calibrate: checks the token estimator's chars/token band.
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
import { arg } from "./lib/args.mjs";
import { compareRows, glyphOf, n, pct } from "./lib/compare.mjs";

const root = repoRoot(import.meta.url);


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

    console.log(`\n=== ${before.ref} @ ${before.head}  →  ${after.ref} @ ${after.head} ===`);
    provenance(before, after);
    for (const { title, rows, notes } of compareRows(before, after)) {
        console.log(`\n${title}`);
        for (const row of rows) {
            console.log(`  ${glyphOf(row)} ${row.label.padEnd(40)} ${n(row.before).padStart(12)} → ${n(row.after).padStart(12)}  ${pct(row.before, row.after).padStart(8)}`);
        }
        for (const note of notes) {
            console.log(`    → ${note}`);
        }
    }
    console.log("");
};

// How many commits (and how many touching source) separate the two refs; a delta from a stale baseline gets credited
// with everyone else's work in between.
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

// The whole-tree ratio is the only real assertion; per-shape rows are printed as information only, since honest
// per-line ranges vary too widely to bound narrowly.
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
