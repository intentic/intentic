import type { MemoryReclaimRefusal, MemoryReclaimResult } from "@intentic/sandbox-contract/schemas/metrics";
import type { FleetUnfit, MachineHost, MachineLoad, MachineStanding, MachineStrain } from "@intentic/sandbox-contract/schemas/offload";
import { formatBytes, type Tip } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
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

const MB = 1_048_576;
const mb = (value: number): string => formatBytes(value * MB);
// A computer's memory as Task Manager shows it, gigabytes to one decimal at any size: "16.6 GB", where the compact
// rounding would say "17 GB" and the owner could not find the figure.
const gb = (valueMb: number): string => `${formatFixed(valueMb / 1024, 1)} GB`;
const gbOfBytes = (bytes: number): string => gb(bytes / MB);

const memoryFree = (load: MachineLoad): string | undefined => (load.memoryFreeMb === undefined ? undefined : mb(load.memoryFreeMb));

/* WHICH MEMORY IS SHORT, IN FIGURES THE OWNER CAN CHECK (2026-11-26). The free figure is the tighter of this sandbox's own
   budget and the room its computer has above the line it keeps for itself, so on rog "only 1.9 GB of memory free" was
   Windows' Available less a 3.1 GB line, while the sandbox had 10.5 GB and the WSL VM held 16.6 GB. Where the computer
   says what it has (MachineHostSchema), the line names it: Windows' own Available as Task Manager shows it, and the VM's
   share and its unused part where read; where the sandbox's own budget is what is short, it says "this sandbox". A host
   that says nothing (a Linux host, an agent older than the reading) keeps the sentence it always had. */

// Unused memory below this is rounding, not a finding: "(0 B of it unused)" would say nothing.
const UNUSED_WORTH_MB = 100;

// What Windows has and what WSL holds of it, as much as the reading says.
const hostFigures = (host: MachineHost): string => {
    const available = gb(host.availableMb);
    if (host.vmMb === undefined) {
        return t(`chat.fleetAdvice.hostFigures`, { available });
    }
    const vm = gb(host.vmMb);
    return host.vmUnusedMb === undefined || host.vmUnusedMb < UNUSED_WORTH_MB
        ? t(`chat.fleetAdvice.hostFiguresVm`, { available, vm })
        : t(`chat.fleetAdvice.hostFiguresVmUnused`, { available, vm, unused: gb(host.vmUnusedMb) });
};

// The computer under this machine, when it is the strongest reason the machine is not calm: memory leads the strains and
// the computer's room is what that memory came to.
const shortHost = (load: MachineLoad): MachineHost | undefined => (load.strain[0] === `memory` && load.host?.binding === true ? load.host : undefined);

const memoryPhrase = (load: MachineLoad): string => {
    if (load.host?.binding === true) {
        return t(`chat.fleetAdvice.strainMemoryHost`, { available: gb(load.host.availableMb) });
    }
    const free = memoryFree(load);
    if (free === undefined) {
        return t(`chat.fleetAdvice.strainMemoryShort`);
    }
    return load.host === undefined ? t(`chat.fleetAdvice.strainMemory`, { free }) : t(`chat.fleetAdvice.strainMemorySandbox`, { free });
};

