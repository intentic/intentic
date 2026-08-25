import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { capabilitiesOf } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { INTENTIC_PROMPT } from "./intentic-prompt.js";
import { sdkSystemPrompt, turnPromptPlacement } from "./system-prompt.js";

/* Properties worth pinning. That the two BUILT-IN bases behave identically apart from the base itself: the
 * split people expect here is three-ways and it is really two, so a regression would look reasonable. That
 * ORDER holds wherever appends happen, since every piece is stable across a session and the provider's prompt
 * cache only survives if they don't shuffle. That "custom" means custom: the owner was told their text becomes
 * the whole system prompt, so anything smuggled in would be a lie told at the settings page. And that the three
 * answers on the instruction axis are three DIFFERENT placements: the axis exists because they were one, and a
 * regression there is silent by construction: nothing errors when a prompt is dropped.
 *
 * The capability records come from the contract rather than being written out here: which runtime replaces,
 * which adds and which takes nothing is that file's answer, and a second copy of it in a test is a copy that
 * keeps passing after the real one changes. */

const CUSTOM = "You are a release-notes writer. Never edit code.";
const PERSONA = "## Who this turn is acting as\n\nYou are acting as Studio.";
const BASE = { append: undefined, unattended: false, browserOutputDir: undefined } as const;

// The Claude Code loop, native Codex, OpenCode, and an ACP agent: one runtime per answer the axis has, plus
// the two that share "replace" and must not share everything else.
const CLAUDE = capabilitiesOf("claude", "native");
const CODEX = capabilitiesOf("codex", "native");
const GROK = capabilitiesOf("grok", "native");
const ACP = capabilitiesOf("some-installed-agent", "native");

test("a built-in base appends the terse steer", () => {
    const placement = turnPromptPlacement({
        capabilities: CLAUDE,
        mode: "intentic",
        systemPrompt: "",
        stableSystemPrompt: false,
        terseOutput: true,
    });
    expect(placement.systemPrompt).toBeUndefined();
    expect(placement.systemAppend).toContain("be concise");
    expect(placement.userNotes).toBeUndefined();
    // Claude's preset is the same deal: the base differs, the composition around it does not.
    expect(
        turnPromptPlacement({ capabilities: CLAUDE, mode: "claude", systemPrompt: "", stableSystemPrompt: false, terseOutput: true }),
    ).toEqual(placement);
});

test("nothing to append is undefined, not an empty string", () => {
    // The runner spreads the result into the request; "" would hang a trailing separator off the base prompt.
    expect(
        turnPromptPlacement({ capabilities: CLAUDE, mode: "intentic", systemPrompt: "", stableSystemPrompt: false, terseOutput: false }).systemAppend,
    ).toBeUndefined();
});

test("custom replaces everything: nothing is appended to it", () => {
    const placement = turnPromptPlacement({
        capabilities: CLAUDE,
        mode: "custom",
        systemPrompt: CUSTOM,
        stableSystemPrompt: false,
        terseOutput: true,
        personaNote: PERSONA,
    });
    expect(placement.systemPrompt).toBe(CUSTOM);
    // The terse steer is dropped with the rest; its toggle is inert under a custom prompt, and the settings page
    // says so rather than leaving the switch looking live. So is the persona note: the owner is doing their own
    // instructing, and the accounts a card withholds are withheld by absence rather than by that sentence.
    expect(placement.systemAppend).toBeUndefined();
    expect(placement.userNotes).toBeUndefined();
});

/* THE WORKSPACE CONVENTIONS TRAVEL, AND ONLY WHERE THEY ARE MISSING. The Claude Code loop composes them itself
 * around whichever base is in force (sdkSystemPrompt below), so repeating them in the append would say the same
 * paragraph twice on the one runtime that already has it, and every other runtime would hear it nowhere. */
test("a runtime outside the Claude Code loop is told the workspace conventions; that loop is not told twice", () => {
    const codex = turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false, terseOutput: false });
    expect(codex.systemAppend).toContain("`refs/`");
    expect(codex.systemAppend).toContain("`public/`");
    // How work leaves the session is the third of them: a runtime told nothing ends every turn offering to
    // commit, which is the one thing the land route exists to make unnecessary.
    expect(codex.systemAppend).toContain("commit only when asked");
    // And nothing that names a mechanism only the Claude Code loop wires: a Codex turn has no question card,
    // no ToolSearch, no browser server to reach for.
    expect(codex.systemAppend).not.toContain("AskUserQuestion");
    expect(codex.systemAppend).not.toContain("mcp__web__browser");

    const claude = turnPromptPlacement({ capabilities: CLAUDE, mode: "intentic", systemPrompt: "", stableSystemPrompt: false, terseOutput: false });
    expect(claude.systemAppend).toBeUndefined();
});

