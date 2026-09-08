import type { TranscriptRow } from "@intentic/sandbox-contract";
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

// Tool output is deliberately left out; only which files were touched and what was attached carries over.
test("carries the files a turn touched and the files the user attached", () => {
    const history: TranscriptRow[] = [
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

test("renders a placed assistant row identically to a spoken one: the mark never reaches the agent", () => {
    const spoken: TranscriptRow[] = [{ role: "assistant", text: "I checked the tests." }];
    const planted: TranscriptRow[] = [{ role: "assistant", text: "I checked the tests.", placed: true }];

    const envelope = withRuntimeHistory("carry on", planted);
    expect(envelope).toBe(withRuntimeHistory("carry on", spoken));
    expect(envelope).not.toContain("placed");
});

test("spends its budget on the end of a long conversation, not its opening", () => {
    const history: TranscriptRow[] = Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `message ${index}: ${"x".repeat(7_000)}`,
    }));

    const envelope = withRuntimeHistory("carry on", history);
    expect(envelope).toContain("message 39:");
    expect(envelope).not.toContain("message 0:");
    expect(envelope.length).toBeLessThan(33_000);
    expect(envelope.endsWith("carry on")).toBe(true);
});

test("carries the answer to a question the turn asked, and nothing for one nobody answered", () => {
    const questions = [{ question: "Which store?", header: "Store", multiSelect: false, options: [{ label: "Postgres", description: "p" }] }];
    const history: TranscriptRow[] = [
        { role: "user", text: "choose" },
        {
            role: "assistant",
            text: "Two ways.",
            question: { requestId: "q1", questions, status: "answered", answers: { "Which store?": ["Postgres"] } },
        },
        { role: "assistant", text: "Again?", question: { requestId: "q2", questions, status: "cancelled" } },
    ];
    const prompt = withRuntimeHistory("go on", history);
    expect(prompt).toContain("Assistant: Two ways.\n[asked: The user answered: - Store: Postgres]");
    expect(prompt).toContain("Assistant: Again?\n\n---");
    expect(parseRuntimeHistory(prompt)?.prompt).toBe("go on");
});

test("keeps the newest two exchanges whole and clips older assistant messages to their opening", () => {
    const long = (label: string): string => `${label} ${"x".repeat(3_000)}`;
    const history: TranscriptRow[] = [
        { role: "user", text: long("ask one") },
        { role: "assistant", text: long("answer one") },
        { role: "user", text: "ask two" },
        { role: "assistant", text: long("answer two") },
        { role: "user", text: "ask three" },
        { role: "assistant", text: long("answer three") },
    ];

    const envelope = withRuntimeHistory("carry on", history);
    expect(envelope).toContain("answer one");
    expect(envelope).toMatch(/answer one x{1,}\n… \(truncated\)/u);
    expect(envelope).toContain(long("answer two"));
    expect(envelope).toContain(long("answer three"));
    expect(envelope).toContain(long("ask one"));
    expect(parseRuntimeHistory(envelope)?.prompt).toBe("carry on");
    expect(parseRuntimeHistory(envelope)?.history).toHaveLength(6);
});
