import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { CLAUDE_CODE_RUNTIME, claudeCodeRuntime, GUIDANCE_HEADER, type GuidanceFacts, guidanceBlock, otherRuntime } from "./guidance.js";

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
        expect(guidanceBlock(facts).startsWith(`${GUIDANCE_HEADER}\n\n`)).toBe(true);
    }
});

// The rules a turn cannot work out by looking: the product, the cards, the owner's landing, how a secret is used, and
// what outside text is.
test("the block carries the rules nothing else in the prompt carries", () => {
    const text = guidanceBlock(NOTHING_MOUNTED);
    expect(text).toContain("`intentic` skill");
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("EnterPlanMode");
    expect(text).toContain("TaskCreate");
    expect(text).toContain("commit only when asked");
    // Claude Code's preset says it; every other loop is told only here (guidance.ts DELIVERABLES).
    expect(text).toContain("A report, audit, analysis, plan or review is your reply, not a file");
    expect(text).toContain("{{secret:name}}");
    // Asking for what the sandbox lacks, on a card, instead of handing the owner setup steps.
    expect(text).toContain("`capabilities request <entry>");
    expect(text).toContain("`secrets ask NAME");
    expect(text).toContain("The answer continues this conversation by itself");
    expect(text).toContain("<untrusted-content");
    expect(text).toContain("`public/`");
    expect(text).toContain("`refs/`");
    expect(text).toContain("mcp__watch__start");
    // One stash serves every checkout, so a pop can bring back another conversation's work (the shinobi-society audit,
    // 2026-11-17); the audit's other facts are the intentic skill's paths reference, not every turn's prompt.
    expect(text).toContain("Leave `git stash` alone");
    expect(text).not.toContain("a restart empties `/tmp`");
});

// The paragraphs a short form once dropped as "the base prompt already says it" are the ones whose absence cost the
// most: without them a turn took 79% more calls to reach the file it edited and 34% more round trips.
test("the batching and context-reuse paragraphs ride every runtime's turn", () => {
    for (const facts of [NOTHING_MOUNTED, OTHER_MOUNTED]) {
        const text = guidanceBlock(facts);
        expect(text).toContain("ORIENTING");
        expect(text).toMatch(/already read this session/i);
    }
});

// Naming tools the turn cannot load would send it hunting.
test("a mounted mechanism is named only on the turns that mounted it", () => {
    const mounted = guidanceBlock(EVERYTHING_MOUNTED);
    const bare = guidanceBlock(NOTHING_MOUNTED);
    for (const name of ["mcp__web__browser", "mcp__browser__", "mcp__diagnostics__", "mcp__terminal__request_help", "`rog`", "`chrome`", "`brave`"]) {
        expect(mounted).toContain(name);
        expect(bare).not.toContain(name);
    }
});

// 2026-10-25: OpenCode turns held three browsers and the owner's computers and were told nothing of them, and two X
// automations asked the owner's Brave for x.com with the sandbox's `x` account signed in.
test("every runtime is told about what it mounted, from the same paragraphs", () => {
    const other = guidanceBlock(OTHER_MOUNTED);
    for (const name of ["mcp__web__browser_navigate", "mcp__browser__browser_navigate", "mcp__accounts__roster", "mcp__diagnostics__errors", "`rog`", "`chrome`", "`brave`"]) {
        expect(other).toContain(name);
    }
    expect(other).toContain("`rog` is ONE computer with 2 environments on it");
    expect(other).toContain("`intentic` skill");
    expect(other).toContain("<untrusted-content");
});

// Only what the runtime genuinely lacks is left out: the Claude Code loop's own tools, and ToolSearch's deferral.
test("a runtime is told nothing that names a tool it does not have, and is given its own instead", () => {
    const other = guidanceBlock(OTHER_MOUNTED);
    for (const name of ["ToolSearch", "AskUserQuestion", "EnterPlanMode", "TaskCreate", "run_in_background", "mcp__terminal__"]) {
        expect(other).not.toContain(name);
    }
    expect(other).toContain("`mcp__ui__ask`");
    expect(other).toContain("`mcp__subagents__wait`");
    expect(other).toContain("`mcp__watch__start`");
});

