import type { TranscriptSession } from "@intentic/agent-context/claude-transcript";
import { digestOf, openingOf, renderDigest } from "./notes-evidence.js";

// The field-notes evidence counts sessions, not lines: a failure every session hits outranks one that failed ten times
// in one afternoon, which is the ranking the brief asks the writer for.

const failing = (id: string, command: string, text: string): TranscriptSession => ({
    sessionId: id,
    cwd: "/src/app",
    turns: [
        {
            index: 0,
            at: Date.UTC(2026, 8, 1),
            prompt: `fix ${id}\nmore detail`,
            calls: [{ id: `${id}-1`, name: "Bash", category: "execute", target: command, at: 1, subagent: false }],
            failures: [{ id: `${id}-1`, text }],
        },
    ],
});

test("failures are ranked by how many sessions hit them, with what they said", () => {
    const sessions = [
        failing("a", "pnpm test", "Exit code 1\nError: Cannot find module 'x'"),
        failing("b", "pnpm test", "Exit code 1\nError: Cannot find module 'x'"),
        failing("c", "cargo build", "Exit code 101\nerror[E0433]: failed to resolve"),
    ];
    const text = renderDigest(digestOf(sessions), "/src/app", "/src/app/.claude/intentic/field-notes.toon");
    expect(text).toContain("Corpus: 3 sessions of this project (2026-09-01 to 2026-09-01), 3 turns, 3 tool calls, 3 of them failed.");
    const pnpm = text.indexOf(`- \`pnpm test\`: 2 failures in 2 sessions — e.g. "Error: Cannot find module 'x'"`);
    const cargo = text.indexOf(`- \`cargo build\`: 1 failures in 1 sessions — e.g. "error[E0433]: failed to resolve"`);
    expect(pnpm).toBeGreaterThan(0);
    expect(cargo).toBeGreaterThan(pnpm);
    expect(text).toContain("- `pnpm test`: 2 runs in 2 sessions, 2 failed");
    expect(text).toContain("- fix a");
});

test("credentials in what a command printed never reach the digest", () => {
    const text = renderDigest(digestOf([failing("a", "curl api", "Exit code 22\nAPI_KEY=sk-live-4f8a9b2c7d6e5f4a3b2c1d0e")]), "/src/app", "/n");
    expect(text).not.toContain("sk-live-4f8a9b2c7d6e5f4a3b2c1d0e");
});

test("a session opened by a slash command is said as it was typed, not as the tags it was filed under", () => {
    expect(openingOf("<command-message>intentic:stats</command-message>\n<command-name>/intentic:stats</command-name>\n<command-args>all</command-args>")).toBe(
        "/intentic:stats all",
    );
    expect(openingOf("<command-name>/intentic:field-notes</command-name>")).toBe("/intentic:field-notes");
    expect(openingOf("fix the parser\nit drops the last token")).toBe("fix the parser");
});
