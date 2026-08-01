import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { expect, test } from "vitest";
import { shellQuote } from "../terminal/terminal-run.js";
import { syncHookOutput } from "../testing.js";
import { bashTmuxHooks } from "./agent-terminals.js";

// What the hook makes of the agent's command line before tmux-run sees it: demoted (nice/ionice — priorities
// only bind under contention, and agent builds are what has starved the daemon) and run as ONE bash -c tree.
const demoted = (command: string): string => `nice -n 10 ionice -c 2 -n 7 bash -c ${shellQuote(command)}`;

const hookOf = (hooks: ReturnType<typeof bashTmuxHooks>) => {
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    if (hook === undefined) {
        throw new Error("PreToolUse hook not registered");
    }
    return hook;
};

const preToolUse = (toolInput: unknown, hooks = bashTmuxHooks()) =>
    hookOf(hooks)(
        {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: toolInput,
            tool_use_id: "tu-1",
            session_id: "3f2a9b1c-0000-0000-0000-000000000000",
            transcript_path: "/tmp/t",
            cwd: "/work",
        },
        "tu-1",
        { signal: new AbortController().signal },
    );

const rewritten = async (toolInput: unknown, hooks?: ReturnType<typeof bashTmuxHooks>): Promise<string | undefined> => {
    const specific = syncHookOutput(await preToolUse(toolInput, hooks)).hookSpecificOutput;
    const updated = specific?.hookEventName === "PreToolUse" ? specific.updatedInput : undefined;
    return updated?.["command"] as string | undefined;
};

test("wraps the command in tmux-run under the session's agent-* tmux session, demoted", async () => {
    const command = await rewritten({ command: "echo hi", description: "Say Hi!" });
    expect(command).toBe(`/usr/local/bin/tmux-run agent-3f2a9b1c ${shellQuote(demoted("echo hi"))} say-hi`);
});

test("single-quotes in the command survive the rewrite", async () => {
    const command = await rewritten({ command: "echo 'a b'" });
    expect(command).toBe(`/usr/local/bin/tmux-run agent-3f2a9b1c ${shellQuote(demoted("echo 'a b'"))} run`);
});

test("keeps the tool input's other fields", async () => {
    const specific = syncHookOutput(await preToolUse({ command: "sleep 1", run_in_background: true, timeout: 5000 })).hookSpecificOutput;
    const updated = specific?.hookEventName === "PreToolUse" ? specific.updatedInput : undefined;
    expect(updated?.["run_in_background"]).toBe(true);
    expect(updated?.["timeout"]).toBe(5000);
});

test("leaves non-string commands and already-wrapped commands alone", async () => {
    expect(await preToolUse({ command: 42 })).toEqual({});
    expect(await preToolUse({ command: "/usr/local/bin/tmux-run agent-x 'ls' run" })).toEqual({});
    expect(await preToolUse({ command: "/usr/local/bin/tmux-run -e FOO agent-x 'ls' run" }, bashTmuxHooks(undefined, ["FOO"]))).toEqual({});
});

test("forwards env key NAMES as sorted -e flags before the session — never values", async () => {
    const hooks = bashTmuxHooks(undefined, ["IMAP_PASSWORD_IMAP", "DISCORD_BOT_TOKEN_DISCORD"]);
    const command = await rewritten({ command: "echo hi", description: "Say Hi!" }, hooks);
    expect(command).toBe(
        `/usr/local/bin/tmux-run -e DISCORD_BOT_TOKEN_DISCORD -e IMAP_PASSWORD_IMAP agent-3f2a9b1c ${shellQuote(demoted("echo hi"))} say-hi`,
    );
});

test("drops env keys that are not plain identifiers — they land unquoted in every rewritten command", async () => {
    const hooks = bashTmuxHooks(undefined, ["PATH", "bad key", "1BAD", "A=B"]);
    const command = await rewritten({ command: "echo hi" }, hooks);
    expect(command).toBe(`/usr/local/bin/tmux-run -e PATH agent-3f2a9b1c ${shellQuote(demoted("echo hi"))} run`);
});

test("agentSessionName derives the same agent-* name the hook routes commands through", () => {
    expect(agentSessionName("3f2a9b1c-0000-0000-0000-000000000000")).toBe("agent-3f2a9b1c");
    // Empty after sanitizing the charset ⇒ no valid session name.
    expect(agentSessionName("!@#$")).toBeUndefined();
    expect(agentSessionName("")).toBeUndefined();
});

