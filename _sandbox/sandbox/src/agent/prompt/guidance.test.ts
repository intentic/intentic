import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "bun:test";
import { GUIDANCE_HEADER, GUIDANCE_REVISION, guidanceBlock, type LoopFacts } from "./guidance.js";

// The registry as the model reads it: one heading, the entries a turn's mechanisms allow, in either form.

const NOTHING_MOUNTED: LoopFacts = {
    unattended: false,
    browserOutputDir: undefined,
    browserAccounts: false,
    diagnostics: false,
    terminal: false,
    hostDevices: undefined,
    ownBrowsers: undefined,
};

const EVERYTHING_MOUNTED: LoopFacts = {
    unattended: false,
    browserOutputDir: `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
    browserAccounts: true,
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
    for (const variant of ["full", "lean"] as const) {
        expect(guidanceBlock(variant, NOTHING_MOUNTED).startsWith(`${GUIDANCE_HEADER}\n\n`)).toBe(true);
        expect(guidanceBlock(variant, undefined).startsWith(`${GUIDANCE_HEADER}\n\n`)).toBe(true);
    }
});

// The rules a turn cannot work out by looking survive the short form: the product, the cards, the owner's landing,
// how a secret is used, and what outside text is.
test("the lean form keeps the rules nothing else in the prompt carries", () => {
    const lean = guidanceBlock("lean", NOTHING_MOUNTED);
    expect(lean).toContain("`intentic` skill");
    expect(lean).toContain("AskUserQuestion");
    expect(lean).toContain("EnterPlanMode");
    expect(lean).toContain("TaskCreate");
    expect(lean).toContain("commit only when asked");
    expect(lean).toContain("{{secret:name}}");
    expect(lean).toContain("<untrusted-content");
    expect(lean).toContain("`public/`");
    expect(lean).toContain("`refs/`");
    expect(lean).toContain("mcp__watch__start");
});

// What the base prompt and the tool descriptions already say is left to them.
test("the lean form drops what the base prompt and the tool descriptions already say", () => {
    const lean = guidanceBlock("lean", NOTHING_MOUNTED);
    expect(lean).not.toContain("ORIENTING");
    expect(lean).not.toMatch(/already read this session/i);
    const full = guidanceBlock("full", NOTHING_MOUNTED);
    expect(full).toContain("ORIENTING");
    expect(full).toMatch(/already read this session/i);
});

test("the lean form is a fraction of the full one, with every mechanism mounted", () => {
    expect(guidanceBlock("lean", EVERYTHING_MOUNTED).length).toBeLessThan(guidanceBlock("full", EVERYTHING_MOUNTED).length / 2);
});

// A short form that named tools the turn cannot load would send it hunting, the same as a long one.
test("either form names a mounted mechanism only on the turns that mounted it", () => {
    for (const variant of ["full", "lean"] as const) {
        const mounted = guidanceBlock(variant, EVERYTHING_MOUNTED);
        const bare = guidanceBlock(variant, NOTHING_MOUNTED);
        for (const name of ["mcp__web__browser", "mcp__browser__", "mcp__diagnostics__", "mcp__terminal__request_help", "`rog`", "`chrome`", "`brave`"]) {
            expect(mounted).toContain(name);
            expect(bare).not.toContain(name);
        }
    }
});

test("an unattended turn is not told about cards nobody can click, in either form", () => {
    for (const variant of ["full", "lean"] as const) {
        expect(guidanceBlock(variant, { ...NOTHING_MOUNTED, unattended: true })).not.toContain("AskUserQuestion");
    }
});

test("the lean form describes a many-sided machine in one line per machine", () => {
    const lean = guidanceBlock("lean", EVERYTHING_MOUNTED);
    expect(lean).toContain("`rog` runs this sandbox.");
    expect(lean).toContain("`rog`: `native` (PowerShell 7, C:\\Users\\radar), `wsl:archlinux` (/usr/bin/zsh, /home/radarsu); `run_command`'s `in` picks one.");
    expect(lean).not.toContain("ONE computer");
});

// A runtime outside the Claude Code loop has no ToolSearch, no cards, no skill loader and no background Bash.
test("a runtime outside the loop is told nothing that names a loop-only mechanism, in either form", () => {
    for (const variant of ["full", "lean"] as const) {
        const outside = guidanceBlock(variant, undefined);
        for (const name of ["ToolSearch", "AskUserQuestion", "TaskCreate", "run_in_background", "`intentic` skill", "{{secret:"]) {
            expect(outside).not.toContain(name);
        }
        // What holds whatever the runtime, including the rule that keeps outside text from steering it.
        expect(outside).toContain("`refs/`");
        expect(outside).toContain("commit only when asked");
        expect(outside).toContain("<untrusted-content");
    }
});

// iq is taught by its own gated plugin under a holdout; naming it here would jump that gate.
test("neither form advertises iq", () => {
    for (const variant of ["full", "lean"] as const) {
        expect(guidanceBlock(variant, EVERYTHING_MOUNTED)).not.toMatch(/\biq\b/);
    }
});

test("the revision is a short content hash, fixed for a build", () => {
    expect(GUIDANCE_REVISION).toMatch(/^[0-9a-f]{12}$/);
});
