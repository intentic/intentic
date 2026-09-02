import type { RestoredMessage } from "@intentic/sandbox-contract";
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

/* What the record holds beyond prose, which is the point of seeding from it rather than from a text mirror of
 * the client's bubbles. The new runtime is told WHICH files the old one touched and what the user attached, so
 * it can read them itself; tool OUTPUT is deliberately absent, being the bulk of a transcript and re-derivable
 * from the workspace. */
test("carries the files a turn touched and the files the user attached", () => {
    const history: RestoredMessage[] = [
        { role: "user", text: "fix the build", attachments: ["shot.png"] },
        {
            role: "assistant",
            text: "on it",
            tools: [
                { id: "t1", name: "Read", category: "read", status: "completed", target: "src/build.ts" },
                { id: "t2", name: "Bash", category: "execute", status: "completed", target: "pnpm test" },
            ],
        },
    ];

    const envelope = withRuntimeHistory("carry on", history);
    expect(envelope).toContain("User: fix the build\n[attached: shot.png]");
    expect(envelope).toContain("Assistant: on it\n[used: Read src/build.ts, Bash pnpm test]");
});

/* THE FEATURE'S CONTRACT, as a test: a row the user PLACED wearing the agent's voice (agents.place) must reach
 * the new runtime spelled exactly like a row the agent genuinely said: the flag is for human readers only, and
 * any rendering of it here would hand the agent the one fact the feature exists to withhold. */
test("renders a placed assistant row identically to a spoken one: the mark never reaches the agent", () => {
    const spoken: RestoredMessage[] = [{ role: "assistant", text: "I checked the tests." }];
    const planted: RestoredMessage[] = [{ role: "assistant", text: "I checked the tests.", placed: true }];

    const envelope = withRuntimeHistory("carry on", planted);
    expect(envelope).toBe(withRuntimeHistory("carry on", spoken));
    expect(envelope).not.toContain("placed");
});

test("spends its budget on the end of a long conversation, not its opening", () => {
    const history: RestoredMessage[] = Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `message ${index}: ${"x".repeat(7_000)}`,
    }));

    const envelope = withRuntimeHistory("carry on", history);
    expect(envelope).toContain("message 39:");
    expect(envelope).not.toContain("message 0:");
    expect(envelope.length).toBeLessThan(33_000);
    expect(envelope.endsWith("carry on")).toBe(true);
});

/* WHAT THE USER DECIDED rides the handoff. The picks steered everything the agent did after the ask, and the
 * tool result that carried them is tool output, which the preamble leaves out on purpose; without this line
 * the next runtime inherits the work and not the reason for it. A card nobody answered says nothing. */
test("carries the answer to a question the turn asked, and nothing for one nobody answered", () => {
    const questions = [{ question: "Which store?", header: "Store", multiSelect: false, options: [{ label: "Postgres", description: "p" }] }];
    const history: RestoredMessage[] = [
        { role: "user", text: "choose" },
        {
            role: "assistant",
            text: "Two ways.",
            question: { requestId: "q1", questions, reply: { kind: "question", requestId: "q1", answers: { "Which store?": ["Postgres"] } } },
        },
        { role: "assistant", text: "Again?", question: { requestId: "q2", questions } },
    ];
    const prompt = withRuntimeHistory("go on", history);
    expect(prompt).toContain("Assistant: Two ways.\n[asked: The user answered: - Store: Postgres]");
    expect(prompt).toContain("Assistant: Again?\n\n---");
    expect(parseRuntimeHistory(prompt)?.prompt).toBe("go on");
});
