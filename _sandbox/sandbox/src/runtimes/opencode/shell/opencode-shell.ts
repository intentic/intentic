import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@intentic/base/fetch-json";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { z } from "zod";
import { NO_PROMPTS, PIPESTATUS_TRAP } from "../../../agent/tools/agent-terminals.js";
import { maskDeep, maskTargets, withheld } from "../../../agent/tools/agent-redaction.js";
import { writeRunFile } from "../../../agent/tools/jobs/run-files.js";
import { resolveCommandSecrets, type SecretAccess } from "../../../secrets/secret-access.js";
import { opt } from "../../../opt.js";
import { WORKLOAD_ENV } from "../../../seams/workload-stamp.js";
import { AGENT_SESSION_ENV } from "../../../system/boot/container-owner.js";
import { TMUX_RUN_BIN } from "../../../terminal/terminal-run.js";
import { shellPrefix } from "../../../workload/workload-class.js";
import { createHookSocket, type HookAnswer, type HookEndpoint } from "../../daemon-tools/hook-socket.js";
import type { SessionJudge } from "../opencode-permissions.js";
import { SHELL_SCRIPT_NAME, shellScript } from "./opencode-shell-script.js";

// OpenCode's shell, routed through the daemon. OpenCode 2.0.26 runs every shell call as `<config shell> -c <command>`,
// with the session's environment (`session.environment`, which the daemon sets whole) plus OPENCODE_SESSION_ID, and only
// after the call's permission ask was answered. The daemon names its own script as that shell (opencode-shell-script.ts);
// the script asks here, by the session id, what to run:
// - a `{{secret:name}}` reference is resolved into its value only now, after the rulebook judged the reference-form
//   command (secrets/secret-access.ts), and an unknown or withheld name refuses the call;
// - the command runs in the conversation's tmux session through tmux-run, the way the Claude loop's Bash does
//   (agent/tools/agent-terminals.ts), so the terminal panel watches it live and the output filter cleans it;
// - what it prints comes back here to be masked, each stored value to its reference, before OpenCode (and so the model)
//   reads it. Only the shell's output: a file the read tool opens, a fetched page and an MCP result are not masked.

// What one shell call runs: refused with a sentence, or an argv, and whether its output is masked on the way back.
export type ShellPlan = { readonly refused: string } | { readonly argv: readonly string[]; readonly masked: boolean };

export interface ShellRoute {
    readonly prepare: (call: { readonly command: string; readonly cwd: string }) => Promise<ShellPlan>;
    readonly mask: (text: string) => Promise<string>;
}

// The pane a turn's commands run in: its tmux session, the agent session stamped on its processes, the environment names
// forwarded into it (a pane inherits the tmux server's environment, not the caller's), and the conversation it is
// stamped for.
export interface ShellPane {
    readonly session: string;
    readonly agentSession: string;
    readonly forward: readonly string[];
    readonly owner?: string;
}

export interface ShellRouteOptions {
    // The turn's secret seam: resolves references in a command and lists the values its output is masked by. Absent,
    // a command runs as written and its output is passed through.
    readonly secrets?: SecretAccess;
    // Absent runs the command plainly, outside any pane (tmux-run is not in this image, or the operator turned it off).
    readonly pane?: ShellPane;
    // Called as a command goes into the pane, so the turn can surface the session in the panel.
    readonly surfaced?: () => void;
    // Where a call's run files are written; the system temp dir by default.
    readonly runRoot?: string;
}

// The bash every command runs in, by its own path: the daemon's script is named `bash` (so OpenCode's description and
// its command scanner read the shell as bash), and is not on any PATH, so nothing resolves back to it.
export const REAL_BASH = "/bin/bash";

// Every pane command is demoted like the Claude loop's (workload-class.ts).
const POLITE = shellPrefix({ class: "command" });

