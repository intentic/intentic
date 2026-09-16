import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { packageRoot } from "../repos.js";
import { type RunRecord, RunRecordSchema } from "../schema.js";

// Where tool calls go, mined from each run's stream-json transcript; drives reads-after-search, search thrash and
// iq-adoption metrics.
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

// npx/npm/pnpm/yarn mostly launch test runners in these tasks ("npx vitest run ...").
const RUNNER_HEADS = new Set(["npx", "npm", "pnpm", "yarn", "bun"]);

export interface ToolEvent {
    readonly tool: string;
    readonly category: Category;
    // Bash only: "<verb> <query...>" of an iq invocation.
    readonly iqCall?: string;
    // iq calls only, from the tool result: returned nothing or errored, the hardening KPI.
    readonly iqZeroHit?: boolean;
    readonly iqUsageError?: boolean;
    // Numbered source lines this call put in front of the model, counted off the tool RESULT. Set for Read and for iq;
    // absent elsewhere. See sourceLinesOf for why those two and nothing else.
    readonly sourceLines?: number;
}

const classifyBash = (command: string): { category: Category; iqCall?: string } => {
    // A command right of `||` is a fallback, not proven execution; only the always-attempted path per statement is
    // classified. Shell text alone cannot prove a fallback ran, so this stays conservative.
    const attempted = command
        .split(/;|\n/)
        .map((statement) => statement.split("||", 1)[0] ?? "")
        .join(";");
    const heads = attempted
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
            categories.add(/\b(vitest|pytest|jest|test)\b/.test(attempted) ? "test" : "probe");
        }
    }
    for (const category of ["iq", "test", "search", "probe", "git", "read"] as const) {
        if (!categories.has(category)) {
            continue;
        }
        if (category !== "iq") {
            return { category };
        }
        const match = /(?:^|[\s;&|(])iq\s+(.{1,80})/.exec(attempted);
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

// `   123\tsource` — how the Read tool renders a file. Counting the result rather than the request is the whole point:
// a Read with no offset/limit hands back up to 2000 lines whether or not the model wanted them.
const READ_NUMBERED = /^\s*\d+\t/gm;
// `  70: source` — how iq renders a code line. The capsule (`iq:`, `answer:`, `candidates:`, `more:`, `════`) and the
// `… N more` footers do not match, so this counts code shown and not the wrapper around it.
const IQ_NUMBERED = /^\s*\d+:/gm;

// Source lines one tool result put in front of the model. Read and iq only, and they are counted apart:
//
// Read is the cross-harness figure — the same thing Benzi's lines_read.py counts, and the one metric whose measurement
// is identical in an arm that has iq and an arm that does not.
//
// iq is counted BECAUSE it returns code: the pack stage hands back whole enclosing bodies. A metric that counted only
// Read would flatter the iq arm by ignoring the code iq itself pasted, and would report a win for moving the cost
// rather than removing it. grep/rg/cat output stays uncounted on both sides: that is search, not reading, and counting
// it would compare different things.
const sourceLinesOf = (event: ToolEvent, text: string): number | undefined => {
    if (event.tool === "Read") {
        return text.match(READ_NUMBERED)?.length ?? 0;
    }
    return event.category === "iq" ? (text.match(IQ_NUMBERED)?.length ?? 0) : undefined;
};

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
        // An absent result is a call that never came back (the turn was cut); it counts no lines rather than zero,
        // which is a different fact.
        const text = id === undefined ? undefined : results.get(id);
        if (text === undefined) {
            return event;
        }
        const measured = sourceLinesOf(event, text);
        const lines = measured === undefined ? {} : { sourceLines: measured };
        if (event.category !== "iq") {
            return Object.assign({}, event, lines);
        }
        return Object.assign(
            {},
            event,
            lines,
            / 0 \w+ in 0 files/.test(text) ? { iqZeroHit: true } : {},
            /No alias registered|No flag registered|Too many arguments|usage error|error: unknown flag|unknown --lang|needs a value|Failed to parse|Expected argument|path not found in the workspace/i.test(
                text,
            )
                ? { iqUsageError: true }
                : {},
        );
    });
};

export interface RunAnalytics {
    readonly counts: Readonly<Record<Category, number>>;
    readonly iqCalls: readonly string[];
    // Read-class call immediately following an iq or search call; what the round-trip pack should remove.
    readonly readsAfterIq: number;
    readonly readsAfterSearch: number;
    // Bursts of ≥3 consecutive search/probe calls with no read/edit between, the grep-loop signature.
    readonly thrashBursts: number;
    // Hardening KPI: iq calls that returned nothing or errored (target <5% of iq calls).
    readonly iqZeroHits: number;
    readonly iqUsageErrors: number;
    // Source lines the run put in front of the model, split by who put them there. `readLines` is the cross-harness
    // figure; `iqLines` is the code iq pasted itself. Their SUM is what an iq arm has to beat, because an arm that
    // halves readLines while doubling iqLines has moved the cost, not removed it.
    readonly readLines: number;
    readonly iqLines: number;
    // Read calls that returned lines, for the lines-per-read average: a Read with no offset is the expensive shape.
    readonly readCalls: number;
}

