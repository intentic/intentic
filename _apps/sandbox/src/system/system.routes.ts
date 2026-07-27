import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type SystemEvent, type TerminalsList, type UsageAccount, HostTunnelSchema, SANDBOX_ROUTE_NAMES, systemContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { agentSessionName } from "../agent/agent-terminals.js";
import type { VerifiedIdentity } from "../auth/auth.js";
import { DOCKER_PANEL_KEY } from "../capabilities/handlers/docker.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { EXTENSION_PROCESS_PREFIX, extensionProcessIndex } from "../extensions/extension-processes.js";
import { PANEL_SESSION_PREFIX, SHELL } from "../processes/managed-processes.js";
import { subscribeRepoChanges } from "../workspace/repo-watch.js";
import { subscribeWorkspaceChanges } from "../workspace/workspace-watch.js";
import { registerPresence, subscribePresence, updatePresence } from "./presence.js";
import { AGENT_SESSION_PREFIX, isValidSessionName, JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "../terminal/terminal-session.js";
import { isNewer, latestVersion } from "../platform/version-check.js";
import { workspaceIdentity } from "./workspace-identity.js";

const execFileAsync = promisify(execFile);

// Fold `tmux list-panes -a` output into one row per SESSION: the last pane's foreground command, plus whether
// any pane in it is still alive. Liveness has to be per-session because agent-*/job-* sessions carry a window
// per command and bin/tmux-run keeps finished ones (remain-on-exit) so their output stays readable — the last
// command of a turn always leaves a dead window behind, and a session with only dead windows is a session
// nothing is running in. Unparseable `pane_dead` reads as alive: the flag gates a destructive sweep, so the
// safe direction is "keep".
export const paneStates = (stdout: string): Map<string, { command: string; live: boolean }> => {
    const states = new Map<string, { command: string; live: boolean }>();
    for (const line of stdout.split("\n")) {
        const [name, dead, command] = line.split("\t");
        if (name === undefined || name === "" || command === undefined) {
            continue;
        }
        states.set(name, { command, live: dead !== "1" || states.get(name)?.live === true });
    }
    return states;
};

// Long-lived events stream the browser holds open: heartbeat frames every ~2s (detect the sandbox dying — the
// tunnel drops the proxied response when the origin goes away — and trip a client watchdog) INTERLEAVED with
// workspaceChanged batches from the filesystem watcher (live tree/viewer refresh) and presence roster
// snapshots. One connection carries all three: a change is forwarded the instant it lands, and the heartbeat
// only fires when the stream is otherwise idle. `member` joins this connection to the roster for its lifetime;
// undefined (no identity — loopback mode, or an old client sending no clientId) observes without joining.
async function* systemEvents(
    services: Services,
    signal: AbortSignal | undefined,
    member: { clientId: string; identity: VerifiedIdentity } | undefined,
): AsyncGenerator<SystemEvent> {
    const abort = signal ?? new AbortController().signal;
    if (abort.aborted) {
        return;
    }
    // First frame: the workspace's identity, so the browser can drop its persisted cache for a workspace that
    // was wiped and recreated under the same sandbox id (see workspace-identity.ts), plus the route surface
    // THIS daemon build implements. A browser newer than the daemon reads the difference and explains the gap
    // instead of 404-ing blind; see the contract's routes.ts.
    yield { kind: "hello", workspaceId: await workspaceIdentity(services), routes: [...SANDBOX_ROUTE_NAMES] };
    const queue: SystemEvent[] = [];
    // Resolver of the current idle wait, so a change (or an abort) ends it immediately instead of stalling until
    // the next heartbeat tick.
    let wake: (() => void) | undefined;
    const onWake = (): void => {
        const resolve = wake;
        wake = undefined;
        resolve?.();
    };
    // Register BEFORE subscribing: the register broadcast reaches the already-connected members, and the
    // subscribe's immediate snapshot then paints the full roster (self included) onto this connection.
    const unregisterPresence = member !== undefined ? registerPresence(member.clientId, member.identity) : undefined;
    const unsubscribePresence = subscribePresence((users) => {
        queue.push({ kind: "presence", users });
        onWake();
    });
    // The fleet roster rides the same stream, same snapshot-not-diff contract: an immediate frame on
    // subscribe paints the fleet, then every registry change (turn lifecycle, usage, land, discard) re-frames.
    const unsubscribeAgents = services.agents.subscribe((agents, rev) => {
        queue.push({ kind: "agents", agents, rev });
        onWake();
    });
    const unsubscribe = subscribeWorkspaceChanges((paths) => {
        queue.push({ kind: "workspaceChanged", paths });
        onWake();
    });
    // Repo-set snapshots: a clone/scaffold/delete anywhere under /work re-frames the discovered repo list
    // (the .git-blind watcher can't surface this — see repo-watch.ts).
    const unsubscribeRepos = subscribeRepoChanges((repos) => {
        queue.push({ kind: "reposChanged", repos });
        onWake();
    });
    abort.addEventListener("abort", onWake);
    try {
        while (!abort.aborted) {
            const framed = queue.shift();
            if (framed !== undefined) {
                yield framed;
                continue;
            }
            // Idle: wait for a change (wake) or the heartbeat interval; a timeout means "nothing changed, beat".
            const timedOut = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => {
                    wake = undefined;
                    resolve(true);
                }, 2000);
                wake = () => {
                    clearTimeout(timer);
                    resolve(false);
                };
            });
            if (!abort.aborted && timedOut) {
                yield { kind: "heartbeat" };
            }
        }
    } finally {
        abort.removeEventListener("abort", onWake);
        unsubscribe();
        unsubscribeRepos();
        unsubscribeAgents();
        unsubscribePresence();
        unregisterPresence?.();
    }
}

