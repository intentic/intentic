import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
    carrySession,
    chainBefore,
    compactPrompt,
    compactSeed,
    contentChars,
    contextBefore,
    contextOf,
    humanText,
    lastExchanges,
    loadSession,
    renderTranscript,
    seedPrompt,
    type SessionLine,
    trimSession,
} from "./handoff-arms.js";

/* HANDOFF BENCH: what should a conversation hand its next session when the allowance runs out and the cache is cold?

   pnpm bench:handoff cuts                    pick the cut points (4, one per context band) from the real sessions
   pnpm bench:handoff tier0                   free: replay every real turn's call trace with each arm's base swapped in
   pnpm bench:handoff run --dry               build every arm for every cut, count sizes, spend nothing
   pnpm bench:handoff run [--cuts a,b] [--arms carry,seed,...]
                                              tier 1: probes + next move per arm, then one blind judge per cut
   pnpm bench:handoff report                  aggregate what ran

   Needs CLAUDE_CODE_OAUTH_TOKEN (a subscription account) for `run`. Results live under
   /work/.intentic/records/bench/handoff/, one directory per cut, and a step already on disk is never re-run. */

const SESSIONS = process.env["HANDOFF_SESSIONS"] ?? "/work/.intentic/records/sessions/claude/projects";
const OUT = process.env["HANDOFF_OUT"] ?? "/work/.intentic/records/bench/handoff";
const ARM_MODEL = "claude-opus-5-5";
const JUDGE_MODEL = "claude-opus-5-5";
const COMPACT_MODEL = "claude-haiku-5-5";

// API list prices per token, used as the allowance proxy: a subscription meters the same tokens.
const PRICE: Record<string, { in: number; write: number; read: number; out: number }> = {
    "claude-opus-5-5": { in: 4e-6, write: 5e-6, read: 0.2e-6, out: 20e-6 },
    "claude-haiku-5-5": { in: 0.5e-6, write: 0.625e-6, read: 0.05e-6, out: 2.5e-6 },
};
// One-hour cache writes, what a long agent turn uses: 2x input.
const WRITE_1H = 8e-6;
const READ = 0.2e-6;
const OUTPUT = 20e-6;

const flags = (): Map<string, string> => {
    const map = new Map<string, string>();
    const argv = process.argv.slice(3);
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg.startsWith("--")) {
            const [name, inline] = arg.slice(2).split("=", 2);
            map.set(name!, inline ?? (argv[index + 1]?.startsWith("--") === false ? argv[++index]! : "true"));
        }
    }
    return map;
};

const sessionFiles = (minBytes: number): { file: string; bytes: number }[] => {
    const found: { file: string; bytes: number }[] = [];
    for (const dir of readdirSync(SESSIONS)) {
        const path = join(SESSIONS, dir);
        if (!statSync(path).isDirectory()) {
            continue;
        }
        for (const name of readdirSync(path)) {
            if (name.endsWith(".jsonl")) {
                const bytes = statSync(join(path, name)).size;
                if (bytes >= minBytes) {
                    found.push({ file: join(path, name), bytes });
                }
            }
        }
    }
    return found.toSorted((a, b) => b.bytes - a.bytes);
};

const compacted = (lines: readonly SessionLine[], before: number): boolean =>
    lines.slice(0, before).some((line) => (line.entry?.["type"] === "system" && line.entry["subtype"] === "compact_boundary") || line.entry?.isCompactSummary === true);

const modelBefore = (lines: readonly SessionLine[], cut: number): string => {
    for (let index = cut - 1; index >= 0; index -= 1) {
        const model = lines[index]?.entry?.message?.model;
        if (contextOf(lines[index]?.entry) !== undefined && model !== undefined) {
            return model;
        }
    }
    return "";
};

const callsBetween = (lines: readonly SessionLine[], from: number, to: number): number => {
    const ids = new Set<string>();
    for (let index = from; index < to; index += 1) {
        const entry = lines[index]?.entry;
        if (contextOf(entry) !== undefined) {
            ids.add(entry?.message?.id ?? String(index));
        }
    }
    return ids.size;
};

const chainContext = (lines: readonly SessionLine[], at: number): number => {
    const chain = chainBefore(lines, at);
    return contextBefore(chain, chain.length);
};

const humanIndexes = (lines: readonly SessionLine[]): number[] => lines.flatMap((line, index) => (humanText(line.entry) === undefined ? [] : [index]));

