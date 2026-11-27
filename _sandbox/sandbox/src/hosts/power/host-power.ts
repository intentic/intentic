import { serialLock } from "@intentic/base/async";
import { type Device, hostRunningSandbox, isWslDevice, machinesOf } from "@intentic/sandbox-contract/schemas/devices";
import { type HostPower, type HostPowerFinding, POWER_FINDING, restartBlocks } from "@intentic/sandbox-contract/schemas/host-power";
import { parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import { type HostPowerNeed, isOpenNeed, type Need } from "@intentic/sandbox-contract/schemas/needs";
import type { Logger } from "pino";
import type { Services } from "../../composition.js";
import type { Needs } from "../../needs/needs.js";
import { heldHostDevices } from "../device-reports.js";
import { ownSlug } from "../self-host.js";

/* WORK BOOKED ON A COMPUTER THAT WOULD SLEEP THROUGH IT (2026-11-22). Two sandboxes on rog, the owner's Windows laptop,
   had sends booked for the night. rog's power plan slept it five hours after the last keypress; every sandbox on it
   froze until the lid was opened at 10:01, a send booked for 07:10 went out three hours late, and nobody had been told.
   The owner's call: nothing here holds the computer awake by itself. Instead, the moment work is booked for later (a
   scheduled send, a continuation, a timed automation), the daemon reads what the computer it runs on says its OS would
   do to work left running (`DeviceFacts.power`, which the machine agent reports), and when something would act before
   the work is due it raises a `host-power` card in the conversation that booked it (needs/kinds/host-power-need.ts).
   The owner's yes there changes those settings on mains power.

   Said once, not at every booking: an open card for that computer in any conversation is enough, and one declined in
   the last week stays down unless something new would stop the work. Read from the needs already stored, so nothing
   new is kept to remember it. */

// Work due sooner than this raises nothing: the owner was at the computer a moment ago, and no idle timer worth a card
// runs out in a quarter of an hour.
export const POWER_LEAD_MS = 15 * 60_000;
// How long a declined card keeps the same findings from raising another.
export const POWER_DECLINE_QUIET_MS = 7 * 24 * 3_600_000;
// How long the computer is given to describe itself again before the check reads what it said last.
const REFRESH_MS = 8_000;
// Moved to the contract (2026-11-27), where the host-power card's answer weighs a restart too; said here as before.
export { windowMeets } from "@intentic/sandbox-contract/schemas/host-power";

// Whether one finding would act before work due at `dueAt`. An idle timer on mains power acts once it runs out, counted
// from now, when the owner may have just stopped typing; the lid, a standby that cuts the network and a Linux or macOS
// suspend can act at any moment; an update restart only inside its hours, and at any hour when the agent did not say
// which, and never while Windows Update is paused past the work or the sandboxes start again with the computer
// (restartBlocks). Battery sleep never raises a card by itself: the card shows it as a note, since nothing here changes it and a
// laptop in a bag must still sleep. An id this build does not know counts only when the agent's op can change it.
const blocks = (finding: HostPowerFinding, power: HostPower, now: number, dueAt: number): boolean => {
    switch (finding.id) {
        case POWER_FINDING.sleepIdle:
        case POWER_FINDING.hibernateIdle:
            return finding.power !== "dc" && (finding.afterSeconds === undefined || finding.afterSeconds * 1_000 <= dueAt - now);
        case POWER_FINDING.lidClose:
        case POWER_FINDING.standbyNetwork:
        case POWER_FINDING.osSleep:
            return true;
        case POWER_FINDING.updateRestart:
            return restartBlocks(finding, power.utcOffsetMinutes, now, dueAt);
        case POWER_FINDING.batterySleep:
            return false;
        default:
            return finding.fixable;
    }
};

/** The findings that would stop or delay work due at `dueAt`, read at `now`; none for work due within POWER_LEAD_MS. Pure. */
export const powerBlockers = (power: HostPower, now: number, dueAt: number): HostPowerFinding[] =>
    dueAt - now < POWER_LEAD_MS ? [] : power.findings.filter((finding) => blocks(finding, power, now, dueAt));

/**
 * Why no card goes up for these blockers on `device`, or undefined when one should: a card for that computer is already
 * open in any conversation (its settings are the computer's, whichever booking found them), or a person declined one in
 * the last week that already named every one of them. Something new that would stop the work raises a card again. Pure.
 */
export const powerCardSuppressed = (needs: readonly Need[], device: string, blockers: readonly HostPowerFinding[], now: number): string | undefined => {
    const cards = needs.flatMap((need): { readonly need: Need; readonly subject: HostPowerNeed }[] =>
        need.subject.kind === "host-power" && need.subject.device === device ? [{ need, subject: need.subject }] : [],
    );
    const open = cards.find((card) => isOpenNeed(card.need));
    if (open !== undefined) {
        return `${open.need.id} is already open for it, in conversation ${open.need.conversationId}`;
    }
    const declined = cards.find(
        ({ need, subject }) =>
            need.status === "declined" &&
            now - need.updatedAt < POWER_DECLINE_QUIET_MS &&
            blockers.every((blocker) => subject.findings.some((finding) => finding.id === blocker.id)),
    );
    return declined === undefined ? undefined : `a person declined ${declined.need.id} for the same findings within the week`;
};

// The connection to a computer that holds its power settings, and what the owner calls that computer.
export interface PowerDoor {
    readonly device: string;
    readonly name: string;
}

/**
 * The connection to the computer this sandbox runs on that holds its power settings, and what the owner calls that
 * computer. `running` is the door whose docker lists this sandbox (`hostRunningSandbox`), which on a Windows PC may be a
 * WSL distro's, sharing the engine; the settings are said by the native side alone (`DeviceFacts.power`), so the
 * machine's native environment is the one asked. Its connection key is its card's id, the name the Devices view and the
 * devices tools call that computer by, which the card shows as it is. Undefined when only a distro of it is connected,
 * which says nothing of power. Pure.
 */
export const powerDoorOf = (devices: readonly Device[], running: string): PowerDoor | undefined => {
    const machine = machinesOf(devices).find((candidate) => candidate.environments.some((environment) => environment.hostId === running));
    const native = machine?.environments.find((environment) => environment.hostId !== undefined && !isWslDevice(environment))?.hostId;
    return native === undefined ? undefined : { device: native, name: parseHostConnection(native).card };
};

// What the check reads and raises through, so it runs over fakes in a test.
export interface HostPowerCheckDeps {
    readonly now: () => number;
    // The computer this sandbox runs on, by the connection holding its power settings; undefined on a runner or in the
    // cloud, and when nothing has been read yet.
    readonly selfHost: () => Promise<PowerDoor | undefined>;
    // Asks it to describe itself again within a short deadline; it keeps what it said last when it cannot.
    readonly refresh: (device: string) => Promise<void>;
    readonly power: (device: string) => HostPower | undefined;
    readonly needs: Pick<Needs, "list" | "observe">;
    readonly logger: Pick<Logger, "info">;
}

/** Raises a host-power card in `conversationId` when the computer it runs on would stop work due at `dueAt`; answers it, or undefined when none went up. */
export const raiseHostPowerCard = async (deps: HostPowerCheckDeps, conversationId: string, dueAt: number): Promise<Need | undefined> => {
    const host = await deps.selfHost();
    if (host === undefined) {
        return undefined;
    }
    // allow(silent-catch): a computer that does not re-describe itself in time is judged by what it said last
    await deps.refresh(host.device).catch(() => undefined);
    // Absent from an agent older than the field, and where the settings could not be read: nothing to say either way.
    const power = deps.power(host.device);
    if (power === undefined) {
        return undefined;
    }
    const now = deps.now();
    const blockers = powerBlockers(power, now, dueAt);
    if (blockers.length === 0) {
        return undefined;
    }
    const ids = blockers.map((blocker) => blocker.id);
    const suppressed = powerCardSuppressed(await deps.needs.list({}), host.device, blockers, now);
    if (suppressed !== undefined) {
        deps.logger.info({ conversationId, device: host.device, blockers: ids, why: suppressed }, "host power: booked work would be slept through; no new card");
        return undefined;
    }
    // No clock time in the title: the daemon's zone is not the reader's, and the card draws `dueAt` in theirs.
    const need = await deps.needs.observe(
        conversationId,
        { kind: "host-power", device: host.device, findings: power.findings, dueAt, utcOffsetMinutes: power.utcOffsetMinutes },
        `${host.name} would sleep through work booked here`,
    );
    deps.logger.info({ conversationId, device: host.device, blockers: ids, need: need.id, dueAt }, "host power: booked work would be slept through; card raised");
    return need;
};

// The check over the daemon's own services: the device list and the hub as they are held, and the needs service.
const hostPowerCheckDeps = (services: Services): HostPowerCheckDeps => ({
    now: Date.now,
    // hostRunningSelf's own reading (self-host.ts), taken once here so the machine it runs on can be read off the same list.
    selfHost: async () => {
        const devices = await heldHostDevices(services);
        const running = hostRunningSandbox(devices, ownSlug(services));
        return running === undefined ? undefined : powerDoorOf(devices, running);
    },
    refresh: (device) => services.hostHub.refresh(device, REFRESH_MS),
    power: (device) => services.hostHub.state(device).facts?.power,
    needs: services.needs,
    logger: services.logger,
});

// One check at a time in this daemon, so two sends booked in the same breath find the first one's card rather than
// raising two.
const oneAtATime = serialLock();

/**
 * After work is booked in `conversationId` for `dueAt`: raises a host-power card there when the computer this sandbox
 * runs on would sleep through it. Never throws and never holds up the booking: callers `void` it, and a failure is a
 * warning in the log.
 */
export const checkHostPowerFor = (services: Services, conversationId: string, dueAt: number): Promise<void> =>
    oneAtATime(() => raiseHostPowerCard(hostPowerCheckDeps(services), conversationId, dueAt))
        .then(() => undefined)
        .catch((error: Error) => services.logger.warn({ err: error, conversationId, dueAt }, "host power: could not check the computer this sandbox runs on"));

/** `checkHostPowerFor` for a booking: one with a time is checked; one waiting on another conversation's work has none. */
export const checkBookedPower = (services: Services, conversationId: string, booking: { readonly until?: number | undefined }): Promise<void> =>
    booking.until === undefined ? Promise.resolve() : checkHostPowerFor(services, conversationId, booking.until);
