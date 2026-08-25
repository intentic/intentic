import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { expect, test } from "vitest";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { syncHookOutput } from "../testing.js";
import { bashTmuxHooks } from "./agent-terminals.js";

// What the hook makes of the agent's command line before tmux-run sees it: demoted (nice/ionice, priorities
// only bind under contention, and agent builds are what has starved the daemon) and run as ONE bash -c tree.
const demoted = (command: string): string => `nice -n 10 ionice -c 2 -n 7 bash -c ${shellQuote(command)}`;

// …and born carrying the conversation it came from, which every process it forks inherits: what lets a daemon
// an agent started from source see that it is a run of the code and not this sandbox's own (container-owner.ts).
const born = (inner: string): string => `INTENTIC_AGENT_SESSION=${shellQuote("3f2a9b1c-0000-0000-0000-000000000000")} ${inner}`;

// The whole line the hook emits. `-c` carries the agent's OWN command for the output filter: cleaner matching
// and the un-cleaned-commands report are both properties of that line, and neither survives the wrapping that
// follows it. Then the session, the wrapped command the pane actually runs, and the window name.
const wrap = (agentCommand: string, inner: string, name: string, envFlags = ``): string =>
    `/usr/local/bin/tmux-run ${envFlags}-c ${shellQuote(agentCommand)} agent-3f2a9b1c ${shellQuote(inner)} ${name}`;

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
            cwd: WORKSPACE_ROOT,
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
    expect(command).toBe(wrap("echo hi", born(demoted("echo hi")), "say-hi"));
});

test("single-quotes in the command survive the rewrite", async () => {
    const command = await rewritten({ command: "echo 'a b'" });
    expect(command).toBe(wrap("echo 'a b'", born(demoted("echo 'a b'")), "run"));
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
    expect(await preToolUse({ command: "/usr/local/bin/tmux-run -e FOO agent-x 'ls' run" }, bashTmuxHooks(["FOO"]))).toEqual({});
});

test("stamps the pane command with the conversation owner, and refuses one outside the safe charset", async () => {
    // The owner rides beside the session stamp, so a pane's whole tree is attributable to its conversation
    // (the reaper's licence over `setsid` survivors: platform/reaper.ts).
    const owned = await rewritten({ command: "echo hi" }, bashTmuxHooks([], undefined, "conv-1"));
    expect(owned).toBe(
        wrap(
            "echo hi",
            `INTENTIC_AGENT_SESSION=${shellQuote("3f2a9b1c-0000-0000-0000-000000000000")} INTENTIC_TURN_OWNER=conv-1 ${demoted("echo hi")}`,
            "run",
        ),
    );
    // It lands unquoted-adjacent in the shell line every command flows through, so a hostile id stays out.
    const unsafe = await rewritten({ command: "echo hi" }, bashTmuxHooks([], undefined, "conv;rm -rf /"));
    expect(unsafe).toBe(wrap("echo hi", born(demoted("echo hi")), "run"));
});

test("forwards env key NAMES as sorted -e flags before the session: never values", async () => {
    const hooks = bashTmuxHooks(["IMAP_PASSWORD_IMAP", "DISCORD_BOT_TOKEN_DISCORD"]);
    const command = await rewritten({ command: "echo hi", description: "Say Hi!" }, hooks);
    expect(command).toBe(wrap("echo hi", born(demoted("echo hi")), "say-hi", "-e DISCORD_BOT_TOKEN_DISCORD -e IMAP_PASSWORD_IMAP "));
});

test("drops env keys that are not plain identifiers: they land unquoted in every rewritten command", async () => {
    const hooks = bashTmuxHooks(["PATH", "bad key", "1BAD", "A=B"]);
    const command = await rewritten({ command: "echo hi" }, hooks);
    expect(command).toBe(wrap("echo hi", born(demoted("echo hi")), "run", "-e PATH "));
});

test("agentSessionName derives the same agent-* name the hook routes commands through", () => {
    expect(agentSessionName("3f2a9b1c-0000-0000-0000-000000000000")).toBe("agent-3f2a9b1c");
    // Empty after sanitizing the charset ⇒ no valid session name.
    expect(agentSessionName("!@#$")).toBeUndefined();
    expect(agentSessionName("")).toBeUndefined();
});

