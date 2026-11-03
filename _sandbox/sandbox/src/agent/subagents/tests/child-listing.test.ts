import { childAlternatives, mergeOutcome } from "../child-listing.js";
import type { SpawnableProvider } from "../spawn-catalog.js";

const provider = (id: string, models: readonly string[]): SpawnableProvider => ({
    id, label: id, spent: 0, models: models.map((model) => ({ id: model, label: model })),
});

test("suggests the child's own model and capability tier before cheaper catalog defaults", () => {
    expect(childAlternatives([
        provider("claude", ["claude-haiku-5-5", "claude-opus-5"]),
        provider("devin", ["swe-1-6-fast", "swe-1-6"]),
        provider("codex", ["gpt-6-luna", "gpt-6-sol"]),
    ], { prompt: "fix", provider: "claude", model: "claude-opus-5" })).toEqual([
        "claude/claude-opus-5", "devin/swe-1-6", "codex/gpt-6-sol",
    ]);
});

test("a refused merge reports each recorded cause and preserves the child's branch", () => {
    expect(mergeOutcome({ landed: false, changed: false, conflicts: [{ repo: "root", clean: 0, paths: [
        { path: "deleted.ts", reason: "diverged" }, { path: "edited.ts", reason: "workspace" }, { path: "logo.png", reason: "binary" },
    ] }] }, "your checkout", "sub-kid")).toEqual({
        ok: false,
        message: "Nothing was written: `deleted.ts`: conflicts with changes to the shared tree (including files modified on one side and deleted on the other); `edited.ts`: conflicts with uncommitted edits in the destination checkout; `logo.png`: cannot be merged as text (binary content). Its work stays on its branch `agent/sub-kid`.",
    });
});


test("merge refusal groups large path lists without losing a different cause", () => {
    expect(mergeOutcome({ landed: false, changed: false, conflicts: [{ repo: "root", clean: 0, paths: [
        ...Array.from({ length: 41 }, (_, i) => ({ path: `file-${i}.ts`, reason: "diverged" as const })),
        { path: "icon.png", reason: "binary" },
    ] }] }, "your checkout", "sub-kid")).toEqual({
        ok: false,
        message: "Nothing was written: `file-0.ts`, `file-1.ts`, `file-2.ts`, `file-3.ts`, `file-4.ts` and 36 more: conflicts with changes to the shared tree (including files modified on one side and deleted on the other); `icon.png`: cannot be merged as text (binary content). Its work stays on its branch `agent/sub-kid`.",
    });
});