// A Claude Code turn the CLI runs with every schema loaded has no ToolSearch: 35 turns called it anyway in the ten days
// to 2026-10-26, because the prompt said to. Its own tools (the checklist, the question card) are still named.
test("a Claude Code turn without deferred schemas is never sent to ToolSearch, and still keeps its checklist", () => {
    const loaded = guidanceBlock({ ...EVERYTHING_MOUNTED, runtime: claudeCodeRuntime(false) });
    expect(loaded).not.toContain("ToolSearch");
    expect(loaded).toContain("(TaskCreate, TaskUpdate, TaskList)");
    const deferred = guidanceBlock(EVERYTHING_MOUNTED);
    expect(deferred).toContain("load them with ToolSearch first: `select:TaskCreate,TaskUpdate,TaskList`");
});

// "The `wait` tool" sent turns to ToolSearch for `select:wait`; the tool is named as the tool list spells it.
test("the waiting paragraph names the wait and keep tools in full on every runtime", () => {
    for (const facts of [EVERYTHING_MOUNTED, OTHER_MOUNTED]) {
        const text = guidanceBlock(facts);
        expect(text).toContain("`mcp__subagents__wait`");
        expect(text).not.toContain("the `wait` tool");
    }
    expect(guidanceBlock(EVERYTHING_MOUNTED)).toContain("`mcp__subagents__keep`");
    expect(guidanceBlock(EVERYTHING_MOUNTED)).toContain("`mcp__subagents__stop`");
});

// 2026-11-02: Codex and OpenCode turns were told to wait on a background command they had no id for, and guessed 87
// targets. A loop whose long commands come back as jobs is told how; one whose do not is not told they do.
test("a long command is said to come back as a job only on a loop that files it as one", () => {
    const filing = guidanceBlock({ ...OTHER_MOUNTED, runtime: otherRuntime("shell", undefined, true) });
    expect(filing).toContain("keeps running as a background job, and its result names the job's id: wait on it with `mcp__subagents__wait` (target that id)");
    expect(filing).toContain("end it early with `mcp__subagents__stop`");
    const plain = guidanceBlock(OTHER_MOUNTED);
    expect(plain).toContain("A subagent you started is waited on with `mcp__subagents__wait`, never by re-reading its log on a timer.");
    expect(plain).not.toContain("background command");
});

test("an MCP tool is spelled as this runtime's tool list spells it", () => {
    const opencode = guidanceBlock({ ...OTHER_MOUNTED, runtime: otherRuntime("shell", "intentic_ab12cd34_") });
    expect(opencode).toContain("`intentic_ab12cd34_browser_browser_navigate`");
    expect(opencode).toContain("`intentic_ab12cd34_accounts_roster`");
    expect(opencode).not.toContain("mcp__browser__browser_navigate");
});

// A turn holding a site's account has two wrong doors beside the right one.
test("the browsers are told apart, and a site with a sandbox account goes to that account alone", () => {
    for (const facts of [EVERYTHING_MOUNTED, OTHER_MOUNTED]) {
        const text = guidanceBlock(facts);
        expect(text).toContain("That browser holds no identity");
        expect(text).toContain("ALWAYS driven there");
        expect(text).toContain("login wall that says nothing about the account");
        expect(text).toContain("It is NOT for a site the sandbox holds its own signed-in account on");
    }
    // A role without the browser shelf has only the accounts' server, and is not told of a `web` it lacks.
    const accountsOnly = guidanceBlock({ ...OTHER_MOUNTED, anonymousBrowser: false });
    expect(accountsOnly).not.toContain("mcp__web__");
    expect(accountsOnly).toContain("mcp__browser__browser_navigate");
});

// Its cards wait for the owner rather than being refused, so an unattended turn keeps the ask guidance and is told that
// nobody is watching right now.
test("an unattended turn is told its cards wait for the owner, and keeps the ask guidance", () => {
    const unwatched = guidanceBlock({ ...NOTHING_MOUNTED, unattended: true });
    expect(unwatched).toContain("AskUserQuestion");
    expect(unwatched).toContain("Nobody is watching this turn right now");
    expect(guidanceBlock(NOTHING_MOUNTED)).not.toContain("Nobody is watching this turn right now");
    expect(guidanceBlock({ ...OTHER_MOUNTED, unattended: true })).toContain("Nobody is watching this turn right now");
});