/* ---------- cuts ---------- */

interface Cut {
    readonly id: string;
    readonly file: string;
    // Index of the first line the continuing session does not get.
    readonly line: number;
    readonly kind: "turn" | "mid-turn";
    readonly context: number;
    readonly model: string;
    // What the continuing session is sent: the real next message, or the restated turn after a mid-turn cut.
    readonly next: string;
    // Where the reference future (what the full-memory session did next) ends.
    readonly futureEnd: number;
}

const BANDS: readonly { lo: number; hi: number; kind: Cut["kind"] }[] = [
    { lo: 120_000, hi: 220_000, kind: "turn" },
    { lo: 250_000, hi: 380_000, kind: "mid-turn" },
    { lo: 400_000, hi: 520_000, kind: "turn" },
    { lo: 550_000, hi: 700_000, kind: "mid-turn" },
];

const restated = (request: string): string =>
    `Continue where you left off: the previous turn was cut short by a usage limit partway through. The request it was working on:\n\n${request}`;

const candidates = (file: string): Cut[] => {
    const lines = loadSession(file);
    const humans = humanIndexes(lines);
    const found: Cut[] = [];
    for (const [order, start] of humans.entries()) {
        if (order < 3 || compacted(lines, start)) {
            continue;
        }
        const end = humans[order + 1] ?? lines.length;
        const turnCalls = callsBetween(lines, start, end);
        const next = humanText(lines[start]?.entry)!;
        const model = modelBefore(lines, start);
        if (!/^claude-opus-5/u.test(model)) {
            continue;
        }
        // A cut before this human message: the session gets the message as the first thing after the hand-off. Context is
        // read off the chain the message continued, not the nearest line above it, which may sit on an abandoned branch.
        const context = chainContext(lines, start);
        // A person's message, not one the daemon wrote (a land conflict, a CI failure): those test the tree, not memory.
        const typed = !/^(Landing your work|CI on |The checks )/u.test(next);
        if (turnCalls >= 8 && typed && next.length >= 30 && next.length <= 3_000) {
            found.push({ id: `${file.slice(-42, -34)}-${start}`, file, line: start, kind: "turn", context, model, next, futureEnd: end });
        }
        // A cut inside this turn, after at least 40% of its calls: right before an assistant line that follows tool results.
        if (turnCalls >= 30) {
            let seen = 0;
            const ids = new Set<string>();
            for (let index = start + 1; index < end; index += 1) {
                const entry = lines[index]?.entry;
                if (contextOf(entry) === undefined) {
                    continue;
                }
                const id = entry?.message?.id ?? String(index);
                if (ids.has(id)) {
                    continue;
                }
                ids.add(id);
                seen += 1;
                const previous = lines[index - 1]?.entry;
                const afterResults = previous?.type === "user" && Array.isArray(previous.message?.content) && previous.message.content.some((block) => block.type === "tool_result");
                if (seen >= turnCalls * 0.4 && afterResults && !compacted(lines, index)) {
                    found.push({
                        id: `${file.slice(-42, -34)}-${index}`,
                        file,
                        line: index,
                        kind: "mid-turn",
                        context: chainContext(lines, index),
                        model: modelBefore(lines, index),
                        next: restated(next),
                        futureEnd: end,
                    });
                    break;
                }
            }
        }
    }
    return found;
};

const pickCuts = (): Cut[] => {
    const files = sessionFiles(3_000_000).slice(0, 250);
    const all = files.flatMap(({ file }) => candidates(file));
    const used = new Set<string>();
    const picked: Cut[] = [];
    for (const band of BANDS) {
        const pool = all
            .filter((cut) => cut.kind === band.kind && cut.context >= band.lo && cut.context < band.hi && !used.has(cut.file))
            // Prefer the newest model and a next step with room to show what the hand-off lost.
            .toSorted((a, b) => Number(b.model === ARM_MODEL) - Number(a.model === ARM_MODEL) || b.futureEnd - b.line - (a.futureEnd - a.line));
        const cut = pool[0];
        if (cut !== undefined) {
            used.add(cut.file);
            picked.push(cut);
        }
    }
    return picked;
};

const cutsFile = join(OUT, "cuts.json");
const loadCuts = (): Cut[] => JSON.parse(readFileSync(cutsFile, "utf8")) as Cut[];

/* ---------- tier 0: cost model ---------- */

