import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { requires } from "@intentic/testing/requires";
import { z } from "zod";
import type { SecretAccess } from "../../../secrets/secret-access.js";
import { TMUX_RUN_BIN } from "../../../terminal/terminal-run.js";
import { RUN_GONE, shellDoor, type ShellHost, shellHost, shellPaneOf, type ShellRoute, shellRouteOf } from "./opencode-shell.js";

// OpenCode's shell as the daemon routes it: the script OpenCode is told to run, asking over its socket how to run each
// command, with the turn's secret references resolved, its output masked, and its pane's run files written the way the
// Claude loop's Bash writes them. The script runs for real here, as OpenCode would run it: `<script> -c <command>` with
// the session's id in its environment.

const run = promisify(execFile);
const tmux = requires(existsSync(TMUX_RUN_BIN), "tmux-run at /usr/local/bin/tmux-run", {
    absentOnCi: "tmux-run is baked into the sandbox image, which the daemon's suites do not run in",
});

const VALUE = "tok-4f9c2e81b7d3a6";
const secrets: SecretAccess = {
    list: async () => [{ name: "API_TOKEN", value: VALUE, source: "env" }],
    used: () => {},
    release: async () => ({ ok: true }),
};

let dir = "";
let host: ShellHost;
let script = "";
const routes = new Map<string, { readonly shell: ShellRoute }>();

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-shell-"));
    host = shellHost(join(dir, "shell"), routes);
    script = (await host.path()) ?? "";
});

afterAll(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
});

// The script as OpenCode runs it: one command, the session's id in its environment; what it printed and how it ended.
const shellRun = async (session: string | undefined, command: string): Promise<{ readonly out: string; readonly code: number }> => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["OPENCODE_SESSION_ID"];
    if (session !== undefined) {
        env["OPENCODE_SESSION_ID"] = session;
    }
    try {
        const { stdout, stderr } = await run(script, ["-c", command], { env, cwd: dir });
        return { out: stdout + stderr, code: 0 };
    } catch (error) {
        // SAFETY: execFile rejects with the child's output and exit code on a non-zero exit.
        const failed = error as { readonly stdout: string; readonly stderr: string; readonly code: number };
        return { out: failed.stdout + failed.stderr, code: failed.code };
    }
};

test("the script is OpenCode's bash: named so, executable, and naming this daemon's socket", () => {
    expect(script).toBe(join(dir, "shell", "bash"));
    expect(readFileSync(script, "utf8")).toContain(join(dir, "shell", "shell.sock"));
});

test("a session's secret reference runs as its value, and what the command prints comes back masked to the reference", async () => {
    routes.set("ses_masked", { shell: shellRouteOf({ secrets }) });

    const result = await shellRun("ses_masked", "echo token={{secret:API_TOKEN}}; echo plain >&2; exit 3");

    expect(result.out).toContain("token={{secret:API_TOKEN}}");
    expect(result.out).not.toContain(VALUE);
    expect(result.out).toContain("plain");
    expect(result.code).toBe(3);
});

test("a reference to no stored secret is refused, and the command does not run", async () => {
    routes.set("ses_unknown", { shell: shellRouteOf({ secrets }) });
    const marker = join(dir, "ran");

    const result = await shellRun("ses_unknown", `touch ${marker} {{secret:NOPE}}`);

    expect(result.out).toContain('no stored secret named "NOPE"');
    expect(result.code).toBe(1);
    expect(existsSync(marker)).toBe(false);
});