export const createSystemRoutes = (services: Services) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        info: i.info.handler(() => {
            const info = services.info;
            if (info === undefined) {
                return {};
            }
            // Read the background-warmed cache synchronously — no fetch on the request path. Cold cache (tests,
            // first-boot instant) omits latest/updateAvailable; the browser's shared /info query refetches.
            const latest = latestVersion();
            return { ...info, ...(latest !== undefined ? { latest, updateAvailable: isNewer(latest, info.version) } : {}) };
        }),
        events: i.events.handler(({ input, context, signal }) =>
            systemEvents(
                services,
                signal,
                context.identity !== undefined && input.clientId !== undefined ? { clientId: input.clientId, identity: context.identity } : undefined,
            ),
        ),
        // A tab's activity self-report. Accepted only for the caller's own live connection (see updatePresence);
        // identity-less callers (loopback) have no roster entry to update — still ok, the report is just moot.
        presence: i.presence.handler(({ input, context }) => {
            if (context.identity !== undefined) {
                updatePresence(context.identity, input);
            }
            return { ok: true } as const;
        }),
        // Relay an intentic-provided host-tunnel mint to the platform (connect-token auth). The platform maps its
        // own failures to statuses we translate back: 404 (tunnels disabled / unknown sandbox), 400 (bad token),
        // anything else is an upstream gateway failure.
        hostTunnel: i.hostTunnel.handler(async ({ input }) => {
            const { status, json } = await services.platformHostTunnel(input.hostName);
            if (status !== 200) {
                const message = (json as { error?: string } | undefined)?.error ?? `host tunnel request failed (${status})`;
                if (status === 404) {
                    throw new ORPCError("NOT_FOUND", { message });
                }
                if (status === 400) {
                    throw new ORPCError("BAD_REQUEST", { message });
                }
                throw new ORPCError("BAD_GATEWAY", { message });
            }
            return HostTunnelSchema.parse(json);
        }),
        // Per-account token/cost totals, folded from the spend ledger (usage/usage-store.ts) — ALL-TIME, because
        // that ledger is never pruned. This used to aggregate the activity log's turn.completed events, so the
        // totals covered only that log's retained window: a busy week evicted the older turns and the number a
        // user reads as "what this account has cost me" silently went DOWN. Unattributed turns (an env-token turn
        // has no account) are skipped rather than pooled under a blank id — they belong to no account's total.
        usage: i.usage.handler(async () => {
            const totals = new Map<string, UsageAccount>();
            for (const row of await services.usage.rollup({})) {
                if (row.account === undefined) {
                    continue;
                }
                const key = `${row.provider}\u0000${row.account}`;
                const current = totals.get(key) ?? {
                    provider: row.provider,
                    account: row.account,
                    turns: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    costUsd: 0,
                };
                totals.set(key, {
                    provider: current.provider,
                    account: current.account,
                    turns: current.turns + row.turns,
                    inputTokens: current.inputTokens + row.inputTokens,
                    outputTokens: current.outputTokens + row.outputTokens,
                    cacheReadTokens: current.cacheReadTokens + row.cacheReadTokens,
                    cacheCreationTokens: current.cacheCreationTokens + row.cacheCreationTokens,
                    costUsd: current.costUsd + row.costUsd,
                });
            }
            return { accounts: [...totals.values()] };
        }),
        // Every attachable tmux session — the ONE list behind the web app's global terminal panel. Same tmux
        // server the /system/terminal PTYs spawn (same root user, same default socket), queried by shelling
        // out. web-* sessions are the user's shells; panel-* sessions are dev servers (labeled by panel key,
        // `running` from the process manager — false = untracked, e.g. a finished oneShot's lingering shell)
        // — EXCEPT managed background processes (an extension's ext-* keys, dockerd's), which read as kind
        // "process": the panel surfaces those in its processes popover, not as killable tabs, and their
        // `running` is the actual process — pane_current_command back at the shell means it crashed, however
        // the manager still tracks the session. agent-* sessions are the Claude agent's Bash terminals
        // (tmux-run): they are `running` while their agent has a turn in flight (the fleet registry's
        // liveSessionIds — an agent between two commands is still working) or any pane in them is alive (see
        // paneStates — a turn nothing tracks, e.g. the CLI's own, still reads honestly). Once neither holds,
        // every window is a finished command's dead pane and nothing will ever write to that session again,
        // which is what lets the panel's "clear finished terminals" sweep take it. job-* sessions are the terminal
        // runner's user-triggered flows (capability adds, infra check — `running` from its in-flight count).
        // Sessions matching no prefix stay hidden. No tmux server yet makes `list-panes` exit non-zero —
        // that's an empty list, not an error.
        terminals: i.terminals.handler(async () => {
            try {
                const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}\t#{pane_current_command}"]);
                const states = paneStates(stdout);
                const extensionProcesses = await extensionProcessIndex(services);
                const liveAgentSessions = new Set(
                    services.agents.liveSessionIds().flatMap((sessionId) => {
                        const session = agentSessionName(sessionId);
                        return session === undefined ? [] : [session];
                    }),
                );
                const sessions = [...states].flatMap(([name, { command, live }]): TerminalsList["sessions"] => {
                    if (name.startsWith(WEB_SESSION_PREFIX)) {
                        return [{ name, kind: "shell" as const, running: true }];
                    }
                    if (name.startsWith(PANEL_SESSION_PREFIX)) {
                        const key = name.slice(PANEL_SESSION_PREFIX.length);
                        if (key === DOCKER_PANEL_KEY || key.startsWith(EXTENSION_PROCESS_PREFIX)) {
                            // An orphan (its extension uninstalled while the session lingers) has no index entry —
                            // still a process row, addressable only by its session name.
                            const owner = extensionProcesses.get(key);
                            return [
                                {
                                    name,
                                    label: key,
                                    kind: "process" as const,
                                    running: services.processes.running(key) && command !== SHELL,
                                    ...(owner !== undefined ? owner : {}),
                                },
                            ];
                        }
                        return [{ name, label: key, kind: "panel" as const, running: services.processes.running(key) }];
                    }
                    if (name.startsWith(AGENT_SESSION_PREFIX)) {
                        return [
                            {
                                name,
                                label: name.slice(AGENT_SESSION_PREFIX.length),
                                kind: "agent" as const,
                                running: live || liveAgentSessions.has(name),
                            },
                        ];
                    }
                    if (name.startsWith(JOB_SESSION_PREFIX)) {
                        return [
                            { name, label: name.slice(JOB_SESSION_PREFIX.length), kind: "job" as const, running: services.terminalRun.running(name) },
                        ];
                    }
                    return [];
                });
                return { sessions };
            } catch {
                return { sessions: [] };
            }
        }),
        // Destroy one session (its tab's close button). Validate the name before it reaches the `kill-session`
        // argv — the security guard against a name like `-C` being read as a flag. Killing a session that already
        // vanished is idempotent-OK (tmux exits non-zero; we don't surface it).
        killTerminal: i.killTerminal.handler(async ({ input }) => {
            if (!isValidSessionName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: `invalid session name: ${input.name}` });
            }
            // A panel session belongs to the process manager — stop through it so `current` unmaps NOW (a Start
            // right after × must not no-op for the sweep interval). stop() kills lingering sessions too.
            if (input.name.startsWith(PANEL_SESSION_PREFIX)) {
                services.processes.stop(input.name.slice(PANEL_SESSION_PREFIX.length));
                return { ok: true };
            }
            // `=` forces an exact target match — a bare `-t web-a` would prefix-match `web-ab` once `web-a` is gone.
            await execFileAsync("tmux", ["kill-session", "-t", `=${input.name}`]).catch(() => undefined);
            return { ok: true };
        }),
    };
};
