import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { CLAUDE_CODE_RUNTIME, GUIDANCE_HEADER, type GuidanceFacts, guidanceBlock, otherRuntime } from "./guidance.js";

// The registry as the model reads it: one heading, and the entries a turn's mounts and runtime allow, for every runtime.

const NOTHING_MOUNTED: GuidanceFacts = {
    runtime: CLAUDE_CODE_RUNTIME,
    unattended: false,
    browserOutputDir: undefined,
    browserAccounts: false,
    desktop: false,
    diagnostics: false,
    terminal: false,
    hostDevices: undefined,
    ownBrowsers: undefined,
};

const EVERYTHING_MOUNTED: GuidanceFacts = {
    runtime: CLAUDE_CODE_RUNTIME,
    unattended: false,
    browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
    browserAccounts: true,
    desktop: true,
    diagnostics: true,
    terminal: true,
    hostDevices: {
        ids: ["rog", "omen"],
        self: "rog",
        machines: [
            {
                id: "rog",
                environments: [
                    { key: "native", shell: "PowerShell 7", home: "C:\\Users\\radar" },
                    { key: "wsl:archlinux", distro: "archlinux", shell: "/usr/bin/zsh", home: "/home/radarsu" },
                ],
            },
        ],
    },
    ownBrowsers: { browsers: [{ id: "chrome" }], unlisted: ["brave"] },
};

// The same mounts on a loop that is not Claude Code's: Codex, OpenCode, an ACP agent. The terminal hand-off rides only
// the Claude Code loop's tmux wrapper, so it is the one mount such a turn never has.
const OTHER_MOUNTED: GuidanceFacts = {
    ...EVERYTHING_MOUNTED,
    runtime: otherRuntime("shell"),
    terminal: false,
    uiAsk: true,
    watch: true,
    subagents: true,
};

test("the block opens with its heading, the one anchor the disclosure finds it by", () => {
    for (const facts of [NOTHING_MOUNTED, OTHER_MOUNTED]) {
        expect(guidanceBlock(facts, "rg").startsWith(`${GUIDANCE_HEADER}\n\n`)).toBe(true);
    }
});

// The rules a turn cannot work out by looking: the product, the cards, the owner's landing, how a secret is used, and
// what outside text is.
test("the block carries the rules nothing else in the prompt carries", () => {
    const text = guidanceBlock(NOTHING_MOUNTED, "rg");
    expect(text).toContain("`intentic` skill");
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("EnterPlanMode");
    expect(text).toContain("TaskCreate");
    expect(text).toContain("commit only when asked");
    expect(text).toContain("{{secret:name}}");
    // Asking for what the sandbox lacks, on a card, instead of handing the owner setup steps.
    expect(text).toContain("`capabilities request <entry>");
    expect(text).toContain("`secrets ask NAME");
    expect(text).toContain("The answer continues this conversation by itself");
    expect(text).toContain("<untrusted-content");
    expect(text).toContain("`public/`");
    expect(text).toContain("`refs/`");
    expect(text).toContain("mcp__watch__start");
});

// The paragraphs a short form once dropped as "the base prompt already says it" are the ones whose absence cost the
// most: without them a turn took 79% more calls to reach the file it edited and 34% more round trips.
test("the batching and context-reuse paragraphs ride every runtime's turn", () => {
    for (const facts of [NOTHING_MOUNTED, OTHER_MOUNTED]) {
        const text = guidanceBlock(facts, "rg");
        expect(text).toContain("ORIENTING");
        expect(text).toMatch(/already read this session/i);
    }
});

// Naming tools the turn cannot load would send it hunting.
test("a mounted mechanism is named only on the turns that mounted it", () => {
    const mounted = guidanceBlock(EVERYTHING_MOUNTED, "rg");
    const bare = guidanceBlock(NOTHING_MOUNTED, "rg");
    for (const name of ["mcp__web__browser", "mcp__browser__", "mcp__diagnostics__", "mcp__terminal__request_help", "`rog`", "`chrome`", "`brave`"]) {
        expect(mounted).toContain(name);
        expect(bare).not.toContain(name);
    }
});

// 2026-10-25: OpenCode turns held three browsers and the owner's computers and were told nothing of them, and two X
// automations asked the owner's Brave for x.com with the sandbox's `x` account signed in.
test("every runtime is told about what it mounted, from the same paragraphs", () => {
    const other = guidanceBlock(OTHER_MOUNTED, "rg");
    for (const name of ["mcp__web__browser_navigate", "mcp__browser__browser_navigate", "mcp__accounts__roster", "mcp__diagnostics__errors", "`rog`", "`chrome`", "`brave`"]) {
        expect(other).toContain(name);
    }
    expect(other).toContain("`rog` is ONE computer with 2 environments on it");
    expect(other).toContain("`intentic` skill");
    expect(other).toContain("<untrusted-content");
});