// Re-runs the real calls after a boundary with the arm's base context in place of the old session's, charging the
// first call a full (1h) write, later calls the read of what was cached plus the write of what each call added.
const replay = (calls: readonly { context: number; written: number; output: number }[], context0: number, base: number): number => {
    let cost = 0;
    for (const [index, call] of calls.entries()) {
        const context = Math.max(0, call.context - context0) + base;
        if (index === 0) {
            cost += context * WRITE_1H;
        } else {
            const written = Math.min(call.written, context);
            cost += (context - written) * READ + written * WRITE_1H;
        }
        cost += call.output * OUTPUT;
    }
    return cost;
};

const tier0 = (): void => {
    const bands = [100_000, 200_000, 400_000, 700_000, 1_100_000];
    const arms = ["carry", "trim10", "trim30", "compact", "seed"] as const;
    type Row = Record<(typeof arms)[number], number> & { n: number; calls: number; base: Record<(typeof arms)[number], number> };
    const rows: Row[] = bands.slice(0, -1).map(() => ({ n: 0, calls: 0, carry: 0, trim10: 0, trim30: 0, compact: 0, seed: 0, base: { carry: 0, trim10: 0, trim30: 0, compact: 0, seed: 0 } }));
    let compactBuild = 0;
    let compactBuilds = 0;
    for (const { file } of sessionFiles(2_000_000).slice(0, 400)) {
        const lines = loadSession(file);
        const humans = humanIndexes(lines);
        // Running char tallies, so every boundary costs one pass: full content, trimmed content, and the newest results.
        let full = 0;
        let trimmed = 0;
        const results: number[] = [];
        let overhead: number | undefined;
        const tallies = new Map<number, { full: number; trimmed: number; last10: number; last30: number }>();
        for (const [index, line] of lines.entries()) {
            const entry = line.entry;
            if (humans.includes(index)) {
                const sum = (k: number): number => results.slice(-k).reduce((a, b) => a + b, 0);
                tallies.set(index, { full, trimmed, last10: sum(10), last30: sum(30) });
            }
            overhead ??= contextOf(entry) === undefined ? undefined : Math.min(contextOf(entry)!, 30_000);
            if (entry?.isSidechain === true || (entry?.type !== "user" && entry?.type !== "assistant") || entry.message?.content === undefined) {
                continue;
            }
            const content = entry.message.content;
            for (const block of typeof content === "string" ? [{ type: "text", text: content }] : content) {
                const size = JSON.stringify(block).length;
                if (block.type === "thinking" || block.type === "redacted_thinking") {
                    continue;
                }
                full += size;
                if (block.type === "tool_result") {
                    results.push(size);
                    trimmed += 160;
                } else if (block.type === "tool_use") {
                    trimmed += Math.min(size, 1_400);
                } else {
                    trimmed += size;
                }
            }
        }
        for (const start of humans) {
            const tally = tallies.get(start);
            const context0 = contextBefore(lines, start);
            const band = bands.findIndex((lo, b) => context0 >= lo && context0 < bands[b + 1]!);
            if (tally === undefined || band < 0 || band >= rows.length || tally.full === 0 || overhead === undefined || compacted(lines, start)) {
                continue;
            }
            const end = humans.find((index) => index > start) ?? lines.length;
            const calls: { context: number; written: number; output: number }[] = [];
            const seen = new Set<string>();
            for (let index = start; index < end; index += 1) {
                const entry = lines[index]?.entry;
                const context = contextOf(entry);
                if (context === undefined || seen.has(entry?.message?.id ?? "")) {
                    continue;
                }
                seen.add(entry?.message?.id ?? "");
                calls.push({ context, written: entry?.message?.usage?.cache_creation_input_tokens ?? 0, output: entry?.message?.usage?.output_tokens ?? 0 });
            }
            if (calls.length === 0) {
                continue;
            }
            // Tokens per char of this session's own content, measured at the boundary.
            const perChar = Math.max(0, context0 - overhead) / tally.full;
            const recent = Math.min(context0, overhead + 6_000 + 8_000);
            const base = {
                carry: context0,
                trim10: Math.min(context0, overhead + (tally.trimmed + tally.last10 - 10 * 160) * perChar),
                trim30: Math.min(context0, overhead + (tally.trimmed + tally.last30 - 30 * 160) * perChar),
                // Measured in tier 1: a Haiku summary runs ~3-6k tokens; the last two exchanges verbatim add ~8k.
                compact: recent,
                // withRuntimeHistory's 32k chars + the 6k-char note.
                seed: Math.min(context0, overhead + 38_000 / 3.6),
            };
            const row = rows[band]!;
            row.n += 1;
            row.calls += calls.length;
            for (const arm of arms) {
                row[arm] += replay(calls, context0, base[arm]);
                row.base[arm] += base[arm];
            }
            // Haiku reads the transcript rendered with tool output capped (~1/3 of the context), writes ~5k.
            compactBuild += (context0 / 3) * PRICE[COMPACT_MODEL]!.in + 5_000 * PRICE[COMPACT_MODEL]!.out;
            compactBuilds += 1;
        }
    }
    const k = (n: number): string => `${Math.round(n / 1000)}k`;
    process.stdout.write(`tier 0 · next human turn after a cut, Opus 5.5 list prices, 1h cache writes · compact build ≈ $${(compactBuild / compactBuilds).toFixed(2)} per hand-off (Haiku 5.5)\n\n`);
    process.stdout.write(`band        n    calls/turn | base ctx: carry  trim10  trim30  compact  seed | $ next turn: carry  trim10  trim30  compact  seed\n`);
    const summary: unknown[] = [];
    for (const [index, row] of rows.entries()) {
        if (row.n === 0) {
            continue;
        }
        const avg = (v: number): number => v / row.n;
        process.stdout.write(
            `${k(bands[index]!)}-${k(bands[index + 1]!)}`.padEnd(12) +
                `${row.n}`.padEnd(5) +
                `${Math.round(row.calls / row.n)}`.padEnd(11) +
                `| ${arms.map((arm) => k(avg(row.base[arm])).padStart(arm.length + 1)).join(" ")} | ${arms.map((arm) => `$${avg(row[arm]).toFixed(2)}`.padStart(arm.length + 2)).join(" ")}\n`,
        );
        summary.push({ band: [bands[index], bands[index + 1]], n: row.n, callsPerTurn: row.calls / row.n, base: Object.fromEntries(arms.map((arm) => [arm, avg(row.base[arm])])), cost: Object.fromEntries(arms.map((arm) => [arm, avg(row[arm])])) });
    }
    // What a token of re-read costs when it lands early in a turn: written once, read by every later call.
    const reRead = WRITE_1H + READ * 50;
    process.stdout.write(`\nre-exploration: a token re-read at the start of a 50-call turn costs ≈ $${(reRead * 1e6).toFixed(0)}/M, so every $1 an arm saves buys ≈ ${k(1 / reRead)} tokens of re-reading before it stops being cheaper.\n`);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "tier0.json"), `${JSON.stringify({ rows: summary, compactBuild: compactBuild / compactBuilds }, undefined, 2)}\n`);
};

