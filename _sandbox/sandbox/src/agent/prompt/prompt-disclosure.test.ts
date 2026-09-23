import { capabilitiesOf } from "@intentic/sandbox-contract";
import { guidanceBlock } from "./guidance.js";
import { promptDisclosure, withBaseText } from "./prompt-disclosure.js";
import { turnPromptPlacement } from "./system-prompt.js";

// What the chat shows must be what the turn was sent. Everything here composes a placement the ordinary way and then
// reads it back, so a note that changes its header, or an arm that stops carrying one, fails here rather than drawing
// a reader a prompt nobody ran.

const CLAUDE = capabilitiesOf("claude", "native");
const CODEX = capabilitiesOf("codex", "native");
const PERSONA = "## Who this turn is acting as\n\nYou are acting as Studio.";
const FIELD_NOTES = "## Field notes for this sandbox\n\npnpm's exit code lies here.";
const MEMORY = "## Standing instructions for this workspace\n\n### AGENTS.md\n\nNo legacy support.";
const AT = 1_700_000_000_000;

// Stands in for the installed CLI, answering with a preset that names the model it was rendered for.
jest.mock("./preset-prompt.js", () => ({
    presetSystemPrompt: async (_cwd: string, model?: string) => ({
        text: `IMPORTANT: Assist with anything.\n\nRendered for ${model ?? "the default"}.`,
        version: "2.1.0",
    }),
}));

const disclosureOf = (capabilities: typeof CLAUDE, mode: "intentic" | "claude" | "custom", systemPrompt = "") => {
    const placement = turnPromptPlacement({
        capabilities,
        mode,
        systemPrompt,
        stableSystemPrompt: false,
        personaNote: PERSONA,
        fieldNotesNote: FIELD_NOTES,
        memoryNote: MEMORY,
    });
    return promptDisclosure({
        capabilities,
        request: { spec: { systemPromptMode: mode, ...placement }, policy: { unattended: true }, tools: {} },
        at: AT,
    });
};

const textOf = (disclosure: ReturnType<typeof disclosureOf>, source: string): string | undefined =>
    disclosure.sections.find((section) => section.source === source)?.text;

test("each composed piece is read back whole, under its own source", () => {
    const disclosure = disclosureOf(CLAUDE, "intentic");
    expect(disclosure.sections.map((section) => section.source)).toEqual(["guidance", "persona", "field-notes", "memory"]);
    // Whole, not merely present: a split at the wrong place would leave one piece holding the next one's words.
    expect(textOf(disclosure, "persona")).toBe(PERSONA);
    expect(textOf(disclosure, "field-notes")).toBe(FIELD_NOTES);
    expect(textOf(disclosure, "memory")).toBe(MEMORY);
});

// The order the model reads them in is the order the reader is shown: this is what makes "my AGENTS.md is last and
// closest to the conversation" checkable rather than claimed.
test("the sections are in the order they were sent", () => {
    const { systemAppend = "" } = turnPromptPlacement({
        capabilities: CLAUDE,
        mode: "intentic",
        systemPrompt: "",
        stableSystemPrompt: false,
        personaNote: PERSONA,
        fieldNotesNote: FIELD_NOTES,
        memoryNote: MEMORY,
    });
    expect(systemAppend.indexOf(PERSONA)).toBeLessThan(systemAppend.indexOf(FIELD_NOTES));
    expect(systemAppend.indexOf(FIELD_NOTES)).toBeLessThan(systemAppend.indexOf(MEMORY));
});

// The Claude Code loop's own paragraphs never ride the append (sdkSystemPrompt adds them), so a disclosure that only
// split the append would show a prompt missing most of what was sent.
test("the harness arm's own guidance is shown, though it never rode the append", () => {
    const claude = disclosureOf(CLAUDE, "intentic");
    expect(claude.base).toEqual({ kind: "intentic" });
    expect(textOf(claude, "guidance")).toContain("You run inside Intentic");
    // Unattended: the interactive paragraph is composed out, and must be absent here for the same turn.
    expect(textOf(claude, "guidance")).not.toContain("AskUserQuestion");
});

