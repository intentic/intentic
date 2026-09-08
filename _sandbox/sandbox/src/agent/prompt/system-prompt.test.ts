import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { capabilitiesOf } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { INTENTIC_PROMPT } from "./intentic-prompt.js";
import { sdkSystemPrompt, turnPromptPlacement } from "./system-prompt.js";

// Built-in bases differ only in base text and append in a stable order (prompt caching); `custom` means the whole
// prompt, and the instruction axis's three answers are three distinct placements.

const CUSTOM = "You are a release-notes writer. Never edit code.";
const PERSONA = "## Who this turn is acting as\n\nYou are acting as Studio.";
const BASE = { append: undefined, unattended: false, browserOutputDir: undefined } as const;

// One runtime per placement the axis distinguishes, plus a second "replace" runtime that must not behave identically
// otherwise.
const CLAUDE = capabilitiesOf("claude", "native");
const CODEX = capabilitiesOf("codex", "native");
const GROK = capabilitiesOf("grok", "native");
const ACP = capabilitiesOf("some-installed-agent", "native");

test("nothing to append is undefined, not an empty string", () => {
    // The runner spreads this into the request; an empty string would leave a trailing separator on the base prompt.
    expect(turnPromptPlacement({ capabilities: CLAUDE, mode: "intentic", systemPrompt: "", stableSystemPrompt: false }).systemAppend).toBeUndefined();
});

test("custom replaces everything: nothing is appended to it", () => {
    const placement = turnPromptPlacement({
        capabilities: CLAUDE,
        mode: "custom",
        systemPrompt: CUSTOM,
        stableSystemPrompt: false,
        personaNote: PERSONA,
    });
    expect(placement.systemPrompt).toBe(CUSTOM);
    // The persona note is suppressed too: withheld accounts are withheld by absence, not by a sentence, once the owner
    // is doing their own instructing.
    expect(placement.systemAppend).toBeUndefined();
    expect(placement.userNotes).toBeUndefined();
});

// Claude Code composes these conventions itself (sdkSystemPrompt), so repeating them in the append would say it twice
// on the one runtime that already has it.
test("a runtime outside the Claude Code loop is told the workspace conventions; that loop is not told twice", () => {
    const codex = turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false });
    expect(codex.systemAppend).toContain("`refs/`");
    expect(codex.systemAppend).toContain("`public/`");
    expect(codex.systemAppend).toMatch(/commit only when asked/i);
    // Nothing here names a mechanism only the Claude Code loop wires (no question card, ToolSearch, or browser server).
    expect(codex.systemAppend).not.toContain("AskUserQuestion");
    expect(codex.systemAppend).not.toContain("mcp__web__browser");

    const claude = turnPromptPlacement({ capabilities: CLAUDE, mode: "intentic", systemPrompt: "", stableSystemPrompt: false });
    expect(claude.systemAppend).toBeUndefined();
});

test("a custom prompt is added where it cannot replace", () => {
    const placement = turnPromptPlacement({
        capabilities: GROK,
        mode: "custom",
        systemPrompt: CUSTOM,
        stableSystemPrompt: false,
    });
    expect(placement.systemPrompt).toBeUndefined();
    expect(placement.systemAppend).toBe(CUSTOM);
});

// "" is a legal custom prompt on a runtime that replaces (no base at all); on one that can only add, there is simply
// nothing to add.
test("an emptied custom prompt replaces with nothing, and adds nothing", () => {
    expect(turnPromptPlacement({ capabilities: CLAUDE, mode: "custom", systemPrompt: "", stableSystemPrompt: false }).systemPrompt).toBe("");
    const grok = turnPromptPlacement({ capabilities: GROK, mode: "custom", systemPrompt: "", stableSystemPrompt: false });
    expect(grok.systemAppend).toBeUndefined();
    expect(grok.systemPrompt).toBeUndefined();
});

// The persona note still has to arrive: a session that does not know which accounts it may speak through is unsafe, and
// the user message is the only channel left.
test("a runtime with no system prompt still hears which persona it is wearing", () => {
    const placement = turnPromptPlacement({
        capabilities: ACP,
        mode: "custom",
        systemPrompt: CUSTOM,
        stableSystemPrompt: false,
        personaNote: PERSONA,
    });
    expect(placement.systemPrompt).toBeUndefined();
    expect(placement.systemAppend).toBeUndefined();
    expect(placement.userNotes).toEqual([{ title: "Who this turn is acting as", text: PERSONA }]);
    // Nothing to say is nothing sent: an empty list would put a bare separator in front of the user's own words.
    expect(turnPromptPlacement({ capabilities: ACP, mode: "intentic", systemPrompt: "", stableSystemPrompt: false })).toEqual({});
});

