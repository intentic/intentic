import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { cleanExplanation, explainCommand } from "./command-explainer.js";

const ask = vi.fn<() => Promise<{ text: string }>>();
vi.mock("./quick-model.js", () => ({ askQuickModel: () => ask() }));

const services = {} as Services;
const signal = new AbortController().signal;

/* The sentence, unwrapped from the packaging a model reaches for even when told not to. Same instinct as
 * cleanSessionTitle: the sentence is right and only its wrapper is wrong, and refusing a good one over a pair
 * of backticks leaves the card with nothing where the reader was told to look. */
test("takes the sentence and nothing but the sentence", () => {
    const sentence = "Searches the workspace for files mentioning secrets.";
    expect(cleanExplanation(sentence)).toBe(sentence);
    expect(cleanExplanation(`\`\`\`\n${sentence}\n\`\`\``)).toBe(sentence);
    expect(cleanExplanation(`"${sentence}"`)).toBe(sentence);
    expect(cleanExplanation(`Explanation: ${sentence}`)).toBe(sentence);
    expect(cleanExplanation(`Summary: ${sentence}`)).toBe(sentence);
    // The first non-empty line is the sentence; a walkthrough the model added anyway has nowhere to go.
    expect(cleanExplanation(`${sentence}\n\nIt does this by first running cd, then…`)).toBe(sentence);
});

// A quoted path inside the sentence is part of it; only symmetric surrounding quotes are packaging.
test("keeps quotes that are part of the sentence", () => {
    expect(cleanExplanation(`Reads the "secrets" directory and prints what is in it.`)).toBe(
        `Reads the "secrets" directory and prints what is in it.`,
    );
});

test("an empty reply is nothing rather than an empty sentence", () => {
    expect(cleanExplanation("")).toBe("");
    expect(cleanExplanation("\n\n  \n")).toBe("");
});

/* THE THREE REPLIES THAT ARE NOT DESCRIPTIONS, each of which would otherwise be printed on a safety card in
 * the exact spot the reader was told to look for what they are approving.
 *
 * The first two are the quick model's own failures arriving as PROSE rather than as a thrown error, which is
 * how a provider whose allowance is spent or whose credential is dead answers. The third is a healthy model
 * that would not do the job and said so; that one is nobody's fault and still not an explanation. */
test("a failure sentence or a question back is not an explanation", async () => {
    for (const text of [
        "Failed to authenticate. API Error: 401 {\"type\":\"error\"}",
        "I need more context to describe this. What is the workspace?",
        "   ",
    ]) {
        ask.mockResolvedValueOnce({ text });
        expect(await explainCommand(services, "git push --force", "bash", signal)).toBeUndefined();
    }
});

test("an ordinary sentence comes back as the card's line", async () => {
    ask.mockResolvedValueOnce({ text: "Force-pushes the branch to origin, discarding whatever commits it has." });
    expect(await explainCommand(services, "git push --force origin main", "bash", signal)).toBe(
        "Force-pushes the branch to origin, discarding whatever commits it has.",
    );
});
