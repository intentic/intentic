// Runs under `claude plugin test` (the engine's own test kit), not under bun: `pnpm --filter @intentic/claude-plugin test:mod`.
// The mod's helpers are covered by src/mod.test.ts; these hold what only the engine can: the hooks as it wires them.
import { expect, test } from "claude-code/testing";

const SESSION = "s-1";
const ROW = JSON.stringify({ project: "/p", session: SESSION, rawBytes: 4000, emittedBytes: 1000 });
const OTHER = JSON.stringify({ project: "/p", session: "s-2", rawBytes: 9000, emittedBytes: 9000 });
const LONG = "x".repeat(8000);

// The engine answers for everything the mod calls; each test says what the ledger holds and what the shell hook answered.
const stub = (on: any, over: { ledger?: boolean; folder?: boolean; trimmed?: string; surfaces?: string[]; placed?: boolean } = {}) => {
    const statuses: (string | undefined)[] = [];
    on("session.start", () => ({ cwd: "/p" }));
    on("command.register", () => ({ value: undefined }));
    on("session.id", () => ({ value: SESSION }));
    on("session.cwd", () => ({ value: "/p" }));
    on("session.surfaces", () => ({ value: over.surfaces ?? ["terminal"] }));
    on("env.get", ($: any, e: { name: string }) => ({ value: { CLAUDE_CONFIG_DIR: "/cfg" }[e.name] }));
    // A plugin read from a folder has no marketplace in its path, so its data directory is found among its siblings.
    const dir = over.folder === true ? "intentic-folder" : "intentic-inline";
    on("fs.exists", ($: any, e: { path: string }) => ({ value: e.path === `/cfg/plugins/data/${dir}/options.json` && over.folder !== true }));
    on("fs.list", () => ({ value: [{ name: "intentic-old", kind: "dir" }, { name: dir, kind: "dir" }, { name: "other-x", kind: "dir" }] }));
    on("fs.stat", ($: any, e: { path: string }) => (e.path.includes(`/${dir}/`) ? { value: { kind: "file", size: 1, mtimeMs: 2000, isLink: false } } : e.path.includes("intentic-old") ? { value: { kind: "file", size: 1, mtimeMs: 1000, isLink: false } } : { deny: "ENOENT" }));
    on("fs.read", ($: any, e: { path: string }) => (over.ledger !== false && e.path === `/cfg/plugins/data/${dir}/output/filter-stats.jsonl` ? { value: `${ROW}\n${OTHER}\n` } : { deny: "ENOENT" }));
    on("ui.status", ($: any, e: { text?: string }) => {
        statuses.push(e.text);
        return { value: undefined };
    });
    on("ui.open", () => ({ value: { isPlaced: over.placed ?? true } }));
    on("ui.close", () => ({ value: undefined }));
    on("ui.invalidate", () => ({ value: undefined }));
    on("process.run", () => ({ value: { exitCode: 0, stdout: "# intentic: what the plugin saved\n", stderr: "" } }));
    on("classic.PostToolUse", () => ({ updatedToolOutput: { stdout: over.trimmed ?? "short", stderr: "" } }));
    return statuses;
};

const bash = (stdout: string) => ({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "./build.sh" }, tool_response: { stdout, stderr: "" }, tool_use_id: "t1" });

test("the status opens from this session's ledger rows and grows with each Bash call", async ($, on) => {
    const statuses = stub(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/p" });
    // Only s-1's row counts: 4000 raw to 1000 emitted is 75% and 750 tokens.
    expect(statuses.at(-1)).toBe("intentic: Bash output trimmed 75% · 750 tokens saved over 1 command");
    await $.classic.PostToolUse(bash(LONG));
    // 4000 + 8000 raw, 1000 + 5 emitted.
    expect(statuses.at(-1)).toBe("intentic: Bash output trimmed 92% · 2.7k tokens saved over 2 commands");
});

test("a Bash call that was not shortened leaves the status as it was; other tools are not counted", async ($, on) => {
    const statuses = stub(on, { trimmed: LONG });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/p" });
    await $.classic.PostToolUse({ ...bash(LONG), tool_name: "Read" });
    expect(statuses.at(-1)).toBe("intentic: Bash output trimmed 75% · 750 tokens saved over 1 command");
    await $.classic.PostToolUse(bash(LONG));
    expect(statuses.at(-1)).toBe("intentic: Bash output trimmed 25% · 750 tokens saved over 2 commands");
});

test("a plugin read from a folder finds its data directory among the siblings, the newest one", async ($, on) => {
    const statuses = stub(on, { folder: true });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/p" });
    expect(statuses.at(-1)).toBe("intentic: Bash output trimmed 75% · 750 tokens saved over 1 command");
});

test("with output_cleaners off there is no status", { options: { output_cleaners: false } }, async ($, on) => {
    const statuses = stub(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/p" });
    await $.classic.PostToolUse(bash(LONG));
    expect(statuses).toEqual([]);
});

test("a missing ledger is a status of nothing, and the first trimmed command brings it", async ($, on) => {
    const statuses = stub(on, { ledger: false });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/p" });
    expect(statuses.at(-1)).toBeUndefined();
    await $.classic.PostToolUse(bash(LONG));
    expect(statuses.at(-1)).toBe("intentic: Bash output trimmed 100% · 2.0k tokens saved over 1 command");
});

test("/intentic-pane opens the pane where a surface draws, and the pane holds the report", async ($, on) => {
    stub(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/p" });
    const answer = await $.command.run({ command: "intentic-pane", args: "" });
    expect(answer.text).toBeUndefined();
    const ui = await $.ui.mount({
        plugin: "intentic",
        surface: "terminal",
        component: "Pane",
        requestId: "intentic-savings",
        viewport: { columns: 100, rows: 30 },
        props: { title: "intentic savings", isFocused: true, bodyColumns: 60, placement: "inline", scroll: { offset: 0, bodyRows: 10 }, view: {} },
    });
    expect(await ui.find({ type: "Markdown", text: /what the plugin saved/ })).toBeDefined();
    expect(await ui.find({ key: "refresh" })).toBeDefined();
    await ui.unmount();
});

test("/intentic-pane answers with the report as text where nothing draws a pane", async ($, on) => {
    stub(on, { surfaces: [] });
    await $.session.start({ surface: "terminal", isInteractive: false, cwd: "/p" });
    const answer = await $.command.run({ command: "intentic-pane", args: "all" });
    expect(answer.text).toContain("what the plugin saved");
});

test("/intentic-pane closes a pane the surface cannot seat and answers with text", async ($, on) => {
    stub(on, { surfaces: ["vscode"], placed: false });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/p" });
    const answer = await $.command.run({ command: "intentic-pane", args: "" });
    expect(answer.text).toContain("what the plugin saved");
});
