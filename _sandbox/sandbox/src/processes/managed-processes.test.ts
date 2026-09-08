import { WORKSPACE_ROOT } from "@intentic/constants";
import { afterEach, expect, test, vi } from "vitest";
import { createManagedProcesses, launchEnv, type ProcessRunner, type ProcessSpec } from "./managed-processes.js";

// Records launches and lets a test drive each session's foreground command, mirroring tmux. Absent means destroyed; a
// launch starts at "node", tests set "zsh" to simulate completion.
const fakeRunner = () => {
    const launches: { session: string; spec: ProcessSpec & { port: number } }[] = [];
    const killed: string[] = [];
    const cmd = new Map<string, string>();
    const runner: ProcessRunner = {
        launch: async (session, spec) => {
            launches.push({ session, spec });
            cmd.set(session, "node");
        },
        kill: (session) => {
            killed.push(session);
            cmd.delete(session);
        },
        states: async () => new Map(cmd),
    };
    return { runner, launches, killed, cmd };
};

const SPEC: ProcessSpec = { command: "pnpm dev", cwd: `${WORKSPACE_ROOT}/app/operator` };

afterEach(() => {
    vi.useRealTimers();
});

test("start launches tmux session panel-<key> with the assigned port, exposed via portOf", async () => {
    const { runner, launches } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    expect(launches[0]?.session).toBe("panel-app");
    expect(launches[0]?.spec.command).toBe("pnpm dev");
    expect(launches[0]?.spec.cwd).toBe("/work/app/operator");
    // The manager assigns a real free port; the runner sees it and portOf reports it.
    const port = panels.portOf("app");
    expect(port).toBeGreaterThan(0);
    expect(launches[0]?.spec.port).toBe(port);
    expect(panels.running("app")).toBe(true);
    expect(panels.running("site")).toBe(false);
    expect(panels.portOf("site")).toBeUndefined();
    panels.stopAll();
});

test("a second start of the same key is ignored while it is running", async () => {
    const { runner, launches } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    await panels.start("app", SPEC);
    expect(launches).toHaveLength(1);
    panels.stopAll();
});

test("two panels run concurrently with separate ports and separate sessions", async () => {
    const { runner, launches } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    await panels.start("site--web", { command: "pnpm dev", cwd: `${WORKSPACE_ROOT}/site` });
    expect(launches.map((launch) => launch.session)).toEqual(["panel-app", "panel-site--web"]);
    expect(panels.portOf("app")).not.toBe(panels.portOf("site--web"));
    panels.stopAll();
});

test("stop kills only the targeted panel's session", async () => {
    const { runner, killed } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    await panels.start("site", { command: "pnpm dev", cwd: `${WORKSPACE_ROOT}/site/operator` });
    panels.stop("app");
    expect(killed).toEqual(["panel-app"]);
    expect(panels.running("app")).toBe(false);
    expect(panels.portOf("app")).toBeUndefined();
    expect(panels.running("site")).toBe(true);
    panels.stopAll();
});

test("stopAll kills everything", async () => {
    const { runner, killed } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    await panels.start("site", { command: "pnpm dev", cwd: `${WORKSPACE_ROOT}/site/operator` });
    panels.stopAll();
    expect(killed.toSorted()).toEqual(["panel-app", "panel-site"]);
    expect(panels.running("app")).toBe(false);
    expect(panels.running("site")).toBe(false);
});

test("a session killed externally (vanished from tmux) drops out of running", async () => {
    vi.useFakeTimers();
    const { runner, cmd } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    cmd.delete("panel-app");
    await vi.advanceTimersByTimeAsync(2100);
    expect(panels.running("app")).toBe(false);
});

test("a dev panel sitting at its shell prompt (Ctrl+C'd server) stays running", async () => {
    vi.useFakeTimers();
    const { runner, cmd } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    cmd.set("panel-app", "zsh");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(panels.running("app")).toBe(true);
    panels.stopAll();
});

