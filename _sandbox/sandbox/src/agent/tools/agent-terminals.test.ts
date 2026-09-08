import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { expect, test } from "vitest";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { syncHookOutput } from "../../testing.js";
import { DEFAULT_HEAVY_COMMANDS, type HeavyCommands, HeavyCommandsSchema } from "../../platform/resources/heavy-commands.js";
import type { SecretAccess } from "./agent-secrets.js";
import { bashTmuxHooks } from "./agent-terminals.js";

// Demotes a command via nice/ionice and runs it as one `bash -c` tree, before tmux-run sees it.
const demoted = (command: string): string => `nice -n 10 ionice -c 2 -n 7 bash -c ${shellQuote(command)}`;

// Carries the conversation id; every forked process inherits it, marking the run as agent-started, not the sandbox's
// own.
const born = (inner: string): string => `INTENTIC_AGENT_SESSION=${shellQuote("3f2a9b1c-0000-0000-0000-000000000000")} ${inner}`;

// The full line the hook emits: `-c` carries the agent's own command for the output filter, then the session, the
// wrapped command, and the window name.
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
    // INTENTIC_TURN_OWNER stamps the pane so its whole process tree is attributable to the conversation.
    const owned = await rewritten({ command: "echo hi" }, bashTmuxHooks([], undefined, "conv-1"));
    expect(owned).toBe(
        wrap(
            "echo hi",
            `INTENTIC_AGENT_SESSION=${shellQuote("3f2a9b1c-0000-0000-0000-000000000000")} INTENTIC_TURN_OWNER=conv-1 ${demoted("echo hi")}`,
            "run",
        ),
    );
    // Unquoted in the shell line, so an id with unsafe characters is dropped rather than substituted.
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
    // tmux-run stays outside the namespace; only the command the pane runs crosses in, already demoted.
    expect(command).toBe(
        wrap(
            "sed -i s/a/b/ x.ts",
            // Unsets PWD/OLDPWD, whose daemon-side values would resolve relative paths outside the mirrors.
            born(`nsenter --mount=/proc/4321/ns/mnt --wdns=${shellQuote("/work")} -- env -u PWD -u OLDPWD ${demoted("sed -i s/a/b/ x.ts")}`),
            "edit",
        ),
    );
});

// `-c` carries the agent's own command, not the wrapped line the pane actually runs: the output filter matches cleaners
// against and records that string.
test("-c carries the agent's own command, never the wrapper the pane runs", async () => {
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/abc` };
    const anchor = { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} };
    const command = await rewritten({ command: "grep -rn needle src", description: "search" }, bashTmuxHooks([], { plan, anchor }));
    expect(command?.startsWith("/usr/local/bin/tmux-run -c 'grep -rn needle src' ")).toBe(true);
    // The wrapper is still what runs: it just no longer stands in for the command in the ledger.
    expect(command).toContain("nsenter --mount=/proc/4321/ns/mnt");
});

// Unanchored isolation rewrites paths into the worktree; `-c` follows, since the redirected line is the one that
// actually ran.
test("-c carries the redirected command when an isolated turn has no namespace to join", async () => {
    const plan = { worktree: `${HISTORY_ROOT}/worktrees/abc`, root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/abc` };
    const command = await rewritten({ command: "wc -l /work/intentic/x.ts" }, bashTmuxHooks([], { plan }));
    expect(command?.startsWith("/usr/local/bin/tmux-run -c 'wc -l /history/worktrees/abc/intentic/x.ts' ")).toBe(true);
});

// No-namespace fallback: without CAP_SYS_ADMIN the mounts cannot be built, so paths are substituted directly instead of
// via nsenter.
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
    // Dependency trees and the untracked state dir resolve to the main checkout, not the worktree.
    expect(await rewrite("/work/intentic/node_modules/.bin/tsgo")).toContain("/work/intentic/node_modules/.bin/tsgo");
    expect(await rewrite("cat /work/.intentic/records/sessions/claude/projects/x.jsonl")).toContain(
        "/work/.intentic/records/sessions/claude/projects/x.jsonl",
    );
    // `.intentic/config` is tracked and moves with the root, unlike the untracked paths above.
    expect(await rewrite("cat /work/.intentic/config/settings.json")).toContain("/wt/.intentic/config/settings.json");
    // `/mnt/intentic-main` is a deliberate main-tree door; `./workspace` only looks like the root.
    expect(await rewrite("diff /mnt/intentic-main/x /work/x")).toContain("/mnt/intentic-main/x /wt/x");
    expect(await rewrite("ls ./workspace")).toContain("./workspace");
});

// The badge marks every command, not just risky ones: anything forked from here, however many levels down, must be able
// to tell it started inside a conversation.
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