// A stopped turn's command can still be printing after its judges were let go, and OpenCode keeps what it printed for
// the session's next turn: it is masked by the route it was prepared with, and withheld once nothing holds that route.
test("a masked run is masked by the turn it was prepared for, past that turn's end, and withheld once it is let go", async () => {
    const live = new Map<string, ShellRoute>([["ses_ending", shellRouteOf({ secrets })]]);
    const door = shellDoor((session) => live.get(session));
    const prepared = await door["/prepare"].answer({ session: "ses_ending", command: "cat token", cwd: dir });
    const { run: runId } = z.object({ run: z.string() }).parse(prepared);
    live.clear();

    expect(prepared).toMatchObject({ masked: true });
    expect(await door["/output"].answer({ session: "ses_ending", run: runId, output: `token ${VALUE}` })).toEqual({ output: "token {{secret:API_TOKEN}}" });
    door["/done"].answer({ run: runId });
    expect(await door["/output"].answer({ session: "ses_ending", run: runId, output: VALUE })).toEqual({ withheld: RUN_GONE });
});

// OpenCode's own command interpolation, or a session the daemon is not driving, as its asks get the standing yes.
test("a command no turn's session asked for runs as written, unmasked", async () => {
    expect((await shellRun(undefined, "echo {{secret:API_TOKEN}}")).out).toBe("{{secret:API_TOKEN}}\n");
    expect((await shellRun("ses_nobody", "echo hi")).out).toBe("hi\n");
});

test("a pane's run is written by file, the agent's words beside the resolved line, and handed to tmux-run by name", async () => {
    const runRoot = await mkdtemp(join(dir, "runs-"));
    const pane = shellPaneOf("ses_0a1b2c3d4e5fXYZabc12", ["INTENTIC_LIVE_PROBE", "not a name"], "chat-1");
    if (pane === undefined) {
        throw new Error("no pane for the session");
    }
    let surfaced = 0;
    const route = shellRouteOf({ secrets, pane, runRoot, surfaced: () => (surfaced += 1) });

    const plan = await route.prepare({ command: "curl -H 'X: {{secret:API_TOKEN}}' example.com", cwd: dir });
    if ("refused" in plan) {
        throw new Error(plan.refused);
    }

    expect(pane.session).toBe("agent-XYZabc12");
    const line = plan.argv.at(-2) ?? "";
    expect(plan.argv).toEqual([TMUX_RUN_BIN, "-e", "INTENTIC_LIVE_PROBE", "-f", line, "agent-XYZabc12"]);
    const runDir = join(line, "..");
    expect(readFileSync(join(runDir, "said"), "utf8")).toBe("curl -H 'X: {{secret:API_TOKEN}}' example.com");
    expect(readFileSync(join(runDir, "agent"), "utf8")).toContain(`X: ${VALUE}`);
    expect(readFileSync(line, "utf8")).toMatch(/^INTENTIC_AGENT_SESSION=ses_0a1b2c3d4e5fXYZabc12 INTENTIC_TURN_OWNER=chat-1 .*bash /);
    expect(readFileSync(join(runDir, "name"), "utf8")).toBe("curl");
    expect(surfaced).toBe(1);
});

test.skipIf(!tmux.runs)(tmux.title("a command routed into the pane runs there, with the session's environment, and no stored value comes back"), async () => {
    const pane = shellPaneOf(`ses_test${String(process.pid)}pane`, ["INTENTIC_LIVE_PROBE"], undefined);
    if (pane === undefined) {
        throw new Error("no pane for the session");
    }
    routes.set("ses_pane", { shell: shellRouteOf({ secrets, pane }) });
    try {
        const env = { ...process.env, OPENCODE_SESSION_ID: "ses_pane", INTENTIC_LIVE_PROBE: "forwarded" };
        const { stdout } = await run(script, ["-c", "echo probe=$INTENTIC_LIVE_PROBE secret={{secret:API_TOKEN}}"], { env, cwd: dir });

        // The pane's own output filter may blank a stored value before the daemon names it; either way it never arrives.
        expect(stdout).toMatch(/^probe=forwarded secret=(?:\{\{secret:API_TOKEN\}\}|\*\*\*)$/m);
        expect(stdout).not.toContain(VALUE);
    } finally {
        // allow(silent-catch): a session tmux already ended has nothing to kill
        await run("tmux", ["kill-session", "-t", `=${pane.session}`]).catch(() => {});
    }
});