test("intentic ships its own prompt as the base, with the harness guidance after it", () => {
    const prompt = sdkSystemPrompt({
        ...BASE,
        mode: "intentic",
        custom: undefined,
        append: "extra",
        browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
    });
    // A string, not an object: Intentic's prompt is not the CLI's preset, so the SDK is told to drop it.
    expect(typeof prompt).toBe("string");
    const text = prompt as string;
    expect(text.startsWith(INTENTIC_PROMPT)).toBe(true);
    // This guidance rides the default setting; without it the shipped question cards, checklist and browser tools go
    // dark for anyone who never touched it.
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("TaskCreate");
    expect(text).toContain("mcp__web__browser_take_screenshot");
    // The reference shelf is a workspace convention: every scanner excludes /work/refs, so this line is what stops a
    // clone dropped there being treated as project code.
    expect(text).toContain("`refs/`");
    expect(text.endsWith("extra")).toBe(true);
});

// browserOutputDir is turn-plan's browser-presence signal; when it is absent, the prompt must not advertise tools the
// turn cannot load.
test("no browser servers this turn: the prompt advertises no browser", () => {
    const prompt = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, append: undefined });
    expect(prompt as string).not.toContain("mcp__web__browser");
});

test("a turn holding accounts is told about the routed browser, and one without is not", () => {
    const browserOutputDir = `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`;
    const withAccounts = sdkSystemPrompt({
        ...BASE,
        mode: "intentic",
        custom: undefined,
        browserOutputDir,
        browserAccounts: true,
    }) as string;
    expect(withAccounts).toContain("mcp__browser__");
    expect(withAccounts).toContain("`account` argument");
    // Accounts tools are deferred too, so the same sentence has to say how they load and what the roster tool is
    // called.
    expect(withAccounts).toContain("ToolSearch `+accounts`");
    expect(withAccounts).toContain("mcp__accounts__roster");
    // Anonymous and signed-in are different tool prefixes, not one tool with a flag.
    expect(withAccounts).toContain("mcp__web__browser_navigate");

    const anonymousOnly = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, browserOutputDir }) as string;
    expect(anonymousOnly).toContain("mcp__web__browser_navigate");
    expect(anonymousOnly).not.toContain("mcp__browser__");
    expect(anonymousOnly).not.toContain("mcp__accounts__");
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
    // Names the exact directory the redirect hook enforces, so a mismatch is a fact the agent is told, not a convention
    // it might miss.
    expect(append).toContain("/work/.intentic/records/artifacts/browser");
    expect(append.endsWith("extra")).toBe(true);
});

test("custom reaches the SDK as the bare text, with no guidance at all", () => {
    const prompt = sdkSystemPrompt({ ...BASE, mode: "custom", custom: CUSTOM, append: "extra" });
    expect(prompt).toBe(CUSTOM);
});

test("an unattended turn loses the interactive guidance but keeps the checklist", () => {
    const text = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, unattended: true }) as string;
    expect(text).not.toContain("AskUserQuestion");
    expect(text).toContain("TaskCreate");
});

test("both built-in bases carry the waiting and context-reuse steers", () => {
    for (const mode of ["intentic", "claude"] as const) {
        const composed = sdkSystemPrompt({ ...BASE, mode, custom: undefined, append: undefined });
        const text = typeof composed === "string" ? composed : (composed as { append: string }).append;
        // The replacement seams are named explicitly; an unnamed capability is one the model falls back past to the
        // shell primitive it already knows.
        expect(text).toContain("run_in_background");
        expect(text).toContain("mcp__watch__start");
        expect(text).toContain("`sleep N`");
        expect(text).toMatch(/already read/i);
    }
});

test("an unattended turn keeps them: a wake nobody watches is where polling costs most", () => {
    const text = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, unattended: true }) as string;
    expect(text).toContain("run_in_background");
    expect(text).toMatch(/already read/i);
});

test("a runtime outside the Claude Code loop is not told to use seams it has not got", () => {
    const codex = turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false });
    expect(codex.systemAppend).not.toContain("run_in_background");
    expect(codex.systemAppend).not.toContain("mcp__watch__start");
});