// Only what the runtime genuinely lacks is left out: the Claude Code loop's own tools, and ToolSearch's deferral.
test("a runtime is told nothing that names a tool it does not have, and is given its own instead", () => {
    const other = guidanceBlock(OTHER_MOUNTED, "rg");
    for (const name of ["ToolSearch", "AskUserQuestion", "EnterPlanMode", "TaskCreate", "run_in_background", "mcp__terminal__"]) {
        expect(other).not.toContain(name);
    }
    expect(other).toContain("`mcp__ui__ask`");
    expect(other).toContain("`mcp__subagents__wait`");
    expect(other).toContain("`mcp__watch__start`");
});

test("an MCP tool is spelled as this runtime's tool list spells it", () => {
    const opencode = guidanceBlock({ ...OTHER_MOUNTED, runtime: otherRuntime("shell", "intentic_ab12cd34_") }, "rg");
    expect(opencode).toContain("`intentic_ab12cd34_browser_browser_navigate`");
    expect(opencode).toContain("`intentic_ab12cd34_accounts_roster`");
    expect(opencode).not.toContain("mcp__browser__browser_navigate");
});

// A turn holding a site's account has two wrong doors beside the right one.
test("the browsers are told apart, and a site with a sandbox account goes to that account alone", () => {
    for (const facts of [EVERYTHING_MOUNTED, OTHER_MOUNTED]) {
        const text = guidanceBlock(facts, "rg");
        expect(text).toContain("That browser holds no identity");
        expect(text).toContain("ALWAYS driven there");
        expect(text).toContain("login wall that says nothing about the account");
        expect(text).toContain("It is NOT for a site the sandbox holds its own signed-in account on");
    }
    // A persona without the browser shelf has only the accounts' server, and is not told of a `web` it lacks.
    const accountsOnly = guidanceBlock({ ...OTHER_MOUNTED, anonymousBrowser: false }, "rg");
    expect(accountsOnly).not.toContain("mcp__web__");
    expect(accountsOnly).toContain("mcp__browser__browser_navigate");
});

// Its cards wait for the owner rather than being refused, so an unattended turn keeps the ask guidance and is told that
// nobody is watching right now.
test("an unattended turn is told its cards wait for the owner, and keeps the ask guidance", () => {
    const unwatched = guidanceBlock({ ...NOTHING_MOUNTED, unattended: true }, "rg");
    expect(unwatched).toContain("AskUserQuestion");
    expect(unwatched).toContain("Nobody is watching this turn right now");
    expect(guidanceBlock(NOTHING_MOUNTED, "rg")).not.toContain("Nobody is watching this turn right now");
    expect(guidanceBlock({ ...OTHER_MOUNTED, unattended: true }, "rg")).toContain("Nobody is watching this turn right now");
});

test("a many-sided machine is described as one computer with its sides", () => {
    const text = guidanceBlock(EVERYTHING_MOUNTED, "rg");
    expect(text).toContain("The one running this sandbox is `rog`.");
    expect(text).toContain("`rog` is ONE computer with 2 environments on it");
});

// The product's own guide is one file, named for every runtime: the Claude Code loop loads it as a skill, the rest read it.
test("every runtime is pointed at the product guide's file", () => {
    for (const facts of [NOTHING_MOUNTED, OTHER_MOUNTED]) {
        expect(guidanceBlock(facts, "rg")).toContain("`/root/.claude/skills/intentic/SKILL.md`");
    }
});

// A loop that leaves a reference as text (ACP) would write one into a command and send the literal.
test("only a runtime whose shell resolves a secret reference is told to write one", () => {
    expect(guidanceBlock(OTHER_MOUNTED, "rg")).toContain("{{secret:name}}");
    expect(guidanceBlock({ ...OTHER_MOUNTED, runtime: otherRuntime("none") }, "rg")).not.toContain("{{secret:");
});

// iq is taught under a holdout, so only a turn that has it is told of it; the holdout's guidance must not jump that gate.
test("the guidance never advertises iq to a turn searching with rg", () => {
    for (const facts of [EVERYTHING_MOUNTED, OTHER_MOUNTED]) {
        expect(guidanceBlock(facts, "rg")).not.toMatch(/\biq\b/);
    }
});

// The system prompt outranks the teaching's own note, so a prompt naming `rg` alone won every search after it: a turn
// with iq is told iq finds and rg matches, on every runtime.
test("a turn with iq is told to find code with iq and keep rg for the exact string", () => {
    for (const facts of [EVERYTHING_MOUNTED, OTHER_MOUNTED]) {
        const text = guidanceBlock(facts, "iq");
        expect(text).toContain('`iq "<question>"`');
        expect(text).toContain("`rg`");
        expect(text).not.toContain("Search code with `rg`");
    }
});