// One strain in a few words, the figure that shows it where there is one.
const strainPhrase = (strain: MachineStrain, load: MachineLoad): string => {
    switch (strain) {
        case `memory`:
            return memoryPhrase(load);
        case `memory-stall`:
            return t(`chat.fleetAdvice.strainMemoryStall`);
        case `cpu`:
            return t(`chat.fleetAdvice.strainCpu`);
        case `agents`:
            return t(`chat.fleetAdvice.strainAgents`, { count: load.agents }, load.agents);
        case `disk`:
            return load.diskFreeMb === undefined
                ? t(`chat.fleetAdvice.strainDiskShort`)
                : t(`chat.fleetAdvice.strainDisk`, { free: formatBytes(load.diskFreeMb * 1_048_576) });
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

// The strip's sentence while this machine is busy and another has room, before anything moved. Led by the computer
// under it when that is what is short; one line, so a second strain is left to the generic sentence.
export const suggestLine = (here: MachineLoad, machine: string): string => {
    const host = shortHost(here);
    if (host !== undefined) {
        return t(`chat.fleetAdvice.suggestHost`, { host: host.name, figures: hostFigures(host), machine });
    }
    const why = strainWords(here);
    return why === undefined ? t(`chat.fleetAdvice.suggestPlain`, { machine }) : t(`chat.fleetAdvice.suggest`, { machine, why });
};

// The strip's sentence once the fleet placed the draft on another machine by itself (settings `offload.sessions: auto`).
export const movedLine = (here: MachineLoad, machine: string): string => {
    const host = shortHost(here);
    if (host !== undefined) {
        return t(`chat.fleetAdvice.movedHost`, { host: host.name, figures: hostFigures(host), machine });
    }
    const why = strainWords(here);
    return why === undefined ? t(`chat.fleetAdvice.movedPlain`, { machine }) : t(`chat.fleetAdvice.moved`, { machine, why });
};

// The strip's hover where the computer under this machine says what memory it has: every figure the line is drawn from,
// the line it keeps for itself included, and the card that proposes a smaller WSL VM while one waits (`wslCard`).
export const hostTip = (here: MachineLoad, wslCard: boolean): Tip | undefined => {
    const { host } = here;
    if (host === undefined) {
        return undefined;
    }
    return {
        title: t(`chat.fleetAdvice.tipTitle`, { host: host.name }),
        rows: [
            { label: t(`chat.fleetAdvice.tipAvailable`), value: gb(host.availableMb) },
            { label: t(`chat.fleetAdvice.tipReserve`), value: gb(host.reserveMb) },
            ...(here.memoryFreeMb === undefined ? [] : [{ label: t(`chat.fleetAdvice.tipRoom`), value: gb(here.memoryFreeMb) }]),
            ...(host.vmMb === undefined ? [] : [{ label: t(`chat.fleetAdvice.tipVm`), value: gb(host.vmMb) }]),
            ...(host.vmUnusedMb === undefined ? [] : [{ label: t(`chat.fleetAdvice.tipVmUnused`), value: gb(host.vmUnusedMb) }]),
            ...(host.ownFreeMb === undefined ? [] : [{ label: t(`chat.fleetAdvice.tipSandbox`), value: gb(host.ownFreeMb) }]),
        ],
        note: wslCard ? t(`chat.fleetAdvice.tipWslCard`) : undefined,
    };
};

// Whether "Free memory" belongs on the strip: the computer under this sandbox is what is short, and a press could reclaim.
export const offersReclaim = (advice: { readonly here: MachineLoad; readonly reclaim?: boolean | undefined }): boolean =>
    advice.reclaim === true && advice.here.host?.binding === true && advice.here.strain.includes(`memory`);

// What Windows has to gain before it counts as having got something back: its Available moves by about this much from
// one second to the next with nothing pressed (measured on rog, 2026-11-26).
const GAINED_WORTH_BYTES = 100 * MB;
// What a sandbox has to let go of before it counts as having given anything.
const GIVEN_WORTH_BYTES = MB;

const REFUSED = {
    "no-host": () => t(`chat.fleetAdvice.freeRefusedNoHost`),
    unsupported: () => t(`chat.fleetAdvice.freeRefusedUnsupported`),
    stalling: () => t(`chat.fleetAdvice.freeRefusedStalling`),
    small: () => t(`chat.fleetAdvice.freeRefusedSmall`),
} as const satisfies Readonly<Record<MemoryReclaimRefusal, () => string>>;

// What came of a press, said plainly: what Windows got back, that it got none of it, or why nothing was tried.
export const reclaimWords = (result: MemoryReclaimResult): string => {
    if (result.outcome === `refused`) {
        return REFUSED[result.why]();
    }
    const { host } = result;
    if (result.givenBytes < GIVEN_WORTH_BYTES) {
        return t(`chat.fleetAdvice.freedNothingGiven`);
    }
    const given = gbOfBytes(result.givenBytes);
    if (host.afterBytes === undefined) {
        return t(`chat.fleetAdvice.freedUnanswered`, { given, host: host.name });
    }
    const gained = host.afterBytes - host.beforeBytes;
    return gained < GAINED_WORTH_BYTES
        ? t(`chat.fleetAdvice.freedNothing`, { given })
        : t(`chat.fleetAdvice.freedGained`, { gained: gbOfBytes(gained), available: gbOfBytes(host.afterBytes) });
};
