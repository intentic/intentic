import { expect, test } from "vitest";
import { INTENTIC_PROMPT } from "./intentic-prompt.js";
import { sdkSystemPrompt, turnPromptPlacement } from "./system-prompt.js";

/* Three properties worth pinning. That the two BUILT-IN bases behave identically apart from the base itself —
 * the split people expect here is three-ways and it is really two, so a regression would look reasonable. That
 * ORDER holds wherever appends happen, since every piece is stable across a session and the provider's prompt
 * cache only survives if they don't shuffle. And that "custom" means custom: the owner was told their text
 * becomes the whole system prompt, so anything smuggled in would be a lie told at the settings page. */

const NOTE = "## Delegating\nUse codex exec.";
const CUSTOM = "You are a release-notes writer. Never edit code.";
const BASE = { append: undefined, unattended: false, browserOutputDir: undefined } as const;

test("a built-in base appends the note then the terse steer, in that order", () => {
    const placement = turnPromptPlacement({ mode: "intentic", systemPrompt: "", note: NOTE, stableSystemPrompt: false, terseOutput: true });
    expect(placement.systemPrompt).toBeUndefined();
    expect(placement.systemAppend?.startsWith(NOTE)).toBe(true);
    expect(placement.systemAppend).toContain("be concise");
    // Nothing to move: the note reached the model through the system prompt.
    expect(placement.userNote).toBeUndefined();
    // Claude's preset is the same deal — the base differs, the composition around it does not.
    expect(turnPromptPlacement({ mode: "claude", systemPrompt: "", note: NOTE, stableSystemPrompt: false, terseOutput: true })).toEqual(placement);
});

test("stableSystemPrompt moves the note to the user message instead of the append", () => {
    const placement = turnPromptPlacement({ mode: "intentic", systemPrompt: "", note: NOTE, stableSystemPrompt: true, terseOutput: true });
    expect(placement.userNote).toBe(NOTE);
    expect(placement.systemAppend).not.toContain(NOTE);
    // The steer still rides: it is a fixed suffix, which is exactly what keeps the prefix byte-stable.
    expect(placement.systemAppend).toContain("be concise");
});

test("nothing to append is undefined, not an empty string", () => {
    // The runner spreads the result into the request; "" would hang a trailing separator off the base prompt.
    expect(turnPromptPlacement({ mode: "intentic", systemPrompt: "", stableSystemPrompt: false, terseOutput: false }).systemAppend).toBeUndefined();
});

test("custom replaces everything — nothing is appended to it", () => {
    const placement = turnPromptPlacement({ mode: "custom", systemPrompt: CUSTOM, note: NOTE, stableSystemPrompt: false, terseOutput: true });
    expect(placement.systemPrompt).toBe(CUSTOM);
    // The terse steer is dropped with the rest; its toggle is inert under a custom prompt, and the settings page
    // says so rather than leaving the switch looking live.
    expect(placement.systemAppend).toBeUndefined();
    // The delegation note is the one survivor, and only via the door it already had: the user-message preamble
    // stableSystemPrompt uses. Losing it would silently un-teach the agent that Codex is reachable.
    expect(placement.userNote).toBe(NOTE);
});

test("intentic ships its own prompt as the base, with the harness guidance after it", () => {
    const prompt = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, append: "extra" });
    // A string, because Intentic's prompt is not the CLI's preset — the SDK has to be told to drop that.
    expect(typeof prompt).toBe("string");
    const text = prompt as string;
    expect(text.startsWith(INTENTIC_PROMPT)).toBe(true);
    // The guidance rides the DEFAULT setting. Without it the shipped product's question cards, checklist panel
    // and browser tools go dark for everyone who never opened this setting — which is almost everyone.
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("TaskCreate");
    expect(text).toContain("mcp__web__browser_take_screenshot");
    expect(text.endsWith("extra")).toBe(true);
});

test("claude keeps the CLI's preset and hands the same guidance to its append", () => {
    const preset = sdkSystemPrompt({
        ...BASE,
        mode: "claude",
        custom: undefined,
        append: "extra",
        browserOutputDir: "/work/.intentic/browser/output",
    });
    expect(preset).toMatchObject({ type: "preset", preset: "claude_code" });
    const { append } = preset as { append: string };
    expect(append).toContain("AskUserQuestion");
    expect(append).toContain("EnterPlanMode");
    expect(append).toContain("TaskCreate");
    // The browser guidance names the directory the redirect hook actually enforces, so the agent is told a fact
    // rather than a convention — a turn whose screenshots land elsewhere costs it a failed Read and a `find /`.
    expect(append).toContain("/work/.intentic/browser/output");
    expect(append.endsWith("extra")).toBe(true);
});

test("custom reaches the SDK as the bare text, with no guidance at all", () => {
    const prompt = sdkSystemPrompt({ ...BASE, mode: "custom", custom: CUSTOM, append: "extra" });
    expect(prompt).toBe(CUSTOM);
});

test("an unattended turn loses the interactive guidance but keeps the checklist", () => {
    // Nobody can answer a question card or approve a plan, so describing them parks the turn on an answer that
    // never comes. The checklist is the opposite: it is the only window an operator has into a long wake.
    const text = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, unattended: true }) as string;
    expect(text).not.toContain("AskUserQuestion");
    expect(text).toContain("TaskCreate");
});
