import { unspokenPromptRow } from "./agent-words.js";
import { needRowText, needWakeOf, needWakePrompt, needWakeRow, type NeedWakeFields, type NeedWakeOutcome } from "./need-wake.js";

const fields = (over: Partial<NeedWakeFields> = {}): NeedWakeFields => ({
    outcome: "met",
    id: "need-7k2q",
    title: "Connect GitHub",
    why: "to open the pull request for the fix",
    result: 'GitHub is connected as "github".',
    use: ["In this turn, prefix a command with GH_TOKEN={{secret:github/token}}."],
    ...over,
});

const OUTCOMES: NeedWakeOutcome[] = ["met", "declined"];

describe("need wake", () => {
    // The composer and the parser are the same piece of knowledge; this holds them together when either is reworded.
    it.each(OUTCOMES)("round-trips a %s wake back to its fields", (outcome) => {
        const prompt = needWakePrompt(fields({ outcome }));
        expect(needWakeOf(prompt)).toEqual({ outcome, title: "Connect GitHub", id: "need-7k2q", sent: prompt });
    });

    it("tells a met need to carry on and a declined one not to wait", () => {
        expect(needWakePrompt(fields()).split("\n").at(-1)).toBe("Continue the task that needed it.");
        expect(needWakePrompt(fields({ outcome: "declined", use: [] }))).not.toContain("Continue the task");
    });

    it("leaves the agent's reason out when it gave none, rather than printing an empty label", () => {
        expect(needWakePrompt(fields({ why: undefined }))).not.toContain("You asked because:");
        expect(needWakePrompt(fields())).toContain("You asked because: to open the pull request for the fix");
    });

    it("is not a wake once its labelled lines are gone", () => {
        const prompt = needWakePrompt(fields());
        expect(needWakeOf(prompt.replace("Need id: need-7k2q\n", ""))).toBeUndefined();
        expect(needWakeOf(prompt.replace("Need: Connect GitHub\n", ""))).toBeUndefined();
        expect(needWakeOf("please connect github")).toBeUndefined();
    });

    it("becomes a notice row that says what happened, and every transcript reader finds it", () => {
        const prompt = needWakePrompt(fields());
        const row = needWakeRow(prompt);
        expect(row).toEqual({
            role: "notice",
            text: "Connect GitHub: done, and the agent carries on.",
            needWake: { outcome: "met", title: "Connect GitHub", id: "need-7k2q", sent: prompt },
        });
        expect(unspokenPromptRow(prompt)).toEqual(row);
        expect(needWakeRow(needWakePrompt(fields({ outcome: "declined" })))?.text).toBe("Connect GitHub: declined, and the agent was told.");
    });

    it("words a raised need's row for a reader that draws no card", () => {
        expect(needRowText({ title: "The OPENAI_API_KEY secret" })).toBe("Needs a person: The OPENAI_API_KEY secret");
    });
});