test("an isolated turn's Bash joins the turn's namespace, inside the tmux wrapper", async () => {
    const plan = { worktree: "/history/worktrees/abc", root: "/work", mirrors: [], overlays: "/history/overlays/abc" };
    const anchor = { pid: 4321, cwd: "/work", plan, dispose: () => {} };
    const command = await rewritten({ command: "sed -i s/a/b/ x.ts", description: "edit" }, bashTmuxHooks(undefined, [], { plan, anchor }));
    // tmux-run stays OUTSIDE: the server, the pane logs and the terminals panel are daemon-side, and only the
    // command the pane runs crosses into the namespace (with the demotion, which is the command's own).
    // Without this, `sed -i` would rewrite the shared tree while the same turn's Edit tool wrote to the worktree.
    expect(command).toBe(
        `/usr/local/bin/tmux-run agent-3f2a9b1c ${shellQuote(`nsenter --mount=/proc/4321/ns/mnt --wd='/work' -- ${demoted("sed -i s/a/b/ x.ts")}`)} edit`,
    );
});

test("the rtk backend prefixes commands rtk can exec — including chains whose first segment it filters", async () => {
    expect(await rewritten({ command: "git status" }, bashTmuxHooks("rtk"))).toContain("'rtk git status'");
    expect(await rewritten({ command: "git add . && git push" }, bashTmuxHooks("rtk"))).toContain("'rtk git add . && git push'");
});

test("the rtk backend leaves shell-interpreted commands bare — rtk execs its argument, so a builtin, keyword or assignment first word would die with exit 127", async () => {
    for (const command of [
        "cd /tmp && git status",
        "export FOO=1",
        "for f in *; do echo $f; done",
        "FOO=1 pnpm test",
        "(cd /tmp && ls)",
        "! grep -q x file",
    ]) {
        expect(await rewritten({ command }, bashTmuxHooks("rtk"))).toContain(`'${command.replaceAll("'", `'\\''`)}'`);
        expect(await rewritten({ command }, bashTmuxHooks("rtk"))).not.toContain("rtk");
    }
});

// The master "Clean command output" switch, off: it beats the backend choice, so rtk does not get to compress
// anyway. Without this the switch was inert under rtk — the UI greyed it out and the owner had no way to see
// raw output at all.
test("cleaning switched off leaves the command bare on the rtk backend too", async () => {
    expect(await rewritten({ command: "git status" }, bashTmuxHooks("none"))).toContain("'git status'");
    expect(await rewritten({ command: "git status" }, bashTmuxHooks("none"))).not.toContain("rtk");
});

test("the rtk backend's prefix rides inside the namespace with the command it wraps", async () => {
    const plan = { worktree: "/wt", root: "/work", mirrors: [], overlays: "/history/overlays/abc" };
    const command = await rewritten({ command: "ls" }, bashTmuxHooks("rtk", [], { plan, anchor: { pid: 9, cwd: "/work", plan, dispose: () => {} } }));
    expect(command).toContain(`bash -c '\\''rtk ls'\\''`);
    // rtk is the agent's own command line, so it must not run outside the tree the agent is working in.
    expect(command).not.toContain("-- rtk");
});

/* The no-namespace fallback. A container without CAP_SYS_ADMIN cannot build the mounts, and a Bash tool left
 * alone there writes the SHARED tree at the same absolute path whose Edit went to the worktree — the exact
 * disagreement the nsenter hop above exists to prevent. The rewrite is the same substitution by other means. */
test("without an anchor, an isolated turn's Bash has its main-tree paths rewritten into the worktree", async () => {
    const plan = { worktree: "/history/worktrees/abc", root: "/work", mirrors: ["intentic/node_modules"], overlays: "/history/overlays/abc" };
    const command = await rewritten({ command: "sed -i s/a/b/ /work/intentic/x.ts" }, bashTmuxHooks(undefined, [], { plan }));
    expect(command).toContain("/history/worktrees/abc/intentic/x.ts");
    expect(command).not.toContain("/work/intentic/x.ts");
    // No namespace to join, so nothing wraps the command — only its paths moved.
    expect(command).not.toContain("nsenter");
});

test("the Bash rewrite leaves the shared subtrees and any path that merely starts with the root alone", async () => {
    const plan = { worktree: "/wt", root: "/work", mirrors: ["intentic/node_modules"], overlays: "/history/overlays/abc" };
    const rewrite = async (command: string): Promise<string | undefined> => rewritten({ command }, bashTmuxHooks(undefined, [], { plan }));
    // Dependency trees and daemon state resolve to the main checkout on both sides — redirecting them would
    // aim at a path the worktree does not have.
    expect(await rewrite("/work/intentic/node_modules/.bin/tsgo")).toContain("/work/intentic/node_modules/.bin/tsgo");
    expect(await rewrite("cat /work/.intentic/settings.json")).toContain("/work/.intentic/settings.json");
    // The deliberate main-tree door, and a look-alike that is not the root at all.
    expect(await rewrite("diff /mnt/intentic-main/x /work/x")).toContain("/mnt/intentic-main/x /wt/x");
    expect(await rewrite("ls ./workspace")).toContain("./workspace");
});
