import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import type { Logger } from "pino";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { SHELL } from "../terminal/pane-state.js";
import { watchPromptSignals } from "../terminal/prompt-signal.js";
import { PANEL_SESSION_PREFIX } from "../terminal/terminal-session.js";
import { isNoTmuxServer } from "../terminal/tmux-server.js";
import { freePort } from "./free-port.js";

const execFileAsync = promisify(execFile);

export interface ProcessSpec {
    // Runs in a detached tmux session in `cwd`, with PORT (manager-assigned) and `env` set.
    readonly command: string;
    readonly cwd: string;
    readonly env?: Record<string, string>;
    // Extra env vars that also get the assigned port, for servers that read a non-PORT var (e.g. API_PORT).
    readonly portEnv?: readonly string[];
    // A one-shot job reports done once its shell returns to prompt; default panels run until session end.
    readonly oneShot?: true;
}

// launching: session exists, shell hasn't run the command yet
// installing: node_modules was missing at start, so pnpm install runs first, until its completion file appears
// starting: command is running, but nothing has bound a port yet
// exited: command returned to a prompt without the session ending, e.g. crashed at start
export type PanelLaunch = "launching" | "installing" | "starting" | "exited";

// The file the package manager writes last (pnpm/npm lockfile); node_modules itself appears within the first second, so
// it says nothing about completion.
const installFinished = (cwd: string): boolean =>
    existsSync(join(cwd, "node_modules", ".pnpm", "lock.yaml")) || existsSync(join(cwd, "node_modules", ".package-lock.json"));
export const panelSession = (key: string): string => `${PANEL_SESSION_PREFIX}${key}`;
// Inverse of panelSession; undefined for a name that isn't a panel session at all.
export const panelKeyOf = (session: string): string | undefined =>
    session.startsWith(PANEL_SESSION_PREFIX) ? session.slice(PANEL_SESSION_PREFIX.length) : undefined;

// The tmux side of the manager, injectable so tests need no tmux binary. `states` reports every pane's foreground
// command in one call; absence means dead, so a listing that failed throws rather than answering empty.
export interface ProcessRunner {
    readonly launch: (session: string, spec: ProcessSpec & { port: number }) => Promise<void>;
    readonly kill: (session: string) => void | Promise<void>;
    readonly states: () => Promise<Map<string, string>>;
}

// Sweep interval; tmux gives no exit event, so liveness is only observable by asking, not pushed.
const POLL_MS = 2000;

export interface ManagedProcessesOptions {
    // Injectable in tests; production uses the image zsh's /run/intentic/shell watcher.
    readonly onPromptWatch?: (onSignal: () => void) => () => void;
    readonly logger?: Pick<Logger, "warn">;
}

/* THE ENVIRONMENT A MANAGED COMMAND IS TYPED INTO, as one pure function so the switches below can be asserted. */
export const launchEnv = (spec: ProcessSpec & { port: number }, path: string): Record<string, string> => ({
    ...spec.env,
    ...Object.fromEntries((spec.portEnv ?? []).map((name) => [name, String(spec.port)])),
    PATH: `${join(spec.cwd, "node_modules", ".bin")}:${path}`,
    PORT: String(spec.port),
    HISTFILE: `/tmp/intentic-panel-${spec.port}.zsh_history`,
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
});

const defaultRunner: ProcessRunner = {
    launch: async (session, spec) => {
        const envFlags = Object.entries(launchEnv(spec, process.env["PATH"] ?? "")).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
        // A lingering same-name session is a previous run's leftover, clear it before creating fresh.
        // `=` forces an exact target match (a bare `-t panel-x` would prefix-match `panel-x--api`).
        await execFileAsync("tmux", ["kill-session", "-t", `=${session}`]).catch(() => undefined);
        // Sent via send-keys so Ctrl+C/↑ still work; trailing `:` is required for tmux to resolve the pane.
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
    // One call for all sessions; pane_current_command at the prompt is how a oneShot's completion is seen. A shell exit
    // destroys the session, reporting as absence; no tmux server means no sessions.
    states: async () => {
        const states = new Map<string, string>();
        const listed = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}"]).catch((error: unknown) => {
            if (isNoTmuxServer(error)) {
                return undefined;
            }
            throw error;
        });
        for (const line of listed?.stdout.split("\n") ?? []) {
            const [name, command] = line.split("\t");
            if (name !== undefined && name !== "" && command !== undefined) {
                states.set(name, command);
            }
        }
        return states;
    },
};