/* ---------- model calls ---------- */

interface Call {
    readonly text: string;
    readonly sessionId: string;
    readonly usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
    readonly usd: number;
    readonly error?: string;
}

const NO_TOOLS = "Tools are disabled for this benchmark reply. Write what you would do as text instead.";
const denyAll: HookCallback = async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: NO_TOOLS } });

const runQuery = async (
    configDir: string,
    cwd: string,
    model: string,
    prompt: string,
    options: { resume?: string; system?: string; maxTurns?: number; effort?: "low" | "medium" | "high" },
): Promise<Call> => {
    const parts: string[] = [];
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const seen = new Set<string>();
    let sessionId = options.resume ?? "";
    let error: string | undefined;
    const stream = query({
        prompt,
        options: {
            model,
            cwd,
            ...(options.resume === undefined ? {} : { resume: options.resume }),
            ...(options.system === undefined ? {} : { systemPrompt: options.system, tools: [] }),
            ...(options.effort === undefined ? {} : { effort: options.effort }),
            maxTurns: options.maxTurns ?? 4,
            settingSources: [],
            hooks: { PreToolUse: [{ hooks: [denyAll] }] },
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        },
    });
    for await (const message of stream as AsyncIterable<SDKMessage>) {
        if (message.type === "system" && message.subtype === "init") {
            sessionId = message.session_id;
        }
        if (message.type === "assistant") {
            const id = message.message.id;
            const u = message.message.usage;
            if (!seen.has(id) && u !== undefined) {
                seen.add(id);
                usage.input += u.input_tokens ?? 0;
                usage.cacheRead += u.cache_read_input_tokens ?? 0;
                usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
                usage.output += u.output_tokens ?? 0;
            }
            for (const block of message.message.content) {
                if (block.type === "text") {
                    parts.push(block.text);
                } else if (block.type === "tool_use") {
                    parts.push(`[would call ${block.name} ${JSON.stringify(block.input).slice(0, 400)}]`);
                }
            }
        }
        if (message.type === "result" && message.subtype !== "success" && message.subtype !== "error_max_turns") {
            error = message.subtype;
        }
    }
    const price = PRICE[model]!;
    const usd = usage.input * price.in + usage.cacheRead * price.read + usage.cacheWrite * price.write + usage.output * price.out;
    return { text: parts.join("\n").trim(), sessionId, usage, usd, ...(error === undefined ? {} : { error }) };
};

