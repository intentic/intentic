import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract";
import { readSwapRecords, type SwapRecord, swapsUnderway } from "../device/sandbox-rounds/swap-records.js";
import { icSwapsInFlight } from "../device/tools/sandboxes.js";
import { installedBuild } from "../installed.js";
import { publishedVersion } from "../release.js";
import { heldDistros, type MachineConfig, readMachineConfig } from "./machine.js";
import { installedIn, launchUpgrade, machineTarget } from "./machine-upgrade.js";

// The root's own update tick: the machine brought level every hour, and onto a new release every few hours.

// Well after sign-in: WSL, Docker and the distros are still starting, and an early download would blame the wrong thing.
const FIRST_CHECK_MS = 2 * 60_000;
const FIRST_JITTER_MS = 5 * 60_000;
// Levelling compares local versions only, so it can run often; the release channel is asked on a slower, jittered cadence.
const LEVEL_EVERY_MS = 60 * 60_000;
const RELEASE_EVERY_MS = 6 * 60 * 60_000;
const RELEASE_JITTER_MS = 30 * 60_000;
// How soon a distro that just attached is compared, so it is not left on another release for the rest of the hour.
const NUDGE_MS = 30_000;
// How soon a pass put off by a swap in flight looks again: a cutover takes minutes, not the hour to the next pass.
const DEFERRED_MS = 5 * 60_000;

// A target that failed is tried again after 1, 2, 4… hours, a day at most, rather than downloaded every pass.
export const retryAfterMs = (count: number): number => Math.min(2 ** Math.max(count - 1, 0), 24) * 60 * 60_000;

export interface AutoUpgradeReading {
    readonly own: string | undefined;
    readonly children: readonly (string | undefined)[];
    readonly published: string | undefined;
    readonly config: MachineConfig;
    readonly now: number;
}

// Whether to start a machine-wide upgrade, and whether it may reach for the release channel or only level the machine.
export const autoUpgradeDecision = (reading: AutoUpgradeReading): { readonly level: boolean; readonly target: string } | undefined => {
    if (reading.own === undefined || reading.own === DEV_VERSION) {
        return undefined;
    }
    const released = reading.config.agentUpdates === false ? undefined : reading.published;
    const installed = [reading.own, ...reading.children];
    const target = machineTarget(released, installed);
    if (target === undefined || !installed.some((version) => version !== undefined && isNewer(target, version))) {
        return undefined;
    }
    const failure = reading.config.upgradeFailure;
    if (failure?.target === target && reading.now - failure.at < retryAfterMs(failure.count)) {
        return undefined;
    }
    // A release this machine rolled back from (agent-trial.ts) is never gone back to; a newer one is a new target.
    if (reading.config.skippedAgent?.version === target) {
        return undefined;
    }
    return { level: released === undefined || machineTarget(undefined, installed) === target, target };
};

// The sandboxes an upgrade now would restart this agent under: a swap this process is running, or one any process here
// is mid-cutover on by ic's own record. The upgrade's restart can wait minutes; a parked container cannot.
export const upgradeHeldBy = (swapping: ReadonlySet<string>, records: readonly SwapRecord[], now: number): string[] => [
    ...new Set([...swapping, ...swapsUnderway(records, now)]),
];

export interface AutoUpgrade {
    readonly stop: () => void;
    // Compares the machine soon rather than on the hour: a distro just attached may run another release.
    readonly nudge: () => void;
}

export const startAutoUpgrade = (log: Log): AutoUpgrade => {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    let releaseDueAt = 0;
    const schedule = (delay: number): void => {
        clearTimeout(timer);
        if (!stopped) {
            timer = setTimeout(() => void tick(), delay);
        }
    };
    const tick = async (): Promise<void> => {
        const swapping = upgradeHeldBy(icSwapsInFlight, await readSwapRecords(), Date.now());
        if (swapping.length > 0) {
            log(
                `auto-upgrade: put off while ${swapping.join(", ")} ${swapping.length === 1 ? "is" : "are"} mid-swap; looking again in ${DEFERRED_MS / 60_000} minutes.`,
            );
            schedule(DEFERRED_MS);
            return;
        }
        try {
            const config = await readMachineConfig();
            const asksRelease = config.agentUpdates !== false && Date.now() >= releaseDueAt;
            const [published, children] = await Promise.all([
                asksRelease ? publishedVersion() : Promise.resolve(undefined),
                heldDistros().then(async (held) => await Promise.all(held.map(installedIn))),
            ]);
            if (asksRelease) {
                releaseDueAt = Date.now() + RELEASE_EVERY_MS + Math.floor(Math.random() * RELEASE_JITTER_MS);
            }
            const decision = autoUpgradeDecision({ own: installedBuild(), children, published, config, now: Date.now() });
            if (decision !== undefined) {
                log(`auto-upgrade: bringing this machine to ${decision.target}${decision.level ? " (levelling to its newest side)" : ""}.`);
                await launchUpgrade(decision.level);
            }
        } catch (error) {
            log(`auto-upgrade: skipped this round — ${errorMessage(error)}`);
        }
        schedule(LEVEL_EVERY_MS);
    };
    schedule(FIRST_CHECK_MS + Math.floor(Math.random() * FIRST_JITTER_MS));
    return {
        stop: () => {
            stopped = true;
            clearTimeout(timer);
        },
        nudge: () => schedule(NUDGE_MS),
    };
};
