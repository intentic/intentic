import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { mergeHeavyRules, type HeavyCommandOverrides } from "@intentic/constants/heavy-rules";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { syncHookOutput, memoryFleet } from "../../testing.js";
import { OOM_SCORE, priorityOf } from "../../workload/workload-class.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import { queueRunEnabled } from "../../system/resources/heavy-commands.js";
import { bashTmuxHooks, NO_PROMPTS, PIPESTATUS_TRAP, softTimeoutOf } from "./agent-terminals.js";
import { backgroundJobOf, type BackgroundJob, noteJobShell, settledBackgroundJobs } from "./jobs/background-jobs.js";

// One fleet's actors, and the cards a turn here parks in them.
const actors = memoryFleet().conversations;

// The command's own file, as the pane runs it: behind the trap that records its last pipeline's statuses.
const script = (command: string): string => `${PIPESTATUS_TRAP}${command}\n`;

// Demotes a command via nice/ionice and ranks it for the OOM killer, turns off the prompts that wait in a pane for good,
// then `bash` runs its file, before tmux-run sees it.
const demoted = (file: string, heavyEnv = ""): string =>
    `nice -n 19 ionice -c 2 -n 7 choom -n ${String(OOM_SCORE.command)} -- ${NO_PROMPTS}${heavyEnv}bash ${shellQuote(file)}`;

// Carries the conversation id; every forked process inherits it, marking the run as agent-started, not the sandbox's
// own.
const born = (inner: string): string => `INTENTIC_AGENT_SESSION=${shellQuote("3f2a9b1c-0000-0000-0000-000000000000")} ${inner}`;

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

// What the hook handed tmux-run: the command it rewrote the call to, and the files beside `line` it named with `-f`.
interface Handover {
    readonly command: string;
    readonly dir: string;
    readonly line: string;
    readonly agent: string;
    readonly said: string;
    readonly name: string;
}

const handover = async (toolInput: unknown, hooks?: ReturnType<typeof bashTmuxHooks>): Promise<Handover> => {
    const command = (await rewritten(toolInput, hooks)) ?? "";
    const file = / -f (\S+) /u.exec(command)?.[1] ?? "";
    const dir = dirname(file.replaceAll("'", ""));
    const read = (name: string): string => readFileSync(join(dir, name), "utf8");
    const files = { command, dir, line: read("line"), agent: read("agent"), said: read("said"), name: read("name") };
    rmSync(dir, { recursive: true, force: true });
    return files;
};

// The whole rewritten call: tmux-run, the env flags, then the one file every other fact about the command is in.
const call = (dir: string, envFlags = ""): string => `/usr/local/bin/tmux-run ${envFlags}-f ${shellQuote(join(dir, "line"))} agent-3f2a9b1c`;

test("wraps the command in tmux-run under the session's agent-* tmux session, demoted, handed over by file", async () => {
    const files = await handover({ command: "echo hi", description: "Say Hi!" });
    expect(files).toEqual({
        command: call(files.dir),
        dir: files.dir,
        line: `${born(demoted(join(files.dir, "agent")))}\n`,
        agent: script("echo hi"),
        said: "echo hi",
        name: "say-hi",
    });
    expect(files.dir).toStartWith(join(tmpdir(), "intentic-run-"));
});

test("single-quotes in the command survive the handover, which quotes nothing", async () => {
    const files = await handover({ command: "echo 'a b'" });
    expect([files.agent, files.said, files.name]).toEqual([script("echo 'a b'"), "echo 'a b'", "run"]);
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
    const owned = await handover({ command: "echo hi" }, bashTmuxHooks([], undefined, "conv-1"));
    expect(owned.line).toBe(
        `INTENTIC_AGENT_SESSION=${shellQuote("3f2a9b1c-0000-0000-0000-000000000000")} INTENTIC_TURN_OWNER=conv-1 ${demoted(join(owned.dir, "agent"))}\n`,
    );
    // Unquoted in the shell line, so an id with unsafe characters is dropped rather than substituted.
    const unsafe = await handover({ command: "echo hi" }, bashTmuxHooks([], undefined, "conv;rm -rf /"));
    expect(unsafe.line).toBe(`${born(demoted(join(unsafe.dir, "agent")))}\n`);
});

