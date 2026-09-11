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
    // Runs in a detached tmux session in `cwd`, with PORT (manager-assigned) and `env` set.
    readonly command: string;
    readonly cwd: string;
    readonly env?: Record<string, string>;
    // Extra env vars that also get the assigned port, for servers that read a non-PORT var (e.g. API_PORT).
    readonly portEnv?: readonly string[];
    // A one-shot job reports done once its shell returns to prompt; default panels run until session end.
    readonly oneShot?: true;
}

// Wire data: session names reach the browser and are string-built there; never rename this prefix.
export const PANEL_SESSION_PREFIX = "panel-";

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

// The tmux side of the manager, injectable so tests need no tmux binary. `states` reports every pane's foreground
// command in one call; absence means dead.
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
}

/* THE ENVIRONMENT A MANAGED COMMAND IS TYPED INTO, as one pure function so the switches below can be asserted
 * without a tmux binary. `-e` sets each of these on the session (the tmux server's global env, inherited from
 * this daemon, supplies the rest).
 *
 * PATH: a bare `sh -c` does NOT add node_modules/.bin to PATH (only pnpm/npm/npx do), so a workspace-local bin
 * like `turbo`/`vite`/`astro` would fail with "not found" (exit 127). The run dir's bin is prepended so any dev
 * command resolves its local tools; the panel's own `env` rides underneath.
 *
 * HISTFILE: a panel's own zsh history, not the owner's. The command is typed into an interactive shell on
 * purpose (see the send-keys comment in `launch`), and the image's zsh shares one history file on the /history
 * volume so terminal autosuggestions survive a rebuild, which would make every dev-server command the DAEMON
 * typed a permanent suggestion in the owner's own tabs. Overriding HISTFILE (the image's .zshrc assigns it only
 * if unset) keeps the durable store to what a human typed, while ↑ still re-runs the command in this pane.
 * Keyed by port, not session name: it is unique per launch, filename-safe without sanitizing, and
 * container-local, this history is meant to die with the pane.
 *
 * PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: pnpm's own pre-run install, switched off, because the daemon already
 * decided whether to install. Every dev command here runs behind a `test -d node_modules || pnpm install`
 * guard, and the baked starter site arrives with its node_modules copied out of the image so that guard is
 * satisfied on a fresh box. pnpm then re-examines the workspace on its own before `pnpm --filter <app> dev`
 * (a copied tree never passes its up-to-date check) and runs a full install first: a lockfile walk, a
 * supply-chain verification that can go to the registry, every lifecycle script. Measured on a warm box that
 * is a second; on the throttled first boot of a hosted machine, or behind a slow network, it is minutes of a
 * pane whose foreground command is `node`, which the launch state below can only call "starting", and a
 * verification that fails leaves the shell at its prompt, which reads as the dev server having crashed. Either
 * way the site the sandbox exists to show sat behind "Preparing the preview…".
 *
 * And that install can END AT A QUESTION. When the node_modules it walks into is not one it would have built
 * — a different layout version, hoist pattern or store, which is what a tree lifted out of an image and into a
 * workspace can look like — pnpm asks `The modules directory at "…" will be removed and reinstalled from
 * scratch. Proceed? (Y/n)` and waits. A pane is a TTY, so pnpm prompts instead of failing, and the preview
 * then sits behind "Preparing the preview…" for as long as the sandbox lives, because the keystroke it wants
 * is in a terminal nobody told the user to open. Switching the pre-run install off is what closes that, by
 * never reaching it: the three levers pnpm names for the prompt itself are all out of reach here. `CI=true`
 * also flips `frozen-lockfile` on, so the install fails instead of asking; `--force` is not ours to pass,
 * since pnpm builds this install's argv itself; and `confirmModulesPurge: false` is read from a workspace
 * manifest only — measured, it is not read from the environment under any spelling — and the manifests here
 * belong to the user's repos, not to the daemon.
 *
 * THE PREFIX IS THE WHOLE POINT. pnpm 11 and 12 read their settings from `PNPM_CONFIG_<UPPER_SNAKE>` (the
 * generic reader in pnpm's config/reader/lib/env.js) and ignore the `npm_config_` prefix entirely — measured
 * both ways, against `pnpm store path` for a setting with a visible value and against a `pnpm run` over a
 * stale tree for this one. The spelling that stood here before (`npm_config_verify-deps-before-run`) was
 * therefore inert, and every preview pane went on paying for the install it was meant to prevent, up to and
 * including that prompt. Inert for anything that is not pnpm. */
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

// The tmux server outlives a daemon restart; panel/agent-*/job-* sessions are killed at boot so 'stopped after a
// restart' holds. `exempt` spares a session main.ts re-adopted instead of truncating.
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
    let timer: NodeJS.Timeout | undefined;
    let unwatchPrompts: (() => void) | undefined;

    // Before this, a prompt sighting reads as a booting shell, not completion, unless the job was seen running.
    const ONE_SHOT_GRACE_MS = 10_000;

    // Untracks a key and publishes the change, since /panels and the terminals list both read `running` from here. A
    // died dev server and a finished oneShot are the two ways a panel stops without a Stop click.
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
