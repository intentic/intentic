#!/usr/bin/env node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { type AgentRequest, runAgent } from "../src/agent/agent.js";
import { sumUsage, type UsageFrame } from "../src/agent/turn-usage.js";
import { type BenchTask, taskFor } from "./agent-tasks.js";

/* AGENT-ARCHITECTURE A/B BENCHMARK, does delegating the tedious work beat one agent doing all of it?
 *
 *   pnpm --filter @intentic/sandbox bench:agents                        # both tasks, both arms, 1 run each
 *   pnpm --filter @intentic/sandbox bench:agents --tasks sweep --runs 5
 *   pnpm --filter @intentic/sandbox bench:agents --tasks arc:135a2760 --model opus
 *   pnpm --filter @intentic/sandbox bench:agents --tasks defects --model opus --timeout 1200 --transcripts ./bench-runs
 *
 * Both arms run runAgent directly, no daemon, no tunnel, no browser, on the same task, prompt, workspace,
 * model, effort and posture. The ONLY difference is whether the agent may spawn subagents. Each run gets a
 * fresh throwaway workspace and grading is mechanical.
 *
 * Needs a Claude credential (CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY); it asks for one if neither is set
 * and checks it before spending anything. It spends real tokens, start with `--runs 1 --tasks sweep`.
 *
 * READ THE NUMBERS HONESTLY.
 *
 * One run per arm catches a big effect and nowhere near a small one, the per-run lines are printed for that
 * reason, and `--transcripts` keeps the frames so a surprising result can be read back rather than re-run.
 *
 * `fed` is every token sent to a model summed over every request, which is what you are billed for; it climbs
 * with the NUMBER of requests as much as with context size, since an agent that reads files one at a time
 * re-sends everything read so far on each later call. `peak` is how full the window actually got. They can
 * differ by 50x, and only one of them is the thing people mean by "context". A caveat on `fed`: a subagent
 * runs in its own session, so what IT spends may not appear in the parent's accounting, cost, which comes
 * from the SDK's own total, is the figure to trust when the two arms disagree.
 */

// How the mainstream harnesses steer delegation: the model keeps every tool and decides for itself when to
// hand tedious work to a subagent, so its own reasoning context stays on the problem.
const SUBAGENT_NUDGE = [
    "Delegate the tedious parts. When a step is mechanical — sweeping the tree, reading many files, gathering facts — spawn a subagent with the Agent tool to do it and report back, so your own context stays on the problem instead of filling with raw output.",
    "Do the reasoning yourself: decide what is needed and what the results mean. A subagent gathers; it does not decide.",
].join("\n\n");

// Every name the subagent-spawning built-in goes by.
const SUBAGENT_TOOLS = ["Agent", "Task"];

interface Arm {
    readonly name: "solo" | "subagent";
    // One line for the run header, so a table read months later says what was actually compared.
    readonly what: string;
    readonly run: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
}

const ARMS: readonly Arm[] = [
    // Withheld so this really is ONE agent: the preset offers subagents, and a solo run that quietly spawned
    // them would be the `subagent` arm under a different name, the comparison that must not blur. BOTH names
    // are listed because the SDK calls this tool `Agent` (its input type is AgentInput/subagent_type) while
    // older harnesses called it `Task`; disallowing only `Task` silently blocked nothing at all.
    { name: "solo", what: "one agent, every tool, no delegation", run: (request) => runAgent({ ...request, disallowedTools: SUBAGENT_TOOLS }) },
    {
        name: "subagent",
        what: "one agent that spawns subagents for the tedious work (the mainstream approach)",
        run: (request) => runAgent({ ...request, systemAppend: SUBAGENT_NUDGE }),
    },
];

interface RunResult {
    readonly task: string;
    readonly arm: string;
    readonly run: number;
    readonly solved: boolean;
    readonly score: number;
    readonly detail: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly costUsd: number;
    readonly toolCalls: number;
    // Auto-compactions: the harness ran out of context window and threw history away. The clearest signal
    // that an arm is drowning in its own tool output rather than reasoning about the problem.
    readonly compactions: number;
    // High-water context fill seen mid-turn, the one accounting figure that survives a timeout.
    readonly contextPeak: number;
    // Which tools were reached for, by name. Both arms hold the same surface bar delegation, so a difference
    // here, `Grep` where the other shells out to `Bash`, or how often `Agent` appears, is a difference in
    // tool SELECTION rather than in the task, and it is invisible in a bare call count.
    readonly toolsByName: Record<string, number>;
    readonly errors: number;
    // The FIRST error the run reported, verbatim. Counting errors and dropping their text turns every failure
    // into "something went wrong", which is exactly how an expired token reads as a broken benchmark.
    readonly error: string | undefined;
    readonly timedOut: boolean;
    readonly wallMs: number;
}