// A background job is the one command whose pane must outlive the turn's CLI, so it carries `-b <dir>`: that flag is
// what stops tmux-run killing the pane when the turn's exit SIGTERMs the wrapper, and the dir is where the daemon
// reads the completion nobody is left to see. The command's files go in that same dir.
test("a background command carries a job dir, holds its files, and is filed for the turn's ending to adopt", async () => {
    const jobs = { conversationId: "conv-bg", profile: {}, conversations: actors };
    const command = await rewritten(
        { command: "pnpm build", description: "Build the app", run_in_background: true },
        bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, jobs),
    );
    const dir = /tmux-run -b (\S+) -f /.exec(command ?? "")?.[1] ?? "";
    expect(dir).toStartWith(join(tmpdir(), "intentic-run-job-"));
    expect(command).toBe(`/usr/local/bin/tmux-run -b ${shellQuote(dir)} -f ${shellQuote(join(dir, "line"))} agent-3f2a9b1c`);
    expect(readFileSync(join(dir, "agent"), "utf8")).toBe(script("pnpm build"));
    noteJobShell(actors, "tu-1", "bsh42");
    expect(backgroundJobOf(actors, "conv-bg", "bsh42")?.dir).toBe(dir);
    // What tmux-run writes first (the handover's own file is `line`, so its presence says nothing about a start);
    // without it the settle would read the job as one that never ran.
    writeFileSync(join(dir, "cmd"), "pnpm build\n");
    // The registry holds the same job, so the settle that follows can hand it to a watch.
    const filed = settledBackgroundJobs(actors, "conv-bg").running;
    expect(filed.map((job: BackgroundJob) => job.dir)).toEqual([dir]);
    expect(filed[0]?.command).toBe("pnpm build");
    // What the chat shows the job as: the agent's own words for the call, not its command.
    expect(filed[0]?.label).toBe("Build the app");
    rmSync(dir, { recursive: true, force: true });
});

test("an ordinary command, and a background one with nowhere to deliver a wake, carry no job dir", async () => {
    const jobs = { conversationId: "conv-bg-none", profile: {}, conversations: actors };
    // Foreground: dies with the turn as everything else does, which is what its timeout semantics need.
    expect((await handover({ command: "pnpm build" }, bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, jobs))).command).not.toContain(
        "-b ",
    );
    // No conversation: a job that outlived the turn would have nobody to report to.
    expect((await handover({ command: "pnpm build", run_in_background: true })).command).not.toContain("-b ");
    expect(settledBackgroundJobs(actors, "conv-bg-none")).toEqual({ running: [], unseen: [] });
});

test("forwards env key NAMES as sorted -e flags before the file: never values", async () => {
    const files = await handover({ command: "echo hi", description: "Say Hi!" }, bashTmuxHooks(["IMAP_PASSWORD_IMAP", "DISCORD_BOT_TOKEN_DISCORD"]));
    expect(files.command).toBe(call(files.dir, "-e DISCORD_BOT_TOKEN_DISCORD -e IMAP_PASSWORD_IMAP "));
});

test("drops env keys that are not plain identifiers: they land unquoted in every rewritten command", async () => {
    const files = await handover({ command: "echo hi" }, bashTmuxHooks(["PATH", "bad key", "1BAD", "A=B"]));
    expect(files.command).toBe(call(files.dir, "-e PATH "));
});

test("agentSessionName derives the same agent-* name the hook routes commands through", () => {
    expect(agentSessionName("3f2a9b1c-0000-0000-0000-000000000000")).toBe("agent-3f2a9b1c");
    // Empty after sanitizing the charset ⇒ no valid session name.
    expect(agentSessionName("!@#$")).toBeUndefined();
    expect(agentSessionName("")).toBeUndefined();
});