// Split out of the main walk because it is a plain sum over independent events, and folding it in there pushed that
// loop past the complexity ceiling for no reading benefit.
const sourceLineTally = (events: readonly ToolEvent[]): Pick<RunAnalytics, "readLines" | "iqLines" | "readCalls"> => {
    let readLines = 0;
    let iqLines = 0;
    let readCalls = 0;
    for (const event of events) {
        if (event.sourceLines === undefined) {
            continue;
        }
        if (event.tool === "Read") {
            readLines += event.sourceLines;
            readCalls += 1;
        } else {
            iqLines += event.sourceLines;
        }
    }
    return { readLines, iqLines, readCalls };
};

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
    return { counts, iqCalls, readsAfterIq, readsAfterSearch, thrashBursts, iqZeroHits, iqUsageErrors, ...sourceLineTally(events) };
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

// The number an iq arm has to beat: every source line the run put in front of the model, whoever put it there.
const contextLines = (analytics: RunAnalytics): number => analytics.readLines + analytics.iqLines;

// Which verbs the runs actually reached for, commonest first. A verb that never appears here is dead weight in the
// help text — the cheapest signal there is that a feature had no effect, and the one that says to delete it.
const verbHistogram = (runs: ReadonlyArray<{ analytics: RunAnalytics }>): string => {
    const counts = new Map<string, number>();
    for (const { analytics } of runs) {
        for (const call of analytics.iqCalls) {
            const verb = call.trim().split(/\s+/)[0] ?? "";
            if (verb !== "" && !verb.startsWith("-") && !verb.startsWith('"')) {
                counts.set(verb, (counts.get(verb) ?? 0) + 1);
            }
        }
    }
    const ranked = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
    // A bare `iq "question"` has no verb token; it lands under the quoted query and is reported as `q`.
    return ranked.length === 0 ? "none" : ranked.map(([verb, count]) => `${verb} ${count}`).join(", ");
};

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
            "| task | arm | calls | iq | iq-0hit | iq-err | search | read | probe | test | edit | reads-after-iq | reads-after-search | thrash | read-lines | iq-lines | ctx-lines |",
        );
        parts.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for (const { record, analytics } of groupRuns) {
            const total = totalCalls(analytics);
            const c = analytics.counts;
            parts.push(
                `| ${record.taskId} | ${record.arm} | ${total} | ${c.iq} | ${analytics.iqZeroHits} | ${analytics.iqUsageErrors} | ${c.search} | ${c.read} | ${c.probe} | ${c.test} | ${c.edit} | ${analytics.readsAfterIq} | ${analytics.readsAfterSearch} | ${analytics.thrashBursts} | ${analytics.readLines} | ${analytics.iqLines} | ${contextLines(analytics)} |`,
            );
        }
        const adoptionFailures = groupRuns.filter(({ record, analytics }) => record.arm !== "a" && analytics.counts.iq === 0);
        parts.push("");
        const iqTotal = groupRuns.reduce((sum, { analytics }) => sum + analytics.counts.iq, 0);
        const zeroTotal = groupRuns.reduce((sum, { analytics }) => sum + analytics.iqZeroHits, 0);
        const errTotal = groupRuns.reduce((sum, { analytics }) => sum + analytics.iqUsageErrors, 0);
        if (iqTotal > 0) {
            parts.push(
                `- **iq failure KPI**: ${zeroTotal}/${iqTotal} zero-hit (${((100 * zeroTotal) / iqTotal).toFixed(0)}%), ${errTotal} usage errors, target <5%`,
            );
            parts.push(`- **verbs reached for**: ${verbHistogram(groupRuns)}`);
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
            // Split out because it is the one line that can say the whole idea failed: if ctx-lines does not fall, iq
            // moved the reading cost from Read into its own output instead of removing it, and read-lines alone would
            // have reported that as a win.
            const wonOn = paired.filter((pair) => contextLines(pair.b) < contextLines(pair.a)).length;
            const perRead = (pick: (pair: (typeof paired)[number]) => RunAnalytics): string => {
                const lines = paired.reduce((sum, pair) => sum + pick(pair).readLines, 0);
                const calls = paired.reduce((sum, pair) => sum + pick(pair).readCalls, 0);
                return calls === 0 ? "n/a" : (lines / calls).toFixed(0);
            };
            parts.push(
                `- **source lines in context (iq arm − a), mean/task**: read ${mean((pair) => pair.b.readLines - pair.a.readLines)}, iq ${mean((pair) => pair.b.iqLines - pair.a.iqLines)}, **total ${mean((pair) => contextLines(pair.b) - contextLines(pair.a))}** — iq arm read fewer total lines on ${wonOn}/${paired.length} tasks`,
            );
            parts.push(`- **lines per Read call**: a ${perRead((pair) => pair.a)}, iq arm ${perRead((pair) => pair.b)}`);
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
    writeFileSync(join(dir, "analytics.md"), `${report}\n`);
    console.log(`${report}\nwritten: ${join(dir, "analytics.md")}`);
};