const SEALED = "Answer with exactly what the prompt asks for and nothing else.";

const jsonFrom = <T>(text: string): T => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    return JSON.parse(text.slice(start, end + 1)) as T;
};

// The CLI finds a resumable session under projects/<cwd with every non-alphanumeric turned into "-">.
const placeSession = (configDir: string, cwd: string, sessionId: string, text: string): void => {
    const dir = join(configDir, "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), text);
};

/* ---------- tier 1 ---------- */

interface Probe {
    readonly q: string;
    readonly answer: string;
    readonly recoverable: boolean;
}

const PROBE_AUTHOR = (before: string, after: string): string => `You are building a test of how well a hand-off preserves what a coding session knew. Below is the transcript of a real Claude Code session up to a cut point (BEFORE), then what the same session actually did next with its full memory (AFTER).

Write 10 short questions a continuing agent must answer correctly to do the AFTER part as well as the original did. Draw them from what AFTER relied on, or from what BEFORE established that AFTER would get wrong if it were forgotten: the user's explicit requests, constraints and preferences; decisions and their reasons; approaches tried and rejected; facts learned (root causes, error messages, numbers, names, paths); the state of the work (done, not done, verified); and the immediate next step. No trivia, and nothing whose answer appears only in AFTER: the continuing agent sees BEFORE only.

For each: the question, a short specific reference answer taken from BEFORE, and "recoverable": true if a capable agent could re-derive the answer by reading the repository, git or running commands, false if it lives only in the conversation (what someone said, decided or tried, or why).

Answer with JSON only: {"questions":[{"q":"...","answer":"...","recoverable":false}]}

<BEFORE>
${before}
</BEFORE>

<AFTER>
${after}
</AFTER>`;

const NEXT_NOTE = "\n\n(Benchmark note: tools are disabled for this one reply. Answer as you would act: what you understand the situation to be, then the concrete next steps you would take, in order: commands, files, edits.)";

const PROBE_ASK = (probes: readonly Probe[]): string =>
    `Benchmark check, not part of the task. Answer each question from what you know of this work right now, one or two lines each, numbered. Tools are off. If you do not know, write "don't know": a wrong guess scores worse than "don't know".\n\n${probes.map((probe, index) => `${index + 1}. ${probe.q}`).join("\n")}`;

const JUDGE = (after: string, probes: readonly Probe[], labelled: readonly { label: string; next: string; answers: string }[]): string => `You are grading hand-off methods for a coding session that hit a usage limit. Each continuing agent (labelled ${labelled.map((arm) => arm.label).join(", ")}) received a different hand-off of the same session, then (1) replied to the next message with what it would do, tools disabled, and (2) answered probe questions.

Reference for (1): what the original session, with its full memory, actually did next (AFTER). Reference for (2): the reference answers.

Grade each probe answer: "correct" (matches the reference in substance), "partial" (right direction, missing a key specific), "dontknow" (says it does not know, or that it would check), "wrong" (contradicts the reference without inventing), "invented" (confidently states specifics that are false: made-up paths, decisions, results).
Grade each next move 1-5 against AFTER (5 = the same plan, as specific; 3 = right goal but vague, or would spend noticeable effort re-discovering; 1 = wrong direction), and flag any of: "contradicts_user" (goes against what the user asked or decided), "redoes_done" (plans to redo finished work), "wrong_state" (wrong about what exists, was done, or passed), "misses_constraint" (ignores a stated constraint), "re_explores" (re-reads or re-derives what the session already knew: a cost, not an error).
Labels are shuffled; do not guess which method is which.

JSON only: {"probes":{"A":["correct","partial",...]},"next":{"A":{"score":4,"flags":[],"why":"one line"}}}

<AFTER>
${after}
</AFTER>

<REFERENCE_ANSWERS>
${probes.map((probe, index) => `${index + 1}. Q: ${probe.q}\n   A: ${probe.answer}`).join("\n")}
</REFERENCE_ANSWERS>

${labelled.map((arm) => `<AGENT ${arm.label}>\n<NEXT_MOVE>\n${arm.next}\n</NEXT_MOVE>\n<PROBE_ANSWERS>\n${arm.answers}\n</PROBE_ANSWERS>\n</AGENT ${arm.label}>`).join("\n\n")}`;

const ARMS = ["carry", "trim10", "seed", "compact"] as const;
type Arm = (typeof ARMS)[number];

const readJson = <T>(path: string): T | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined);
const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);