// The tmux server outlives a daemon restart; panel/agent-*/job-* sessions are killed at boot so 'stopped after a
// restart' holds. `exempt` spares a session the boot chain re-adopted instead of truncating.
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
    // Assigns a free port and starts the panel; no-op if already running, replacing a lingering session.
    readonly start: (repo: string, spec: ProcessSpec) => Promise<void>;
    // Re-tracks a session that survived a restart (a live one-shot the boot sweep spared); false if none exists.
    readonly adopt: (repo: string, spec: Pick<ProcessSpec, "oneShot">) => Promise<boolean>;
    // Kills the session (including a finished oneShot's lingering shell).
    readonly stop: (repo: string) => void | Promise<void>;
    readonly running: (repo: string) => boolean;
    // A one-shot run's state, the only thing that tells an install or a check from a dev server once its shell is back
    // at a prompt; undefined for a dev-server panel and for a key this manager never ran.
    readonly runOf: (repo: string) => { readonly running: boolean; readonly finishedAt?: number } | undefined;
    // The assigned port, undefined when not running; the preview proxy's forward target.
    readonly portOf: (repo: string) => number | undefined;
    // Start progress for a dev-server panel (PanelLaunch); undefined when not running or for a one-shot job.
    readonly launchOf: (repo: string) => PanelLaunch | undefined;
    // SIGTERM shutdown path, kill every managed panel.
    readonly stopAll: () => void;
}

// Manages long-running tmux sessions (panels, dev servers, dockerd, one-shot jobs) by key. `running` means
// session-alive, not process-alive; a oneShot also completes once its shell returns to prompt.
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
            // For launch state: where the command runs, whether deps existed at start, last-seen foreground command.
            cwd: string;
            installed: boolean;
            lastCommand: string | undefined;
        }
    >();
    // When each one-shot run completed, keyed like `current`: a finished run's shell sits at a prompt, so tmux alone
    // cannot tell it from a dev server nobody typed in. Bounded by the number of distinct one-shot keys a workspace
    // has (one per project per check), and a re-run replaces its own entry.
    const finishedRuns = new Map<string, number>();
    let timer: NodeJS.Timeout | undefined;
    let unwatchPrompts: (() => void) | undefined;

    // Before this, a prompt sighting reads as a booting shell, not completion, unless the job was seen running.
    const ONE_SHOT_GRACE_MS = 10_000;

    // Untracks a key and publishes the change, since /panels and the terminals list both read `running` from here. A
    // died dev server and a finished oneShot are the two ways a panel stops without a Stop click. `completed` is false
    // for a Stop, which takes the session with it and so leaves nothing to remember.
    const untrack = (key: string, completed: boolean): void => {
        if (completed && current.get(key)?.oneShot !== undefined) {
            finishedRuns.set(key, Date.now());
        } else {
            finishedRuns.delete(key);
        }
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

    // A sweep that could not list the panes changes nothing: untracking on it would report every live run as finished.
    const sweepLogged = (fromPrompt: boolean): void =>
        void sweep(fromPrompt).catch((error: unknown) => options.logger?.warn({ err: error }, "managed processes: tmux panes could not be listed"));

    const ensureWatching = (): void => {
        timer ??= setInterval(() => sweepLogged(false), POLL_MS);
        unwatchPrompts ??= watchPrompts(() => sweepLogged(true));
    };

    const sweep = async (fromPrompt = false): Promise<void> => {
        const states = await runner.states();
        for (const [key, entry] of current) {
            const command = states.get(panelSession(key));
            if (command === undefined) {
                // Session gone: a one-shot whose shell exited outright finished too, it just left nothing behind.
                untrack(key, true);
                continue;
            }
            // First non-shell sighting is the command starting; a later shell sighting is it exiting. Published on
            // change so a watching screen updates immediately.
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
            // One prompt is enough once a job was seen, since precmd itself says the command finished. Two consecutive
            // sightings cover what precmd can't tell apart: a still-booting shell, or the gap between chained `&&`
            // commands.
            entry.promptStreak += 1;
            const graceOk = Date.now() - entry.startedAt > ONE_SHOT_GRACE_MS;
            if ((fromPrompt && entry.sawJob && entry.promptStreak >= 1) || (entry.promptStreak >= 2 && (entry.sawJob || graceOk))) {
                untrack(key, true);
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
            // A re-run of the same key is not the old run any more; its completion stops being a fact about now.
            finishedRuns.delete(key);
            const port = await freePort();
            // A concurrent start of the same key won the race during the port await; leave it be.
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
            // The session exists but isn't serving yet; the port sampler's later frame is what turns the row healthy.
            publishRuntimeChange("panels", "terminals");
            ensureWatching();
        },
        adopt: async (key, spec) => {
            const command = (await runner.states()).get(panelSession(key));
            if (command === undefined) {
                return false;
            }
            if (!current.has(key)) {
                // sawJob is true if the pane's current command isn't the shell, so a later prompt completes it without
                // the boot grace. Adopted mid-life: no cwd, nothing of its start to narrate.
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
            untrack(key, false);
            if (current.size === 0) {
                stopWatching();
            }
            await stopped;
        },
        running: (key) => current.has(key),
        runOf: (key) => {
            const entry = current.get(key);
            if (entry !== undefined) {
                return entry.oneShot === undefined ? undefined : { running: true };
            }
            const finishedAt = finishedRuns.get(key);
            return finishedAt === undefined ? undefined : { running: false, finishedAt };
        },
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
            finishedRuns.clear();
            if (stopped) {
                publishRuntimeChange("panels", "terminals");
            }
            stopWatching();
        },
    };
};
