import { learnBurnRates } from "../agent/run/spend/burn-wiring.js";
import { startRuntimeHealth } from "../agent/providers/adapter-health.js";
import { onChildSettled,childTurnResult,isWorker,resultWords } from "../agent/subagents/child-records.js";
import { onJobEnded } from "../agent/tools/jobs/job-ended.js";
import { linkTaskDepsOf, noteLinkTurnAwaiting, noteLinkTurnSettled, noteLinkTurnStarted, startUnstartedTasks } from "../links/link-tasks.js";
import { childLandingWords, reportChildLanded } from "../conversations/land/child-lands.js";
import { capacityNoticer } from "../agent/subagents/capacity-reopened.js";
import { type ChildReportDeps, reportChildTurn } from "../agent/subagents/child-report.js";
import { onAccountReopened } from "../usage/serviceability/state-log.js";
import { watchCapacity } from "../usage/serviceability/capacity-watch.js";
import { adoptChildTurn, childKillNote, childMovingOn } from "../agent/subagents/children.js";
import { createProjectDelivery, type ProjectDeliveryDeps } from "../conversations/land/project-delivery.js";
import { landHeldForWake } from "../conversations/land/wake-held-land.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { passwordWakeOf } from "../needs/password-wake.js";
import { startWatchers } from "../agent/verification/watchers.js";
import { approvalsExecutorFor } from "../approvals/approvals-executor.js";
import { createAutomationsScheduler } from "../automations/scheduler.js";
import { fixerSettled, resumeMainFixer } from "../ci/main-fixer.js";
import { createCiPoller } from "../ci/poller.js";
import { createOriginFollow, type OriginFollowDeps } from "../git/remote/follow-origin.js";
import { autoKeepWarm, stopKeepWarm } from "../agent/run/turn/cache-keepwarm.js";
import type { BootPhase } from "./boot-phase.js";
import { publicAddressOf } from "../env.config.js";
import { reportedPairings } from "../hosts/device-reports.js";
import { subscribeRepoChanges } from "../workspace/watch/repo-watch.js";
import { subscribeUnwatchedWrites, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";
import { onRuntimeChange } from "../seams/runtime-feed.js";

// What a child's report reads off the daemon: the doors a wake goes through, the child's and parent's entries, how a
// killed runtime reads, and where the child's work went.
const childReportDeps = (services: BootPhase["services"], logger: BootPhase["logger"]): ChildReportDeps => ({
    doors: { turns: services.turns },
    logger,
    conversations: services.conversations,
    entryOf: (conversationId) => {
        const entry = services.agents.entry(conversationId);
        return entry === undefined ? undefined : { startedBy: entry.identity.startedBy, title: entry.social.title?.text, fresh: entry.identity.fresh !== undefined };
    },
    profileOf: (conversationId) => {
        const entry = services.agents.entry(conversationId);
        return entry === undefined ? undefined : conversationProfile(entry);
    },
    killNote: (childId, failure) => childKillNote(services, childId, failure),
    landingOf: (childId) => childLandingWords(services.agents, childId),
    movingOn: (childId) => childMovingOn(services.conversations, childId),
    resultOf: (childId, closing) => resultWords(childTurnResult(services.conversations, childId, closing)),
    worker: (childId) => isWorker(services.conversations, childId),
});

// A wake disarmed before it fired: the land its conversation's last close skipped for it runs now, if still due.
const landWhenWakeGoes =
    (services: BootPhase["services"]) =>
    (conversationId: string): void =>
        void landHeldForWake(services, conversationId);

// What following the remote reads off the daemon (git/remote/follow-origin.ts): the switch, and whether a turn is
// working in the main tree, whose files must not move under it.
const originFollowDeps = (services: BootPhase["services"], logger: BootPhase["logger"]): OriginFollowDeps => ({
    workspace: services.workspace,
    enabled: async () => (await services.sandboxSettings.get()).followOrigin,
    mainTreeBusy: () =>
        services.agents.ids().some((id) => services.conversations.running(id) && services.agents.entry(id)?.placement.kind !== "worktree"),
    agentWorktrees: services.agentWorktrees,
    history: services.history,
    logger,
});

// What delivering landed work to the owner's folder reads off the daemon (land/project-delivery.ts): the machines and
// what each reports of its folders (hosts/), and the names this sandbox goes by on them.
const projectDeliveryDeps = (services: BootPhase["services"]): ProjectDeliveryDeps => ({
    agents: services.agents,
    agentWorktrees: services.agentWorktrees,
    events: services.events,
    hostHub: services.hostHub,
    logger: services.logger,
    syncFleet: services.syncFleet,
    historyRoot: services.config.historyRoot,
    publicUrl: services.config.sandbox.publicUrl,
    platformId: publicAddressOf(services.config).sandboxId,
    pairingsOf: async (host) => await reportedPairings(services, host),
    hostsChanged: (listener) =>
        onRuntimeChange((domains) => {
            if (domains.includes("hosts")) {
                listener();
            }
        }),
});

// Work landing in a folder attached to this computer's own sandbox goes to the folder on the computer as well
// (land/project-delivery.ts): only on that sandbox, and only from the daemon that owns the container.
const startProjectDelivery = ({ role, services, shutdown }: Pick<BootPhase, "role" | "services" | "shutdown">): void => {
    if (role.container && services.config.sandbox.projectsHost) {
        shutdown.push(createProjectDelivery(projectDeliveryDeps(services)).start());
    }
};

// Linked sandboxes, both halves (links/): a task another sandbox handed here reports how each of its turns ended, and the
// tasks this sandbox handed out are followed again after a restart, so their parents still hear how each one ended. A task
// handed here that was filed but never started before the restart starts now.
const startLinks = ({ role, services, logger, shutdown }: Pick<BootPhase, "role" | "services" | "logger" | "shutdown">): void => {
    const deps = { links: services.inboundLinks, logger };
    shutdown.push(services.events.subscribe("run.settled", (settled) => noteLinkTurnSettled(deps, settled)));
    shutdown.push(services.events.subscribe("run.started", (started) => noteLinkTurnStarted(deps, started)));
    shutdown.push(services.events.subscribe("turn.awaiting", noteLinkTurnAwaiting));
    shutdown.push(() => services.linkedChildren.close());
    if (role.container) {
        void services.linkedChildren.resume().catch((error: Error) => logger.warn({ err: error }, "linked tasks: not followed again"));
        void startUnstartedTasks(linkTaskDepsOf(services)).catch((error: Error) => logger.warn({ err: error }, "link: tasks filed before a restart not started"));
    }
};

// The keyrings on the owner's computers (secrets/device/): each read when its computer connects and every minute after,
// the sync mailbox between them carried every five, and the needs waiting on each looked at again after every read.
// Only the daemon that owns the roots reads them, since what they say is kept under the auth root it owns.
const startKeyrings = ({ role, services, shutdown }: Pick<BootPhase, "role" | "services" | "shutdown">): void => {
    if (role.roots) {
        shutdown.push(services.deviceSecrets.start());
        shutdown.push(services.keyringNeeds.start(passwordWakeOf(() => services, services.logger)));
    }
};

// The automations pass: on its interval, at each moment it knows is due, and at once when a turn settles (a held wake
// waits for no live turn) or an automation is saved (a moment may fall inside this window).
const startAutomations = ({ role, services, shutdown }: Pick<BootPhase, "role" | "services" | "shutdown">): void => {
    const scheduler = createAutomationsScheduler(services);
    shutdown.push(() => scheduler.stop());
    if (role.container) {
        scheduler.start();
        shutdown.push(services.events.subscribe("run.settled", scheduler.nudge));
        shutdown.push(services.automations.onSaved(scheduler.nudge));
    }
};

// Work held for memory looks again the moment a turn, a background job or a spawned child lets memory go, rather than
// at its next interval: measured before, a held heavy command waited ~2.5 s past the room being there (2026-10-20).
// Wired here, above both the workload budget and the agent layer, which the budget may not import.
const wireRoomWakes = ({ events, resources }: BootPhase["services"], shutdown: BootPhase["shutdown"]): void => {
    const roomFreed = (): void => resources.changed();
    for (const stop of [events.subscribe("run.settled", roomFreed), onJobEnded(roomFreed), onChildSettled(roomFreed)]) {
        shutdown.push(stop);
    }
};

// Each scheduler registers its stop whether or not this role starts it, so every role unwinds cleanly.
export const startBootSchedulers = ({ role, services, logger, shutdown }: BootPhase): void => {
    startAutomations({ role, services, shutdown });
    wireRoomWakes(services, shutdown);

    // Open needs outlive every turn and every restart (docs/architecture/needs.md): their cards are told what they wait
    // on, answers a restart interrupted are delivered, and the checks against the world start.
    if (role.container) {
        shutdown.push(services.needs.start());
    }

    // Stop clears timers only; the watch journal survives for the next boot to restore. What a turn left running is
    // judged and handed to a watch by the turn's own close (agent/run/placement/turn-close.ts), which needs this bound. A
    // wake stopped before it fired lets the land its close skipped run after all (wake-held-land.ts).
    shutdown.push(startWatchers(services, landWhenWakeGoes(services)));

    // A spawned child's settled turn is its parent's news, delivered like a wake unless a parked `wait` took it.
    const childReports = childReportDeps(services, logger);
    shutdown.push(services.events.subscribe("run.settled", (settled) => reportChildTurn(childReports, settled)));
    // An account coming back is news to a parent waiting with children failed or paused on it (capacity-reopened.ts).
    shutdown.push(
        onAccountReopened(
            capacityNoticer({ conversations: services.conversations, doors: childReports.doors, profileOf: childReports.profileOf, logger }),
        ),
    );
    // Which is judged at the reopen a judgement saw ahead and on each new reading, not only when somebody asks.
    shutdown.push(watchCapacity(services));
    // So is its work reaching the main tree, while the parent still supervises (child-lands.ts), and a turn that starts on
    // it without the parent, which the parent supervises like its own (children.ts adoptChildTurn).
    shutdown.push(services.events.subscribe("workspace", (event) => reportChildLanded(services, event)));
    shutdown.push(services.events.subscribe("run.started", (started) => adoptChildTurn(services, started)));
    startProjectDelivery({ role, services, shutdown });
    startLinks({ role, services, logger, shutdown });
    startKeyrings({ role, services, shutdown });

    // A settled turn a person asked for arms a hold on its prompt cache where the setting says so; each hold sets its
    // own deadline, so there is nothing to start, only timers to clear.
    shutdown.push(() => stopKeepWarm(services));
    if (role.container) {
        shutdown.push(services.events.subscribe("run.settled", (settled) => autoKeepWarm(services, settled)));
    }

    // Armed, not polled: the deadline is the item's own scheduledAt on disk, so dropping the timer loses nothing.
    const approvalsExecutor = approvalsExecutorFor(services);
    shutdown.push(() => approvalsExecutor.stop());
    if (role.container) {
        void approvalsExecutor.arm().catch((error: unknown) => logger.warn({ err: error }, "approvals executor not armed"));
    }

    if (role.container) {
        services.ciHooks.start();
        // Main's CI has one fix agent (ci/main-fixer.ts): each of its settled turns may hand main's failure to the owner, and
        // what main did while the daemon was down reaches it now.
        shutdown.push(
            services.events.subscribe("run.settled", (settled) => {
                void fixerSettled(services, settled).catch((error: unknown) =>
                    logger.warn({ err: error }, "ci repair: a settled turn could not be read"),
                );
            }),
        );
        void resumeMainFixer(services).catch((error: unknown) => logger.warn({ err: error }, "ci repair: main's failures could not be resumed"));
    }

    // Covers repos whose CI hook could not be registered; its first pass is a silent seed.
    const ciPoller = createCiPoller(services);
    shutdown.push(() => ciPoller.stop());
    if (role.container) {
        ciPoller.start();
    }

    // Each workspace repo keeps up with the remote branch it tracks, so another writer's push reaches main within
    // minutes rather than at the owner's next pull; `followOrigin` off, nothing is fetched.
    const originFollow = createOriginFollow(originFollowDeps(services, logger));
    shutdown.push(originFollow.stop);

    shutdown.push(() => services.probeRunner.stop());
    shutdown.push(() => services.driftSweep.stop());
    if (role.container) {
        // Both idle-only, allowed to fail, unref'd; the probe runner also waits out the boot's own pnpm install.
        services.probeRunner.start();
        services.driftSweep.start();
        originFollow.start();
    }

    shutdown.push(startRuntimeHealth(services));
    // Idle backstop: headroom is otherwise re-read only on a turn, refusal or screen.
    shutdown.push(services.headroom.start());
    shutdown.push(learnBurnRates(services));
    // Anything the watchers see, a repo appearing or going, or a write the daemon made where no watcher looks.
    services.history.start((changed) => {
        const stops = [subscribeWorkspaceChanges(changed), subscribeRepoChanges(changed), subscribeUnwatchedWrites(changed)];
        return () => {
            for (const stop of stops) {
                stop();
            }
        };
    });
};
