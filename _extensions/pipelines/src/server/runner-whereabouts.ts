import type { CiFleet, CiRunner, Device, PipelinesDaemon } from "./daemon.js";

/* WHICH OF THE OWNER'S COMPUTERS A CI RUNNER IS ON, for the notice main's fix sends when a job failed on the fleet
   rather than in the code (main-fleet.ts): GitHub names only the runner, and the job's log only the hostname, which a PC
   and every WSL distro on it share. Every connected computer whose agent reads its runners is asked for them
   (GET /system/devices/{id}/ci-runners, the daemon's relay to the machine), briefly remembered, and the runner looked up
   by name. Best-effort through and through: a computer that does not answer in time, or answers something else, is one
   that does not have it, and the notice is sent without. (2026-11-26) The daemon's hosts/ci-fleet/runner-whereabouts.ts
   until main's fix agent moved here; the relay itself stays the daemon's. */

/** A runner found on a connected computer: the computer as the notice names it, and the runner as it stands now. */
export interface RunnerWhereabouts {
    // The device's id, with its WSL distro where the agent runs in one: `omen (archlinux)`.
    readonly device: string;
    readonly runner: CiRunner;
}

// A notice waits on this, so a computer that has not answered in a few seconds is taken not to have the runner.
const ASK_DEADLINE_MS = 8_000;
// A run that failed on the fleet fails several jobs at once, each asking: one answer per computer serves them all.
const REMEMBERED_MS = 3 * 60_000;
// The feature a machine's agent advertises once it can list its runners (the contract's DEVICE_FEATURE_CI_RUNNERS, a
// subpath outside the extension wire, so named here by its word, as the Runners section names it).
const CI_RUNNERS_FEATURE = "ci-runners";

interface Asked {
    readonly at: number;
    readonly fleet: Promise<CiFleet | undefined>;
}
const asked = new Map<string, Asked>();

// Within the deadline, or not at all.
const withinDeadline = <T>(work: Promise<T>): Promise<T | undefined> =>
    Promise.race([
        // allow(silent-catch): a computer that does not answer is one that does not have the runner; the notice goes without
        work.catch(() => undefined),
        new Promise<undefined>((resolve) => {
            setTimeout(() => resolve(undefined), ASK_DEADLINE_MS).unref();
        }),
    ]);

// The computer's runners, from its answer of the last few minutes or asked now; the promise is what is kept, so jobs
// judged at once share one question.
const rememberedFleet = (daemon: Pick<PipelinesDaemon, "ciFleet">, id: string, now: number): Promise<CiFleet | undefined> => {
    const kept = asked.get(id);
    if (kept !== undefined && now - kept.at < REMEMBERED_MS) {
        return kept.fleet;
    }
    const fleet = withinDeadline(daemon.ciFleet(id));
    asked.set(id, { at: now, fleet });
    return fleet;
};

// Only a live connection can be asked, and only an agent that says it can list its runners.
const askable = (device: Device): device is Device & { readonly hostId: string } =>
    device.hostId !== undefined && device.online !== false && (device.facts?.features ?? []).includes(CI_RUNNERS_FEATURE);

const deviceLabel = (device: Device & { readonly hostId: string }): string => {
    const distro = device.facts?.wsl?.distro;
    return distro === undefined || device.hostId.includes(distro) ? device.hostId : `${device.hostId} (${distro})`;
};

/** The connected computer that has a runner of this name, and the runner as it reports it; undefined when none says so.
 *  Never throws and never waits much past a few seconds. */
export const runnerWhereabouts = async (daemon: Pick<PipelinesDaemon, "devices" | "ciFleet">, name: string, now = Date.now()): Promise<RunnerWhereabouts | undefined> => {
    const devices = ((await withinDeadline(daemon.devices())) ?? []).filter(askable);
    const fleets = await Promise.all(devices.map(async (device) => ({ device, fleet: await rememberedFleet(daemon, device.hostId, now) })));
    for (const { device, fleet } of fleets) {
        const runner = fleet?.runners.find((candidate) => candidate.name === name);
        if (runner !== undefined) {
            return { device: deviceLabel(device), runner };
        }
    }
    return undefined;
};

/** The runner in a notice's words: `radarsu-worker-3 on omen (archlinux), actions.runner….service, inactive`. */
export const whereaboutsWords = ({ device, runner }: RunnerWhereabouts): string =>
    `${runner.name} on ${device}, ${runner.unit}, ${runner.state}${runner.held === undefined ? "" : ` (held down: ${runner.held})`}`;

/** Test seam: forget every computer's remembered answer. */
export const resetRunnerWhereabouts = (): void => {
    asked.clear();
};
