import type { Config } from "../../../config.js";
import { hostedEnabled } from "../hosted.js";
import { getMachine, isFlyGone } from "./fly.js";

type HostedState = "awake" | "asleep" | "starting" | "down" | "unknown";

// Fly's stopped machine keeps its disk and wakes on selection; destroyed machines need recovery.
export const hostedStateOf = (state: string): HostedState => {
    switch (state) {
        case "started":
            return "awake";
        case "stopped":
        case "suspended":
            return "asleep";
        case "created":
        case "starting":
        case "replacing":
            return "starting";
        case "failed":
        case "destroyed":
        case "destroying":
            return "down";
        default:
            return "unknown";
    }
};

// Every summary carries this read, the editor's sandbox list among them, so a slow provider costs a hint, never the list:
// past this a state reads `unknown`, which is what an older platform answers anyway.
const STATE_READ_DEADLINE_MS = 2_000;

/** What a hosted sandbox's machine is doing right now, read from Fly; `unknown` where hosting is off or no machine is named. */
const readHostedState = async (config: Config, hosted: { appName?: string; machineId?: string }): Promise<HostedState> => {
    if (!hostedEnabled(config) || !hosted.appName || !hosted.machineId) {
        return `unknown`;
    }
    try {
        const machine = await getMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId, STATE_READ_DEADLINE_MS);
        return hostedStateOf(machine.state);
    } catch (error) {
        // A provider outage is not evidence that a machine is asleep.
        return isFlyGone(error) ? `down` : `unknown`;
    }
};

/** A hosted sandbox's row as the summary carries it, with its machine's state read live. */
export const hostedSummaryOf = async (
    config: Config,
    hosted: { region: string; warm: boolean; previousImage?: string | null; appName?: string; machineId?: string },
) => ({
    region: hosted.region,
    warm: hosted.warm,
    // The platform kept the image the machine ran before its last image change (hostedRollback).
    canRollBack: (hosted.previousImage ?? null) !== null,
    state: await readHostedState(config, hosted),
});