interface Options {
    readonly tasks: string[];
    readonly arms: string[];
    readonly runs: number;
    readonly model: string | undefined;
    readonly effort: string | undefined;
    readonly timeoutMs: number;
    readonly json: string | undefined;
    readonly transcripts: string | undefined;
    readonly keep: boolean;
}

const parseArgs = (argv: readonly string[]): Options => {
    const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (!arg.startsWith("--")) {
            continue;
        }
        const [name, inline] = arg.slice(2).split("=", 2);
        flags.set(name!, inline ?? (argv[index + 1]?.startsWith("--") === false ? argv[++index]! : "true"));
    }
    const list = (name: string, fallback: string[]): string[] => {
        const raw = flags.get(name);
        return raw === undefined ? fallback : raw.split(",").filter((entry) => entry !== "");
    };
    return {
        tasks: list("tasks", ["sweep", "arc"]),
        arms: list("arms", ["solo", "subagent"]),
        runs: Number(flags.get("runs") ?? 1),
        model: flags.get("model"),
        effort: flags.get("effort"),
        timeoutMs: Number(flags.get("timeout") ?? 900) * 1000,
        json: flags.get("json"),
        transcripts: flags.get("transcripts"),
        keep: flags.get("keep") === "true",
    };
};

// One run: fresh workspace, one turn, mechanical grade. Never throws for an agent-side failure, a crashed or
// timed-out run is a data point (scored 0), not a reason to abandon the sweep.
const runOnce = async (task: BenchTask, arm: Arm, index: number, options: Options): Promise<RunResult> => {
    const dir = await mkdtemp(join(tmpdir(), `agent-bench-${task.id.replace(/[^a-z0-9]+/gi, "-")}-`));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const started = Date.now();
    let usage: UsageFrame | undefined;
    let toolCalls = 0;
    let errors = 0;
    let compactions = 0;
    let contextPeak = 0;
    let error: string | undefined;
    const toolsByName: Record<string, number> = {};
    const frames: AgentEvent[] = [];
    try {
        const prepared = await task.prepare(dir);
        const request: AgentRequest = {
            prompt: prepared.prompt,
            cwd: dir,
            signal: controller.signal,
            // Nothing here can answer a card, so say so: an agent that reaches for a plan approval or a
            // question would otherwise park until the timeout and score as a failure that never happened. A
            // run measured before this flag existed did exactly that. EnterPlanMode, work, ExitPlanMode,
            // then 600s of waiting for a user who was never there.
            permissionMode: "bypassPermissions",
            unattended: true,
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.effort !== undefined ? { effort: options.effort } : {}),
        };
        for await (const event of arm.run(request)) {
            if (options.transcripts !== undefined) {
                frames.push(event);
            }
            if (event.kind === "usage") {
                usage = sumUsage(usage, event);
            } else if (event.kind === "tool_call") {
                toolCalls += 1;
                toolsByName[event.name] = (toolsByName[event.name] ?? 0) + 1;
            } else if (event.kind === "context_usage") {
                contextPeak = Math.max(contextPeak, event.tokens);
            } else if (event.kind === "compact") {
                compactions += 1;
            } else if (event.kind === "error") {
                errors += 1;
                error ??= controller.signal.aborted ? `bench timeout after ${options.timeoutMs / 1000}s (${event.message})` : event.message;
            }
        }
        const graded = await prepared.grade();
        // The whole event stream, so a surprising result can be read back instead of re-run: what the agent
        // asked for, what came back, and which tools it actually chose.
        if (options.transcripts !== undefined) {
            await mkdir(options.transcripts, { recursive: true });
            const name = `${task.id.replace(/[^a-z0-9]+/gi, "-")}-${arm.name}-${index}.jsonl`;
            await writeFile(join(options.transcripts, name), frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
        }
        return {
            task: task.id,
            arm: arm.name,
            run: index,
            solved: graded.solved,
            score: graded.score,
            detail: graded.detail,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
            costUsd: usage?.costUsd ?? 0,
            toolCalls,
            compactions,
            contextPeak,
            toolsByName,
            errors,
            error,
            timedOut: controller.signal.aborted,
            wallMs: Date.now() - started,
        };
    } finally {
        clearTimeout(timer);
        if (!options.keep) {
            await rm(dir, { recursive: true, force: true });
        }
    }
};

