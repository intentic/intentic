import type { Rule } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { turnEndingNote } from "./turn-ending-note.js";

const command = (over: Partial<Rule> = {}): Rule => ({
    id: "pre-land",
    label: "Verify before you finish",
    moment: "turn.ending",
    action: { kind: "command", command: "pnpm verify", timeoutMs: 900_000 },
    enabled: true,
    ...over,
});

test("says nothing when no automatic command runs at turn end", () => {
    const builtin: Rule = {
        id: "verify-ui-edits",
        label: "Review UI edits",
        moment: "turn.ending",
        action: { kind: "builtin", name: "verify-ui-edits" },
        enabled: true,
    };

    expect(turnEndingNote([])).toBeUndefined();
    expect(turnEndingNote([command({ enabled: false })])).toBeUndefined();
    expect(turnEndingNote([command({ moment: "push.starting" })])).toBeUndefined();
    expect(turnEndingNote([command({ action: { kind: "command", command: " ", timeoutMs: 900_000 } })])).toBeUndefined();
    expect(turnEndingNote([builtin])).toBeUndefined();
});

test("names the automatic command without inviting narration", () => {
    expect(turnEndingNote([command()])?.text).toBe(
        [
            "## Automatic end-of-turn checks",
            "",
            "These run automatically when you finish:",
            "",
            "- **Verify before you finish:** `pnpm verify`",
            "",
            "Do not run or announce them yourself. Use targeted checks only when you need an earlier result.",
        ].join("\n"),
    );
});

test("includes a path condition", () => {
    expect(turnEndingNote([command({ when: { paths: ["intentic/**", "docs/**"] } })])?.text).toContain(
        "(after edits to `intentic/**` or `docs/**`)",
    );
});
