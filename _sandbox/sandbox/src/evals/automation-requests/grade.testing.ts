import type { AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import type { Scenario } from "./scenarios.testing.js";

// One scenario's turn, graded from what the daemon recorded: the cards the conversation raised, where its turn ended,
// the tools it called and its last words. Deterministic wherever the records can say; a model is asked only whether a
// reply asks the owner something, and only when no question card says so already.

export interface ToolCall {
    readonly name: string;
    readonly category: string;
    readonly target?: string | undefined;
}

export interface Observation {
    readonly needs: readonly Need[];
    readonly status: AgentStatus;
    readonly tools: readonly ToolCall[];
    // The agent's last words in the turn.
    readonly reply: string;
}

export interface Verdict {
    readonly pass: boolean;
    // Why it failed, or what was notable on a pass; one line each.
    readonly reasons: readonly string[];
    // Whether a model was asked, which a report should say.
    readonly judged: boolean;
}

// Asks a model whether a reply asks the owner to clarify before acting; true when it does.
export type Judge = (request: string, reply: string) => Promise<boolean>;

const proposalsIn = (needs: readonly Need[]): readonly Automation[] =>
    needs.flatMap((need) => (need.subject.kind === "automation" ? [need.subject.automation] : []));

const QUESTION_TOOLS = /^(AskUserQuestion|mcp__ui__ask(_page)?|request_user_input)$/u;
const AUTOMATIONS_FILE = /automations\.json/u;
const SHELL_WRITE = /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b)/u;

// A turn that parked on a question card, or called a question tool, asked; the reply's words are only the fallback.
const askedByCard = (observation: Observation): boolean =>
    observation.status === "awaiting" || observation.tools.some((tool) => QUESTION_TOOLS.test(tool.name));

// The skill forbids writing automations.json by hand: approval is the owner's, and a hand-written entry skips the card.
const wroteConfigByHand = (tools: readonly ToolCall[]): readonly string[] =>
    tools
        .filter((tool) => AUTOMATIONS_FILE.test(tool.target ?? ""))
        .filter((tool) => ["edit", "delete", "move"].includes(tool.category) || (tool.category === "run" && SHELL_WRITE.test(tool.target ?? "")))
        .map((tool) => `wrote automations.json itself (${tool.name}: ${tool.target ?? ""})`);

// The proposal that fails fewest checks, with what it failed.
const closest = (scenario: Scenario, proposals: readonly Automation[]): readonly string[] => {
    if (scenario.expect.act !== "propose") {
        return [];
    }
    const checks = scenario.expect.checks;
    const failures = proposals.map((automation) => checks.flatMap((check) => check(automation) ?? []));
    return failures.toSorted((a, b) => a.length - b.length)[0] ?? ["nothing was proposed"];
};

export const grade = async (scenario: Scenario, observation: Observation, judge?: Judge): Promise<Verdict> => {
    const proposals = proposalsIn(observation.needs);
    const byHand = wroteConfigByHand(observation.tools);
    const verdict = (pass: boolean, reasons: readonly string[], judged = false): Verdict => ({
        pass: pass && byHand.length === 0,
        reasons: [...byHand, ...reasons],
        judged,
    });
    switch (scenario.expect.act) {
        case "propose": {
            const missed = closest(scenario, proposals);
            const asked = proposals.length === 0 && askedByCard(observation) ? ["asked a question instead"] : [];
            return verdict(missed.length === 0, [...missed, ...asked]);
        }
        case "ask": {
            if (proposals.length > 0) {
                return verdict(false, [`proposed ${proposals.map((automation) => automation.id).join(", ")} on an ambiguous request`]);
            }
            if (askedByCard(observation)) {
                return verdict(true, []);
            }
            if (!observation.reply.includes("?")) {
                return verdict(false, ["neither asked a question nor proposed anything"]);
            }
            if (judge === undefined) {
                return verdict(false, ["the reply may ask in words, and no judge was given to read it"]);
            }
            const asks = await judge(scenario.request, observation.reply);
            return verdict(asks, asks ? [] : ["the judge read the reply as not asking the owner to clarify"], true);
        }
        case "none":
            return verdict(
                proposals.length === 0,
                proposals.length === 0 ? [] : [`proposed ${proposals.map((automation) => automation.id).join(", ")} unasked`],
            );
    }
};

// The question a judge turn is given: one word back, so reading its answer needs no model.
export const judgePrompt = (request: string, reply: string): string =>
    [
        "You are grading another assistant's reply. Do not use any tools, do not set anything up, and answer with one word.",
        "The owner's request was ambiguous. Does the reply ask the owner a clarifying question (what, when, where or which) before setting anything up?",
        "Answer YES or NO.",
        "",
        "<request>",
        request,
        "</request>",
        "<reply>",
        reply,
        "</reply>",
    ].join("\n");

export const judgeSaidYes = (answer: string): boolean => /^\W*yes\b/iu.test(answer.trim());

export interface ScenarioTally {
    readonly id: string;
    readonly passed: number;
    readonly trials: number;
    readonly minPassRate: number;
    readonly reasons: readonly string[];
}

export interface Summary {
    readonly rows: readonly ScenarioTally[];
    readonly passRate: number;
    // The scenarios under their own floor, and whether the whole run is under the suite's.
    readonly below: readonly string[];
    readonly overallBelow: boolean;
}

export const summarize = (rows: readonly ScenarioTally[], minOverall: number): Summary => {
    const trials = rows.reduce((sum, row) => sum + row.trials, 0);
    const passed = rows.reduce((sum, row) => sum + row.passed, 0);
    const passRate = trials === 0 ? 0 : passed / trials;
    return {
        rows,
        passRate,
        below: rows.filter((row) => row.passed / row.trials < row.minPassRate).map((row) => row.id),
        overallBelow: passRate < minOverall,
    };
};

const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;

// The report a person reads after a run: one line per scenario, the reasons under each failure.
export const report = (summary: Summary): string =>
    [
        ...summary.rows.flatMap((row) => [
            `${row.passed === row.trials ? "pass" : row.passed / row.trials >= row.minPassRate ? "flaky" : "FAIL"}  ${row.id}  ${String(row.passed)}/${String(row.trials)}`,
            ...[...new Set(row.reasons)].map((reason) => `        ${reason}`),
        ]),
        `overall ${percent(summary.passRate)}${summary.below.length === 0 ? "" : `; under their floor: ${summary.below.join(", ")}`}`,
    ].join("\n");