test("an isolated turn's Bash joins the turn's namespace, inside the tmux wrapper", async () => {
    const plan = {
        worktree: `${HISTORY_ROOT}/worktrees/abc`,
        root: WORKSPACE_ROOT,
        mirrors: [],
        overlays: `${HISTORY_ROOT}/overlays/abc`,
        fence: undefined,
    };
    const anchor = { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} };
    const files = await handover({ command: "sed -i s/a/b/ x.ts", description: "edit" }, bashTmuxHooks([], { plan, anchor }));
    // tmux-run stays outside the namespace; only the line the pane runs crosses in, already demoted.
    expect(files.line).toBe(
        // Unsets PWD/OLDPWD, whose daemon-side values would resolve relative paths outside the mirrors.
        `${born(`nsenter --mount=/proc/4321/ns/mnt --wdns=${shellQuote("/work")} -- env -u PWD -u OLDPWD ${demoted(join(files.dir, "agent"))}`)}\n`,
    );
    expect(files.agent).toBe(script("sed -i s/a/b/ x.ts"));
});

// `said` is the agent's own command, not the wrapped line the pane actually runs: the output filter matches cleaners
// against and records that string.
test("the filter's words are the agent's own command, never the wrapper the pane runs", async () => {
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/abc`, fence: undefined };
    const anchor = { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} };
    const files = await handover({ command: "grep -rn needle src", description: "search" }, bashTmuxHooks([], { plan, anchor }));
    expect(files.said).toBe("grep -rn needle src");
    // The wrapper is still what runs: it just no longer stands in for the command in the ledger.
    expect(files.line).toContain("nsenter --mount=/proc/4321/ns/mnt");
});

// Unanchored isolation rewrites paths into the worktree; the words follow, since the redirected line is what ran.
test("the filter's words are the redirected command when an isolated turn has no namespace to join", async () => {
    const plan = {
        worktree: `${HISTORY_ROOT}/worktrees/abc`,
        root: WORKSPACE_ROOT,
        mirrors: [],
        overlays: `${HISTORY_ROOT}/overlays/abc`,
        fence: undefined,
    };
    const files = await handover({ command: "wc -l /work/intentic/x.ts" }, bashTmuxHooks([], { plan }));
    expect(files.said).toBe("wc -l /history/worktrees/abc/intentic/x.ts");
});

// No-namespace fallback: without CAP_SYS_ADMIN the mounts cannot be built, so paths are substituted directly instead of
// via nsenter.
test("without an anchor, an isolated turn's Bash has its main-tree paths rewritten into the worktree", async () => {
    const plan = {
        worktree: `${HISTORY_ROOT}/worktrees/abc`,
        root: WORKSPACE_ROOT,
        mirrors: ["intentic/node_modules"],
        overlays: `${HISTORY_ROOT}/overlays/abc`,
        fence: undefined,
    };
    const files = await handover({ command: "sed -i s/a/b/ /work/intentic/x.ts" }, bashTmuxHooks([], { plan }));
    expect(files.agent).toBe(script("sed -i s/a/b/ /history/worktrees/abc/intentic/x.ts"));
    // No namespace to join, so nothing wraps the command: only its paths moved.
    expect(files.line).not.toContain("nsenter");
});

test("the Bash rewrite leaves the shared subtrees and any path that merely starts with the root alone", async () => {
    const plan = {
        worktree: "/wt",
        root: WORKSPACE_ROOT,
        mirrors: ["intentic/node_modules"],
        overlays: `${HISTORY_ROOT}/overlays/abc`,
        fence: undefined,
    };
    const rewrite = async (command: string): Promise<string> => (await handover({ command }, bashTmuxHooks([], { plan }))).agent;
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
    expect((await handover({ command: "echo hi" })).line).toContain(born("nice"));

    // An env assignment is a shell construct: placed after nsenter it would be exec'd as a program name.
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: [], overlays: "/ov", fence: undefined };
    const anchored = await handover(
        { command: "pnpm exec tsx src/main.ts" },
        bashTmuxHooks([], { plan, anchor: { pid: 4242, cwd: WORKSPACE_ROOT, plan, dispose: () => {} } }),
    );
    expect(anchored.line).toContain(born("nsenter"));
});

// THE HEAVY TABLE RIDES DOWN; NOTHING IS DECIDED FROM THE LINE. Whether a program queues is judged as it starts
// (@intentic/constants heavy-hook.cjs, heavy-exec.cjs): here the hook only hands every program of the line the table,
// inside the namespace hop and the demotion, so what it starts is judged in the tree it runs in.

const heavy = (overrides: HeavyCommandOverrides = {}) => {
    const config = mergeHeavyRules(overrides);
    return () => Promise.resolve(config);
};

// The JSON table a line carries, read back out of its INTENTIC_HEAVY assignment.
const tableOf = (line: string): Record<string, unknown> => {
    const quoted = /INTENTIC_HEAVY=('(?:[^']|'\\'')*')/u.exec(line)?.[1] ?? "''";
    return JSON.parse(quoted.slice(1, -1).replaceAll(`'\\''`, "'")) as Record<string, unknown>;
};

test("every line carries the heavy table, between the demotion and the shell it runs in", async () => {
    const files = await handover({ command: "git status" }, bashTmuxHooks([], undefined, undefined, undefined, heavy()));
    // Whatever the words: `git status` gets the same table as `pnpm test`, because the words decide nothing.
    const at = files.line.indexOf("env INTENTIC_HEAVY=");
    expect(at).toBeGreaterThan(files.line.indexOf("choom"));
    expect(at).toBeLessThan(files.line.indexOf(`bash ${shellQuote(join(files.dir, "agent"))}`));
    expect(files.line).toContain(`NODE_OPTIONS="--require `);
    expect(tableOf(files.line)).toEqual({
        rules: mergeHeavyRules(),
        queue: queueRunEnabled(),
        ...(queueRunEnabled() ? { queueRun: "/usr/local/bin/queue-run" } : {}),
        offloadRun: "/usr/local/bin/offload-run",
        offload: {},
        klass: priorityOf({ class: "toolchain" }),
    });
});

// Switching the queue off must not also drop what a build is to the OOM killer: the class still rides down.
test("a table with the queue switched off still ranks heavy programs", async () => {
    const files = await handover({ command: "pnpm test" }, bashTmuxHooks([], undefined, undefined, undefined, heavy({ queue: false })));
    expect(tableOf(files.line)).toMatchObject({ queue: false, klass: { oomScoreAdj: OOM_SCORE.heavy, nice: 19, lowIo: true } });
});

test("the owner's own rule and hold ceiling reach the programs as the merged table", async () => {
    const files = await handover(
        { command: "make all" },
        bashTmuxHooks([], undefined, undefined, undefined, heavy({ ruleEdits: [{ id: "slow-make", pattern: "^make\\b", maxHoldSeconds: 7200 }] })),
    );
    expect((tableOf(files.line)["rules"] as { rules: unknown[] }).rules[0]).toEqual({ id: "slow-make", pattern: "^make\\b", maxHoldSeconds: 7200 });
});

test("a sandbox with no table configured runs the line with no table at all", async () => {
    expect((await handover({ command: "pnpm test" })).line).not.toContain("INTENTIC_HEAVY");
});

test("the table rides inside the namespace hop, so a slot is held in the tree the command runs in", async () => {
    const plan = { worktree: "/wt", root: WORKSPACE_ROOT, mirrors: [], overlays: "/ov", fence: undefined };
    const files = await handover(
        { command: "pnpm test" },
        bashTmuxHooks([], { plan, anchor: { pid: 4242, cwd: WORKSPACE_ROOT, plan, dispose: () => {} } }, undefined, undefined, heavy()),
    );
    expect(files.line.indexOf("nsenter")).toBeLessThan(files.line.indexOf("INTENTIC_HEAVY"));
});

// The kinds the owner sends to a runner (settings `offload.commands`) travel with the table; a program of such a kind
// goes there as it starts (heavy-turn.cjs), keeping the queue for running it here when the runner cannot take it.
const offloadTo = (map: Record<string, string>) => () => Promise.resolve(map);

test("the kinds sent to a runner travel with the table", async () => {
    const files = await handover({ command: "pnpm test" }, bashTmuxHooks([], undefined, undefined, undefined, heavy(), offloadTo({ "package-script": "runner-omen" })));
    expect(tableOf(files.line)).toMatchObject({ offloadRun: "/usr/local/bin/offload-run", offload: { "package-script": "runner-omen" } });
});

test("a line that resolved a secret sends nothing to a runner, whatever its kind", async () => {
    const bundle: SecretAccess = {
        list: async () => [{ name: "TOKEN", value: "t0k3n", source: "env" }],
        used: () => {},
        release: async () => ({ ok: true }),
    };
    const reference = `{{secret:${"TOKEN"}}}`;
    const files = await handover(
        { command: `TOKEN=${reference} pnpm test` },
        bashTmuxHooks([], undefined, undefined, bundle, heavy(), offloadTo({ "package-script": "runner-omen" })),
    );
    expect(tableOf(files.line)).toMatchObject({ offload: {} });
    // The pane runs the resolved line from its own 0600 file; the filter is told the reference form.
    expect([files.agent, files.said]).toEqual([script("TOKEN=t0k3n pnpm test"), `TOKEN=${reference} pnpm test`]);
});

test("a table that cannot be read costs the command nothing", async () => {
    const files = await handover({ command: "pnpm test" }, bashTmuxHooks([], undefined, undefined, undefined, () => Promise.reject(new Error("nope"))));
    expect(files.line).toBe(`${born(demoted(join(files.dir, "agent")))}\n`);
});

test("a pool or label out of the config file is data in the table, never shell", async () => {
    // Config values are agent-writable and reach a shell line; single-quoted JSON is data only.
    const label = "x'; touch /tmp/pwned; '";
    const files = await handover(
        { command: "make all" },
        bashTmuxHooks([], undefined, undefined, undefined, heavy({ ruleEdits: [{ id: label, pattern: "\\bmake\\b", pool: "$(id)" }] })),
    );
    expect((tableOf(files.line)["rules"] as { rules: { id: string; pattern: string; pool?: string }[] }).rules[0]).toEqual({ id: label, pattern: "\\bmake\\b", pool: "$(id)" });
});

// `pkill -f vite` matched its own call's command line and killed it: 161 results with no output and exit 144. With the
// command handed over by file, no argv carries it — nor the window name, nor the words the filter reads.
test("a pkill pattern the command names appears in no argv of its own call, and runs as written", async () => {
    const files = await handover({ command: "pkill -f vite; rm -rf node_modules/.vite && pnpm dev", description: "Kill vite" });
    expect(files.command).not.toContain("vite");
    expect(files.agent).toBe(script("pkill -f vite; rm -rf node_modules/.vite && pnpm dev"));
    expect(files.name).toBe("kill-vite");
    expect(files.line).not.toContain("vite");
});

// A call that asked for longer than the CLI's two-minute default used to come back at 110 s anyway (922 times in one
// week), and its agent then polled the log. A shorter timeout keeps 110, so the CLI's own kill still lands when asked.
test("tmux-run waits as long as the call asked for, less a margin, and never past ten minutes", () => {
    expect([undefined, 30_000, 120_000].map(softTimeoutOf)).toEqual([undefined, undefined, undefined]);
    expect([121_000, 300_000, 600_000, 3_600_000].map(softTimeoutOf)).toEqual([111, 290, 590, 590]);
});

test("a long call's wait rides beside its line as `soft`; an ordinary call writes none", async () => {
    const long = await rewritten({ command: "pnpm test", timeout: 300_000 });
    const dir = dirname((/ -f (\S+) /u.exec(long ?? "")?.[1] ?? "").replaceAll("'", ""));
    expect(readFileSync(join(dir, "soft"), "utf8")).toBe("290\n");
    rmSync(dir, { recursive: true, force: true });
    const plain = await rewritten({ command: "pnpm test" });
    const plainDir = dirname((/ -f (\S+) /u.exec(plain ?? "")?.[1] ?? "").replaceAll("'", ""));
    expect(existsSync(join(plainDir, "soft"))).toBe(false);
    rmSync(plainDir, { recursive: true, force: true });
});

const postToolUse = (hooks: ReturnType<typeof bashTmuxHooks>, response: unknown) => {
    const hook = hooks.PostToolUse?.find((matcher) => matcher.matcher === "Bash")?.hooks[0];
    if (hook === undefined) {
        throw new Error("PostToolUse Bash hook not registered");
    }
    return hook(
        {
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: {},
            tool_response: response,
            tool_use_id: "tu-1",
            session_id: "3f2a9b1c-0000-0000-0000-000000000000",
            transcript_path: "/tmp/t",
            cwd: WORKSPACE_ROOT,
        },
        "tu-1",
        { signal: new AbortController().signal },
    );
};

test("a foreground call that came back still running is filed as a job the agent waits on, not a log it polls", async () => {
    const jobs = { conversationId: "conv-overrun", profile: {}, conversations: actors };
    const hooks = bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, jobs);
    const command = await rewritten({ command: "pnpm test", description: "Run the tests" }, hooks);
    const dir = dirname((/ -f (\S+) /u.exec(command ?? "")?.[1] ?? "").replaceAll("'", ""));
    // What tmux-run leaves for a command still running: its own files, and no status yet.
    writeFileSync(join(dir, "cmd"), "pnpm test\n");
    writeFileSync(join(dir, "out"), "12 pass\n");
    const output = syncHookOutput(await postToolUse(hooks, { stdout: `12 pass\n\n--- command still running in tmux window run-the-tests · follow: ${dir}/out`, stderr: "" }));
    const specific = output.hookSpecificOutput;
    const told = specific?.hookEventName === "PostToolUse" ? (specific.additionalContext ?? "") : "";
    const id = /background job (\S+)\./u.exec(told)?.[1] ?? "";
    const job = backgroundJobOf(actors, "conv-overrun", id);
    expect(job?.dir).toBe(dir);
    expect(job?.label).toBe("Run the tests");
    expect(told).toContain(`target "${id}"`);
    // Still running as the turn ends: awaited, so its exit wakes the conversation.
    expect(settledBackgroundJobs(actors, "conv-overrun").running.map((filed) => filed.id)).toEqual([id]);
    rmSync(dir, { recursive: true, force: true });
});

