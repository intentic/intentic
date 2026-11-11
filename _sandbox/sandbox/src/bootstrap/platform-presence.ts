import type { ReachPosture } from "../system/listeners/reach-posture.js";
import { DEFAULT_PROBES, lastTerminalActivity, startIdleStop } from "../system/sleep/idle-stop.js";
import { connectedCount } from "../system/presence.js";
import type { QuietProbes } from "../system/quiet-watch.js";
import { anyConnected } from "../ports/established.js";
import { fileRestartResume } from "../system/restart-resume.js";
import type { BootPhase } from "./boot-phase.js";
import type { ActiveHost } from "@intentic/api-contract/ingress";
import { clearStandby, standbyNotice, standbyTurn, writeStandby } from "../system/standby/standby.js";
import { LINK_LOST_EXIT } from "../system/boot/restarts/daemon-stop.js";
import { opt } from "../opt.js";
import { nextPromisedWake } from "./promised-wakes.js";
import { workingNow } from "./working-now.js";
import { createHostedSleep } from "../system/sleep/hosted-sleep.js";
import { join } from "node:path";
import { fileMembersStore, membersDocument } from "../auth/auth.js";
import { revokeHeld } from "../auth/members/revoke-held.js";
import { reconcileOrgRoster } from "../org/org-roster.js";
import { settingsDocument } from "../settings/settings-store.js";
import { subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";
import { runningJobsOf } from "../agent/tools/jobs/background-jobs.js";

// Webhooks have no durable ingress outside this daemon; gateway listeners need their live connection. A sandbox on
// somebody's own computer keeps receiving until the owner disables them (or they expire): staying up costs it only
// memory. A hosted machine does not (sleep/idle-stop.ts): it would spend its month's hours in days.
export const continuousReception = async (services: Pick<BootPhase["services"], "automations">): Promise<boolean> =>
    (await services.automations.list()).some(
        (automation) =>
            automation.enabled &&
            (automation.expiresAt === undefined || automation.expiresAt > Date.now()) &&
            (automation.trigger.kind === "event" || automation.trigger.kind === "listener"),
    );

// The soonest moment this sandbox promised somebody that a stop for idleness must not sleep through, 0 for none: one list
// (promised-wakes.ts), shared with the automatic update's.
export const nextPromisedWakeAt = async (services: BootPhase["services"]): Promise<number> => (await nextPromisedWake(services, "idle-stop")) ?? 0;

// What the quiet watch asks for the host's keeper that puts an unneeded sandbox to sleep (system/quiet-watch.ts): the
// same questions idle-stop asks, plus whether a workspace app is in use and whether the owner switched sleep off for this
// sandbox (settings `sleepWhenUnused`). Its promised wakes are the sleep's, crons among them: the keeper sets an alarm
// for the soonest and starts the sandbox ahead of it.
/* A RUNNER IS NEVER QUIET (2026-11-09). Nobody opens a runner (runners/runner-mode.ts): it waits for its parent to
   dispatch, so between turns it read as unused, and omen's keeper put runner-omen to sleep after 30 idle minutes
   (machine.log 2026-10-31T09:36:34, the parent's "peer disconnected" the same second). A wake comes only from somebody
   opening a sandbox's page or from its own alarm, and a runner has neither, so it stayed down until it was removed.
   Kept awake here, which every ic reads the same way (no `quietSince`), whatever its version. */
export const quietProbes = (services: BootPhase["services"]): QuietProbes => ({
    connected: connectedCount,
    working: () => workingNow(services, "idle-stop").length,
    terminalActivityAt: lastTerminalActivity,
    appsInUse: () => anyConnected(services.processes.ports()),
    nextWakeAt: async () => (await nextPromisedWake(services, "sleep")) ?? 0,
    keepAwake: async () =>
        services.runnerParent.current !== undefined || !(await services.sandboxSettings.get()).sleepWhenUnused || (await continuousReception(services)),
});

// What the daemon does when the organisation policy or a file it pins moves, started at boot beside the policy's own
// fetch loop (below). Both are no-ops for a personal sandbox: no policy, nothing to reconcile or pin.
const startOrgReactions = ({ config, logger, services, shutdown }: Pick<BootPhase, "config" | "logger" | "services" | "shutdown">): void => {
    // Every policy in force, the one boot read included, takes the people it no longer admits off the roster file. The
    // file's own handle, not services.members: that one is fenced, and no longer lists them.
    const rosterFile = fileMembersStore(join(config.historyRoot, membersDocument.path));
    shutdown.push(
        services.orgPolicy.onChange(async (policy) => {
            await reconcileOrgRoster({ members: rosterFile, revoke: (email) => revokeHeld(services, email), record: services.audit.record, logger }, policy);
        }),
    );
    // settings.json edited outside the routes (by hand, or an agent's own write) is read once on the change, which writes
    // the organisation's pinned values back when the edit loosened one (settings-store.ts), so a program that reads the
    // file itself sees them within the watcher's latency rather than at the daemon's next read.
    shutdown.push(
        subscribeWorkspaceChanges((paths) => {
            if (paths.includes(settingsDocument.path)) {
                void services.sandboxSettings.get().catch((error: Error) => logger.warn({ err: error }, "org pins: reading settings after a change failed"));
            }
        }),
    );
};

/* WHICH COPY RUNS THIS SANDBOX (system/standby/standby.ts). The platform's answer to an announce says whether this copy is
 * the one; a change either way is written to /history/.ic/standby.json (or cleared) and the daemon restarts into it,
 * netd starting it again, since the boot is what decides what starts. An answer that says nothing changes nothing. */
const followStanding = async (
    { config, logger, stop, standby }: Pick<BootPhase, "config" | "logger" | "stop"> & { readonly standby: BootPhase["standby"] | undefined },
    standing: { active: boolean; activeHost?: ActiveHost; activeEpoch?: number },
): Promise<void> => {
    const turn = standbyTurn(standing.active, standby !== undefined);
    if (turn === undefined) {
        return;
    }
    if (turn === "enter") {
        await writeStandby(config.historyRoot, { v: 1, since: Date.now(), ...opt("activeHost", standing.activeHost), ...opt("activeEpoch", standing.activeEpoch) });
    } else {
        await clearStandby(config.historyRoot);
    }
    const reason =
        turn === "enter"
            ? `${standbyNotice(standing.activeHost)}: this copy restarts on standby`
            : "the platform holds this copy to be the one that runs the sandbox again: it restarts to take it up";
    logger.warn({ activeHost: standing.activeHost, activeEpoch: standing.activeEpoch }, reason);
    // EX_TEMPFAIL, so netd starts the daemon again rather than ending the container (daemon-stop.ts).
    stop(LINK_LOST_EXIT, { action: "restart", reason });
};

// Container role only: a guest daemon or a local folder speaks for nobody.
export const startPlatformPresence = ({ config, logger, role, services, shutdown, stop, standby }: BootPhase, reach: ReachPosture): void => {
    // Started with the listeners so it can't queue behind the sweeps it reports through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "" && role.container) {
        services.announcer.onStanding((standing) => void followStanding({ config, logger, stop, standby }, standing));
        services.announcer.start();
        // A standby copy reports no reach: its boot report would overwrite the active copy's with an address it never dials.
        if (standby === undefined) {
            services.reach.start(reach);
        }
    }
    // The organisation policy, from the same platform over the same token; a personal sandbox is answered null each time.
    // Its reactions start whether or not the platform is configured: a held policy is enforced either way.
    startOrgReactions({ config, logger, services, shutdown });
    if (config.platform.url !== "" && config.connectToken !== "") {
        services.orgPolicy.start();
    }

    // Unawaited and self-swallowing: a platform that never answers means no trial offered.
    if (role.container) {
        void services.trial.refresh();
    }
};

