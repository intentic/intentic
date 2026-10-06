import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { GUIDANCE_HEADER, guidanceBlock, type LoopFacts } from "./guidance.js";

// The registry as the model reads it: one heading, and the entries a turn's mechanisms allow.

const NOTHING_MOUNTED: LoopFacts = {
    unattended: false,
    browserOutputDir: undefined,
    browserAccounts: false,
    desktop: false,
    diagnostics: false,
    terminal: false,
    hostDevices: undefined,
    ownBrowsers: undefined,
};

const EVERYTHING_MOUNTED: LoopFacts = {
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

test("the block opens with its heading, the one anchor the disclosure finds it by", () => {
    expect(guidanceBlock(NOTHING_MOUNTED, "rg").startsWith(`${GUIDANCE_HEADER}\n\n`)).toBe(true);
    expect(guidanceBlock(undefined, "rg").startsWith(`${GUIDANCE_HEADER}\n\n`)).toBe(true);
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
test("the batching and context-reuse paragraphs ride every loop turn", () => {
    const text = guidanceBlock(NOTHING_MOUNTED, "rg");
    expect(text).toContain("ORIENTING");
    expect(text).toMatch(/already read this session/i);
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

// Its cards wait for the owner rather than being refused, so an unattended turn keeps the ask guidance and is told that
// nobody is watching right now.
test("an unattended turn is told its cards wait for the owner, and keeps the ask guidance", () => {
    const unwatched = guidanceBlock({ ...NOTHING_MOUNTED, unattended: true }, "rg");
    expect(unwatched).toContain("AskUserQuestion");
    expect(unwatched).toContain("Nobody is watching this turn right now");
    expect(guidanceBlock(NOTHING_MOUNTED, "rg")).not.toContain("Nobody is watching this turn right now");
});

test("a many-sided machine is described as one computer with its sides", () => {
    const text = guidanceBlock(EVERYTHING_MOUNTED, "rg");
    expect(text).toContain("The one running this sandbox is `rog`.");
    expect(text).toContain("`rog` is ONE computer with 2 environments on it");
});

// The product's own guide is baked where only the Claude Code loop's skill loader looks; every other runtime is pointed
// at its file instead, since an owner's first question is often about the product itself.
test("a runtime outside the loop is pointed at the product guide's file, and the loop is not", () => {
    expect(guidanceBlock(undefined, "rg")).toContain("`/root/.claude/skills/intentic/SKILL.md`");
    expect(guidanceBlock(EVERYTHING_MOUNTED, "rg")).not.toContain("/root/.claude/skills/intentic/SKILL.md");
});

// A runtime outside the Claude Code loop has no ToolSearch, no cards, no skill loader and no background Bash.
test("a runtime outside the loop is told nothing that names a loop-only mechanism", () => {
    const outside = guidanceBlock(undefined, "rg");
    for (const name of ["ToolSearch", "AskUserQuestion", "TaskCreate", "run_in_background", "`intentic` skill", "{{secret:"]) {
        expect(outside).not.toContain(name);
    }
    // What holds whatever the runtime, including the rule that keeps outside text from steering it.
    expect(outside).toContain("`refs/`");
    expect(outside).toContain("commit only when asked");
    expect(outside).toContain("<untrusted-content");
});

// iq is taught under a holdout, so only a turn that has it is told of it; the holdout's guidance must not jump that gate.
test("the guidance never advertises iq to a turn searching with rg", () => {
    expect(guidanceBlock(EVERYTHING_MOUNTED, "rg")).not.toMatch(/\biq\b/);
    expect(guidanceBlock(undefined, "rg")).not.toMatch(/\biq\b/);
});

// The system prompt outranks the teaching's own note, so a prompt naming `rg` alone won every search after it: a turn
// with iq is told iq finds and rg matches, on every runtime.
test("a turn with iq is told to find code with iq and keep rg for the exact string", () => {
    for (const loop of [EVERYTHING_MOUNTED, undefined]) {
        const text = guidanceBlock(loop, "iq");
        expect(text).toContain('`iq "<question>"`');
        expect(text).toContain("`rg`");
        expect(text).not.toContain("Search code with `rg`");
    }
});