test("a many-sided machine is described as one computer with its sides", () => {
    const text = guidanceBlock(EVERYTHING_MOUNTED);
    expect(text).toContain("The one running this sandbox is `rog`.");
    expect(text).toContain("`rog` is ONE computer with 2 environments on it");
});

// 2026-11-22, shinobi-society: two computers set up alike were each described in full, word for word but for the name,
// and a distro whose record lacked its name was called "the metal".
test("computers set up alike are described once together, and what `in` does is said once for all", () => {
    const rog = EVERYTHING_MOUNTED.hostDevices?.machines?.[0];
    if (rog === undefined) {
        throw new Error("the fixture names rog");
    }
    const machines = [
        rog,
        { ...rog, id: "omen" },
        { id: "z440", environments: [...rog.environments, { key: "wsl:itest-arch", shell: "/bin/sh", home: "/root" }] },
    ];
    const text = guidanceBlock({ ...EVERYTHING_MOUNTED, hostDevices: { ids: ["rog", "omen", "z440"], self: "rog", machines } });
    expect(text).toContain("`rog` and `omen` are each ONE computer with 2 environments on it");
    expect(text).toContain("`z440` is ONE computer with 3 environments on it");
    expect(text).toContain('`wsl:itest-arch` is the WSL distro "itest-arch" on it (/bin/sh, home /root)');
    expect(text.split("`in` picks the side")).toHaveLength(2);
    expect(text.split("One Docker engine serves")).toHaveLength(2);
});

// The product's own guide is one file, named for every runtime: the Claude Code loop loads it as a skill, the rest read it.
test("every runtime is pointed at the product guide's file", () => {
    for (const facts of [NOTHING_MOUNTED, OTHER_MOUNTED]) {
        expect(guidanceBlock(facts)).toContain("`/root/.claude/skills/intentic/SKILL.md`");
    }
});

// A loop that leaves a reference as text (ACP) would write one into a command and send the literal.
test("only a runtime whose shell resolves a secret reference is told to write one", () => {
    expect(guidanceBlock(OTHER_MOUNTED)).toContain("{{secret:name}}");
    expect(guidanceBlock({ ...OTHER_MOUNTED, runtime: otherRuntime("none") })).not.toContain("{{secret:");
});


// 2026-11-19, the shinobi-society audit: a preference restated in six conversations, rules that died with the reply they
// were said in. Every runtime is told how to keep one, and never to write it into the file unasked.
test("every runtime is told to keep a lasting rule through an approved proposal, not by editing AGENTS.md", () => {
    for (const facts of [NOTHING_MOUNTED, OTHER_MOUNTED]) {
        const text = guidanceBlock(facts);
        expect(text).toContain('`instructions propose --text "…" --why "…"`');
        expect(text).toContain("Only for words the owner said: not for an instruction about the task at hand, and not for a convention you worked out yourself");
        expect(text).toContain("do not write the rule into an AGENTS.md yourself");
    }
});

// Off by default, and then every turn reads as it did before the setting; on, every runtime is told in the same words,
// with the plan-mode sentence only where the loop has plan mode.
test("only a turn planned with the owner's go-ahead is told to proceed without asking", () => {
    expect(guidanceBlock(NOTHING_MOUNTED)).not.toContain("proceed without asking");
    expect(guidanceBlock({ ...NOTHING_MOUNTED, proceed: false })).not.toContain("proceed without asking");
    const claude = guidanceBlock({ ...NOTHING_MOUNTED, proceed: true });
    expect(claude).toContain("The owner has asked agents here to proceed without asking");
    expect(claude).toContain("Do not enter plan mode to have a plan approved first.");
    expect(claude).toContain("Subagents you spawn are told the same");
    const other = guidanceBlock({ ...OTHER_MOUNTED, proceed: true });
    expect(other).toContain("End your final message with what you decided for them");
    expect(other).not.toContain("plan mode");
    expect(guidanceBlock({ ...OTHER_MOUNTED, proceed: true, subagents: false })).not.toContain("Subagents you spawn");
});