// Everything fed INTO the models across the WHOLE run: fresh input plus both cache buckets, summed over every
// request. This is what you are billed for, and it grows with the NUMBER of requests as much as with context
// size, an agent that reads 18 files one at a time re-sends everything it has read on each subsequent call,
// so `fed` climbs quadratically while the window itself is nowhere near full. `contextPeak` is the other
// half of the story: how full the window actually got.
const context = (result: RunResult): number => result.inputTokens + result.cacheReadTokens + result.cacheCreationTokens;

// Means over runs that actually finished. A timed-out run has no accounting at all, the SDK reports usage
// only when a turn completes, so folding its zeroes into a cost or token average understates precisely the
// arm that could not finish. Absent rather than zero is the honest reading.
const meanOfFinished = (runs: readonly RunResult[], of: (result: RunResult) => number): number | undefined => {
    const finished = runs.filter((result) => !result.timedOut);
    return finished.length === 0 ? undefined : mean(finished.map(of));
};

const orDash = (value: number | undefined, render: (value: number) => string): string => (value === undefined ? "—" : render(value));

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
const pad = (value: unknown, width: number): string => String(value).padEnd(width);
const short = (tokens: number): string => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens)));

const report = (results: readonly RunResult[]): void => {
    const groups = new Map<string, RunResult[]>();
    for (const result of results) {
        const key = `${result.task}\u0000${result.arm}`;
        groups.set(key, [...(groups.get(key) ?? []), result]);
    }
    process.stdout.write(
        `\n${pad("task", 18)}${pad("arm", 10)}${pad("solved", 9)}${pad("score", 8)}${pad("fed", 9)}${pad("peak", 8)}${pad("out", 8)}${pad("$", 9)}${pad("tools", 7)}${pad("cmpct", 7)}${pad("t/o", 5)}${pad("wall", 8)}\n`,
    );
    process.stdout.write(`${"-".repeat(106)}\n`);
    for (const [, runs] of groups) {
        const { task, arm } = runs[0]!;
        const solved = runs.filter((result) => result.solved).length;
        process.stdout.write(
            [
                pad(task, 18),
                pad(arm, 10),
                pad(`${solved}/${runs.length}`, 9),
                pad(mean(runs.map((result) => result.score)).toFixed(2), 8),
                pad(orDash(meanOfFinished(runs, context), short), 9),
                pad(
                    orDash(
                        meanOfFinished(runs, (result) => result.outputTokens),
                        short,
                    ),
                    8,
                ),
                pad(
                    orDash(
                        meanOfFinished(runs, (result) => result.costUsd),
                        (value) => value.toFixed(3),
                    ),
                    9,
                ),
                pad(mean(runs.map((result) => result.toolCalls)).toFixed(1), 7),
                pad(mean(runs.map((result) => result.compactions)).toFixed(1), 7),
                pad(`${runs.filter((result) => result.timedOut).length}/${runs.length}`, 5),
                pad(`${(mean(runs.map((result) => result.wallMs)) / 1000).toFixed(0)}s`, 8),
            ].join(""),
        );
        process.stdout.write("\n");
    }
    // Which tools each arm reached for. Both arms hold the SAME tool surface, so a difference here is a
    // difference in tool SELECTION, the claim that a small model picks tools better when picking tools is the
    // only thing it has been asked to do, which a bare call count cannot show.
    process.stdout.write("\ntool mix (calls per run, by arm):\n");
    for (const [, runs] of groups) {
        const { task, arm } = runs[0]!;
        const names = new Map<string, number>();
        for (const result of runs) {
            for (const [name, count] of Object.entries(result.toolsByName)) {
                names.set(name, (names.get(name) ?? 0) + count);
            }
        }
        const mix = [...names.entries()]
            .toSorted((a, b) => b[1] - a[1])
            .map(([name, count]) => `${name} ${(count / runs.length).toFixed(1)}`)
            .join(", ");
        process.stdout.write(`  ${pad(task, 18)}${pad(arm, 10)}${mix === "" ? "(no tool calls)" : mix}\n`);
    }

    // Per-task deltas, but only where both arms actually ran, the whole point is the comparison.
    const tasks = [...new Set(results.map((result) => result.task))];
    for (const task of tasks) {
        const solo = results.filter((result) => result.task === task && result.arm === "solo");
        if (solo.length === 0) {
            continue;
        }
        for (const arm of ["subagent"]) {
            const runs = results.filter((result) => result.task === task && result.arm === arm);
            if (runs.length === 0) {
                continue;
            }
            const delta = (of: (result: RunResult) => number): string => {
                const before = meanOfFinished(solo, of);
                const after = meanOfFinished(runs, of);
                if (before === undefined || after === undefined || before === 0) {
                    return "n/a";
                }
                const percent = Math.round(((after - before) / before) * 100);
                return `${percent > 0 ? "+" : ""}${percent}%`;
            };
            const solveDelta = runs.filter((r) => r.solved).length / runs.length - solo.filter((r) => r.solved).length / solo.length;
            // Cost first, because it is the only figure that already accounts for the two halves running on
            // different models at different prices. Context is reported separately from output for the same
            // reason a bare "tokens" number misleads: under prompt caching almost all input arrives as cache
            // reads, so input-plus-output can fall while the context actually fed to the models grows.
            process.stdout.write(
                `\n${task}: ${arm} vs solo — cost ${delta((result) => result.costUsd)} · fed ${delta(context)} · peak ${delta((result) => result.contextPeak)} · output ${delta((result) => result.outputTokens)} · solved ${solveDelta > 0 ? "+" : ""}${Math.round(solveDelta * 100)}pp\n`,
            );
        }
    }
};