test("an isolated turn's Bash joins the turn's namespace, inside the tmux wrapper", async () => {
    const plan = { worktree: `${HISTORY_ROOT}/worktrees/abc`, root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/abc` };
    const anchor = { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} };
    const command = await rewritten({ command: "sed -i s/a/b/ x.ts", description: "edit" }, bashTmuxHooks([], { plan, anchor }));
    // tmux-run stays OUTSIDE: the server, the pane logs and the terminals panel are daemon-side, and only the
    // command the pane runs crosses into the namespace (with the demotion, which is the command's own).
    // Without this, `sed -i` would rewrite the shared tree while the same turn's Edit tool wrote to the worktree.
    expect(command).toBe(
        wrap("sed -i s/a/b/ x.ts", born(`nsenter --mount=/proc/4321/ns/mnt --wdns=${shellQuote("/work")} -- ${demoted("sed -i s/a/b/ x.ts")}`), "edit"),
    );
});

/* WHAT THE OUTPUT FILTER IS TOLD THIS COMMAND IS. The heaviest wrapping there is: a namespace hop with a
 * per-turn pid in it, then the demotion, then `bash -c`: sits between the agent's words and the string the
 * pane runs, and the filter both matches cleaners against that string and records it. Reading the wrapped one
 * put ~100 characters of daemon boilerplate at the head of every ledger row and a pid that made no two rows
 * groupable, which emptied the settings page's "un-cleaned (add a handler)" list of anything actionable. */
test("-c carries the agent's own command, never the wrapper the pane runs", async () => {
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/abc` };
    const anchor = { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} };
    const command = await rewritten({ command: "grep -rn needle src", description: "search" }, bashTmuxHooks([], { plan, anchor }));
    expect(command?.startsWith("/usr/local/bin/tmux-run -c 'grep -rn needle src' ")).toBe(true);
    // The wrapper is still what runs: it just no longer stands in for the command in the ledger.
    expect(command).toContain("nsenter --mount=/proc/4321/ns/mnt");
});

// Unanchored isolation rewrites paths into the worktree, and `-c` follows: the redirected line is the one that
// actually ran, so it is the one the cleaners should be matched against and the one worth reporting.
test("-c carries the redirected command when an isolated turn has no namespace to join", async () => {
    const plan = { worktree: `${HISTORY_ROOT}/worktrees/abc`, root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/abc` };
    const command = await rewritten({ command: "wc -l /work/intentic/x.ts" }, bashTmuxHooks([], { plan }));
    expect(command?.startsWith("/usr/local/bin/tmux-run -c 'wc -l /history/worktrees/abc/intentic/x.ts' ")).toBe(true);
});

/* The no-namespace fallback. A container without CAP_SYS_ADMIN cannot build the mounts, and a Bash tool left
 * alone there writes the SHARED tree at the same absolute path whose Edit went to the worktree: the exact
 * disagreement the nsenter hop above exists to prevent. The rewrite is the same substitution by other means. */
test("without an anchor, an isolated turn's Bash has its main-tree paths rewritten into the worktree", async () => {
    const plan = {
        worktree: `${HISTORY_ROOT}/worktrees/abc`,
        root: WORKSPACE_ROOT,
        mirrors: ["intentic/node_modules"],
        overlays: `${HISTORY_ROOT}/overlays/abc`,
    };
    const command = await rewritten({ command: "sed -i s/a/b/ /work/intentic/x.ts" }, bashTmuxHooks([], { plan }));
    expect(command).toContain("/history/worktrees/abc/intentic/x.ts");
    expect(command).not.toContain("/work/intentic/x.ts");
    // No namespace to join, so nothing wraps the command: only its paths moved.
    expect(command).not.toContain("nsenter");
});

test("the Bash rewrite leaves the shared subtrees and any path that merely starts with the root alone", async () => {
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: ["intentic/node_modules"], overlays: `${HISTORY_ROOT}/overlays/abc` };
    const rewrite = async (command: string): Promise<string | undefined> => rewritten({ command }, bashTmuxHooks([], { plan }));
    // Dependency trees and daemon state resolve to the main checkout on both sides: redirecting them would
    // aim at a path the worktree does not have.
    expect(await rewrite("/work/intentic/node_modules/.bin/tsgo")).toContain("/work/intentic/node_modules/.bin/tsgo");
    expect(await rewrite("cat /work/.intentic/config/settings.json")).toContain("/work/.intentic/config/settings.json");
    // The deliberate main-tree door, and a look-alike that is not the root at all.
    expect(await rewrite("diff /mnt/intentic-main/x /work/x")).toContain("/mnt/intentic-main/x /wt/x");
    expect(await rewrite("ls ./workspace")).toContain("./workspace");
});

/* THE BADGE IS ON EVERY COMMAND, not just the interesting ones: what reads it is a process nobody here knows
 * about (a server, a test harness, a `tsx src/main.ts` of this very daemon) deciding whether it is allowed to
 * behave like this sandbox's own. Twice on 2026-08-11 a daemon started from a session swept the live one's
 * processes and took four turns down with it, so "was I started from inside a conversation" has to be a
 * question anything forked from here can answer, however many levels down it sits. */
test("every command is born carrying the conversation that ran it, ahead of the namespace hop", async () => {
    expect(await rewritten({ command: "echo hi" })).toContain(born("nice"));

    // An env assignment is a shell construct: placed after nsenter it would be exec'd as a program name.
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: [], overlays: "/ov" };
    const anchored = await rewritten(
        { command: "pnpm exec tsx src/main.ts" },
        bashTmuxHooks([], { plan, anchor: { pid: 4242, cwd: WORKSPACE_ROOT, plan, dispose: () => {} } }),
    );
    expect(anchored).toContain(born("nsenter"));
});

