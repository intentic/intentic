import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    type SystemEvent,
    type TerminalsList,
    type UsageAccount,
    HostTunnelSchema,
    SANDBOX_ROUTE_NAMES,
    systemContract,
} from "@intentic/sandbox-contract";
import { AGENT_SESSION_PREFIX, agentSessionName, JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { implement, ORPCError } from "@orpc/server";
import type { VerifiedIdentity } from "../auth/auth.js";
import { listSubagentSessions } from "../agent/subagents.js";
import { closeBrowserSession, listBrowserSessions } from "../browser/browser-sessions.js";
import { readSubagentTranscript } from "../sessions/subagent-transcript.js";
import { DOCKER_PANEL_KEY } from "../capabilities/handlers/docker.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { EXTENSION_PROCESS_PREFIX, extensionProcessIndex } from "../extensions/extension-processes.js";
import { PANEL_SESSION_PREFIX, SHELL } from "../processes/managed-processes.js";
import { subscribeRepoChanges } from "../workspace/repo-watch.js";
import { subscribeRefChanges } from "../git/ref-watch.js";
import { subscribeWorkspaceChanges } from "../workspace/workspace-watch.js";
import { registerPresence, subscribePresence, updatePresence } from "./presence.js";
import { isValidSessionName } from "../terminal/terminal-session.js";
import { isNewer, latestVersion } from "../platform/version-check.js";
import { runtimeHealth } from "../agent/adapter-health.js";
import { buildId } from "../version.js";
import { workspaceIdentity } from "./workspace-identity.js";

const execFileAsync = promisify(execFile);

// Fold `tmux list-panes -a` output into one row per SESSION: the last pane's foreground command and exit
// status, the session's last-activity stamp, plus whether any pane in it is still alive. Liveness has to be
// per-session because agent-*/job-* sessions carry a window per command and bin/tmux-run keeps finished ones
// (remain-on-exit) so their output stays readable — the last command of a turn always leaves a dead window
// behind, and a session with only dead windows is a session nothing is running in. Unparseable `pane_dead`
// reads as alive: the flag gates a destructive sweep, so the safe direction is "keep".
//
// `exitCode` follows `command` — the LAST pane wins, which for a window-per-command session is precisely the
// last command's status (empty, hence undefined, while that pane still runs). `activityAt` is session-wide, so
// every line of a session carries the same value; 0 stands for "tmux didn't say", and both consumers (the work
// popover's "how long since this said anything", the retention sweep's clock) read that as unknown rather than
// as 1970.
export interface PaneState {
    readonly command: string;
    readonly live: boolean;
    readonly exitCode: number | undefined;
    readonly activityAt: number;
}

export const paneStates = (stdout: string): Map<string, PaneState> => {
    const states = new Map<string, PaneState>();
    for (const line of stdout.split("\n")) {
        const [name, dead, status, activity, command] = line.split("\t");
        if (name === undefined || name === "" || command === undefined) {
            continue;
        }
        const exitCode = Number.parseInt(status ?? "", 10);
        const activitySeconds = Number(activity);
        states.set(name, {
            command,
            live: dead !== "1" || states.get(name)?.live === true,
            exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
            activityAt: Number.isFinite(activitySeconds) && activitySeconds > 0 ? activitySeconds * 1000 : 0,
        });
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
    /* First frame: the workspace's identity, so the browser can drop its persisted cache for a workspace that
     * was wiped and recreated under the same sandbox id (see workspace-identity.ts), plus the route surface
     * THIS daemon build implements. A browser newer than the daemon reads the difference and explains the gap
     * instead of 404-ing blind; see the contract's routes.ts.
     *
     * `build` is the cache guard on the other axis — a rebuilt daemon may shape its answers differently, so
     * the browser drops what it cached from the previous build rather than hydrating it (see version.ts).
     *
     * And `boot` is where the daemon is in its own convergence. This frame is the only thing the browser has
     * to tell "up and serving" from "up and still parking every read"; without it a hydrated cache painted an
     * operable workspace over a boot, and the user's first click went into the readiness gate. Sent BEFORE the
     * subscription below so the wait is visible from the stream's very first frame. */
    yield {
        kind: "hello",
        workspaceId: await workspaceIdentity(services),
        routes: [...SANDBOX_ROUTE_NAMES],
        build: buildId(),
        boot: services.boot.progress(),
    };
    /* Frames waiting to go out, each stamped with when it was produced. The stamp is what makes the browser's
     * half of a "the UI felt stale" report answerable: a roster snapshot that sat in this array for two seconds
     * was late leaving the daemon, and no amount of looking at the browser would ever have shown that. Queue
     * DEPTH rides along because the two causes look identical from one frame's latency alone — a burst of
     * workspaceChanged batches (deep queue, each frame fine) versus a consumer that stopped pulling (shallow
     * queue, one very late frame). */
    const queue: { readonly event: SystemEvent; readonly at: bigint }[] = [];
    const enqueue = (event: SystemEvent): void => {
        queue.push({ event, at: process.hrtime.bigint() });
    };
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
        enqueue({ kind: "presence", users });
        onWake();
    });
    // The fleet roster rides the same stream, same snapshot-not-diff contract: an immediate frame on
    // subscribe paints the fleet, then every registry change (turn lifecycle, usage, land, discard) re-frames.
    const unsubscribeAgents = services.agents.subscribe((agents, rev) => {
        enqueue({ kind: "agents", agents, rev });
        onWake();
    });
    // Boot transitions, for a stream opened DURING one: the hello above carried the snapshot at connect, and
    // each step then re-frames it until the gate opens. Snapshot-not-diff like the rosters, so a browser that
    // reconnects mid-boot is consistent from its first frame.
    const unsubscribeBoot = services.boot.subscribe((progress) => {
        enqueue({ kind: "boot", ...progress });
        onWake();
    });
    const unsubscribe = subscribeWorkspaceChanges((paths) => {
        enqueue({ kind: "workspaceChanged", paths });
        onWake();
    });
    // Repo-set snapshots: a clone/scaffold/delete anywhere under /work re-frames the discovered repo list
    // (the .git-blind watcher can't surface this — see repo-watch.ts).
    const unsubscribeRepos = subscribeRepoChanges((repos) => {
        enqueue({ kind: "reposChanged", repos });
        onWake();
    });
    // Which repos' refs just moved — a commit, a checkout, a branch or tag, a rebase started or aborted. The
    // agent does most of these out-of-band, so without this frame every commit-graph surface stays as fresh as
    // the last thing the user clicked (see git/ref-watch.ts).
    const unsubscribeRefs = subscribeRefChanges((repos) => {
        enqueue({ kind: "refsChanged", repos });
        onWake();
    });
    abort.addEventListener("abort", onWake);
    try {
        while (!abort.aborted) {
            const framed = queue.shift();
            if (framed !== undefined) {
                // Measured at the hand-off, not after: what follows is the consumer's serialization and the
                // socket write, and the number this line is about is how long the frame sat here waiting for
                // its turn. `depth` is what was still behind it.
                services.perf.record("events.frame", Number(process.hrtime.bigint() - framed.at) / 1e6, {
                    frame: framed.event.kind,
                    depth: queue.length,
                });
                yield framed.event;
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
        unsubscribeRefs();
        unsubscribeAgents();
        unsubscribeBoot();
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
            // Read the background-warmed caches synchronously — no fetch or credential read on the request
            // path. A cold cache (tests, first-boot instant) omits the field entirely; the browser's shared
            // /info query refetches. Same shape for both, for the same reason — see adapter-health.ts.
            const latest = latestVersion();
            const runtimes = runtimeHealth();
            return {
                ...info,
                ...(latest !== undefined ? { latest, updateAvailable: isNewer(latest, info.version) } : {}),
                ...(runtimes !== undefined ? { runtimes } : {}),
            };
        }),
        // Exchange the request's verified bearer for a daemon-minted session (the steady-state browser
        // credential — see auth/session.ts). The bearer middleware already verified WHO is asking (a Google ID
        // token, or a still-valid session — which makes this same route sliding renewal); loopback mode and
        // token-scoped callers (panel/bridge/sync) carry no member identity and have no session to mint.
        session: i.session.handler(async ({ context }) => {
            if (services.auth === undefined || context.identity === undefined) {
                throw new ORPCError("UNAUTHORIZED", { message: "no verified identity to mint a session for" });
            }
            const { token, expiresAt } = await services.auth.mintSession(context.identity);
            return { token, expiresAt, email: context.identity.email };
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
        // which is what retires it from the panel's strip and hands it to the retention sweep
        // (terminal-session.ts reapFinishedSessions). job-* sessions are the terminal
        // runner's user-triggered flows (capability adds, infra check — `running` from its in-flight count).
        // Sessions matching no prefix stay hidden. No tmux server yet makes `list-panes` exit non-zero —
        // that's an empty list, not an error.
        terminals: i.terminals.handler(async () => {
            try {
                const { stdout } = await execFileAsync("tmux", [
                    "list-panes",
                    "-a",
                    "-F",
                    "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_activity}\t#{pane_current_command}",
                ]);
                const states = paneStates(stdout);
                const extensionProcesses = await extensionProcessIndex(services);
                const liveAgentSessions = new Set(
                    services.agents.liveSessionIds().flatMap((sessionId) => {
                        const session = agentSessionName(sessionId);
                        return session === undefined ? [] : [session];
                    }),
                );
                const sessions = [...states].flatMap(([name, { command, live, exitCode, activityAt }]): TerminalsList["sessions"] => {
                    // Every row carries the session's clock and its last window's status; what differs per kind is
                    // only what `running` means.
                    const seen = { activityAt, ...(exitCode !== undefined ? { exitCode } : {}) };
                    if (name.startsWith(WEB_SESSION_PREFIX)) {
                        return [{ name, kind: "shell" as const, running: true, ...seen }];
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
                                    ...seen,
                                    ...(owner !== undefined ? owner : {}),
                                },
                            ];
                        }
                        return [{ name, label: key, kind: "panel" as const, running: services.processes.running(key), ...seen }];
                    }
                    if (name.startsWith(AGENT_SESSION_PREFIX)) {
                        return [
                            {
                                name,
                                label: name.slice(AGENT_SESSION_PREFIX.length),
                                kind: "agent" as const,
                                running: live || liveAgentSessions.has(name),
                                ...seen,
                            },
                        ];
                    }
                    if (name.startsWith(JOB_SESSION_PREFIX)) {
                        return [
                            {
                                name,
                                label: name.slice(JOB_SESSION_PREFIX.length),
                                kind: "job" as const,
                                running: services.terminalRun.running(name),
                                ...seen,
                            },
                        ];
                    }
                    return [];
                });
                return { sessions };
            } catch {
                // No tmux server yet — nothing has opened a shell in this sandbox.
                return { sessions: [] };
            }
        }),
        // The agent's Chromiums and the pages each holds open. Nothing to shell out to: these are records this
        // daemon keeps itself, from the hooks that see the browser tool calls (browser/browser-sessions.ts).
        browsers: i.browsers.handler(() => ({ sessions: listBrowserSessions() })),
        closeBrowser: i.closeBrowser.handler(async ({ input }) => {
            await closeBrowserSession(input.name);
            return { ok: true };
        }),
        // The agents this sandbox's agents started, and one of their transcripts. Both are daemon-held records
        // like the browsers above — the list from the registry the turn stream feeds (agent/subagents.ts), the
        // transcript from whichever store actually ran the child (sessions/subagent-transcript.ts).
        subagents: i.subagents.handler(() => ({ sessions: listSubagentSessions() })),
        subagentTranscript: i.subagentTranscript.handler(async ({ input }) => ({
            messages: await readSubagentTranscript(
                { root: services.workspace.root, codexHome: services.codexHome, openCode: services.openCode },
                input.id,
            ),
        })),
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