// A window name from the command's first word, in the session names' charset since tmux-run reads it unquoted.
const windowOf = (command: string): string => {
    const slug = (command.trim().split(/\s+/)[0] ?? "")
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 24);
    return slug === "" ? "run" : slug;
};

// Environment names as tmux-run's `-e` flags: names only, valid identifiers only; tmux-run reads each value from its
// own environment, which is the session's.
const forwardFlags = (names: readonly string[]): string[] => names.flatMap((name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? ["-e", name] : []));

// The pane's run, by file as the Claude loop's hook writes it, so no command rides an argv a `pkill -f` could match.
const paneArgv = (pane: ShellPane, said: string, executed: string, runRoot: string): string[] => {
    const dir = mkdtempSync(join(runRoot, "intentic-run-"));
    const agent = join(dir, "agent");
    writeRunFile(dir, "agent", `${PIPESTATUS_TRAP}${executed}\n`);
    const owner = pane.owner !== undefined && /^[A-Za-z0-9_-]+$/u.test(pane.owner) ? `${WORKLOAD_ENV}=${pane.owner} ` : "";
    writeRunFile(dir, "line", `${AGENT_SESSION_ENV}=${shellQuote(pane.agentSession)} ${owner}${POLITE}${NO_PROMPTS}bash ${shellQuote(agent)}\n`);
    writeRunFile(dir, "said", said);
    writeRunFile(dir, "name", windowOf(said));
    return [TMUX_RUN_BIN, ...forwardFlags(pane.forward), "-f", join(dir, "line"), pane.session];
};

export const shellRouteOf = (options: ShellRouteOptions): ShellRoute => ({
    prepare: async ({ command }) => {
        const resolved = options.secrets === undefined ? { command } : await resolveCommandSecrets(command, options.secrets, "shell", "shell");
        if ("refusal" in resolved) {
            return { refused: `Not run: ${resolved.refusal}` };
        }
        const masked = options.secrets !== undefined;
        if (options.pane === undefined) {
            return { argv: [REAL_BASH, "-c", resolved.command], masked };
        }
        const argv = paneArgv(options.pane, command, resolved.command, options.runRoot ?? tmpdir());
        options.surfaced?.();
        return { argv, masked };
    },
    // Read per call, so a credential stored mid-turn masks from the next stretch of output on.
    mask: async (text) => {
        if (options.secrets === undefined) {
            return text;
        }
        const targets = maskTargets(await options.secrets.list());
        // SAFETY: maskDeep maps a string to a string; it only walks into arrays and objects.
        return targets.length === 0 ? text : (maskDeep(text, targets) as string);
    },
});

/**
 * The pane a turn's root session runs its commands in, its subagents' too; undefined where the session id names no tmux
 * session. Named from the id's tail: an OpenCode id is `ses_`, then its creation time, then a random part, and the
 * shared derivation keeps only eight characters, which from the front would be the same for every session made the
 * same hour.
 */
export const shellPaneOf = (rootSession: string, forward: readonly string[], owner: string | undefined): ShellPane | undefined => {
    const session = agentSessionName(rootSession.slice(-8));
    return session === undefined ? undefined : { session, agentSession: rootSession, forward, ...opt("owner", owner) };
};

const PrepareSchema = z.object({ session: z.string(), command: z.string(), cwd: z.string().catch("") });
const OutputSchema = z.object({ session: z.string(), run: z.string().optional(), output: z.string() });
const DoneSchema = z.object({ run: z.string() });

// What the script prints instead of running, when the daemon could not say how.
export const NOT_PREPARED = "Not run: the sandbox daemon could not prepare this command, so it was not run. Do not retry it in a loop.";

// The words a masked run's output is withheld with once the daemon no longer holds the route it was prepared with.
export const RUN_GONE = "the turn this command was started for has ended, so nothing could mask what it printed";

// How long a masked run's route is held for a script that never said it was done (it was killed): longer than any shell
// OpenCode waits on, short enough that a daemon running for weeks does not keep every turn's seam.
const RUN_HELD_MS = 24 * 3_600_000;