const renderOptions = { reader: { resultCap: 1_500, inputCap: 800 }, compactor: { resultCap: 2_000, inputCap: 1_000 }, recent: { resultCap: 2_000, inputCap: 1_000 } };

interface Built {
    readonly kind: "session" | "prompt";
    readonly text: string;
    readonly chars: number;
    readonly note?: string;
}

// `chain` is what the session knew at the cut (chainBefore), so every builder cuts at its end.
const buildArm = async (arm: Arm, cut: Cut, chain: readonly SessionLine[], sessionId: string, compactor: () => Promise<Call>): Promise<Built> => {
    const prompt = `${cut.next}${NEXT_NOTE}`;
    const end = chain.length;
    switch (arm) {
        case "carry": {
            const text = carrySession(chain, end, sessionId);
            return { kind: "session", text, chars: contentChars(chain) };
        }
        case "trim10": {
            const { text, stats } = trimSession(chain, end, 10, sessionId);
            return { kind: "session", text, chars: contentChars(loadedFrom(text)), note: `${stats.cleared} results cleared, ${stats.droppedLines} lines dropped` };
        }
        case "seed": {
            const text = seedPrompt(chain, end, prompt);
            return { kind: "prompt", text, chars: text.length };
        }
        case "compact": {
            const summary = await compactor();
            const text = compactSeed(summary.text, lastExchanges(chain, end, 2, renderOptions.recent), prompt);
            return { kind: "prompt", text, chars: text.length, note: `summary ${summary.text.length} chars, $${summary.usd.toFixed(3)}` };
        }
    }
};

const loadedFrom = (text: string): SessionLine[] =>
    text
        .split("\n")
        .filter((raw) => raw !== "")
        .map((raw) => ({ raw, entry: JSON.parse(raw) }));