/* A runtime that can only ADD gets the owner's text as an addition rather than not at all. The promise the
 * settings page makes there is different, which is the point of the axis: refusing to send it would cost the
 * owner their prompt to preserve a promise this seam was never able to keep. */
test("a custom prompt is added where it cannot replace", () => {
    const placement = turnPromptPlacement({
        capabilities: GROK,
        mode: "custom",
        systemPrompt: CUSTOM,
        stableSystemPrompt: false,
        terseOutput: true,
    });
    expect(placement.systemPrompt).toBeUndefined();
    expect(placement.systemAppend).toBe(CUSTOM);
});

// "" is a legal custom prompt on a runtime that replaces: the owner emptied the box, and it means no base at
// all. On one that can only add there is simply nothing to add, and an empty system message is not the same
// request as no system message.
test("an emptied custom prompt replaces with nothing, and adds nothing", () => {
    expect(
        turnPromptPlacement({ capabilities: CLAUDE, mode: "custom", systemPrompt: "", stableSystemPrompt: false, terseOutput: false }).systemPrompt,
    ).toBe("");
    const grok = turnPromptPlacement({ capabilities: GROK, mode: "custom", systemPrompt: "", stableSystemPrompt: false, terseOutput: false });
    expect(grok.systemAppend).toBeUndefined();
    expect(grok.systemPrompt).toBeUndefined();
});

/* NO SYSTEM SEAM AT ALL. The owner's prompt is not applied: the composer discloses that rather than pasting it
 * onto the user's message as a different feature wearing the setting's name, but the persona note has to
 * arrive, because a session that does not know which accounts it may speak through is the mistake the whole
 * layer exists to stop, and here the user message is the only channel there is. */
test("a runtime with no system prompt still hears which persona it is wearing", () => {
    const placement = turnPromptPlacement({
        capabilities: ACP,
        mode: "custom",
        systemPrompt: CUSTOM,
        stableSystemPrompt: false,
        terseOutput: true,
        personaNote: PERSONA,
    });
    expect(placement.systemPrompt).toBeUndefined();
    expect(placement.systemAppend).toBeUndefined();
    expect(placement.userNotes).toEqual([PERSONA]);
    // Nothing at all to say is nothing at all sent: an empty list would put a bare separator in front of the
    // user's own words.
    expect(turnPromptPlacement({ capabilities: ACP, mode: "intentic", systemPrompt: "", stableSystemPrompt: false, terseOutput: true })).toEqual({});
});

test("intentic ships its own prompt as the base, with the harness guidance after it", () => {
    const prompt = sdkSystemPrompt({
        ...BASE,
        mode: "intentic",
        custom: undefined,
        append: "extra",
        browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
    });
    // A string, because Intentic's prompt is not the CLI's preset: the SDK has to be told to drop that.
    expect(typeof prompt).toBe("string");
    const text = prompt as string;
    expect(text.startsWith(INTENTIC_PROMPT)).toBe(true);
    // The guidance rides the DEFAULT setting. Without it the shipped product's question cards, checklist panel
    // and browser tools go dark for everyone who never opened this setting, which is almost everyone.
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("TaskCreate");
    expect(text).toContain("mcp__web__browser_take_screenshot");
    // The reference shelf is a workspace convention, not a model trait: every scanner excludes /work/refs, so
    // this line is the only thing that stops the agent treating a clone dropped there as project code.
    expect(text).toContain("`refs/`");
    expect(text.endsWith("extra")).toBe(true);
});

// The dir is turn-plan's browser-presence signal: omitted when no browser servers were wired (a core image
// without the browser pack), and then the prompt must not advertise tools the turn cannot load.
test("no browser servers this turn: the prompt advertises no browser", () => {
    const prompt = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, append: undefined });
    expect(prompt as string).not.toContain("mcp__web__browser");
});

test("claude keeps the CLI's preset and hands the same guidance to its append", () => {
    const preset = sdkSystemPrompt({
        ...BASE,
        mode: "claude",
        custom: undefined,
        append: "extra",
        browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
    });
    expect(preset).toMatchObject({ type: "preset", preset: "claude_code" });
    const { append } = preset as { append: string };
    expect(append).toContain("AskUserQuestion");
    expect(append).toContain("EnterPlanMode");
    expect(append).toContain("TaskCreate");
    expect(append).toContain("`refs/`");
    // The browser guidance names the directory the redirect hook actually enforces, so the agent is told a fact
    // rather than a convention: a turn whose screenshots land elsewhere costs it a failed Read and a `find /`.
    expect(append).toContain("/work/.intentic/records/artifacts/browser");
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
