import { expect, test } from "vitest";
import { sdkSystemPrompt, turnPromptPlacement } from "./system-prompt.js";

/* Two properties worth pinning. On the PRESET path, order — every piece is stable across a session so the
 * provider's prompt cache survives it, and that only holds if the pieces don't shuffle. On the REPLACE path,
 * that "replace" means replace: the owner was told their text becomes the whole system prompt, so anything
 * this file still managed to smuggle in would be a lie told at the settings page. */

const NOTE = "## Delegating\nUse codex exec.";
const CUSTOM = "You are a release-notes writer. Never edit code.";

test("the preset path appends the note then the terse steer, in that order", () => {
    const placement = turnPromptPlacement({ systemPrompt: "", note: NOTE, stableSystemPrompt: false, terseOutput: true });
    expect(placement.systemPrompt).toBeUndefined();
    expect(placement.systemAppend?.startsWith(NOTE)).toBe(true);
    expect(placement.systemAppend).toContain("be concise");
    // Nothing to move: the note reached the model through the system prompt.
    expect(placement.userNote).toBeUndefined();
});

test("stableSystemPrompt moves the note to the user message instead of the append", () => {
    const placement = turnPromptPlacement({ systemPrompt: "", note: NOTE, stableSystemPrompt: true, terseOutput: true });
    expect(placement.userNote).toBe(NOTE);
    expect(placement.systemAppend).not.toContain(NOTE);
    // The steer still rides: it is a fixed suffix, which is exactly what keeps the prefix byte-stable.
    expect(placement.systemAppend).toContain("be concise");
});

test("nothing to append is undefined, not an empty string", () => {
    // The runner spreads the result into the request; "" would hang a trailing separator off the preset prompt.
    expect(turnPromptPlacement({ systemPrompt: "", stableSystemPrompt: false, terseOutput: false }).systemAppend).toBeUndefined();
});

test("a custom prompt replaces everything — nothing is appended to it", () => {
    const placement = turnPromptPlacement({ systemPrompt: CUSTOM, note: NOTE, stableSystemPrompt: false, terseOutput: true });
    expect(placement.systemPrompt).toBe(CUSTOM);
    // The terse steer is dropped with the rest; its toggle is inert while a custom prompt is set, and the
    // settings page says so rather than leaving the switch looking live.
    expect(placement.systemAppend).toBeUndefined();
    // The delegation note is the one survivor, and only via the door it already had: the user-message preamble
    // stableSystemPrompt uses. Losing it would silently un-teach the agent that Codex is reachable.
    expect(placement.userNote).toBe(NOTE);
});

test("the SDK gets a bare string for a replacement and the preset object otherwise", () => {
    // A string IS the SDK's replace: the claude_code preset never reaches the API.
    expect(sdkSystemPrompt({ custom: CUSTOM, append: undefined, unattended: false, browserOutputDir: undefined })).toBe(CUSTOM);

    const preset = sdkSystemPrompt({ custom: undefined, append: "extra", unattended: false, browserOutputDir: "/work/.intentic/browser/output" });
    expect(preset).toMatchObject({ type: "preset", preset: "claude_code" });
    const { append } = preset as { append: string };
    // The harness's own guidance — the question/plan cards, the checklist panel, the browser tools — plus
    // whatever the turn composed, last.
    expect(append).toContain("AskUserQuestion");
    expect(append).toContain("EnterPlanMode");
    expect(append).toContain("TaskCreate");
    expect(append).toContain("mcp__web__browser_take_screenshot");
    // The browser guidance names the directory the redirect hook actually enforces, so the agent is told a fact
    // rather than a convention — a turn whose screenshots land elsewhere costs it a failed Read and a `find /`.
    expect(append).toContain("/work/.intentic/browser/output");
    expect(append.endsWith("extra")).toBe(true);
});

test("an unattended turn loses the interactive guidance but keeps the checklist", () => {
    // Nobody can answer a question card or approve a plan, so describing them parks the turn on an answer that
    // never comes. The checklist is the opposite: it is the only window an operator has into a long wake.
    const { append } = sdkSystemPrompt({ custom: undefined, append: undefined, unattended: true, browserOutputDir: undefined }) as { append: string };
    expect(append).not.toContain("AskUserQuestion");
    expect(append).toContain("TaskCreate");
});