const run = async (): Promise<void> => {
    const options = flags();
    const dry = options.get("dry") === "true";
    const cuts = loadCuts().filter((cut) => options.get("cuts")?.split(",").includes(cut.id) ?? true);
    const arms = (options.get("arms")?.split(",") ?? [...ARMS]) as Arm[];
    if (!dry && process.env["CLAUDE_CODE_OAUTH_TOKEN"] === undefined && process.env["ANTHROPIC_API_KEY"] === undefined) {
        process.stderr.write("handoff-bench run needs CLAUDE_CODE_OAUTH_TOKEN (or --dry).\n");
        process.exit(1);
    }
    const configDir = await mkdtemp(join(tmpdir(), "handoff-bench-claude-"));
    const cwd = await mkdtemp(join(tmpdir(), "handoff-bench-cwd-"));
    let spent = 0;
    try {
        for (const cut of cuts) {
            const dir = join(OUT, cut.id);
            mkdirSync(dir, { recursive: true });
            const lines = loadSession(cut.file);
            const chain = chainBefore(lines, cut.line);
            const before = renderTranscript(chain, renderOptions.reader);
            const after = renderTranscript(lines.slice(cut.line, cut.futureEnd), renderOptions.reader).slice(0, 60_000);
            process.stdout.write(`\n${cut.id} · ${cut.kind} · ${Math.round(cut.context / 1000)}k ctx · ${cut.model} · chain ${chain.length} of ${cut.line} lines\n  next: ${cut.next.slice(0, 160).replaceAll("\n", " ")}\n`);
            const compactor = async (): Promise<Call> => {
                const cached = readJson<Call>(join(dir, "compact-summary.json"));
                if (cached !== undefined) {
                    return cached;
                }
                const rendering = renderTranscript(chain, renderOptions.compactor);
                if (dry) {
                    return { text: `(dry: Haiku would read ${Math.round(rendering.length / 3.6 / 1000)}k tokens)`, sessionId: "", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usd: 0 };
                }
                const call = await runQuery(configDir, cwd, COMPACT_MODEL, compactPrompt(rendering), { system: SEALED, maxTurns: 1 });
                spent += call.usd;
                writeJson(join(dir, "compact-summary.json"), call);
                return call;
            };
            // Probes first: written from BEFORE and AFTER by a model none of the arms are.
            let probes = readJson<{ questions: Probe[] }>(join(dir, "probes.json"))?.questions;
            if (probes === undefined && !dry) {
                const call = await runQuery(configDir, cwd, JUDGE_MODEL, PROBE_AUTHOR(before, after), { system: SEALED, maxTurns: 1, effort: "high" });
                spent += call.usd;
                probes = jsonFrom<{ questions: Probe[] }>(call.text).questions;
                writeJson(join(dir, "probes.json"), { questions: probes, usd: call.usd, usage: call.usage });
                process.stdout.write(`  probes: ${probes.length} (${probes.filter((probe) => !probe.recoverable).length} conversation-only) · $${call.usd.toFixed(2)}\n`);
            }
            await Promise.all(
                arms.map(async (arm) => {
                    const path = join(dir, `${arm}.json`);
                    if (existsSync(path)) {
                        return;
                    }
                    const sessionId = randomUUID();
                    const built = await buildArm(arm, cut, chain, sessionId, compactor);
                    process.stdout.write(`  ${arm.padEnd(8)} ${built.kind} ${Math.round(built.chars / 1000)}k chars${built.note === undefined ? "" : ` · ${built.note}`}\n`);
                    if (dry || probes === undefined) {
                        return;
                    }
                    let next: Call;
                    if (built.kind === "session") {
                        placeSession(configDir, cwd, sessionId, built.text);
                        next = await runQuery(configDir, cwd, ARM_MODEL, `${cut.next}${NEXT_NOTE}`, { resume: sessionId, effort: "medium" });
                    } else {
                        next = await runQuery(configDir, cwd, ARM_MODEL, built.text, { effort: "medium" });
                    }
                    const answers = await runQuery(configDir, cwd, ARM_MODEL, PROBE_ASK(probes), { resume: next.sessionId, maxTurns: 1, effort: "medium" });
                    spent += next.usd + answers.usd;
                    writeJson(path, { arm, built: { kind: built.kind, chars: built.chars, note: built.note }, next, answers });
                    process.stdout.write(`  ${arm.padEnd(8)} done · next ${Math.round((next.usage.cacheRead + next.usage.cacheWrite + next.usage.input) / 1000)}k in · $${(next.usd + answers.usd).toFixed(2)}${next.error === undefined ? "" : ` · ${next.error}`}\n`);
                }),
            );
            const judgePath = join(dir, "judge.json");
            if (!dry && probes !== undefined && !existsSync(judgePath)) {
                const results = arms.map((arm) => ({ arm, result: readJson<{ next: Call; answers: Call }>(join(dir, `${arm}.json`)) })).filter((entry) => entry.result !== undefined);
                const shuffled = results.toSorted(() => Math.random() - 0.5).map((entry, index) => ({ ...entry, label: String.fromCharCode(65 + index) }));
                const call = await runQuery(
                    configDir,
                    cwd,
                    JUDGE_MODEL,
                    JUDGE(
                        after.slice(0, 30_000),
                        probes,
                        shuffled.map((entry) => ({ label: entry.label, next: entry.result!.next.text, answers: entry.result!.answers.text })),
                    ),
                    { system: SEALED, maxTurns: 1, effort: "high" },
                );
                spent += call.usd;
                writeJson(judgePath, { labels: Object.fromEntries(shuffled.map((entry) => [entry.label, entry.arm])), verdict: jsonFrom(call.text), usd: call.usd });
                process.stdout.write(`  judged · $${call.usd.toFixed(2)}\n`);
            }
        }
    } finally {
        await rm(configDir, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
    }
    process.stdout.write(`\nspent ≈ $${spent.toFixed(2)} at API list prices this run\n`);
};

/* ---------- report ---------- */

const report = (): void => {
    const cuts = loadCuts();
    const totals = new Map<string, { probes: number; correct: number; partial: number; dontknow: number; wrong: number; invented: number; convOnly: number; convCorrect: number; next: number[]; flags: Record<string, number>; usd: number; inTokens: number }>();
    for (const cut of cuts) {
        const dir = join(OUT, cut.id);
        const judge = readJson<{ labels: Record<string, string>; verdict: { probes: Record<string, string[]>; next: Record<string, { score: number; flags: string[]; why: string }> } }>(join(dir, "judge.json"));
        const probes = readJson<{ questions: Probe[] }>(join(dir, "probes.json"))?.questions;
        if (judge === undefined || probes === undefined) {
            continue;
        }
        process.stdout.write(`\n${cut.id} (${cut.kind}, ${Math.round(cut.context / 1000)}k)\n`);
        for (const [label, arm] of Object.entries(judge.labels)) {
            const grades = judge.verdict.probes[label] ?? [];
            const next = judge.verdict.next[label];
            const result = readJson<{ next: Call; answers: Call }>(join(dir, `${arm}.json`));
            const total = totals.get(arm) ?? { probes: 0, correct: 0, partial: 0, dontknow: 0, wrong: 0, invented: 0, convOnly: 0, convCorrect: 0, next: [], flags: {}, usd: 0, inTokens: 0 };
            for (const [index, grade] of grades.entries()) {
                total.probes += 1;
                total[grade as "correct"] = (total[grade as "correct"] ?? 0) + 1;
                if (probes[index]?.recoverable === false) {
                    total.convOnly += 1;
                    total.convCorrect += grade === "correct" ? 1 : grade === "partial" ? 0.5 : 0;
                }
            }
            if (next !== undefined) {
                total.next.push(next.score);
                for (const flag of next.flags) {
                    total.flags[flag] = (total.flags[flag] ?? 0) + 1;
                }
            }
            total.usd += (result?.next.usd ?? 0) + (result?.answers.usd ?? 0);
            total.inTokens += (result?.next.usage.cacheRead ?? 0) + (result?.next.usage.cacheWrite ?? 0) + (result?.next.usage.input ?? 0);
            totals.set(arm, total);
            const score = grades.reduce((sum, grade) => sum + (grade === "correct" ? 1 : grade === "partial" ? 0.5 : 0), 0);
            process.stdout.write(`  ${arm.padEnd(8)} probes ${score}/${grades.length} · next ${next?.score ?? "?"}${next?.flags.length ? ` [${next.flags.join(", ")}]` : ""} · ${next?.why ?? ""}\n`);
        }
    }
    process.stdout.write(`\narm       probe%  conv-only%  dontknow  wrong  invented  next(avg)  flags\n`);
    const summary: Record<string, unknown> = {};
    for (const [arm, total] of totals) {
        const pct = (n: number, d: number): string => `${d === 0 ? 0 : Math.round((100 * n) / d)}%`;
        const nextAvg = total.next.reduce((a, b) => a + b, 0) / Math.max(1, total.next.length);
        process.stdout.write(
            `${arm.padEnd(9)} ${pct(total.correct + total.partial / 2, total.probes).padEnd(7)} ${pct(total.convCorrect, total.convOnly).padEnd(11)} ${String(total.dontknow ?? 0).padEnd(9)} ${String(total.wrong ?? 0).padEnd(6)} ${String(total.invented ?? 0).padEnd(9)} ${nextAvg.toFixed(2).padEnd(10)} ${JSON.stringify(total.flags)}\n`,
        );
        summary[arm] = { ...total, nextAvg };
    }
    writeJson(join(OUT, "report.json"), summary);
};

const command = process.argv[2];
if (command === "cuts") {
    mkdirSync(OUT, { recursive: true });
    const cuts = pickCuts();
    writeJson(cutsFile, cuts);
    for (const cut of cuts) {
        process.stdout.write(`${cut.id}  ${cut.kind.padEnd(8)} ${Math.round(cut.context / 1000)}k  ${cut.model}  future ${cut.futureEnd - cut.line} lines\n  next: ${cut.next.slice(0, 200).replaceAll("\n", " ")}\n`);
    }
} else if (command === "tier0") {
    tier0();
} else if (command === "run") {
    await run();
} else if (command === "report") {
    report();
} else {
    process.stderr.write("usage: handoff-bench cuts | tier0 | run [--dry] [--cuts a,b] [--arms carry,trim10,seed,compact] | report\n");
    process.exit(1);
}
