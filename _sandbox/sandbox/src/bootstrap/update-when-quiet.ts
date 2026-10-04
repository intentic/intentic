import { hostRunningSandbox } from "@intentic/sandbox-contract";
import { ORIGIN_HOST } from "@intentic/sandbox-run";
import { listSubagentSessions } from "../agent/subagents/subagents.js";
import { fileRestartResume } from "../agent/run/turn/restart-resume.js";
import { nextBookedSendAt } from "../agent/run/turn/turn-resume.js";
import { nextOneTimeWakeAt, nextRunOf } from "../automations/scheduler.js";
import { sandboxZone } from "../automations/schedule-zone.js";
import type { BootPhase } from "./boot-phase.js";
import type { Services } from "../composition.js";
import { containerFacts } from "../environment/environment.js";
import { devices, manageDeviceSandbox } from "../hosts/device-reports.js";
import { agentsMidTurn } from "../hosts/host-restart-guard.js";
import { hostRunningSelf, ownSlug } from "../hosts/self-host.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { isDevBuild } from "../version.js";
import { runningWorkflowIds } from "../workflows/workflow-runner.js";
import { lastTerminalActivity } from "../system/idle-stop.js";
import { connectedCount, peopleAtEditor, subscribePresence } from "../system/presence.js";
import { type AutoUpdateActivity, type AutoUpdateOffer, createAutoUpdater, holdAutoUpdater } from "../system/updates/auto-update.js";
import { breakingNotes } from "../system/updates/release-notes.js";
import { preparingUpdate, stagedUpdate } from "../system/updates/staged-update.js";
import { fileUpdatePolicy } from "../system/updates/update-policy.js";
import { fileUpdateSkip } from "../system/updates/update-skip.js";
import { latestVersion } from "../system/updates/version-check.js";

// Where the automatic update (system/updates/auto-update.ts) meets the rest of the daemon: what it reads to judge the moment, and the
// one door it uses to ask the machine. Started only where a machine's `ic` swaps this container: never on a hosted
// machine (the platform moves its image), a checkout-built base (an update would replace what the checkout built), a dev
// build, or a container no machine knows by name.

// Everything mid-flight that a restart would cut, by the name the board or the run shows it under, once each.
const workingNow = async (services: Services): Promise<string[]> => {
    const working = new Set(agentsMidTurn(services));
    for (const agent of services.agents.list()) {
        if (services.conversations.landing(agent.id)) {
            working.add(agent.title ?? agent.id);
        }
    }
    // Only one actually running: a subagent parked on a question or a spent allowance waits as well across a restart.
    for (const session of listSubagentSessions(services.conversations)) {
        if (session.status === "running") {
            working.add(session.description ?? session.agentType ?? "a subagent");
        }
    }
    for (const runId of runningWorkflowIds()) {
        const run = await services.workflowRuns.get(runId);
        working.add(run?.workflow.name ?? "a workflow");
    }
    return [...working];
};

// The soonest moment the sandbox promised somebody: an automation's next run (a cron's too, unlike idle-stop: a restart
// landing on its minute would fire it late for nothing) and a scheduled message.
const soonestDue = async (services: Services): Promise<number> => {
    const zone = await sandboxZone(services);
    const crons = (await services.automations.list()).flatMap((automation) =>
        automation.trigger.kind === "schedule" ? [nextRunOf(automation, zone) ?? 0].filter((at) => at > 0) : [],
    );
    const moments = [await nextOneTimeWakeAt(services), nextBookedSendAt(services), ...crons].filter((at) => at > 0);
    return moments.length === 0 ? 0 : Math.min(...moments);
};

const activityOf = async (services: Services): Promise<AutoUpdateActivity> => {
    const [working, terminalAt, dueAt] = await Promise.all([workingNow(services), lastTerminalActivity(), soonestDue(services)]);
    return { working, people: peopleAtEditor(), connected: connectedCount(), terminalAt, dueAt };
};

const offerOf = async (services: Services): Promise<AutoUpdateOffer> => {
    const root = services.config.historyRoot;
    const [staged, preparing, skipped] = await Promise.all([stagedUpdate(root), preparingUpdate(root, Date.now()), fileUpdateSkip(root).skipped()]);
    const version = services.info?.version;
    return { running: version, staged, preparing: preparing !== undefined, latest: latestVersion(), skipped, breaking: breakingNotes(version).length > 0 };
};

export const startAutoUpdate = ({ config, traits, role, services, logger, shutdown }: BootPhase): void => {
    const slug = ownSlug(services);
    const swappedByIc =
        traits.containerUpdates &&
        role.container &&
        !config.sandbox.vm &&
        !isDevBuild &&
        config.sandbox.name !== ORIGIN_HOST &&
        containerFacts(config.sandbox).localImage === undefined;
    if (!swappedByIc || slug === undefined) {
        return;
    }
    const updater = createAutoUpdater({
        offer: () => offerOf(services),
        activity: () => activityOf(services),
        policy: fileUpdatePolicy(config.historyRoot),
        host: async (fresh) => (fresh ? hostRunningSandbox(await devices(services), slug) : await hostRunningSelf(services)),
        relay: (host, flow) => manageDeviceSandbox(services, host, flow),
        restartResume: fileRestartResume(config.historyRoot),
        slug,
        changed: () => publishRuntimeChange("update"),
        logger,
    });
    const release = holdAutoUpdater(updater);
    // Somebody arriving at the editor, or leaving it, is the likeliest thing to start or stop a countdown.
    const unsubscribe = subscribePresence(() => updater.poke());
    shutdown.push(() => {
        unsubscribe();
        updater.stop();
        release();
    });
};
