import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    type SystemEvent,
    type TerminalsList,
    type UsageAccount,
    SANDBOX_ROUTE_NAMES,
    SANDBOX_ROUTE_SHAPES,
    systemContract,
} from "@intentic/sandbox-contract";
import { AGENT_SESSION_PREFIX, agentSessionName, JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { implement, ORPCError } from "@orpc/server";
import type { Caller } from "../auth/auth.js";
import { listSubagentSessions, pairLiveSubagents } from "../agent/subagents/subagents.js";
import { closeBrowserSession, listBrowserSessions } from "../browser/sessions/browser-sessions.js";
import { readSubagentTranscript } from "../sessions/subagent-transcript.js";
import { DOCKER_PANEL_KEY } from "../capabilities/handlers/docker.handler.js";
import { LOCAL_MODEL_PREFIX } from "../capabilities/handlers/localmodel.handler.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { extensionProcessIndex } from "../extensions/extension-processes.js";
import { PANEL_SESSION_PREFIX } from "../processes/managed-processes.js";
import { SERVICE_SESSION_PREFIX, serviceSession } from "../processes/service-processes.js";
import { foreground, PANE_FORMAT, paneStates, SHELL } from "../terminal/pane-state.js";
import { subscribeRepoChanges } from "../workspace/watch/repo-watch.js";
import { subscribeRefChanges } from "../git/remote/ref-watch.js";
import { subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";
import { publishRuntimeChange, subscribeRuntimeChanges } from "./runtime-watch.js";
import { registerPresence, subscribePresence, updatePresence } from "./presence.js";
import { captureScrollback, isValidSessionName, jobSessionLabel } from "../terminal/terminal-session.js";
import { settleTerminalHelpFor, terminalHelpFor } from "../terminal/terminal-help.js";
import { isNewer, latestVersion } from "../platform/boot/version-check.js";
import { breakingNotes, MAX_UPDATE_NOTES, updateNotes } from "../platform/boot/release-notes.js";
import { stagedUpdate } from "../platform/boot/staged-update.js";
import { runtimeHealth } from "../agent/providers/adapter-health.js";
import { buildId } from "../version.js";
import { manifestProblems } from "../store/manifest-problems.js";
import { repairManifest } from "../store/manifest-repair.js";
import { workspaceIdentity } from "./workspace-identity.js";

const execFileAsync = promisify(execFile);

// Long-lived /events stream: heartbeats every ~2s interleaved with workspaceChanged batches and presence snapshots.
// `member` joins the roster for this connection's lifetime; undefined observes without joining.
async function* systemEvents(
    services: Services,
    signal: AbortSignal | undefined,
    identity: Caller | undefined,
    clientId: string | undefined,
): AsyncGenerator<SystemEvent> {
    const controller = new AbortController();
    const abort = controller.signal;
    if (abort.aborted) {
        return;
    }
    const abortFromCaller = (): void => controller.abort();
    signal?.addEventListener("abort", abortFromCaller);
    if (signal?.aborted === true) {
        controller.abort();
        signal.removeEventListener("abort", abortFromCaller);
        return;
    }
    // First frame: workspace identity (a wipe/recreate gets a new one), the route/shape surface this build implements,
    // the build id for cache invalidation, and boot progress; sent before subscribing so it appears before any wait.
    yield {
        kind: "hello",
        workspaceId: await workspaceIdentity(services),
        routes: [...SANDBOX_ROUTE_NAMES],
        shapes: { ...SANDBOX_ROUTE_SHAPES },
        build: buildId(),
        boot: services.boot.progress(),
    };
    // Frames waiting to go out, stamped with production time; queue depth distinguishes a burst from a stalled
    // consumer.
    const queue: { readonly event: SystemEvent; readonly at: bigint }[] = [];
    const enqueue = (event: SystemEvent): void => {
        queue.push({ event, at: process.hrtime.bigint() });
    };
    // Resolves the current idle wait immediately on a change or abort, instead of stalling for the next heartbeat.
    let wake: (() => void) | undefined;
    const onWake = (): void => {
        const resolve = wake;
        wake = undefined;
        resolve?.();
    };
    // Registers before subscribing, so the broadcast reaches existing members before the snapshot paints back.
    const unregisterPresence = identity !== undefined && clientId !== undefined ? registerPresence(clientId, identity) : undefined;
    const unsubscribePresence = subscribePresence((users) => {
        enqueue({ kind: "presence", users });
        onWake();
    });
    // Fleet roster: snapshot-not-diff, an immediate frame on subscribe then a re-frame on every registry change.
    const unsubscribeAgents = services.agents.subscribe((agents, rev) => {
        enqueue({ kind: "agents", agents, rev });
        onWake();
    });
    // Boot transitions re-frame the hello snapshot, so a mid-boot reconnect is consistent from its first frame.
    const unsubscribeBoot = services.boot.subscribe((progress) => {
        enqueue({ kind: "boot", ...progress });
        onWake();
    });
    const unsubscribe = subscribeWorkspaceChanges((paths) => {
        enqueue({ kind: "workspaceChanged", paths });
        onWake();
    });
    // Repo-set snapshots: a clone, scaffold, or delete under /work re-frames the discovered list.
    const unsubscribeRepos = subscribeRepoChanges((repos) => {
        enqueue({ kind: "reposChanged", repos });
        onWake();
    });
    // Which repos' refs moved (commit, checkout, branch/tag, rebase); without it, commit-graphs refresh on click.
    const unsubscribeRefs = subscribeRefChanges((repos) => {
        enqueue({ kind: "refsChanged", repos });
        onWake();
    });
    // Running things with no file on disk (sessions, ports, browsers, subagents); this also starts the sampler.
    const unsubscribeRuntime = subscribeRuntimeChanges((domains) => {
        enqueue({ kind: "runtimeChanged", domains });
        onWake();
    });
    // Account plan limits or a provider refusal changed, so every open window's usage ring agrees without polling.
    const unsubscribeHeadroom = services.headroom.onChange((provider, account, usage) => {
        enqueue({ kind: "accountUsage", provider, account, ...(usage === undefined ? {} : { usage }) });
        onWake();
    });
    const unsubscribeRefusals = services.providerRefusals.onChange((provider, refusal) => {
        enqueue({ kind: "providerRefusal", provider, ...(refusal === undefined ? {} : { refusal }) });
        onWake();
    });
    // Registered after every step that could throw, right before the loop, so a dead entry can't leak.
    const unregisterAccess = identity === undefined ? undefined : services.auth?.connections.register(identity, () => controller.abort());
    abort.addEventListener("abort", onWake);
    try {
        while (!abort.aborted) {
            const framed = queue.shift();
            if (framed !== undefined) {
                // Measures how long the frame sat queued, not the serialization or write after; depth is what was
                // behind it.
                services.perf.record("events.frame", Number(process.hrtime.bigint() - framed.at) / 1e6, {
                    frame: framed.event.kind,
                    depth: queue.length,
                });
                yield framed.event;
                continue;
            }
            // Idle: wait for a change (wake) or the heartbeat interval; a timeout means nothing changed, beat.
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
                // Carries the fleet revision honestly only because the queue is empty here; a mismatch means a missed
                // snapshot.
                yield { kind: "heartbeat", rev: services.agents.revision() };
            }
        }
    } finally {
        abort.removeEventListener("abort", onWake);
        unsubscribe();
        unsubscribeRepos();
        unsubscribeRefs();
        unsubscribeRuntime();
        unsubscribeHeadroom();
        unsubscribeRefusals();
        unsubscribeAgents();
        unsubscribeBoot();
        unsubscribePresence();
        unregisterPresence?.();
        unregisterAccess?.();
        signal?.removeEventListener("abort", abortFromCaller);
    }
}

export const createSystemRoutes = (services: Services) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        info: i.info.handler(async () => {
            const info = services.info;
            if (info === undefined) {
                return {};
            }
            // Reads background-warmed caches synchronously; a cold cache omits the field and the browser's query
            // refetches.
            const latest = latestVersion();
            const runtimes = runtimeHealth();
            // The host machine's own build status, unknowable to the daemon; read fresh from /history, never cached.
            const staged = await stagedUpdate(services.config.historyRoot);
            // Capped so a long-neglected sandbox gets a card, not a scroll; the remainder travels as a count.
            const notes = updateNotes(info.version);
            const shown = notes.slice(0, MAX_UPDATE_NOTES);
            // Uncapped unlike the notes above: a warning cut off by the cap would be a breaking update taken unwarned.
            const breaking = breakingNotes(info.version);
            return {
                ...info,
                ...(latest !== undefined ? { latest, updateAvailable: isNewer(latest, info.version) } : {}),
                ...(runtimes !== undefined ? { runtimes } : {}),
                ...(shown.length > 0 ? { updateNotes: shown } : {}),
                ...(notes.length > shown.length ? { moreUpdateNotes: notes.length - shown.length } : {}),
                ...(breaking.length > 0 ? { breakingNotes: breaking } : {}),
                ...(staged !== undefined ? { staged } : {}),
            };
        }),
        // What the daemon couldn't read in `.intentic/` manifests. The three hand-edited ones are re-read here before
        // answering, since a registry entry is only as fresh as its last read; daemon-written manifests skip this step.
        manifestProblems: i.manifestProblems.handler(async () => {
            await Promise.all([services.sandboxSettings.get(), services.capabilities.list(), services.personas.list()]);
            return manifestProblems(services.workspace.root);
        }),
        // Removes one stray key from a manifest. Nothing to invalidate afterward: the write goes through the store's
        // queue and the workspace watcher's own refetch re-reads it. Each refusal is an ordinary race, not a fault.
        repairManifest: i.repairManifest.handler(async ({ input }) => {
            const refusal = await repairManifest({ root: services.workspace.root, ...input });
            if (refusal === "unknown file") {
                throw new ORPCError("NOT_FOUND", { message: `not a settings file this sandbox reports on: ${input.path}` });
            }
            if (refusal === "not repairable") {
                throw new ORPCError("NOT_FOUND", { message: `nothing in this sandbox owns ${input.path}` });
            }
            if (refusal === "unreadable file") {
                throw new ORPCError("CONFLICT", {
                    message: `${input.path} isn't valid JSON right now, so there is no "${input.key}" to take out — open it and fix it by hand`,
                });
            }
            if (refusal === "no such key") {
                throw new ORPCError("CONFLICT", { message: `"${input.key}" is not in ${input.path} any more — it looks like it has already been fixed` });
            }
            if (refusal === "name taken") {
                throw new ORPCError("CONFLICT", { message: `${input.path} already has a "${input.to}" — remove "${input.key}" instead of renaming it` });
            }
            return { ok: true };
        }),
        // Exchanges a verified bearer for a daemon session; loopback and token-scoped callers mint nothing.
        session: i.session.handler(async ({ context }) => {
            if (services.auth === undefined || context.identity === undefined) {
                throw new ORPCError("UNAUTHORIZED", { message: "no verified identity to mint a session for" });
            }
            const { token, expiresAt } = await services.auth.mintSession(context.identity);
            return { token, expiresAt, email: context.identity.email };
        }),
        events: i.events.handler(({ input, context, signal }) => systemEvents(services, signal, context.identity, input.clientId)),
        // A tab's self-report, accepted only for its own live connection; identity-less callers update nothing.
        presence: i.presence.handler(({ input, context }) => {
            if (context.identity !== undefined) {
                updatePresence(context.identity, input);
            }
            return { ok: true } as const;
        }),
        // Per-account totals folded from the all-time ledger; unattributed turns are skipped, not pooled blank.
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
        // Every attachable session behind the terminal panel.
        // - web-*: the user's own shells
        // - panel-*: dev servers, labeled by panel key; dockerd and local-model panels read as kind "process" instead
        // - agent-*: the agent's own Bash terminals, running while a turn is in flight or any pane is alive
        // - job-*: the terminal runner's user-triggered flows
        // Anything else stays hidden; no tmux server yet reads as an empty list, not an error.
        terminals: i.terminals.handler(async () => {
            // Supervised services aren't tmux sessions; their rows come from the supervisor, so `running` is exact.
            const extensionProcesses = await extensionProcessIndex(services);
            const serviceRows = services.serviceProcesses.list().map((service) => ({
                name: serviceSession(service.key),
                label: service.key,
                kind: "process" as const,
                running: service.state === "running",
                activityAt: service.since,
                ...(service.state === "backoff" && service.lastExitCode !== undefined ? { exitCode: service.lastExitCode } : {}),
                ...extensionProcesses.get(service.key),
            }));
            try {
                const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]);
                const states = paneStates(stdout);
                const liveAgentSessions = new Set(
                    services.agents.liveSessionIds().flatMap((sessionId) => {
                        const session = agentSessionName(sessionId);
                        return session === undefined ? [] : [session];
                    }),
                );
                const sessions = [...states].flatMap(([name, { command, live, exitCode, activityAt, liveCommand }]): TerminalsList["sessions"] => {
                    // Every row carries its activity clock, exit status, and a command if busy; `running` differs per
                    // kind.
                    const busy = foreground(liveCommand);
                    const seen = {
                        activityAt,
                        ...(exitCode !== undefined ? { exitCode } : {}),
                        ...(busy !== undefined ? { command: busy } : {}),
                    };
                    if (name.startsWith(WEB_SESSION_PREFIX)) {
                        return [{ name, kind: "shell" as const, running: true, ...seen }];
                    }
                    if (name.startsWith(PANEL_SESSION_PREFIX)) {
                        const key = name.slice(PANEL_SESSION_PREFIX.length);
                        // dockerd and local-model servers outlive a restart, adopted at boot; extension processes are
                        // listed apart.
                        if (key === DOCKER_PANEL_KEY || key.startsWith(LOCAL_MODEL_PREFIX)) {
                            return [
                                {
                                    name,
                                    label: key,
                                    kind: "process" as const,
                                    running: services.processes.running(key) && command !== SHELL,
                                    ...seen,
                                },
                            ];
                        }
                        return [{ name, label: key, kind: "panel" as const, running: services.processes.running(key), ...seen }];
                    }
                    if (name.startsWith(AGENT_SESSION_PREFIX)) {
                        // `help` isn't tmux's own state: the agent is parked on a prompt; rides this list since the
                        // panel polls it.
                        const help = terminalHelpFor(name);
                        return [
                            {
                                name,
                                label: name.slice(AGENT_SESSION_PREFIX.length),
                                kind: "agent" as const,
                                running: live || liveAgentSessions.has(name),
                                ...seen,
                                ...(help === undefined ? {} : { help }),
                            },
                        ];
                    }
                    if (name.startsWith(JOB_SESSION_PREFIX)) {
                        return [
                            {
                                name,
                                label: jobSessionLabel(name),
                                kind: "job" as const,
                                running: services.terminalRun.running(name),
                                ...seen,
                            },
                        ];
                    }
                    return [];
                });
                return { sessions: [...sessions, ...serviceRows] };
            } catch {
                // No tmux server yet, nothing has opened a shell in this sandbox; the services don't need one.
                return { sessions: serviceRows };
            }
        }),
        // The agent's Chromiums and open pages; records this daemon keeps itself, not shelled out for.
        browsers: i.browsers.handler(() => ({ sessions: listBrowserSessions() })),
        closeBrowser: i.closeBrowser.handler(async ({ input }) => {
            await closeBrowserSession(input.name);
            return { ok: true };
        }),
        // Subagents this sandbox started, and one's transcript; both records from the registry and the child's store.
        // Paired against meta files first: the only model source for a child the daemon never watched spawn.
        subagents: i.subagents.handler(async () => {
            await pairLiveSubagents();
            return { sessions: listSubagentSessions() };
        }),
        subagentTranscript: i.subagentTranscript.handler(async ({ input }) => ({
            messages: await readSubagentTranscript(
                { root: services.workspace.root, conversation: (agent) => services.transcripts.read(agent) },
                input.id,
            ),
        })),
        // The three `system.*Device*` procedures are implemented in hosts/devices.routes.ts, beside the devices they
        // act on, and merged into this object by router.ts; the wire shape is the same either way.
        // Destroys one session. The name is validated before it reaches the `kill-session` argv, guarding against
        // something like `-C` being read as a flag; killing an already-gone session is a silent no-op.
        killTerminal: i.killTerminal.handler(async ({ input }) => {
            if (!isValidSessionName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: `invalid session name: ${input.name}` });
            }
            // Stopped through the process manager so `current` unmaps at once, not after the sweep; stop() kills
            // lingering.
            if (input.name.startsWith(PANEL_SESSION_PREFIX)) {
                services.processes.stop(input.name.slice(PANEL_SESSION_PREFIX.length));
                return { ok: true };
            }
            // A service row's name is its log view, not a tmux session; killing it means stopping the service.
            if (input.name.startsWith(SERVICE_SESSION_PREFIX)) {
                services.serviceProcesses.stop(input.name.slice(SERVICE_SESSION_PREFIX.length));
                return { ok: true };
            }
            // `=` forces an exact target match, a bare `-t web-a` would prefix-match `web-ab` once `web-a` is gone.
            await execFileAsync("tmux", ["kill-session", "-t", `=${input.name}`]).catch(() => undefined);
            // An agent parked on a prompt is waiting on a person; killing the session must tell it the terminal is
            // gone.
            settleTerminalHelpFor(input.name);
            // Announced rather than left to the sampler: a deliberate close should vanish from every tab at once.
            publishRuntimeChange("terminals");
            return { ok: true };
        }),
        // The pane's history as text; same name guard as kill above, since this also reaches a `capture-pane -t` argv.
        terminalScrollback: i.terminalScrollback.handler(async ({ input }) => {
            if (!isValidSessionName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: `invalid session name: ${input.name}` });
            }
            const captured = await captureScrollback(input.name, input.lines);
            if (captured === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `no such session: ${input.name}` });
            }
            return { name: input.name, ...captured };
        }),
    };
};
