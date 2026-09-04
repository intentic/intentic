import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { SHELL } from "../terminal/pane-state.js";
import { watchPromptSignals } from "../terminal/prompt-signal.js";
import { freePort } from "./free-port.js";

const execFileAsync = promisify(execFile);

export interface ProcessSpec {
    // Run inside a detached tmux session in `cwd` with PORT (assigned by the manager) + `env` in the
    // environment. `port` is filled in by the manager before the runner sees it.
    readonly command: string;
    readonly cwd: string;
    readonly env?: Record<string, string>;
    // Extra env var names that ALSO get the assigned port, for a dev server that reads a non-PORT var (e.g. the
    // Hono API reads API_PORT). PORT is always injected; these mirror it under the app's own name.
    readonly portEnv?: readonly string[];
    // A one-shot job (infra-apply): launched like any panel (command typed into the interactive shell), but
    // the sweep flips `running` → false once the shell is back at its prompt, how the job reports completion
    // (InfraDeclare polls exactly that). Default (dev servers) stays running until the session ends.
    readonly oneShot?: true;
}

// Every managed process (panel/app dev server, docker daemon, local model server, infra-apply job) runs inside
// tmux session `panel-<key>` so the owner can attach the existing /system/terminal WebSocket to it, live output
// with full scrollback replaces the old captured-tail logs. The `panel-` prefix predates the generic manager and
// is wire data (session names reach the browser and are string-built in web/_extensions), do not rename.
// Extension-declared processes do NOT ride this manager: they are supervised daemon children
// (service-processes.ts), which is the right shape for a service and the wrong one for these interactive and
// daemon-restart-surviving surfaces.
export const PANEL_SESSION_PREFIX = "panel-";

/* WHERE A START HAS GOT TO, as far as a tmux pane's foreground command can say (the contract's PanelLaunch):
 *   launching   the session exists and its shell has not run the command yet (oh-my-zsh on a cold volume, a
 *               throttled CPU: this can be seconds)
 *   installing  the command is running and node_modules was missing when it started, so `pnpm install` goes
 *               first; ends when the package manager writes its completion file
 *   starting    the dev command is running and nothing has bound a port yet (the panels route, which sees
 *               the listeners, drops the state entirely once the preview proxy has something to serve)
 *   exited      the command returned to a prompt without the session ending: a dev server that crashed on
 *               start, the one case a person must be told at once rather than left on a spinner */
export type PanelLaunch = "launching" | "installing" | "starting" | "exited";

// The file the package manager writes LAST: pnpm's current lockfile, npm's hidden lockfile. node_modules itself
// appears within the install's first second, so its presence says nothing about whether the install finished.
const installFinished = (cwd: string): boolean =>
    existsSync(join(cwd, "node_modules", ".pnpm", "lock.yaml")) || existsSync(join(cwd, "node_modules", ".package-lock.json"));
export const panelSession = (key: string): string => `${PANEL_SESSION_PREFIX}${key}`;

// The tmux side of the manager, injectable so tests need no tmux binary. `states` reports every panel pane's
// foreground command (session name → pane_current_command) in one call; an absent session is a dead one.
export interface ProcessRunner {
    readonly launch: (session: string, spec: ProcessSpec & { port: number }) => Promise<void>;
    readonly kill: (session: string) => void | Promise<void>;
    readonly states: () => Promise<Map<string, string>>;
}

// How often the manager sweeps pane liveness while anything is tracked. The `-d` tmux client exits the moment
// the session is created, so there is no child "exit" event, session state is only observable by asking tmux.
// Prompt signals (terminal/prompt-signal.ts) run the same sweep on every preexec and precmd, so a one-shot
// install that finishes in milliseconds is not held until the next tick.
const POLL_MS = 2000;

export interface ManagedProcessesOptions {
    // Injectable in tests; production uses the image zsh's /run/intentic/shell watcher.
    readonly onPromptWatch?: (onSignal: () => void) => () => void;
}