// Check the credential BEFORE spending anything. Without this, a token that is expired, mistyped or mangled by
// the terminal produces a whole sweep of runs that fail with `authentication_failed` and a table of zeroes,
// which reads as "the benchmark is broken" rather than "your token is bad". One free call to the account's own
// model list settles it. A network failure is NOT fatal: being briefly unable to reach Anthropic is no reason
// to refuse to run, so it warns and continues.
const CREDENTIAL_CHECK_URL = "https://api.anthropic.com/v1/models?limit=1";

const verifyCredential = async (): Promise<void> => {
    const oauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    const headers: Record<string, string> = {
        "anthropic-version": "2023-06-01",
        // The OAuth token authenticates as the subscription (the same pair claude-models.ts uses); an API key
        // goes on its own header.
        ...(oauth !== undefined ? { authorization: `Bearer ${oauth}`, "anthropic-beta": "oauth-2025-04-20" } : { "x-api-key": apiKey ?? "" }),
    };
    const response = await fetch(CREDENTIAL_CHECK_URL, { headers }).catch((error: unknown) => {
        process.stdout.write(`\u26a0 couldn't reach Anthropic to check the credential (${String(error)}) - running anyway.\n`);
        return undefined;
    });
    if (response === undefined) {
        return;
    }
    if (response.status === 401 || response.status === 403) {
        process.stderr.write(
            `\nAnthropic rejected that ${oauth !== undefined ? "OAuth token" : "API key"} (${response.status}). Nothing was run.\n` +
                "A token pasted into a terminal can pick up stray characters - re-copy it and try again.\n" +
                "`claude setup-token` mints a fresh one.\n",
        );
        process.exit(1);
    }
    if (!response.ok) {
        process.stdout.write(`\u26a0 credential check answered ${response.status} ${response.statusText} - running anyway.\n`);
        return;
    }
    process.stdout.write("credential accepted by Anthropic.\n");
};

// Ask for the credential rather than refusing to start. It is read from the terminal with echo off and lives
// only in this process's env for the length of the run, never written to disk, never printed, never passed on
// a command line where it would land in shell history.
const ENTER = new Set(["\r", "\n"]);
const CTRL_C = "\u0003";
const BACKSPACE = new Set(["\u007F", "\b"]);

// Terminals in bracketed-paste mode wrap a paste in ESC[200~ ... ESC[201~, and raw mode hands those markers
// over as ordinary input - so a pasted token arrives with escape sequences glued to both ends and fails
// authentication for a reason nothing on screen explains. Strip them, and any other control bytes.
const BRACKETED_PASTE_START = "\u001B[200~";
const BRACKETED_PASTE_END = "\u001B[201~";
const DELETE = "\u007F";

const cleanToken = (raw: string): string =>
    [...raw.replaceAll(BRACKETED_PASTE_START, "").replaceAll(BRACKETED_PASTE_END, "")]
        // Everything below the space is a control byte, and none of them belong in a credential.
        .filter((char) => char >= " " && char !== DELETE)
        .join("")
        .trim();