// Position of the heavy-command queue is what these tests pin:
// - inside the namespace hop, not queued against the wrong tree
// - inside the demotion, not at normal priority
// - outside `bash -c`, not inside an already-forked shell

const heavy = (over: Partial<HeavyCommands> = {}) => {
    const config = HeavyCommandsSchema.parse({ ...DEFAULT_HEAVY_COMMANDS, ...over });
    return () => Promise.resolve(config);
};

// The demoted form, with the queue between demotion and shell: position is the assertion.
const queued = (command: string, label: string, pool = "heavy", limit = 2): string =>
    `nice -n 10 ionice -c 2 -n 7 /usr/local/bin/queue-run --pool ${shellQuote(pool)} --limit ${String(limit)} --wait 900 --memory-gate 120 --label ${shellQuote(label)} -- bash -c ${shellQuote(command)}`;

test("a heavy command is queued, between the demotion and the shell it runs in", async () => {
    const command = await rewritten({ command: "pnpm test" }, bashTmuxHooks([], undefined, undefined, undefined, heavy()));
    expect(command).toBe(wrap("pnpm test", born(queued("pnpm test", "package-script")), "run"));
});

test("an ordinary command is not queued at all", async () => {
    // Ordinary commands get no wrapper, no lock file, no extra process.
    const command = await rewritten({ command: "git status" }, bashTmuxHooks([], undefined, undefined, undefined, heavy()));
    expect(command).not.toContain("queue-run");
    expect(command).toBe(wrap("git status", born(demoted("git status")), "run"));
});

test("a sandbox with no queue configured rewrites exactly as it always did", async () => {
    // Without bin/queue-run baked into the image, queueRunEnabled() is false and nothing is queued.
    expect(await rewritten({ command: "pnpm test" })).toBe(wrap("pnpm test", born(demoted("pnpm test")), "run"));
});

test("the queue rides inside the namespace hop, so its slot is held in the tree the command runs in", async () => {
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: [], overlays: "/ov" };
    const command = await rewritten(
        { command: "pnpm test" },
        bashTmuxHooks([], { plan, anchor: { pid: 4242, cwd: WORKSPACE_ROOT, plan, dispose: () => {} } }, undefined, undefined, heavy()),
    );
    expect(command).toContain("nsenter");
    expect(command?.indexOf("nsenter")).toBeLessThan(command?.indexOf("queue-run") ?? -1);
});

test("the agent's own line still reaches the output filter unwrapped", async () => {
    // `-c` feeds cleaner matching and the un-cleaned-commands report; the queue must not appear there either.
    const command = await rewritten({ command: "pnpm test" }, bashTmuxHooks([], undefined, undefined, undefined, heavy()));
    expect(command).toContain(`-c ${shellQuote("pnpm test")} agent-3f2a9b1c`);
});

test("a pool or label out of the config file is quoted, not interpreted", async () => {
    // Config values are agent-writable and reach `bash -c`; treated as data only, never as code.
    const label = "x'; touch /tmp/pwned; '";
    const nasty = heavy({ rules: [{ id: label, pattern: "\\bmake\\b", pool: "$(id)" }] });
    const command = await rewritten({ command: "make all" }, bashTmuxHooks([], undefined, undefined, undefined, nasty));
    // Exact match: quoting only proves itself against the whole line, both values surviving two levels of it.
    expect(command).toBe(wrap("make all", born(queued("make all", label, "$(id)")), "run"));
    expect(command).not.toContain("--pool $(id) ");
    expect(command).not.toContain("touch /tmp/pwned; ' --limit");
});

test("matching reads the agent's reference form, never the resolved secret", async () => {
    // Order matters: heavy-command matching must run before secret resolution, or a resolved credential could reach a
    // user-authored regex or a logged rule id.
    const bundle: SecretAccess = {
        list: async () => [{ name: "TOKEN", value: "pnpm test", source: "env" }],
        used: () => {},
        release: async () => ({ ok: true }),
    };
    const reference = `{{secret:${"TOKEN"}}}`;
    const command = await rewritten({ command: `curl -H ${reference}` }, bashTmuxHooks([], undefined, undefined, bundle, heavy()));
    // The pane's line does carry the resolved value; only the earlier reference form decided whether to queue.
    expect(command).toContain("pnpm test");
    expect(command).not.toContain("queue-run");
});

test("a config that cannot be read costs the command nothing", async () => {
    // The store falls back to the shipped rules; a further throw drops the queue rather than failing the tool call.
    const command = await rewritten(
        { command: "pnpm test" },
        bashTmuxHooks([], undefined, undefined, undefined, () => Promise.reject(new Error("nope"))),
    );
    expect(command).toBe(wrap("pnpm test", born(demoted("pnpm test")), "run"));
});