const defaultRunner: ProcessRunner = {
    launch: async (session, spec) => {
        // A bare `sh -c` does NOT add node_modules/.bin to PATH (only pnpm/npm/npx do), so a workspace-local bin
        // like `turbo`/`vite`/`astro` would fail with "not found" (exit 127). Prepend the run dir's bin so any dev
        // command resolves its local tools; the panel's own `env` rides underneath. `-e` sets the vars on the
        // session (the tmux server's global env, inherited from this daemon, supplies the rest).
        // A panel's own zsh history, not the owner's. The command below is typed into an interactive shell on
        // purpose (see the send-keys comment), and the image's zsh now shares one history file on the /history
        // volume so terminal autosuggestions survive a rebuild, which would make every dev-server command the
        // DAEMON typed a permanent suggestion in the owner's own tabs. Overriding HISTFILE here (the image's
        // .zshrc assigns it only if unset) keeps the durable store to what a human typed, while ↑ still re-runs
        // the command in this pane. Keyed by port, not session name: it is unique per launch, filename-safe
        // without sanitizing, and container-local, this history is meant to die with the pane.
        const binDir = join(spec.cwd, "node_modules", ".bin");
        const portVars = Object.fromEntries((spec.portEnv ?? []).map((name) => [name, String(spec.port)]));
        const env = {
            ...spec.env,
            ...portVars,
            PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
            PORT: String(spec.port),
            HISTFILE: `/tmp/intentic-panel-${spec.port}.zsh_history`,
        };
        const envFlags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
        // A lingering same-name session is a previous run's leftover, clear it before creating fresh.
        // `=` forces an exact target match (a bare `-t panel-x` would prefix-match `panel-x--api`).
        await execFileAsync("tmux", ["kill-session", "-t", `=${session}`]).catch(() => undefined);
        // Every panel runs INSIDE an interactive shell (the image's default-command zsh, same as a web-* shell):
        // the command is typed via send-keys so it goes through the line editor and lands in HISTORY. Ctrl+C
        // then returns to a live prompt and ↑ re-runs it, the `-e` session env keeps PORT, so the re-run binds
        // the same port and the preview proxy keeps forwarding. The keys buffer in the pty while the shell
        // boots; `-l` sends the command literally (no key-name lookup). No remain-on-exit: a shell exit destroys
        // the session like any other terminal, and a crashed server's output sits in scrollback above the prompt.
        // The trailing ":" is required: send-keys takes a target-PANE, and tmux (3.3a) never resolves a bare
        // exact-match `=name` as a pane target ("can't find pane") even though the session exists, the window
        // form `=name:` resolves to the window's active pane.
        await execFileAsync("tmux", [
            "new-session",
            "-d",
            "-s",
            session,
            "-c",
            spec.cwd,
            ...envFlags,
            ";",
            "send-keys",
            "-t",
            `=${session}:`,
            "-l",
            spec.command,
            ";",
            "send-keys",
            "-t",
            `=${session}:`,
            "Enter",
        ]);
    },
    kill: async (session) => {
        await execFileAsync("tmux", ["kill-session", "-t", `=${session}`]).catch(() => undefined);
    },
    // One call for all sessions: pane_current_command is the pane's foreground process (the shell itself at a
    // prompt), how the sweep sees a oneShot job finish. A shell exit destroys its single-pane session, which
    // reports as absence. No tmux server yet ⇒ non-zero exit ⇒ no sessions.
    states: async () => {
        const states = new Map<string, string>();
        try {
            const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}"]);
            for (const line of stdout.split("\n")) {
                const [name, command] = line.split("\t");
                if (name !== undefined && name !== "" && command !== undefined) {
                    states.set(name, command);
                }
            }
        } catch {
            // no tmux server ⇒ nothing running
        }
        return states;
    },
};