// The hosted machine's sleep: idle-stop and the platform alarm it saves before stopping (sleep/hosted-sleep.ts).
// Started with the platform presence, before the boot chain, so a boot that stalls still stops for idleness
// (2026-10-18: started past the gate, a stalled chain billed until the month's hours ran out). The alarm the last sleep
// left stands until `takeCharge`, once the schedulers and resumers that keep its promises have started.
export interface PlatformSleep {
    readonly takeCharge: () => void;
}

export const startPlatformSleep = ({ config, logger, role, services, shutdown }: BootPhase): PlatformSleep | undefined => {
    // A hosted machine retracts its last alarm even when idle-stop has since been switched off; 0 means always-on.
    if (!role.container || (config.idleStopMinutes === 0 && !config.sandbox.vm)) {
        return undefined;
    }
    const alarm = createHostedSleep(config, logger);
    if (config.idleStopMinutes > 0) {
        shutdown.push(
            startIdleStop(
                { minutes: config.idleStopMinutes, logger },
                {
                    ...DEFAULT_PROBES,
                    working: () => workingNow(services, "idle-stop").length,
                    nextPromisedWakeAt: () => nextPromisedWakeAt(services),
                    leftRunning: () => services.agents.list().filter((agent) => runningJobsOf(services.conversations, agent.id).length > 0).length,
                    alarmBoot: alarm.alarmBoot,
                    prepareSleep: alarm.prepare,
                    cancelSleep: alarm.cancel,
                },
                // Named as the initiator before the SIGTERM main.ts answers, so the stop and the next boot say why.
                () => {
                    fileRestartResume(config.historyRoot).announce?.({
                        by: "daemon",
                        action: "stop",
                        reason: `idle-stop: nobody connected and nothing running for ${String(config.idleStopMinutes)} minutes`,
                    });
                    process.kill(process.pid, "SIGTERM");
                },
            ),
        );
    }
    return {
        takeCharge: () => {
            void alarm.retractAtBoot();
        },
    };
};