/**
 * The daemon's end of the script: `/prepare` turns a session's command into what to run, `/output` masks what it
 * printed, `/done` lets go of the run. A session no turn registered (OpenCode's own command interpolation, a session the
 * daemon is not driving) runs its command as written, unmasked, as its permission asks get the standing yes. A masked
 * run is masked by the route it was prepared with for as long as it prints, even past its turn's end (a stopped turn's
 * command that is still printing, whose result OpenCode keeps for the session's next turn), and withheld if that route is
 * gone. A prepare that failed refuses the call; a mask that failed answers no output, which the script reads as withheld
 * from there on.
 */
export const shellDoor = (routeOf: (session: string) => ShellRoute | undefined, now: () => number = Date.now) => {
    const runs = new Map<string, { readonly route: ShellRoute; readonly at: number }>();
    const forgetStale = (): void => {
        for (const [run, held] of runs) {
            if (now() - held.at > RUN_HELD_MS) {
                runs.delete(run);
            }
        }
    };
    return {
        "/prepare": {
            answer: async (payload: JsonValue): Promise<HookAnswer> => {
                const call = PrepareSchema.parse(payload);
                const route = routeOf(call.session);
                const plan = route === undefined ? { argv: [REAL_BASH, "-c", call.command], masked: false } : await route.prepare(call);
                if ("refused" in plan) {
                    return { refused: plan.refused };
                }
                if (!plan.masked || route === undefined) {
                    return { argv: [...plan.argv], masked: false };
                }
                forgetStale();
                const run = randomUUID();
                runs.set(run, { route, at: now() });
                return { argv: [...plan.argv], masked: true, run };
            },
            unreadable: { refused: NOT_PREPARED },
            failed: () => ({ refused: NOT_PREPARED }),
        },
        "/output": {
            answer: async (payload: JsonValue): Promise<HookAnswer> => {
                const { session, run, output } = OutputSchema.parse(payload);
                const route = run === undefined ? routeOf(session) : runs.get(run)?.route;
                if (route === undefined) {
                    return run === undefined ? { output } : { withheld: RUN_GONE };
                }
                return { output: await route.mask(output) };
            },
            unreadable: {},
            failed: (error) => ({ withheld: withheld(error) }),
        },
        "/done": {
            answer: (payload: JsonValue): HookAnswer => {
                runs.delete(DoneSchema.parse(payload).run);
                return {};
            },
            unreadable: {},
        },
    } satisfies Readonly<Record<string, HookEndpoint>>;
};

export interface ShellHost {
    // The script OpenCode is told to run as its shell, written fresh for every boot (it names this daemon's node and
    // socket), with its socket listening before any command could ask; undefined where the daemon does not route it.
    readonly path: () => Promise<string | undefined>;
    readonly close: () => Promise<void>;
}

/**
 * The shell for one OpenCode service: the script, and the 0600 socket it asks over, in `dir` (owner-only: what can write
 * to the socket can have commands prepared). A command is placed by its session on the service's judges, and runs the
 * way that turn's judge says. No `dir`, no routing: OpenCode keeps its own shell.
 */
export const shellHost = (dir: string | undefined, judges: ReadonlyMap<string, Pick<SessionJudge, "shell">>): ShellHost => {
    if (dir === undefined) {
        return { path: async () => undefined, close: async () => {} };
    }
    const socketPath = join(dir, "shell.sock");
    const socket = createHookSocket(
        socketPath,
        shellDoor((session) => judges.get(session)?.shell),
    );
    return {
        path: async () => {
            const path = join(dir, SHELL_SCRIPT_NAME);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await writeFile(path, shellScript(socketPath, process.execPath), { mode: 0o755 });
            // A file that was already there keeps its old mode through writeFile.
            await chmod(path, 0o755);
            await socket.listen();
            return path;
        },
        close: socket.close,
    };
};