const promptForToken = async (): Promise<string> => {
    const input = process.stdin;
    process.stdout.write("Claude Code OAuth token (input hidden, Enter to submit): ");
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    const token = await new Promise<string>((resolve) => {
        let typed = "";
        const onKey = (chunk: Buffer): void => {
            const key = chunk.toString("utf8");
            if (ENTER.has(key)) {
                input.off("data", onKey);
                resolve(typed);
                return;
            }
            if (key === CTRL_C) {
                // Raw mode swallows the terminal's own interrupt, so honour it here or Ctrl-C does nothing.
                input.setRawMode(wasRaw);
                process.stdout.write("\n");
                process.exit(130);
            }
            // Backspace, so a mistyped paste is recoverable even though nothing is echoed.
            typed = BACKSPACE.has(key) ? typed.slice(0, -1) : typed + key;
        };
        input.on("data", onKey);
    });
    input.setRawMode(wasRaw);
    input.pause();
    process.stdout.write("\n");
    return cleanToken(token);
};

const main = async (): Promise<void> => {
    const options = parseArgs(process.argv.slice(2));
    if (process.env["CLAUDE_CODE_OAUTH_TOKEN"] === undefined && process.env["ANTHROPIC_API_KEY"] === undefined) {
        if (process.stdin.isTTY !== true) {
            process.stderr.write("imp-bench needs CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (no TTY to ask on).\n");
            process.exit(1);
        }
        const token = await promptForToken();
        if (token === "") {
            process.stderr.write("No token given — nothing to run.\n");
            process.exit(1);
        }
        process.env["CLAUDE_CODE_OAUTH_TOKEN"] = token;
    }
    await verifyCredential();
    // Keep the developer's own ~/.claude (CLAUDE.md, skills, settings, hooks) out of the measurement: the SDK
    // loads the user tier by default, and it differs per machine, which is exactly what a benchmark cannot have.
    //
    // This is ALSO why a credential is required rather than optional. An isolated config dir has no stored
    // login, so the CLI can only authenticate with the token in the environment, whereas pointed at the real
    // ~/.claude it authenticates as the machine's own session and IGNORES the token you were asked for, which
    // would quietly benchmark someone else's account and someone else's CLAUDE.md.
    const configDir = await mkdtemp(join(tmpdir(), "imp-bench-claude-"));
    await mkdir(configDir, { recursive: true });
    process.env["CLAUDE_CONFIG_DIR"] = configDir;

    const tasks = options.tasks.map(taskFor);
    const arms = ARMS.filter((arm) => options.arms.includes(arm.name));
    const results: RunResult[] = [];
    const worstCaseMinutes = Math.round((tasks.length * arms.length * options.runs * options.timeoutMs) / 60_000);
    process.stdout.write(
        `imp-bench · ${tasks.length} task(s) × ${arms.length} arm(s) × ${options.runs} run(s) · model=${options.model ?? "account default"}\n` +
            `timeout ${options.timeoutMs / 1000}s per run — up to ${worstCaseMinutes} min if everything runs long. Ctrl-C is safe; nothing is written outside temp dirs.\n`,
    );
    for (const task of tasks) {
        process.stdout.write(`\n${task.id}: ${task.title}\n`);
        for (const arm of arms) {
            process.stdout.write(`  ${arm.name}: ${arm.what}\n`);
            for (let index = 1; index <= options.runs; index += 1) {
                process.stdout.write(`  ${pad(`${arm.name} #${index}`, 12)}running…`);
                const result = await runOnce(task, arm, index, options);
                results.push(result);
                process.stdout.write(
                    `\r  ${pad(`${arm.name} #${index}`, 12)}${result.solved ? "PASS" : "FAIL"} · ${result.detail} · ${result.timedOut ? `TIMED OUT, context reached ${short(result.contextPeak)}` : `${short(context(result))} ctx / ${short(result.outputTokens)} out`} · ${result.toolCalls} tools${result.compactions > 0 ? ` · ${result.compactions} compactions` : ""}\n`,
                );
                if (result.error !== undefined) {
                    process.stdout.write(`             ↳ ${result.errors > 1 ? `${result.errors} errors, first: ` : ""}${result.error}\n`);
                }
            }
        }
    }
    report(results);
    if (options.json !== undefined) {
        await writeFile(options.json, `${JSON.stringify(results, undefined, 2)}\n`);
        process.stdout.write(`\nwrote ${options.json}\n`);
    }
    await rm(configDir, { recursive: true, force: true });
};

await main();
