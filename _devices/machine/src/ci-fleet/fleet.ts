import { errorMessage } from "@intentic/base/errors";
import type { CiFleet, CiFleetService } from "@intentic/sandbox-contract/schemas/ci-fleet";
import { MACHINE_VERSION } from "../version.js";
import { askFleet, FleetUnavailable } from "./client.js";
import { FleetConfigSchema } from "./config.js";
import { DEFAULT_RUNNERS_GLOB, discoverRunners } from "./discover.js";
import { readHolds } from "./fleet-holds.js";
import { FLEET_CONFIG_PATH, FLEET_UNIT } from "./paths.js";
import type { FleetStatus } from "./protocol.js";
import { type FleetSys, machineSys } from "./sys.js";

/* THE FLEET AS THE PERSON'S AGENT READS IT for `ci_runners`: the runners, read here (no root needed), joined with what
   the service keeps (its version, the last passes, the cache sizes, the slot pool). A service that is down leaves the
   runners listed and says why it is not answering. Each read also tells the service this agent's version, which it
   follows through a signed release (update.ts). */

const ASK_MS = 15_000;

// Where the service keeps its state and the fleet's caches, from its settings where this account can read them
// (`ci-fleet install` writes them 0644: they hold no secret), else the defaults the service would use.
const settings = async (sys: FleetSys): Promise<{ stateDir: string; cacheRoot: string; runnersGlob: string }> => {
    const text = await sys.readText(FLEET_CONFIG_PATH);
    let raw: unknown;
    try {
        raw = text === undefined ? undefined : JSON.parse(text);
    } catch {
        // allow(silent-catch): settings that do not read leave the defaults, as for a computer without the service
        raw = undefined;
    }
    const parsed = FleetConfigSchema.safeParse(raw);
    return parsed.success
        ? { stateDir: parsed.data.stateDir, cacheRoot: parsed.data.cacheRoot, runnersGlob: parsed.data.janitor.runnersGlob }
        : { stateDir: "/var/lib/intentic-ci", cacheRoot: "/ci-cache", runnersGlob: DEFAULT_RUNNERS_GLOB };
};

// Whether the service's unit is installed, answering or not.
const unitInstalled = async (sys: FleetSys): Promise<boolean> => {
    const shown = await sys.run("systemctl", ["show", "--no-pager", "--property=LoadState", FLEET_UNIT], { timeoutMs: ASK_MS });
    return shown.status === 0 && shown.stdout.includes("LoadState=loaded");
};

const serviceStatus = async (sys: FleetSys, ask: typeof askFleet): Promise<{ service: CiFleetService; status?: FleetStatus }> => {
    try {
        const answer = await ask({ verb: "hello", version: MACHINE_VERSION }, ASK_MS);
        return answer.status === undefined
            ? { service: { running: true, installed: true } }
            : { service: { running: true, installed: true, version: answer.status.version }, status: answer.status };
    } catch (error) {
        const installed = await unitInstalled(sys);
        if (error instanceof FleetUnavailable && !installed) {
            return { service: { running: false, installed: false } };
        }
        return { service: { running: false, installed, problem: errorMessage(error) } };
    }
};

export const readFleet = async (sys: FleetSys = machineSys, ask: typeof askFleet = askFleet): Promise<CiFleet> => {
    const where = await settings(sys);
    const [{ runners }, { service, status }] = await Promise.all([
        (async () => await discoverRunners(sys, await readHolds(where.stateDir), where.runnersGlob))(),
        serviceStatus(sys, ask),
    ]);
    const fleet: CiFleet = { service, runners: [...runners], cacheRoot: where.cacheRoot, caches: status?.caches ?? [] };
    if (status?.slots !== undefined) {
        fleet.slots = status.slots;
    }
    if (status?.keeper !== undefined) {
        fleet.keeper = status.keeper;
    }
    if (status?.janitor !== undefined) {
        fleet.janitor = status.janitor;
    }
    if (status?.prune !== undefined) {
        fleet.prune = status.prune;
    }
    return fleet;
};
