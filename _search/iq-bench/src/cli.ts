#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runImpact } from "./impact.js";
import { renderImpactReport, renderRetrievalReport } from "./report.js";
import { packageRoot } from "./repos.js";
import { runRetrieval } from "./retrieval.js";

const USAGE = `iq-bench <command>

  retrieval [--repo <id>] [--config <name>]   tier 1: sweep retrieval configs against golden datasets
  impact    [--repo <id>]                     tier 1b: impact strategies against co-change ground truth
  agents    [--dry] [...]                     tier 2: paired agent-CLI runs (see agents/run.ts)
  analyze   [results-dir|timestamp]           mine tier-2 transcripts: tool mix, reads-after-search, thrash
`;

const flagValue = (args: string[], flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
};

const resultsDir = (): string => {
    const dir = join(packageRoot, "results", new Date().toISOString().replaceAll(":", "-"));
    mkdirSync(dir, { recursive: true });
    return dir;
};

const retrieval = async (args: string[]): Promise<void> => {
    const repo = flagValue(args, "--repo");
    const config = flagValue(args, "--config");
    const { rows, metas, skippedModels } = await runRetrieval({
        ...(repo !== undefined ? { repo } : {}),
        ...(config !== undefined ? { config } : {}),
    });
    const dir = resultsDir();
    writeFileSync(join(dir, "retrieval.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const report = renderRetrievalReport(rows, metas, skippedModels);
    writeFileSync(join(dir, "summary.md"), `${report}\n`);
    console.log(`\n${report}\n\nresults: ${dir}`);
};

const impact = async (args: string[]): Promise<void> => {
    const repo = flagValue(args, "--repo");
    const { rows, meta } = await runImpact(repo !== undefined ? { repo } : {});
    const dir = resultsDir();
    writeFileSync(join(dir, "impact.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const report = renderImpactReport(rows, meta);
    writeFileSync(join(dir, "summary.md"), `${report}\n`);
    console.log(`\n${report}\n\nresults: ${dir}`);
};

const [command, ...args] = process.argv.slice(2);
if (command === "retrieval") {
    await retrieval(args);
} else if (command === "impact") {
    await impact(args);
} else if (command === "agents") {
    const { agents } = await import("./agents/run.js");
    await agents(args);
} else if (command === "analyze") {
    const { analyze } = await import("./agents/analyze.js");
    analyze(args);
} else {
    console.error(USAGE);
    process.exit(2);
}
