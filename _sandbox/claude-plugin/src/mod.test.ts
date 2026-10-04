import { add, dataDirOf, EMPTY, emittedLength, seedFromLedger, statusText, textLength } from "../hooks/register.js";

// The mod's own functions, which run in Claude Code's module environment but are plain code. The hooks as the engine wires
// them are tested by tests/mod.test.ts (`pnpm --filter @intentic/claude-plugin test:mod`).

const row = (session: string, rawBytes: number, emittedBytes: number): string => JSON.stringify({ project: "/p", session, ts: 1, rawBytes, emittedBytes });

test("the ledger seeds a session's tally from its own rows only, and skips lines that are not rows", () => {
    const ledger = [row("s-1", 4000, 1000), row("s-2", 9000, 9000), "{torn", row("s-1", 400, 400), JSON.stringify({ session: "s-1", rawBytes: "x" }), ""].join("\n");
    expect(seedFromLedger(ledger, "s-1")).toEqual({ commands: 2, raw: 4400, emitted: 1400 });
    expect(seedFromLedger(ledger, "s-3")).toEqual(EMPTY);
});

test("a Bash result is measured the way the cleaning hook measures it", () => {
    expect(textLength({ stdout: "abc\n", stderr: "" })).toBe(4);
    expect(textLength({ stdout: "abc", stderr: "warn" })).toBe(3 + 1 + 4);
    expect(textLength({ stdout: "abc\n", stderr: "warn" })).toBe(4 + 4);
    expect(textLength({ stdout: "", stderr: "warn" })).toBe(4);
    // Not a text result: interrupted, an image, a background task, or no result at all.
    expect(textLength({ stdout: "abc", interrupted: true })).toBeUndefined();
    expect(textLength({ stdout: "abc", isImage: true })).toBeUndefined();
    expect(textLength({ stdout: "abc", backgroundTaskId: "b1" })).toBeUndefined();
    expect(textLength(undefined)).toBeUndefined();
    expect(textLength("text")).toBeUndefined();
});

test("what the cleaning hook answered is the emitted length; no answer is unchanged", () => {
    expect(emittedLength({ updatedToolOutput: { stdout: "short", stderr: "" } })).toBe(5);
    expect(emittedLength({})).toBeUndefined();
    expect(emittedLength(undefined)).toBeUndefined();
});

test("the status says nothing until something was shortened, then percent, tokens and commands", () => {
    expect(statusText(EMPTY)).toBeUndefined();
    expect(statusText(add(EMPTY, 4000, 4000))).toBeUndefined();
    expect(statusText(add(EMPTY, 4000, 1000))).toBe("intentic: Bash output trimmed 75% · 750 tokens saved over 1 command");
    expect(statusText(add(add(EMPTY, 4_000_000, 400_000), 4000, 4000))).toBe("intentic: Bash output trimmed 90% · 900k tokens saved over 2 commands");
    expect(statusText({ commands: 400, raw: 8_000_000, emitted: 1_000_000 })).toBe("intentic: Bash output trimmed 88% · 1.8M tokens saved over 400 commands");
});

test("the data directory is the one Claude Code gives hooks as CLAUDE_PLUGIN_DATA", () => {
    expect(dataDirOf("intentic", "/x", { data: "/d", config: "/c", home: "/h" })).toBe("/d");
    // Installed from the intentic marketplace: the id is <name>-<marketplace>.
    expect(dataDirOf("intentic", "/home/u/.claude/plugins/cache/intentic/intentic/1.2.3", { config: undefined, home: "/home/u" })).toBe("/home/u/.claude/plugins/data/intentic-intentic");
    expect(dataDirOf("intentic", "C:\\Users\\u\\.claude\\plugins\\cache\\my.market\\intentic\\1.2.3\\", { config: "C:\\Users\\u\\.claude\\", home: undefined })).toBe("C:\\Users\\u\\.claude/plugins/data/intentic-my-market");
    // Loaded from a folder with --plugin-dir.
    expect(dataDirOf("intentic", "/work/intentic/_sandbox/claude-plugin", { config: "/cfg", home: "/h" })).toBe("/cfg/plugins/data/intentic-inline");
    expect(dataDirOf("intentic", "/x", {})).toBeUndefined();
});
