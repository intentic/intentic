import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { packageRoot } from "../repos.js";
import { type RunRecord, RunRecordSchema } from "../schema.js";

// Where the tokens actually go: mined from the stream-json transcripts each run already saves. The categories
// drive three decision metrics — reads-after-search (the round-trip `pack` must delete), search thrash, and
// iq-adoption failures (arm b/c runs that never called iq).
type Category = "iq" | "search" | "read" | "probe" | "test" | "git" | "edit" | "other";

const HEAD_CATEGORY: ReadonlyMap<string, Category> = new Map([
    ["iq", "iq"],
    ["grep", "search"],
    ["rg", "search"],
    ["find", "search"],
    ["ack", "search"],
    ["cat", "read"],
    ["head", "read"],
    ["tail", "read"],
    ["sed", "read"],
    ["awk", "read"],
    ["node", "probe"],
    ["python", "probe"],
    ["python3", "probe"],
    ["curl", "probe"],
    ["wget", "probe"],
    ["vitest", "test"],
    ["pytest", "test"],
    ["jest", "test"],
    ["git", "git"],
]);

const TOOL_CATEGORY: ReadonlyMap<string, Category> = new Map([
    ["Grep", "search"],
    ["Glob", "search"],
    ["ToolSearch", "search"],
    ["WebSearch", "search"],
    ["Read", "read"],
    ["WebFetch", "read"],
    ["Edit", "edit"],
    ["Write", "edit"],
    ["NotebookEdit", "edit"],
]);

// npx/npm/pnpm/yarn mostly launch test runners in these tasks ("npx vitest run …").
const RUNNER_HEADS = new Set(["npx", "npm", "pnpm", "yarn", "bun"]);

export interface ToolEvent {
    readonly tool: string;
    readonly category: Category;
    // Bash only: "<verb> <query…>" of an iq invocation.
    readonly iqCall?: string;
    // iq calls only, from the tool result: returned nothing / errored — the hardening KPI.
    readonly iqZeroHit?: boolean;
    readonly iqUsageError?: boolean;
}