test("a foreground call that finished, or came back early and then finished in its turn, wakes nobody", async () => {
    const jobs = { conversationId: "conv-overrun-done", profile: {}, conversations: actors };
    const hooks = bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, jobs);
    await rewritten({ command: "ls" }, hooks);
    expect(await postToolUse(hooks, { stdout: "a\nb\n", stderr: "" })).toEqual({});
    const command = await rewritten({ command: "pnpm test" }, hooks);
    const dir = dirname((/ -f (\S+) /u.exec(command ?? "")?.[1] ?? "").replaceAll("'", ""));
    writeFileSync(join(dir, "cmd"), "pnpm test\n");
    await postToolUse(hooks, { stdout: "--- command still running in tmux window run · follow: x", stderr: "" });
    writeFileSync(join(dir, "status"), "0\n");
    // The agent was handed the result to look at in its turn; a finished overrun is not an unread completion.
    expect(settledBackgroundJobs(actors, "conv-overrun-done")).toEqual({ running: [], unseen: [] });
    rmSync(dir, { recursive: true, force: true });
});

// A filed overrun's job, as the PostToolUse hook leaves it: the id the agent was told, and its capture dir.
const overrun = async (hooks: ReturnType<typeof bashTmuxHooks>, conversationId: string, stdout: (dir: string) => string): Promise<{ id: string; dir: string; told: string }> => {
    const command = await rewritten({ command: "npx eslint src/a.vue 2>&1 | tail -10" }, hooks);
    const dir = dirname((/ -f (\S+) /u.exec(command ?? "")?.[1] ?? "").replaceAll("'", ""));
    writeFileSync(join(dir, "cmd"), "npx eslint src/a.vue 2>&1 | tail -10\n");
    writeFileSync(join(dir, "out"), "");
    const specific = syncHookOutput(await postToolUse(hooks, { stdout: stdout(dir), stderr: "" })).hookSpecificOutput;
    const told = specific?.hookEventName === "PostToolUse" ? (specific.additionalContext ?? "") : "";
    const id = /background job (\S+?)[.:]/u.exec(told)?.[1] ?? "";
    expect(backgroundJobOf(actors, conversationId, id)?.dir).toBe(dir);
    return { id, dir, told };
};

