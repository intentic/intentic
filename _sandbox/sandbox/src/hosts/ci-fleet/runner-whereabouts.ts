import { type CiFleet, CiFleetSchema, type CiRunner } from "@intentic/sandbox-contract/schemas/ci-fleet";
import { DEVICE_FEATURE_CI_RUNNERS, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { parseJsonWith } from "@intentic/base/json";
import type { Services } from "../../composition.js";
import { callTool } from "../device-reports.js";

/* WHICH OF THE OWNER'S COMPUTERS A CI RUNNER IS ON, for the notice main's fix sends when a job failed on the fleet
   rather than in the code (ci/fleet/main-fleet.ts): GitHub names only the runner, and the job's log only the hostname,
   which a PC and every WSL distro on it share. Every connected computer whose agent reads its runners is asked
   `ci_runners`, briefly remembered, and the runner looked up by name. Best-effort through and through: a computer that
   does not answer in time, or answers something else, is one that does not have it, and the notice is sent without. */

export type WhereaboutsServices = Pick<Services, "hostHub">;

/** A runner found on a connected computer: the computer as the notice names it, and the runner as it stands now. */
export interface RunnerWhereabouts {
    // The device's card id, with its WSL distro where the agent runs in one: `omen (archlinux)`.
    readonly device: string;
    readonly runner: CiRunner;
}

// A notice waits on this, so a computer that has not answered in a few seconds is taken not to have the runner.
const ASK_DEADLINE_MS = 8_000;
// A run that failed on the fleet fails several jobs at once, each asking: one answer per computer serves them all.
const REMEMBERED_MS = 3 * 60_000;

interface Asked {
    readonly at: number;
    readonly fleet: Promise<CiFleet | undefined>;
}
const asked = new Map<string, Asked>();

const fleetOf = async (services: WhereaboutsServices, id: string): Promise<CiFleet | undefined> => {
    const answer = await callTool(services, id, "ci_runners", {}, AbortSignal.timeout(ASK_DEADLINE_MS)).catch((error: Error) => ({
        text: error.message,
        refused: true,
    }));
    return answer.refused ? undefined : parseJsonWith(answer.text, CiFleetSchema);
};

// The computer's runners, from its answer of the last few minutes or asked now; the promise is what is kept, so jobs
// judged at once share one question.
const rememberedFleet = (services: WhereaboutsServices, id: string, now: number): Promise<CiFleet | undefined> => {
    const kept = asked.get(id);
    if (kept !== undefined && now - kept.at < REMEMBERED_MS) {
        return kept.fleet;
    }
    const fleet = fleetOf(services, id);
    asked.set(id, { at: now, fleet });
    return fleet;
};

const deviceLabel = (services: WhereaboutsServices, id: string): string => {
    const distro = services.hostHub.state(id).facts?.wsl?.distro;
    return distro === undefined || id.includes(distro) ? id : `${id} (${distro})`;
};

/** The connected computer that has a runner of this name, and the runner as it reports it; undefined when none says so.
 *  Never throws and never waits much past a few seconds. */
export const runnerWhereabouts = async (services: WhereaboutsServices, name: string, now = Date.now()): Promise<RunnerWhereabouts | undefined> => {
    const devices = services.hostHub.connected().filter((id) => deviceSupports(services.hostHub.state(id).facts, DEVICE_FEATURE_CI_RUNNERS));
    const fleets = await Promise.all(devices.map(async (id) => ({ id, fleet: await rememberedFleet(services, id, now) })));
    for (const { id, fleet } of fleets) {
        const runner = fleet?.runners.find((candidate) => candidate.name === name);
        if (runner !== undefined) {
            return { device: deviceLabel(services, id), runner };
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