// The variant rides the request, so the disclosure recomposes the form the turn drew rather than the default.
test("the guidance shown is the form the turn was sent", () => {
    const lean = promptDisclosure({
        capabilities: CLAUDE,
        request: { spec: { systemPromptMode: "intentic", guidance: "lean" }, policy: { unattended: true }, tools: {} },
        at: AT,
    });
    expect(textOf(lean, "guidance")).toBe(
        guidanceBlock("lean", {
            unattended: true,
            browserOutputDir: undefined,
            browserAccounts: false,
            diagnostics: false,
            terminal: false,
            hostDevices: undefined,
            ownBrowsers: undefined,
        }),
    );
    const codex = promptDisclosure({
        capabilities: CODEX,
        request: {
            spec: {
                systemPromptMode: "intentic",
                ...turnPromptPlacement({ capabilities: CODEX, mode: "intentic", systemPrompt: "", stableSystemPrompt: false, guidance: "lean" }),
            },
            policy: {},
            tools: {},
        },
        at: AT,
    });
    expect(textOf(codex, "guidance")).toBe(guidanceBlock("lean", undefined));
});

test("a runtime that keeps its own prompt says so, and its guidance is the append's own head", () => {
    const codex = disclosureOf(CODEX, "intentic");
    expect(codex.base).toEqual({ kind: "runtime" });
    expect(codex.runtime).toBe("codex");
    // What that runtime actually got: the workspace conventions, not the Claude loop's mechanisms.
    expect(textOf(codex, "guidance")).toContain("`refs/`");
    expect(textOf(codex, "guidance")).not.toContain("You run inside Intentic");
});

// A custom prompt drops this product's guidance outright; showing a "guidance" row for it would be showing words
// nobody sent.
test("a custom prompt is the base, with the owner's rules still beside it", () => {
    const own = "You are a release-notes writer.";
    const custom = disclosureOf(CLAUDE, "custom", own);
    expect(custom.base).toEqual({ kind: "custom", text: own });
    expect(custom.sections.map((section) => section.source)).toEqual(["memory"]);
});

// The same custom prompt on a runtime with no seam to replace: it rides the append ahead of the owner's rules, and
// must still be read back as the base rather than as guidance.
test("a custom prompt that could only be appended is still the base", () => {
    const own = "You are a release-notes writer.";
    const codex = disclosureOf(CODEX, "custom", own);
    expect(codex.base).toEqual({ kind: "custom", text: own });
    expect(codex.sections.map((section) => section.source)).toEqual(["memory"]);
});

test("a header quoted mid-sentence does not open a section", () => {
    const quoting = `Never write "## Field notes for this sandbox" into a file.\n\n${MEMORY}`;
    const disclosure = promptDisclosure({
        capabilities: CODEX,
        request: { spec: { systemPromptMode: "intentic", systemAppend: quoting }, policy: {}, tools: {} },
        at: AT,
    });
    expect(disclosure.sections.map((section) => section.source)).toEqual(["guidance", "memory"]);
});

test("a turn with nothing added discloses the base alone", () => {
    const disclosure = promptDisclosure({ capabilities: CODEX, request: { spec: { systemPromptMode: "intentic" }, policy: {}, tools: {} }, at: AT });
    expect(disclosure.sections).toEqual([]);
    expect(disclosure.base).toEqual({ kind: "runtime" });
});

// Claude Code renders a different preset per model, so a built-in base is read back for the model the turn ran on.
test("a built-in base is shown as its turn's model had it", async () => {
    const intentic = promptDisclosure({
        capabilities: CLAUDE,
        request: { spec: { systemPromptMode: "intentic", model: "claude-sonnet-5" }, policy: {}, tools: {} },
        at: AT,
    });
    expect(intentic.base).toEqual({ kind: "intentic", model: "claude-sonnet-5" });
    expect((await withBaseText(intentic, "/work")).base.text).toBe("Rendered for claude-sonnet-5.");

    const claude = promptDisclosure({ capabilities: CLAUDE, request: { spec: { systemPromptMode: "claude" }, policy: {}, tools: {} }, at: AT });
    expect((await withBaseText(claude, "/work")).base.text).toBe("IMPORTANT: Assist with anything.\n\nRendered for the default.");
});
