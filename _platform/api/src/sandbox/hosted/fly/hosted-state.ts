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

/** What a hosted sandbox's machine is doing right now, read from Fly; `unknown` where hosting is off or no machine is named. */
const readHostedState = async (config: Config, hosted: { appName?: string; machineId?: string }): Promise<HostedState> => {
    if (!hostedEnabled(config) || !hosted.appName || !hosted.machineId) {
        return `unknown`;
    }
    try {
        const machine = await getMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId);
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