// Sessions outlive a daemon restart (the tmux server is container-scoped, not daemon-scoped), kill leftovers
// at boot so the documented "panels are stopped after a restart" semantics hold and no orphan dev server squats
// a port the manager no longer tracks. agent-* sessions (the Claude agent's tmux Bash terminals) and job-*
// sessions (terminal-run jobs whose owning stream died with the daemon) are equally orphaned after a restart.
// `exempt` names sessions that must SURVIVE the sweep: a running infra apply that main.ts re-adopted instead
// of truncating mid-mutation.
export const killStaleManagedSessions = async (exempt: readonly string[] = []): Promise<void> => {
    try {
        const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
        const stale = stdout
            .split("\n")
            .filter(
                (name) =>
                    (name.startsWith(PANEL_SESSION_PREFIX) || name.startsWith(AGENT_SESSION_PREFIX) || name.startsWith(JOB_SESSION_PREFIX)) &&
                    !exempt.includes(name),
            );
        await Promise.all(stale.map((name) => execFileAsync("tmux", ["kill-session", "-t", `=${name}`]).catch(() => undefined)));
    } catch {
        // no tmux server ⇒ nothing stale
    }
};

export interface ManagedProcesses {
    // Assigns a free PORT and starts the panel's dev server in tmux session `panel-<key>`. No-op when already
    // running; a previous run's lingering session is replaced.
    readonly start: (repo: string, spec: ProcessSpec) => Promise<void>;
    // Re-track a session that outlived a daemon restart (a live one-shot job the boot sweep must not kill):
    // registers it so `running` reports it and the sweep watches it to completion. False when no such session.
    readonly adopt: (repo: string, spec: Pick<ProcessSpec, "oneShot">) => Promise<boolean>;
    // Kills the session (including a finished oneShot's lingering shell).
    readonly stop: (repo: string) => void | Promise<void>;
    readonly running: (repo: string) => boolean;
    // The port the running panel was assigned (undefined when not running), the preview proxy's forward target.
    readonly portOf: (repo: string) => number | undefined;
    // Where a running dev-server panel's start has got to (see PanelLaunch); undefined when not running, and for
    // one-shot jobs, whose completion is their own story (`running`).
    readonly launchOf: (repo: string) => PanelLaunch | undefined;
    // SIGTERM shutdown path, kill every managed panel.
    readonly stopAll: () => void;
}

