import { expect, test } from "vitest";
import { parseRuntimeHistory, withRuntimeHistory } from "./runtime-history.js";

test("round-trips a cross-runtime transcript and its current prompt", () => {
    const history = [
        { role: "user" as const, text: "Investigate the blank chat." },
        { role: "assistant" as const, text: "I will trace hydration." },
        { role: "user" as const, text: "What model are you?" },
    ];

    expect(parseRuntimeHistory(withRuntimeHistory("Continue.", history))).toEqual({ history, prompt: "Continue." });
});

test("leaves an ordinary prompt alone", () => {
    expect(parseRuntimeHistory("Continue.")).toBeUndefined();
});
