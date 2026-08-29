import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIGS } from "../configs.js";
import { renderAgentsReport } from "../report.js";
import { ensureModels, headSha, packageRoot, repoRoot } from "../repos.js";
import { type RunRecord, type Task, TaskSchema } from "../schema.js";
import type { AgentAdapter } from "./adapter.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { gradeAnchors, gradeTest } from "./grade.js";
import { grokAdapter } from "./grok.js";
import { type Arm, prepareWorkspace } from "./workspace.js";

const ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter, grokAdapter];
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_SPEND_USD = 40;

const parseArm = (raw: string): Arm => {
    if (raw === "a") {
        return { name: "a", kind: "baseline" };
    }
    if (raw === "b") {
        return { name: "b", kind: "iq" };
    }
    if (raw.startsWith("c:")) {
        const config = CONFIGS.find((candidate) => candidate.name === raw.slice(2));
        if (config === undefined) {
            throw new Error(`iq-bench: unknown config in arm "${raw}", known: ${CONFIGS.map((candidate) => candidate.name).join(", ")}`);
        }
        return { name: raw, kind: "iq", config };
    }
    throw new Error(`iq-bench: unknown arm "${raw}", use a, b, or c:<config>`);
};

const loadTasks = (): Task[] =>
    ["locate", "fix"].flatMap((kind) => {
        const dir = join(packageRoot, "tasks", kind);
        if (!existsSync(dir)) {
            return [];
        }
        return readdirSync(dir)
            .filter((name) => name.endsWith(".json"))
            .toSorted()
            .map((name) => TaskSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
    });

const flagValue = (args: string[], flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
};

export const agents = async (args: string[]): Promise<void> => {
    const dry = args.includes("--dry");
    if (!dry && process.env["IQ_BENCH_AGENTS"] !== "1") {
        throw new Error("iq-bench agents: spends real tokens, set IQ_BENCH_AGENTS=1 (pnpm bench:agents does) or use --dry");
    }
    const taskFilter = flagValue(args, "--task");
    const vendorFilter = flagValue(args, "--vendor");
    const model = flagValue(args, "--model");
    const arms = (flagValue(args, "--arms") ?? "a,b").split(",").map(parseArm);
    const maxSpend = Number(flagValue(args, "--max-spend") ?? DEFAULT_MAX_SPEND_USD);
    const tasks = loadTasks().filter((task) => taskFilter === undefined || task.id === taskFilter);
    if (tasks.length === 0) {
        throw new Error(`iq-bench: no tasks${taskFilter === undefined ? "" : ` matching "${taskFilter}"`}`);
    }
    const requested = ADAPTERS.filter((adapter) => vendorFilter === undefined || vendorFilter.split(",").includes(adapter.id));
    const adapters = requested.filter((adapter) => adapter.available());
    for (const adapter of requested.filter((candidate) => !candidate.available())) {
        console.warn(`iq-bench: vendor "${adapter.id}" unavailable (binary or credentials missing), skipped`);
    }
    if (adapters.length === 0) {
        throw new Error("iq-bench: no available vendors");
    }
    const plan = adapters.flatMap((adapter) => tasks.flatMap((task) => arms.map((arm) => ({ adapter, task, arm }))));
    if (dry) {
        for (const entry of plan) {
            console.log(`${entry.task.id} × ${entry.adapter.id}(${model ?? entry.adapter.defaultModel ?? "default"}) × arm ${entry.arm.name}`);
        }
        console.log(`\n${plan.length} runs planned, max spend $${maxSpend}`);
        return;
    }
    const models = ensureModels();
    const outDir = join(packageRoot, "results", new Date().toISOString().replaceAll(":", "-"), "agents");
    const transcriptsDir = join(outDir, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    const runsPath = join(outDir, "runs.jsonl");
    const records: RunRecord[] = [];
    let spent = 0;
    for (const { adapter, task, arm } of plan) {
        if (spent >= maxSpend) {
            console.warn(`iq-bench: vendor-reported spend $${spent.toFixed(2)} crossed --max-spend $${maxSpend}, aborting remaining runs`);
            break;
        }
        const runId = `${task.id}-${adapter.id}-${arm.name.replaceAll(":", "_")}`;
        const runModel = model ?? adapter.defaultModel;
        console.log(`[${runId}] preparing workspace…`);
        const workspace = await prepareWorkspace(task, runId, arm, models);
        try {
            const timeoutMs = task.caps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            console.log(`[${runId}] running ${adapter.id} (${runModel ?? "default"}), maxTurns ${task.caps.maxTurns}, timeout ${timeoutMs / 1000}s`);
            const start = Date.now();
            const result = await adapter.run({
                cwd: workspace.dir,
                prompt: task.prompt,
                maxTurns: task.caps.maxTurns,
                timeoutMs,
                ...(runModel !== undefined ? { model: runModel } : {}),
                env: workspace.env,
            });
            const wallMs = Date.now() - start;
            const verdict = task.grader.kind === "anchors" ? gradeAnchors(result.answer, task.grader) : gradeTest(workspace.dir, task.grader);
            const transcriptPath = join(transcriptsDir, `${runId}.jsonl`);
            writeFileSync(transcriptPath, result.raw);
            const record: RunRecord = {
                runId,
                taskId: task.id,
                repo: task.repo,
                sha: headSha(repoRoot(task.repo)),
                vendor: adapter.id,
                model: runModel ?? "default",
                arm: arm.name,
                success: verdict.success,
                graderDetail: verdict.detail,
                ...(result.turns !== undefined ? { turns: result.turns } : {}),
                ...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
                ...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
                ...(result.cacheReadTokens !== undefined ? { cacheReadTokens: result.cacheReadTokens } : {}),
                ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
                wallMs,
                ...(workspace.indexBuildMs !== undefined ? { indexBuildMs: workspace.indexBuildMs } : {}),
                exitCode: result.exitCode,
                answer: result.answer,
                transcriptPath,
                timestamp: new Date().toISOString(),
                caps: { maxTurns: task.caps.maxTurns, timeoutMs },
            };
            records.push(record);
            appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
            spent += result.costUsd ?? 0;
            const cost = result.costUsd === undefined ? "" : `, $${result.costUsd.toFixed(3)}`;
            console.log(
                `[${runId}] ${verdict.success ? "✓" : "✗"} ${verdict.detail} (${(wallMs / 1000).toFixed(0)}s${cost}; total $${spent.toFixed(2)})`,
            );
        } finally {
            workspace.cleanup();
        }
    }
    const report = renderAgentsReport(records);
    writeFileSync(join(outDir, "summary.md"), `${report}\n`);
    console.log(`\n${report}\n\nresults: ${outDir}`);
};
