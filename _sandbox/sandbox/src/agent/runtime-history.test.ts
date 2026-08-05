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

/* What the record holds beyond prose — which is the point of seeding from it rather than from a text mirror of
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

test("spends its budget on the end of a long conversation, not its opening", () => {
    const history: RestoredMessage[] = Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `message ${index}: ${"x".repeat(7_000)}`,
    }));

    const envelope = withRuntimeHistory("carry on", history);
    expect(envelope).toContain("message 39:");
    expect(envelope).not.toContain("message 0:");
    expect(envelope.endsWith("carry on")).toBe(true);
});