test("a call that came back at a prompt is told to stop it and run it so it cannot ask, never to wait on it", async () => {
    const jobs = { conversationId: "conv-at-prompt", profile: {}, conversations: actors };
    const hooks = bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, jobs);
    const { id, dir, told } = await overrun(
        hooks,
        "conv-at-prompt",
        (at) => `\n--- waiting for input: npm exec eslint src/a.vue (pid 4242)\n--- command still running in tmux window run · follow: ${at}/out`,
    );
    expect(told).toContain("That command is waiting for input: npm exec eslint src/a.vue (pid 4242) is blocked reading its terminal");
    expect(told).toContain(`stop it with TaskStop (task_id "${id}")`);
    expect(told).toContain("request_help");
    expect(told).not.toContain(`target "${id}"`);
    rmSync(dir, { recursive: true, force: true });
});

const taskStop = (hooks: ReturnType<typeof bashTmuxHooks>, taskId: string) => {
    const hook = hooks.PreToolUse?.find((matcher) => matcher.matcher === "TaskStop|KillShell|KillBash")?.hooks[0];
    if (hook === undefined) {
        throw new Error("PreToolUse TaskStop hook not registered");
    }
    return hook(
        {
            hook_event_name: "PreToolUse",
            tool_name: "TaskStop",
            tool_input: { task_id: taskId },
            tool_use_id: "tu-stop",
            session_id: "3f2a9b1c-0000-0000-0000-000000000000",
            transcript_path: "/tmp/t",
            cwd: WORKSPACE_ROOT,
        },
        "tu-stop",
        { signal: new AbortController().signal },
    );
};

