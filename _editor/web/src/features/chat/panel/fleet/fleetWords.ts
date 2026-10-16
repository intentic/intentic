import type { FleetUnfit, MachineLoad, MachineStanding, MachineStrain } from "@intentic/sandbox-contract/schemas/offload";
import { formatBytes } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// The words for the fleet advice (GET /offload/placement): how full a machine is, why, and why a session could not start
// on a runner. Kept apart from the components so each sentence is pinned without mounting anything; every key is
// spelled out once, since the catalog check finds a key only where it is written whole.

const STANDING = {
    calm: () => t(`chat.fleetAdvice.standingCalm`),
    busy: () => t(`chat.fleetAdvice.standingBusy`),
    full: () => t(`chat.fleetAdvice.standingFull`),
} as const satisfies Readonly<Record<MachineStanding, () => string>>;
export const standingWord = (standing: MachineStanding): string => STANDING[standing]();

const memoryFree = (load: MachineLoad): string | undefined =>
    load.memoryFreeMb === undefined ? undefined : formatBytes(load.memoryFreeMb * 1_048_576);

// One strain in a few words, the figure that shows it where there is one.
const strainPhrase = (strain: MachineStrain, load: MachineLoad): string => {
    switch (strain) {
        case `memory`: {
            const free = memoryFree(load);
            return free === undefined ? t(`chat.fleetAdvice.strainMemoryShort`) : t(`chat.fleetAdvice.strainMemory`, { free });
        }
        case `memory-stall`:
            return t(`chat.fleetAdvice.strainMemoryStall`);
        case `cpu`:
            return t(`chat.fleetAdvice.strainCpu`);
        case `agents`:
            return t(`chat.fleetAdvice.strainAgents`, { count: load.agents }, load.agents);
    }
};

// Why a machine is not calm: its strongest strain, and the second when there is one, since "memory and CPU" says more
// than either alone. Undefined for a calm machine, which has nothing to explain.
export const strainWords = (load: MachineLoad): string | undefined => {
    const [first, second] = load.strain;
    if (first === undefined) {
        return undefined;
    }
    return second === undefined
        ? strainPhrase(first, load)
        : t(`chat.fleetAdvice.strainBoth`, { first: strainPhrase(first, load), second: strainPhrase(second, load) });
};

// The line under a machine in the placement menu: how full, how many agents of its slots, what memory is free.
export const loadLine = (load: MachineLoad): string => {
    const free = memoryFree(load);
    return [
        standingWord(load.standing),
        t(`chat.fleetAdvice.agentsOfSlots`, { agents: load.agents, slots: load.slots }, load.slots),
        ...(free === undefined ? [] : [t(`chat.fleetAdvice.memoryFree`, { free })]),
    ].join(` · `);
};

const UNFIT = {
    offline: () => t(`chat.chatPlacementMenu.runnerOffline`),
    unmeasured: () => t(`chat.fleetAdvice.unfitUnmeasured`),
    credentials: () => t(`chat.fleetAdvice.unfitCredentials`),
    privacy: () => t(`chat.fleetAdvice.unfitPrivacy`),
    areas: () => t(`chat.fleetAdvice.unfitAreas`),
} as const satisfies Readonly<Record<FleetUnfit, () => string>>;
// Why a new session could not start on a runner now, said where the runner is listed.
export const unfitWords = (unfit: FleetUnfit): string => UNFIT[unfit]();

// The strip's sentence while this machine is busy and another has room, before anything moved.
export const suggestLine = (here: MachineLoad, machine: string): string => {
    const why = strainWords(here);
    return why === undefined ? t(`chat.fleetAdvice.suggestPlain`, { machine }) : t(`chat.fleetAdvice.suggest`, { machine, why });
};

// The strip's sentence once the fleet placed the draft on another machine by itself (settings `offload.sessions: auto`).
export const movedLine = (here: MachineLoad, machine: string): string => {
    const why = strainWords(here);
    return why === undefined ? t(`chat.fleetAdvice.movedPlain`, { machine }) : t(`chat.fleetAdvice.moved`, { machine, why });
};