test("a oneShot job stays running while its command is in the foreground, even past the grace", async () => {
    vi.useFakeTimers();
    const { runner } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("job", { ...SPEC, oneShot: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(panels.running("job")).toBe(true);
    panels.stopAll();
});

test("a oneShot job completes on the first prompt signal once the job was seen, without waiting for a poll tick", async () => {
    let onPrompt: (() => void) | undefined;
    const { runner, cmd, killed } = fakeRunner();
    const panels = createManagedProcesses(runner, {
        onPromptWatch: (signal) => {
            onPrompt = signal;
            return () => {
                onPrompt = undefined;
            };
        },
    });
    await panels.start("job", { ...SPEC, oneShot: true });
    onPrompt?.();
    expect(panels.running("job")).toBe(true);
    cmd.set("panel-job", "zsh");
    onPrompt?.();
    await vi.waitFor(() => expect(panels.running("job")).toBe(false));
    expect(killed).toEqual([]);
});

test("a oneShot job completes after two consecutive prompt sightings on the poll tick: the session lingers unkilled", async () => {
    vi.useFakeTimers();
    const { runner, cmd, killed } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("job", { ...SPEC, oneShot: true });
    await vi.advanceTimersByTimeAsync(2100);
    cmd.set("panel-job", "zsh");
    await vi.advanceTimersByTimeAsync(2000);
    // One prompt sighting is not completion: it could be the shell between two chained commands.
    expect(panels.running("job")).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(panels.running("job")).toBe(false);
    // The sweep only untracked it: no kill, so the finished job's shell stays attachable.
    expect(killed).toEqual([]);
});

test("a single prompt sighting between chained commands does not complete a oneShot job", async () => {
    vi.useFakeTimers();
    const { runner, cmd } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("job", { ...SPEC, oneShot: true });
    await vi.advanceTimersByTimeAsync(2100);
    cmd.set("panel-job", "zsh");
    await vi.advanceTimersByTimeAsync(2000);
    cmd.set("panel-job", "node");
    await vi.advanceTimersByTimeAsync(2000);
    cmd.set("panel-job", "zsh");
    await vi.advanceTimersByTimeAsync(2000);
    // The streak reset on the next chained command; one fresh sighting is again not completion.
    expect(panels.running("job")).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(panels.running("job")).toBe(false);
});

test("a oneShot job never observed running (instant failure) completes only after the boot grace", async () => {
    vi.useFakeTimers();
    const { runner, cmd } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("job", { ...SPEC, oneShot: true });
    // The command failed before the first sweep: the pane shows only the booted shell at its prompt.
    cmd.set("panel-job", "zsh");
    await vi.advanceTimersByTimeAsync(8100);
    expect(panels.running("job")).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(panels.running("job")).toBe(false);
});

test("a start after a crash relaunches into a fresh session", async () => {
    vi.useFakeTimers();
    const { runner, cmd, launches } = fakeRunner();
    const panels = createManagedProcesses(runner);
    await panels.start("app", SPEC);
    cmd.delete("panel-app");
    await vi.advanceTimersByTimeAsync(2100);
    await panels.start("app", SPEC);
    expect(launches).toHaveLength(2);
    expect(panels.running("app")).toBe(true);
    panels.stopAll();
});

test("a launch failure propagates to the caller and leaves nothing tracked", async () => {
    const runner: ProcessRunner = {
        launch: async () => {
            throw new Error("tmux failed");
        },
        kill: () => {},
        states: async () => new Map(),
    };
    const panels = createManagedProcesses(runner);
    await expect(panels.start("app", SPEC)).rejects.toThrow("tmux failed");
    expect(panels.running("app")).toBe(false);
});

test("launchOf narrates a start: launching until the command is seen, starting while it runs, exited once it returns to a prompt", async () => {
    vi.useFakeTimers();
    const { runner, cmd } = fakeRunner();
    const panels = createManagedProcesses(runner, { onPromptWatch: () => () => undefined });
    // The fake reports the job command only from the first sweep on; before that nothing's been seen.
    await panels.start("app", SPEC);
    expect(panels.launchOf("app")).toBe("launching");
    await vi.advanceTimersByTimeAsync(2_000);
    // SPEC's cwd has no node_modules and no install-completion file, so this reads as installing.
    expect(panels.launchOf("app")).toBe("installing");
    cmd.set("panel-app", "zsh");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(panels.launchOf("app")).toBe("exited");
    // Not running at all, and a one-shot job, both answer nothing.
    expect(panels.launchOf("site")).toBeUndefined();
    await panels.start("job", { ...SPEC, oneShot: true });
    expect(panels.launchOf("job")).toBeUndefined();
    panels.stopAll();
});

/* THE PANE'S ENVIRONMENT, which is where a start's cost is decided before its first line prints. The pnpm switch
 * is the one a fresh sandbox's first screen hung on: without it `pnpm --filter <app> dev` over the image's
 * copied node_modules re-runs a whole install before the dev server, which the launch state can only report
 * as "starting" for however long that takes. Spelled with dashes because that is the spelling pnpm reads. */
test("the launch env carries the assigned port, the run dir's bin, its own history and pnpm's pre-run install switched off", () => {
    const env = launchEnv({ ...SPEC, port: 4321, portEnv: ["API_PORT"], env: { INTENTIC_DAEMON: "http://127.0.0.1:8787" } }, "/usr/bin");
    expect(env["PORT"]).toBe("4321");
    expect(env["API_PORT"]).toBe("4321");
    expect(env["PATH"]).toBe("/work/app/operator/node_modules/.bin:/usr/bin");
    expect(env["HISTFILE"]).toBe("/tmp/intentic-panel-4321.zsh_history");
    expect(env["INTENTIC_DAEMON"]).toBe("http://127.0.0.1:8787");
    expect(env["npm_config_verify-deps-before-run"]).toBe("false");
    expect(env["npm_config_verify_deps_before_run"]).toBeUndefined();
});