// Which binary is installed is not a loop-specific mechanism, so unlike the seams above it travels to every runtime.
test("the search-binary steer travels to every runtime, like the other image facts", () => {
    const codex = turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false });
    expect(codex.systemAppend).toContain("`rg` (ripgrep)");
    const claude = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, append: undefined }) as string;
    expect(claude).toContain("`rg` (ripgrep)");
});

// iqSearch defaults off and is measured under a holdout arm; naming it here unconditionally would jump that gate and
// spoil the holdout.
test("the always-on prompt never advertises iq: its plugin is gated and under measurement", () => {
    const intentic = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, append: undefined }) as string;
    const claude = sdkSystemPrompt({ ...BASE, mode: "claude", custom: undefined, append: undefined }) as { append: string };
    for (const text of [intentic, claude.append]) {
        expect(text).not.toMatch(/\biq\b/);
    }
});

// Names the situation (orienting) rather than restating the batching rule.
test("both built-in bases name orientation as the place to batch", () => {
    for (const mode of ["intentic", "claude"] as const) {
        const composed = sdkSystemPrompt({ ...BASE, mode, custom: undefined, append: undefined });
        const text = typeof composed === "string" ? composed : (composed as { append: string }).append;
        expect(text).toContain("ORIENTING");
        expect(text).toContain("ONE response");
    }
});

// The only place "Intentic" is explained at all; the reference itself is a pointer to the on-demand `intentic` skill,
// kept out of the always-on cost.
test("both built-in bases say what the agent runs inside and where the product's reference is", () => {
    for (const mode of ["intentic", "claude"] as const) {
        const composed = sdkSystemPrompt({ ...BASE, mode, custom: undefined, append: undefined });
        const text = typeof composed === "string" ? composed : (composed as { append: string }).append;
        expect(text).toContain("You run inside Intentic");
        expect(text).toContain("`intentic` skill");
        // The one fact the model cannot infer on its own: this workspace's own CLAUDE.md is read as the owner's
        // instruction.
        expect(text).toMatch(/CLAUDE\.md.*owner's instruction/);
        expect(text).toMatch(/never say Intentic cannot/i);
    }
});

// The skill lives under /root/.claude/skills, loaded only via the Claude Code loop's settingSources.
test("a runtime outside the Claude Code loop is not pointed at a skill it cannot load", () => {
    const codex = turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false });
    expect(codex.systemAppend).not.toContain("`intentic` skill");
});

// Diagnostics tools are named only on the turns that mounted them; turn-plan withholds the server from a persona with
// no files power.
test("the diagnostics tools are named on the turns that mounted them, and nowhere else", () => {
    const mounted = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, diagnostics: true }) as string;
    expect(mounted).toContain("mcp__diagnostics__errors");
    expect(mounted).toContain("mcp__diagnostics__turns");
    expect(mounted).toContain("mcp__diagnostics__slow");
    expect(mounted).toContain("mcp__diagnostics__resources");
    expect(mounted).toMatch(/before re-instrumenting/i);

    const withheld = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined }) as string;
    expect(withheld).not.toContain("mcp__diagnostics__");
    // An unattended wake keeps diagnostics: an automation's own failure is exactly what those records answer.
    const unattended = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, unattended: true, diagnostics: true }) as string;
    expect(unattended).toContain("mcp__diagnostics__errors");
    const codex = turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false });
    expect(codex.systemAppend).not.toContain("mcp__diagnostics__");
});

// The terminal hand-off is deferred, and named only on turns agent.ts mounted it for: attended, with the tmux wrapper.
test("the terminal hand-off is named on the turns that mounted it, and nowhere else", () => {
    const mounted = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined, terminal: true }) as string;
    expect(mounted).toContain("mcp__terminal__request_help");
    expect(mounted).toContain("ToolSearch (`+terminal`)");
    // Said for the moment it arrives in (mid-run), not as a tool summary.
    expect(mounted).toContain("still running");

    const withheld = sdkSystemPrompt({ ...BASE, mode: "intentic", custom: undefined }) as string;
    expect(withheld).not.toContain("mcp__terminal__");
    const preset = sdkSystemPrompt({ ...BASE, mode: "claude", custom: undefined, terminal: true }) as { append: string };
    expect(preset.append).toContain("mcp__terminal__request_help");
    const codex = turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false });
    expect(codex.systemAppend ?? "").not.toContain("mcp__terminal__");
});