// 2026-10-04: the agent was told to wait on job 9672168b by that id, then TaskStop on it answered "No task found" and
// left npx at its prompt, because the CLI only knows the ids its own run_in_background calls returned.
test("a stop naming a job by the sandbox's own id ends it here, before the CLI can answer that it knows no such task", async () => {
    const jobs = { conversationId: "conv-stop-own-id", profile: {}, conversations: actors };
    const hooks = bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, jobs);
    const { id, dir } = await overrun(hooks, "conv-stop-own-id", (at) => `--- command still running in tmux window run · follow: ${at}/out`);
    const specific = syncHookOutput(await taskStop(hooks, id)).hookSpecificOutput;
    expect(specific).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(specific?.hookEventName === "PreToolUse" ? specific.permissionDecisionReason : "").toBe(
        `Stopped background job ${id}: the sandbox ended it itself, since the CLI never knew this id, and it exited 143 (SIGTERM). Nothing more to stop.`,
    );
    // No pane ran it here, so its end was written down on its runner's behalf.
    expect(readFileSync(join(dir, "status"), "utf8").trim()).toBe("143");
    expect(actors.state("conv-stop-own-id")?.jobs?.find((entry) => entry.id === id)).toMatchObject({ stoppedBy: "agent", exitCode: 143 });
    rmSync(dir, { recursive: true, force: true });
});

test("a stop naming a job by the id the CLI gave it is left to the CLI, whose own result the agent gets", async () => {
    const jobs = { conversationId: "conv-stop-shell-id", profile: {}, conversations: actors };
    const hooks = bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, jobs);
    await rewritten({ command: "pnpm dev", run_in_background: true }, hooks);
    noteJobShell(actors, "tu-1", "bsh-stop");
    expect(syncHookOutput(await taskStop(hooks, "bsh-stop"))).toEqual({});
    expect(syncHookOutput(await taskStop(hooks, "no-such-task"))).toEqual({});
    const dir = backgroundJobOf(actors, "conv-stop-shell-id", "bsh-stop")?.dir;
    if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
    }
});
