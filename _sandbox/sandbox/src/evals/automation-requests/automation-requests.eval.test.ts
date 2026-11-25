import type { StartedTestContainer } from "testcontainers";
import { daemonUrl, startSandboxContainer } from "../../harness/e2e-harness.js";
import { daemonClient, type DaemonClient, runTurn } from "./daemon-turns.testing.js";
import { grade, type Judge, judgePrompt, judgeSaidYes, report, type ScenarioTally, summarize, type Verdict } from "./grade.testing.js";
import { SCENARIOS, type Scenario } from "./scenarios.testing.js";

// How a real agent handles an owner's plain-English automation requests: create one (a schedule, a listener, a CI
// event), ask what they meant, or set nothing up. Each request is a real Claude turn in the real sandbox image (the
// shipped system prompt, skills and `automations` CLI), graded from the daemon's records (grade.testing.ts).
// A manual suite: it spends real model allowance, so only `suites --manual automation-requests` runs it
// (`pnpm eval:automations`), and it fails at once when its credential is missing rather than standing down.

const env = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
};

const number = (name: string, fallback: number): number => {
    const raw = env(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number, not ${raw ?? ""}`);
    }
    return value;
};

// The container's fallback credential (seams/sealed-env.ts): an OAuth token from `claude setup-token`, or an API key.
const credentialEnv = (): Record<string, string> => {
    const token = env("INTENTIC_EVAL_CLAUDE_TOKEN");
    if (token === undefined) {
        throw new Error(
            "the automation-request eval runs real Claude turns: set INTENTIC_EVAL_CLAUDE_TOKEN to a Claude OAuth token (sk-ant-oat…, from `claude setup-token`) or an Anthropic API key",
        );
    }
    return token.startsWith("sk-ant-oat") ? { CLAUDE_CODE_OAUTH_TOKEN: token } : { ANTHROPIC_API_KEY: token };
};

const only = env("INTENTIC_EVAL_ONLY")
    ?.split(",")
    .map((id) => id.trim());
const chosen = only === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => only.includes(scenario.id));
const unknown = (only ?? []).filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
const trials = Math.round(number("INTENTIC_EVAL_TRIALS", 1));
const concurrency = Math.round(number("INTENTIC_EVAL_CONCURRENCY", 3));
const minOverall = number("INTENTIC_EVAL_MIN_PASS_RATE", 0.8);
const model = env("INTENTIC_EVAL_MODEL");
const TURN_DEADLINE_MS = 10 * 60_000;
const BOOT_MS = 20 * 60_000;

// At most `limit` at once, in order.
const pool = async <T>(jobs: readonly (() => Promise<T>)[], limit: number): Promise<T[]> => {
    const results: T[] = [];
    const waiting = [...jobs.entries()];
    const worker = async (): Promise<void> => {
        for (let job = waiting.shift(); job !== undefined; job = waiting.shift()) {
            results[job[0]] = await job[1]();
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
    return results;
};

describe("automation requests, graded on a real agent", () => {
    let container: StartedTestContainer | undefined;
    let client: DaemonClient;

    beforeAll(async () => {
        if (unknown.length > 0) {
            throw new Error(`INTENTIC_EVAL_ONLY names no scenario ${unknown.join(", ")}`);
        }
        container = await startSandboxContainer(credentialEnv());
        client = daemonClient(daemonUrl(container));
    }, BOOT_MS);

    afterAll(async () => {
        await container?.stop().catch(() => undefined);
    }, 120_000);

    // A judge is a turn of its own on the same daemon, told to answer in one word, asked only when a reply might ask
    // in words and no question card says so.
    let judged = 0;
    const judge: Judge = async (request, reply) => {
        judged += 1;
        const turn = await runTurn(client, `eval-judge-${String(judged)}`, judgePrompt(request, reply), { deadlineMs: 5 * 60_000, model });
        return judgeSaidYes(turn.reply);
    };

    const attempt = async (scenario: Scenario, trial: number, offered: ReadonlySet<string>): Promise<Verdict> => {
        const missing = (scenario.sources ?? []).filter((provider) => !offered.has(provider));
        if (missing.length > 0) {
            // The world is wrong, not the agent: said as a failure so a run never reports a pass it did not measure.
            return { pass: false, reasons: [`the sandbox offers no ${missing.join(", ")} listener source`], judged: false };
        }
        const turn = await runTurn(client, `eval-${scenario.id}-${String(trial)}`, scenario.request, { deadlineMs: TURN_DEADLINE_MS, model });
        // A turn the agent never got to speak in (a refused credential, a spent allowance) measured nothing about it:
        // said as what happened, so a broken world does not read as a bad agent.
        if (turn.reply === "" && turn.tools.length === 0) {
            return { pass: false, reasons: [`the turn did not run (${turn.status}): ${turn.notices.join(" / ") || "no notice"}`], judged: false };
        }
        const verdict = await grade(scenario, turn, judge);
        return turn.timedOut ? { ...verdict, pass: false, reasons: ["the turn ran out of time", ...verdict.reasons] } : verdict;
    };

    test(
        "each scenario passes at its floor, and the run at the suite's",
        async () => {
            const catalog = await client.automations.catalog();
            const offered = new Set(catalog.sources.map((source) => source.provider));
            const jobs = chosen.flatMap((scenario) =>
                Array.from({ length: trials }, (_, trial) => async () => ({ scenario, verdict: await attempt(scenario, trial, offered) })),
            );
            const outcomes = await pool(jobs, concurrency);
            const rows: ScenarioTally[] = chosen.map((scenario) => {
                const mine = outcomes.filter((outcome) => outcome.scenario.id === scenario.id).map((outcome) => outcome.verdict);
                return {
                    id: scenario.id,
                    passed: mine.filter((verdict) => verdict.pass).length,
                    trials: mine.length,
                    minPassRate: scenario.minPassRate ?? 0.5,
                    reasons: mine.flatMap((verdict) => [...verdict.reasons, ...(verdict.judged ? ["(a model judged the reply)"] : [])]),
                };
            });
            const summary = summarize(rows, minOverall);
            process.stdout.write(
                `\nautomation requests (${String(trials)} trial${trials === 1 ? "" : "s"} each, sources offered: ${[...offered].join(", ")}):\n${report(summary)}\n`,
            );
            expect(summary.below).toEqual([]);
            expect(summary.overallBelow).toBe(false);
        },
        BOOT_MS + Math.ceil((chosen.length * trials) / concurrency) * TURN_DEADLINE_MS,
    );
});
