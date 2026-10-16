import type { ReachPosture } from "../system/listeners/reach-posture.js";
import { DEFAULT_PROBES, startIdleStop } from "../system/idle-stop.js";
import { fileRestartResume } from "../system/restart-resume.js";
import type { BootPhase } from "./boot-phase.js";
import { nextPromisedWake } from "./promised-wakes.js";
import { workingNow } from "./working-now.js";
import { join } from "node:path";
import { fileMembersStore, membersDocument } from "../auth/auth.js";
import { revokeHeld } from "../auth/members/revoke-held.js";
import { reconcileOrgRoster } from "../org/org-roster.js";
import { settingsDocument } from "../settings/settings-store.js";
import { subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";

// The soonest moment this sandbox promised somebody that a stop for idleness must not sleep through, 0 for none: one list
// (promised-wakes.ts), shared with the automatic update's.
export const nextPromisedWakeAt = async (services: BootPhase["services"]): Promise<number> => (await nextPromisedWake(services, "idle-stop")) ?? 0;

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

// Container role only: a guest daemon or a local folder speaks for nobody.
export const startPlatformPresence = ({ config, logger, role, services, shutdown }: BootPhase, reach: ReachPosture): void => {
    // Started with the listeners so it can't queue behind the sweeps it reports through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "" && role.container) {
        services.announcer.start();
        services.reach.start(reach);
    }
    // The organisation policy, from the same platform over the same token; a personal sandbox is answered null each time.
    // Its reactions start whether or not the platform is configured: a held policy is enforced either way.
    startOrgReactions({ config, logger, services, shutdown });
    if (config.platform.url !== "" && config.connectToken !== "") {
        services.orgPolicy.start();
    }

    // 0 means always-on. A wake due before a stopped machine could be back keeps it up, since only a visit would restart it.
    if (config.idleStopMinutes > 0 && role.container) {
        shutdown.push(
            startIdleStop(
                { minutes: config.idleStopMinutes, logger },
                {
                    ...DEFAULT_PROBES,
                    working: () => workingNow(services, "idle-stop").length,
                    nextPromisedWakeAt: () => nextPromisedWakeAt(services),
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

    // Unawaited and self-swallowing: a platform that never answers means no trial offered.
    if (role.container) {
        void services.trial.refresh();
    }
};
