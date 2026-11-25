import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { asZone } from "@intentic/sandbox-contract/time/zone";
import { grade, type Observation, report, summarize } from "./grade.testing.js";
import { SCENARIOS, type Scenario } from "./scenarios.testing.js";

// The grader on records shaped as the daemon writes them, so a passing eval means what the scenario says it means.

const scenario = (id: string): Scenario => {
    const found = SCENARIOS.find((entry) => entry.id === id);
    if (found === undefined) {
        throw new Error(`no scenario ${id}`);
    }
    return found;
};

const card = (fields: Partial<Automation> & Pick<Automation, "trigger">): Need => {
    const automation: Automation = { id: "proposed", enabled: true, prompt: "do it", ...fields };
    return {
        id: "need-1",
        conversationId: "eval-1",
        subject: { kind: "automation", automation },
        title: "Switch on an automation",
        status: "open",
        createdAt: 1,
        updatedAt: 1,
    };
};

const observed = (overrides: Partial<Observation> = {}): Observation => ({ needs: [], status: "idle", tools: [], reply: "Done.", ...overrides });

test("a proposal matching every check passes; the closest miss is named when none does", async () => {
    const digest = scenario("schedule-weekday-digest");
    const right = card({
        trigger: { kind: "schedule", cron: "7 9 * * 1-5", tz: asZone("Europe/Warsaw") },
        guard: "true",
        prompt: "Summarise yesterday's commits.",
    });
    expect(await grade(digest, observed({ needs: [right] }))).toEqual({ pass: true, reasons: [], judged: false });

    const wrongZone = card({ trigger: { kind: "schedule", cron: "7 9 * * 1-5" }, prompt: "Summarise commits." });
    const verdict = await grade(digest, observed({ needs: [wrongZone] }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toEqual(["zone is unset, wanted Europe/Warsaw"]);
});

test("a listener is checked for its provider, its narrowing and who may set it off", async () => {
    const mail = scenario("listener-mail-from");
    const narrowed = card({
        trigger: { kind: "listener", provider: "google", eventType: "mail" },
        senders: { rules: [{ ids: ["billing@acme.example"] }], others: "ignore" },
    });
    expect((await grade(mail, observed({ needs: [narrowed] }))).pass).toBe(true);

    const everyone = card({ trigger: { kind: "listener", provider: "google", eventType: "mail" } });
    expect((await grade(mail, observed({ needs: [everyone] }))).reasons[0]).toContain("does not admit only billing@acme.example");
});

test("nothing proposed on a create request fails, and says when the agent asked instead", async () => {
    const verdict = await grade(scenario("listener-slack-mentions"), observed({ status: "awaiting" }));
    expect(verdict).toEqual({ pass: false, reasons: ["nothing was proposed", "asked a question instead"], judged: false });
});

test("an ambiguous request passes on a question card, fails on a proposal, and asks the judge only about words", async () => {
    const ambiguous = scenario("ask-remind-it");
    expect((await grade(ambiguous, observed({ tools: [{ name: "AskUserQuestion", category: "think" }] }))).pass).toBe(true);
    expect((await grade(ambiguous, observed({ needs: [card({ trigger: { kind: "schedule", cron: "0 9 * * *" } })] }))).pass).toBe(false);

    const judge = jest.fn(async () => true);
    expect(await grade(ambiguous, observed({ reply: "Sure. What should I remind you about?" }), judge)).toEqual({
        pass: true,
        reasons: [],
        judged: true,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect((await grade(ambiguous, observed({ reply: "I set nothing up." }), judge)).reasons).toEqual([
        "neither asked a question nor proposed anything",
    ]);
    expect(judge).toHaveBeenCalledTimes(1);
});

test("writing automations.json by hand fails any scenario, even one that asked for nothing", async () => {
    const tools = [{ name: "Bash", category: "run", target: "echo '[]' > .intentic/config/automations.json" }];
    const verdict = await grade(scenario("none-explain"), observed({ tools }));
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("wrote automations.json itself");
    expect(
        (
            await grade(
                scenario("none-list"),
                observed({ tools: [{ name: "Bash", category: "run", target: "cat .intentic/config/automations.json" }] }),
            )
        ).pass,
    ).toBe(true);
});

test("the summary holds each scenario to its floor and the run to the suite's", () => {
    const summary = summarize(
        [
            { id: "a", passed: 2, trials: 2, minPassRate: 0.5, reasons: [] },
            { id: "b", passed: 0, trials: 2, minPassRate: 0.5, reasons: ["nothing was proposed"] },
        ],
        0.8,
    );
    expect(summary.passRate).toBe(0.5);
    expect(summary.below).toEqual(["b"]);
    expect(summary.overallBelow).toBe(true);
    expect(report(summary)).toContain("FAIL  b  0/2\n        nothing was proposed");
});

test("every scenario id is unique and every family is covered", () => {
    expect(new Set(SCENARIOS.map((entry) => entry.id)).size).toBe(SCENARIOS.length);
    expect(new Set(SCENARIOS.map((entry) => entry.family))).toEqual(new Set(["schedule", "listener", "event", "ask", "none"]));
});
