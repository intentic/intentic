import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { cleanExplanation, explainCommand } from "./command-explainer.js";

const ask = vi.fn<() => Promise<{ value: string }>>();
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

/* THE REPLIES THAT ARE NOT DESCRIPTIONS, each of which would otherwise be printed on a safety card in the exact
 * spot the reader was told to look for what they are approving: a provider's own failure arriving as prose, a
 * healthy model that would not do the job, a rung writing out the tool call it would have made.
 *
 * WHICH IS NO LONGER THIS FILE'S JUDGMENT. The ask carries it (quick-answer.ts, and its suite pins each of those
 * replies), so a chain that produced none of them produces a value, and a chain that produced only them throws.
 * What this pins is the half that matters at this call site: the throw is not swallowed here, because the gate
 * races the call and swallows every failure itself (command-gate.ts), leaving the card exactly as it was. */
test("a chain that wrote no usable sentence leaves the card to the gate", async () => {
    ask.mockRejectedValue(new Error("gpt-5.6: answered the asker instead of writing a one-sentence explanation"));
    await expect(explainCommand(services, "git push --force", "bash", signal)).rejects.toThrow(/answered the asker/);
});

test("an ordinary sentence comes back as the card's line", async () => {
    ask.mockResolvedValueOnce({ value: "Force-pushes the branch to origin, discarding whatever commits it has." });
    expect(await explainCommand(services, "git push --force origin main", "bash", signal)).toBe(
        "Force-pushes the branch to origin, discarding whatever commits it has.",
    );
});