// Manages the sandbox's long-running tmux sessions (operator panels, app dev servers, dockerd, local model
// servers, one-shot infra jobs), keyed by process key. A session
// that ends (its shell exited or was ×-killed) drops out of `running` on the next liveness sweep, `running`
// means "session alive", not "dev process alive": a Ctrl+C'd dev server sits at a usable prompt and stays
// running. A oneShot job additionally completes when its shell is back at the prompt; the session lingers
// attachable, output in scrollback above a live prompt.
export const createManagedProcesses = (runner: ProcessRunner = defaultRunner, options: ManagedProcessesOptions = {}): ManagedProcesses => {
    const watchPrompts = options.onPromptWatch ?? watchPromptSignals;
    const current = new Map<
        string,
        {
            port: number;
            oneShot: true | undefined;
            startedAt: number;
            sawJob: boolean;
            promptStreak: number;
            // For the launch state: where the command runs, whether its dependencies were there when it was
            // typed, and the pane's foreground command as of the last sweep.
            cwd: string;
            installed: boolean;
            lastCommand: string | undefined;
        }
    >();
    let timer: NodeJS.Timeout | undefined;
    let unwatchPrompts: (() => void) | undefined;

    // Before this many ms, a oneShot sitting at the prompt is treated as "shell still booting, buffered
    // send-keys not consumed yet" rather than "job finished", unless the job was already observed running
    // (sawJob). ponytail: a job that finishes before any sweep samples it AND a shell boot slower than this
    // grace would still read as a false completion; widen the grace if that ever materializes.
    const ONE_SHOT_GRACE_MS = 10_000;

    /* Untrack a key and say so. `running` is what /panels draws a repo's dev server from and what the terminals
     * list reports each panel row's status from, so both go stale together, a dev server that died and a
     * one-shot that finished are the two ways a panel stops without anybody clicking Stop, and until this push
     * existed they were only ever discovered by the browser asking again. */
    const untrack = (key: string): void => {
        current.delete(key);
        publishRuntimeChange("panels", "terminals");
    };

    const stopWatching = (): void => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
        unwatchPrompts?.();
        unwatchPrompts = undefined;
    };

    const ensureWatching = (): void => {
        timer ??= setInterval(() => void sweep(false), POLL_MS);
        unwatchPrompts ??= watchPrompts(() => void sweep(true));
    };

    const sweep = async (fromPrompt = false): Promise<void> => {
        const states = await runner.states();
        for (const [key, entry] of current) {
            const command = states.get(panelSession(key));
            if (command === undefined) {
                untrack(key);
                continue;
            }
            // The launch state's inputs, for every kind of panel: the first non-shell sighting is the command
            // starting, a later shell sighting is it having exited. A change is pushed so the screen watching
            // a start moves with it rather than on the next unrelated frame.
            if (command !== SHELL) {
                entry.sawJob = true;
            }
            if (entry.lastCommand !== command) {
                entry.lastCommand = command;
                publishRuntimeChange("panels");
            }
            if (entry.oneShot === undefined) {
                continue;
            }
            if (command !== SHELL) {
                entry.sawJob = true;
                entry.promptStreak = 0;
                continue;
            }
            /* One prompt after a job the sweep saw is enough: precmd IS the shell saying the command finished,
             * which is what prompt-signal.ts exists to surface without waiting for this tick. Two consecutive
             * prompt sightings stay for the cases precmd cannot distinguish: a shell still booting before its
             * send-keys land (never sawJob), and the ms-window between two commands in a `&&` chain that a poll
             * can read as zsh between forks. */
            entry.promptStreak += 1;
            const graceOk = Date.now() - entry.startedAt > ONE_SHOT_GRACE_MS;
            if ((fromPrompt && entry.sawJob && entry.promptStreak >= 1) || (entry.promptStreak >= 2 && (entry.sawJob || graceOk))) {
                untrack(key);
            }
        }
        if (current.size === 0) {
            stopWatching();
        }
    };

    return {
        start: async (key, spec) => {
            if (current.has(key)) {
                return;
            }
            const port = await freePort();
            // A concurrent start of the same key won the race while we awaited the port, leave the winner be.
            if (current.has(key)) {
                return;
            }
            await runner.launch(panelSession(key), { ...spec, port });
            current.set(key, {
                port,
                oneShot: spec.oneShot,
                startedAt: Date.now(),
                sawJob: false,
                promptStreak: 0,
                cwd: spec.cwd,
                installed: existsSync(join(spec.cwd, "node_modules")),
                lastCommand: undefined,
            });
            // The session exists now; it is not SERVING yet. This frame draws the row as starting, and the port
            // sampler's frame, seconds later, when the dev server actually binds, is what turns it healthy.
            publishRuntimeChange("panels", "terminals");
            ensureWatching();
        },
        adopt: async (key, spec) => {
            const command = (await runner.states()).get(panelSession(key));
            if (command === undefined) {
                return false;
            }
            if (!current.has(key)) {
                // sawJob from the live pane: a job currently in the foreground counts as observed, so a
                // shell-at-prompt sighting after it finishes completes the one-shot without the boot grace.
                // Adopted mid-life: no cwd to read an install off, and nothing of its start left to narrate.
                current.set(key, {
                    port: 0,
                    oneShot: spec.oneShot,
                    startedAt: Date.now(),
                    sawJob: command !== SHELL,
                    promptStreak: 0,
                    cwd: "",
                    installed: true,
                    lastCommand: command,
                });
                publishRuntimeChange("panels", "terminals");
                ensureWatching();
            }
            return true;
        },
        stop: async (key) => {
            const stopped = runner.kill(panelSession(key));
            untrack(key);
            if (current.size === 0) {
                stopWatching();
            }
            await stopped;
        },
        running: (key) => current.has(key),
        portOf: (key) => current.get(key)?.port,
        launchOf: (key) => {
            const entry = current.get(key);
            if (entry === undefined || entry.oneShot !== undefined) {
                return undefined;
            }
            if (!entry.sawJob) {
                return "launching";
            }
            if (entry.lastCommand === SHELL) {
                return "exited";
            }
            return entry.installed || entry.cwd === "" || installFinished(entry.cwd) ? "starting" : "installing";
        },
        stopAll: () => {
            for (const key of current.keys()) {
                runner.kill(panelSession(key));
            }
            const stopped = current.size > 0;
            current.clear();
            if (stopped) {
                publishRuntimeChange("panels", "terminals");
            }
            stopWatching();
        },
    };
};