const classifyBash = (command: string): { category: Category; iqCall?: string } => {
    const heads = command
        .split(/&&|\|\||;|\|/)
        .map((segment) => segment.trim().split(/\s+/)[0] ?? "")
        .map((head) => head.split("/").pop() ?? "");
    const categories = new Set<Category>();
    for (const head of heads) {
        const mapped = HEAD_CATEGORY.get(head);
        if (mapped !== undefined) {
            categories.add(mapped);
            continue;
        }
        if (RUNNER_HEADS.has(head)) {
            categories.add(/\b(vitest|pytest|jest|test)\b/.test(command) ? "test" : "probe");
        }
    }
    for (const category of ["iq", "test", "search", "probe", "git", "read"] as const) {
        if (!categories.has(category)) {
            continue;
        }
        if (category !== "iq") {
            return { category };
        }
        const match = /(?:^|[\s;&|(])iq\s+(.{1,80})/.exec(command);
        return { category, ...(match?.[1] !== undefined ? { iqCall: match[1].replaceAll("\n", " ").trim() } : {}) };
    }
    return { category: "other" };
};

const TranscriptLineSchema = z.looseObject({
    type: z.string(),
    message: z
        .looseObject({
            content: z
                .array(
                    z.looseObject({
                        type: z.string(),
                        id: z.string().optional(),
                        name: z.string().optional(),
                        input: z.unknown().optional(),
                        tool_use_id: z.string().optional(),
                        content: z.unknown().optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});

const resultText = (content: unknown): string =>
    Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? "")).join("") : String(content ?? "");

export const toolEvents = (transcript: string): ToolEvent[] => {
    const uses: Array<{ id?: string; event: ToolEvent }> = [];
    const results = new Map<string, string>();
    for (const line of transcript.split("\n")) {
        if (!line.startsWith("{")) {
            continue;
        }
        let json: unknown;
        try {
            json = JSON.parse(line);
        } catch {
            continue;
        }
        const parsed = TranscriptLineSchema.safeParse(json);
        if (!parsed.success) {
            continue;
        }
        for (const block of parsed.data.message?.content ?? []) {
            if (parsed.data.type === "assistant" && block.type === "tool_use" && block.name !== undefined) {
                const event: ToolEvent =
                    block.name === "Bash"
                        ? { tool: "Bash", ...classifyBash(String((block.input as { command?: unknown } | undefined)?.command ?? "")) }
                        : { tool: block.name, category: TOOL_CATEGORY.get(block.name) ?? "other" };
                uses.push({ ...(block.id !== undefined ? { id: block.id } : {}), event });
            }
            if (parsed.data.type === "user" && block.type === "tool_result" && block.tool_use_id !== undefined) {
                results.set(block.tool_use_id, resultText(block.content));
            }
        }
    }
    return uses.map(({ id, event }) => {
        if (event.category !== "iq" || id === undefined) {
            return event;
        }
        const text = results.get(id) ?? "";
        return Object.assign(
            {},
            event,
            / 0 \w+ in 0 files/.test(text) ? { iqZeroHit: true } : {},
            /No alias registered|usage error|error: unknown flag|unknown --lang|needs a value/i.test(text) ? { iqUsageError: true } : {},
        );
    });
};

export interface RunAnalytics {
    readonly counts: Readonly<Record<Category, number>>;
    readonly iqCalls: readonly string[];
    // Read-class call immediately following an iq / non-iq search call — the round-trip pack should remove.
    readonly readsAfterIq: number;
    readonly readsAfterSearch: number;
    // Bursts of ≥3 consecutive search/probe calls with no read/edit between — the grep-loop signature.
    readonly thrashBursts: number;
    // Hardening KPI: iq calls that returned nothing or errored (target <5% of iq calls).
    readonly iqZeroHits: number;
    readonly iqUsageErrors: number;
}

export const analyzeEvents = (events: readonly ToolEvent[]): RunAnalytics => {
    const counts: Record<Category, number> = { iq: 0, search: 0, read: 0, probe: 0, test: 0, git: 0, edit: 0, other: 0 };
    const iqCalls: string[] = [];
    let readsAfterIq = 0;
    let readsAfterSearch = 0;
    let burst = 0;
    let thrashBursts = 0;
    let iqZeroHits = 0;
    let iqUsageErrors = 0;
    let previous: Category | undefined;
    for (const event of events) {
        counts[event.category] += 1;
        if (event.iqCall !== undefined) {
            iqCalls.push(event.iqCall);
        }
        if (event.iqZeroHit === true) {
            iqZeroHits += 1;
        }
        if (event.iqUsageError === true) {
            iqUsageErrors += 1;
        }
        if (event.category === "read" && previous === "iq") {
            readsAfterIq += 1;
        }
        if (event.category === "read" && previous === "search") {
            readsAfterSearch += 1;
        }
        if (event.category === "search" || event.category === "probe") {
            burst += 1;
        } else if (event.category !== "other") {
            if (burst >= 3) {
                thrashBursts += 1;
            }
            burst = 0;
        }
        if (event.category !== "other") {
            previous = event.category;
        }
    }
    if (burst >= 3) {
        thrashBursts += 1;
    }
    return { counts, iqCalls, readsAfterIq, readsAfterSearch, thrashBursts, iqZeroHits, iqUsageErrors };
};

const loadRuns = (dir: string): RunRecord[] =>
    readFileSync(join(dir, "runs.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => RunRecordSchema.parse(JSON.parse(line)));

const latestResultsDir = (): string => {
    const root = join(packageRoot, "results");
    const withAgents = readdirSync(root)
        .toSorted()
        .filter((name) => existsSync(join(root, name, "agents/transcripts")));
    const last = withAgents.at(-1);
    if (last === undefined) {
        throw new Error("iq-bench analyze: no results dir with agents/transcripts found");
    }
    return join(root, last, "agents");
};

const totalCalls = (analytics: RunAnalytics): number => Object.values(analytics.counts).reduce((sum, value) => sum + value, 0);

const renderAnalytics = (runs: ReadonlyArray<{ record: RunRecord; analytics: RunAnalytics }>): string => {
    const parts = ["# tool-use analytics\n"];
    const groups = new Map<string, Array<{ record: RunRecord; analytics: RunAnalytics }>>();
    for (const run of runs) {
        const key = `${run.record.vendor} / ${run.record.model}`;
        groups.set(key, [...(groups.get(key) ?? []), run]);
    }
    for (const [group, groupRuns] of groups) {
        parts.push(`## ${group}\n`);
        parts.push(
            "| task | arm | calls | iq | iq-0hit | iq-err | search | read | probe | test | edit | reads-after-iq | reads-after-search | thrash |",
        );
        parts.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for (const { record, analytics } of groupRuns) {
            const total = totalCalls(analytics);
            const c = analytics.counts;
            parts.push(
                `| ${record.taskId} | ${record.arm} | ${total} | ${c.iq} | ${analytics.iqZeroHits} | ${analytics.iqUsageErrors} | ${c.search} | ${c.read} | ${c.probe} | ${c.test} | ${c.edit} | ${analytics.readsAfterIq} | ${analytics.readsAfterSearch} | ${analytics.thrashBursts} |`,
            );
        }
        const adoptionFailures = groupRuns.filter(({ record, analytics }) => record.arm !== "a" && analytics.counts.iq === 0);
        parts.push("");
        const iqTotal = groupRuns.reduce((sum, { analytics }) => sum + analytics.counts.iq, 0);
        const zeroTotal = groupRuns.reduce((sum, { analytics }) => sum + analytics.iqZeroHits, 0);
        const errTotal = groupRuns.reduce((sum, { analytics }) => sum + analytics.iqUsageErrors, 0);
        if (iqTotal > 0) {
            parts.push(
                `- **iq failure KPI**: ${zeroTotal}/${iqTotal} zero-hit (${((100 * zeroTotal) / iqTotal).toFixed(0)}%), ${errTotal} usage errors — target <5%`,
            );
        }
        if (adoptionFailures.length > 0) {
            parts.push(
                `- ⚠ **adoption failures** (iq arm, zero iq calls): ${adoptionFailures.map(({ record }) => `${record.taskId}/${record.arm}`).join(", ")}`,
            );
        }
        const byTask = new Map<string, Map<string, RunAnalytics>>();
        for (const { record, analytics } of groupRuns) {
            const arms = byTask.get(record.taskId) ?? new Map<string, RunAnalytics>();
            arms.set(record.arm, analytics);
            byTask.set(record.taskId, arms);
        }
        const paired: Array<{ a: RunAnalytics; b: RunAnalytics }> = [];
        for (const arms of byTask.values()) {
            const a = arms.get("a");
            const b = [...arms.entries()].find(([arm]) => arm !== "a")?.[1];
            if (a !== undefined && b !== undefined) {
                paired.push({ a, b });
            }
        }
        if (paired.length > 0) {
            const mean = (pick: (pair: (typeof paired)[number]) => number): string => {
                const value = paired.reduce((sum, pair) => sum + pick(pair), 0) / paired.length;
                return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
            };
            parts.push(
                `- **paired (iq arm − a), mean/task**: calls ${mean((pair) => totalCalls(pair.b) - totalCalls(pair.a))}, search ${mean((pair) => pair.b.counts.search - pair.a.counts.search)}, probe ${mean((pair) => pair.b.counts.probe - pair.a.counts.probe)}, reads ${mean((pair) => pair.b.counts.read - pair.a.counts.read)}, thrash ${mean((pair) => pair.b.thrashBursts - pair.a.thrashBursts)}`,
            );
        }
        parts.push("");
    }
    return parts.join("\n");
};

export const analyze = (args: string[]): void => {
    const dir = args[0] !== undefined ? (existsSync(args[0]) ? args[0] : join(packageRoot, "results", args[0], "agents")) : latestResultsDir();
    const runs = loadRuns(dir).map((record) => {
        const path = record.transcriptPath ?? join(dir, "transcripts", `${record.runId}.jsonl`);
        return { record, analytics: analyzeEvents(toolEvents(readFileSync(path, "utf8"))) };
    });
    const report = renderAnalytics(runs);
    writeFileSync(join(dir, "analytics.md"), report + "\n");
    console.log(`${report}\nwritten: ${join(dir, "analytics.md")}`);
};
