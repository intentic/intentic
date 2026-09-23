import type { HostedOffer, HostedStatus, SandboxSummary } from "@intentic/api-contract";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf, useNow } from "@intentic/ui/async";
import { computed, onScopeDispose, ref } from "vue";
import { track } from "../../../app/analytics";
import type { apiClient } from "../../../lib/useApi";
import type { useSandbox } from "../../sandbox/client/useSandbox";
import { hostedWaitView, machineStartable } from "../hostedWait";
import type { OfferRead } from "../setupLanes";
import { HOSTED_IDLE, type HostedEvent, type HostedLane, laneBusy, owesHandBack, stepHosted } from "./hostedLane";
import type { Machine } from "./machineLadder";
import { type MachinePower, type PowerEvent, stepPower, UNREAD, wakeDue, wakeRefusalOf } from "./machinePower";
import type { SetupRow } from "./useSetupRow";

// The hosted lane wired to the platform: its offer, the machine on this row (started, rebuilt, restarted, handed back),
// the rung the picker holds, and the wait card's account of that machine while somebody waits on it. A lane moves a
// machine onto the existing row; it never deletes or recreates the sandbox.

type Platform = (typeof apiClient)[`sandbox`];
type SandboxStore = ReturnType<typeof useSandbox>;

// Machine state is a rate-limited provider call: read once every this many registry polls.
const MACHINE_EVERY = 4;

// The platform has no machine to give (503 only): not broken, so the card offers the other rung instead of a retry.
const isAtCapacity = (err: unknown): boolean => {
    if (!err || typeof err !== `object`) {
        return false;
    }
    const { code, status } = err as { code?: unknown; status?: unknown };
    return code === `SERVICE_UNAVAILABLE` || status === 503;
};

const hostOf = (url: string | null | undefined): string | undefined => {
    if (url === null || url === undefined) {
        return undefined;
    }
    try {
        return new URL(url).host;
    } catch {
        return undefined;
    }
};

export interface HostedLaneHost {
    readonly platform: Pick<Platform, `hostedOffer` | `hostedStatus` | `hostedRestart` | `wake`>;
    readonly sandbox: Pick<SandboxStore, `hostedProvision` | `hostedRelease`>;
    readonly row: SetupRow;
}

export const useHostedLane = ({ platform, sandbox, row }: HostedLaneHost) => {
    const { created } = row;
    // Which machine runs the sandbox: set by the arrival, and by the reader only through the picker.
    const machine = ref<Machine>(`mine`);
    const lane = ref<HostedLane>(HOSTED_IDLE);
    const power = ref<MachinePower>(UNREAD);
    // Three-valued: a platform that said no and one that never answered differ.
    const hostedRead = ref<OfferRead<{ enabled: boolean; remaining: number }>>({ kind: `unreachable` });
    // Null until answered; a platform without the route reads as disabled.
    const hostedOffer = ref<HostedOffer | null>(null);
    // Why the hosted lane failed, shown on the step where it was pressed; kept apart from the arrival's notice.
    const hostedError = ref<NoticeModel | undefined>(undefined);
    // A refusal for room met by this browser, harder than a later count; cleared only by `recheckCapacity`.
    const hostedRefusedForRoom = ref(false);
    // When the hosted wait began (ms): it only escalates a wait already progressing, never decides what the card says.
    const hostedSince = ref<number | undefined>(undefined);
    // Asked before a hand-back that has something to lose: the row keeps its name, address and sharing, so the
    // workspace looks recoverable afterwards, but the disk under it does not come back.
    const handBackAsked = ref(false);
    // Armed only while somebody waits on the machine.
    const now = useNow(() => hostedSince.value !== undefined);
    let polls = 0;

    const step = (event: HostedEvent): void => {
        lane.value = stepHosted(lane.value, event);
    };
    const note = (event: PowerEvent): void => {
        power.value = stepPower(power.value, event);
    };
    // An answer asked under `action` still describes the machine this page waits on.
    const current = (action: number): boolean => action === lane.value.action && lane.value.kind !== `releasing`;

    // The row carries a machine: the wait card renders off this rather than the picker, so a resumed row narrates right.
    const hostedRow = computed(() => created.value?.hosted ?? null);
    const hostedOffered = computed(() => hostedOffer.value?.enabled === true);
    // The account's allowance is already spent on a different sandbox; the card still renders, explaining why.
    const hostedSpent = computed(() => hostedOffered.value && (hostedOffer.value?.remaining ?? 0) === 0 && hostedRow.value === null);
    // Switched off for this account (an acceptable-use verdict): reads as spent, in its own words.
    const hostedSuspended = computed(() => hostedOffer.value?.suspended === true);
    // Out of machines, unlike spent: it gates only starting one, never a machine already on the row.
    const hostedFull = computed(
        () => hostedOffered.value && (hostedOffer.value?.full === true || hostedRefusedForRoom.value) && hostedRow.value === null,
    );
    // The free plan's hour budget; null where none applies, and the cards then say nothing about hours at all.
    const hostedHours = computed(() => hostedOffer.value?.hours ?? null);
    // The daemon's announced host once it exists: the address line for a lane that never mints a code.
    const hostedHost = computed(() => hostOf(created.value?.daemonUrl));
    const hostedBusy = computed(() => laneBusy(lane.value));
    const releasingHosted = computed(() => lane.value.kind === `releasing`);
    const hostedWait = computed(() =>
        hostedWaitView({
            machine: power.value.reading,
            boot: row.bootReport.value,
            refusal: row.announceRefusal.value,
            announced: row.announced.value,
            // The machine's origin decides which of the two boot-time promises the card makes.
            warm: hostedRow.value?.warm,
            waitedMs: hostedSince.value === undefined ? 0 : now.value - hostedSince.value,
            downForMs: power.value.downSince === undefined ? 0 : now.value - power.value.downSince,
            waking: power.value.waking,
            wakeRefusal: power.value.refusal,
        }),
    );

    // The arrival's read of the offer; an unreachable platform offers nothing without having said so.
    const recordOffer = (read: OfferRead<HostedOffer>): void => {
        hostedRead.value = read;
        hostedOffer.value = read.kind === `answered` ? read.value : { enabled: false, remaining: 0 };
    };

    // Re-reads what the account has left, since releasing a machine changes it; a failed re-read keeps the last answer.
    const refreshHostedOffer = async (): Promise<void> => {
        try {
            hostedOffer.value = await platform.hostedOffer();
        } catch {
            // A platform that cannot be asked keeps the answer it already gave.
        }
    };

    // Retries the capacity read, not a provision: drops the held refusal and asks again; nothing is spent either way.
    const recheckCapacity = async (): Promise<void> => {
        hostedRefusedForRoom.value = false;
        hostedError.value = undefined;
        await refreshHostedOffer();
    };

    // Whether a provision's answer still lands: the lane, the rung and the row are the ones it was asked for.
    const provisionLands = (action: number, id: string): boolean =>
        action === lane.value.action && machine.value === `hosted` && created.value?.id === id;

    // Gives this row a platform-run machine, then the registry poll takes over; a refusal costs only the attempt and
    // leaves the sandbox untouched. False when it did not happen.
    const provisionHosted = async (): Promise<boolean> => {
        const target = created.value;
        if (target === null || target.token === null || lane.value.kind !== `idle`) {
            return false;
        }
        step({ kind: `provision` });
        const { action } = lane.value;
        hostedError.value = undefined;
        try {
            const updated = await sandbox.hostedProvision(target.id, target.token);
            if (!provisionLands(action, target.id)) {
                return false;
            }
            created.value = updated;
            hostedSince.value = Date.now();
            // Zero-command milestone: `sandbox_connected` completes it once this machine checks in.
            track(`sandbox_hosted_created`, {});
            return true;
        } catch (err) {
            if (action === lane.value.action) {
                // No machines left isn't a failure notice: the card replaces itself with what to do instead.
                hostedRefusedForRoom.value = isAtCapacity(err);
                hostedError.value = noticeFrom(err, `Couldn't start a machine for you right now.`);
            }
            return false;
        } finally {
            if (action === lane.value.action) {
                step({ kind: `settled`, action });
                void refreshHostedOffer();
            }
        }
    };

    // `remake` discards the machine and has the lane build another (a bad address baked in), true once released;
    // otherwise restarts what exists, files kept.
    const startOver = async (target: SandboxSummary, remake: boolean, action: number): Promise<boolean> => {
        if (!remake) {
            await platform.hostedRestart({ sandboxId: target.id });
            return false;
        }
        const updated = await sandbox.hostedRelease(target.id);
        if (action !== lane.value.action) {
            return false;
        }
        created.value = updated;
        row.baseline.value = null;
        return true;
    };

    // A rebuild needs a new machine, so it can meet a full fleet like any provision, worded the same way.
    const refuseRestart = (err: unknown): void => {
        hostedRefusedForRoom.value = isAtCapacity(err);
        hostedError.value = hostedRefusedForRoom.value
            ? noticeOf(`We're out of machines right now, so we can't build you another one this minute.`, { tone: `warning` })
            : noticeFrom(err, `Couldn't start it over. Try again in a moment.`);
    };

    // The wait's one recovery, as the failure it answers says: rebuild or restart. The clock restarts with the machine.
    const restartHosted = async (): Promise<void> => {
        const target = created.value;
        if (target === null || lane.value.kind !== `idle`) {
            return;
        }
        // Read before the readings it depends on are cleared below.
        const remake = hostedWait.value.failure?.action === `remake`;
        step({ kind: `restart` });
        const { action } = lane.value;
        hostedError.value = undefined;
        // Cleared before the call, not after it: what the old machine said must not narrate the one replacing it.
        row.forgetBoot();
        note({ kind: `restarted` });
        hostedSince.value = Date.now();
        let released = false;
        try {
            released = await startOver(target, remake, action);
        } catch (err) {
            if (action === lane.value.action) {
                refuseRestart(err);
            }
        } finally {
            step({ kind: `settled`, action });
        }
        // Outside the busy window on purpose, since provisioning shares it: a released machine must not leave the row empty.
        if (released && action === lane.value.action && machine.value === `hosted`) {
            await provisionHosted();
        }
    };

    // Gives the machine on the row back to the platform, so the row carries none: the one gesture that lets the local
    // lane mint a setup code at all. False means the platform refused and the machine is still there, `hostedError`
    // saying so.
    const handBackMachine = async (): Promise<boolean> => {
        const target = created.value;
        if (target === null) {
            return true;
        }
        step({ kind: `release` });
        try {
            created.value = await sandbox.hostedRelease(target.id);
            step({ kind: `released` });
            hostedSince.value = undefined;
            row.baseline.value = null;
            row.forgetBoot();
            note({ kind: `forgot` });
            row.claimedAt.value = null;
            row.report.value = null;
            return true;
        } catch (err) {
            hostedError.value = noticeFrom(err, `Couldn't remove the machine we started. Try again in a moment.`);
            step({ kind: `refused` });
            return false;
        } finally {
            void refreshHostedOffer();
        }
    };

    // A pick the picker may act on: not while the row is being made or its machine handed back, not the rung already
    // held, and hosted not again while its machine is being made.
    const choosable = (next: Machine): boolean =>
        !row.creating.value && !releasingHosted.value && next !== machine.value && !(next === `hosted` && hostedBusy.value);

    // The picker's own pick; stepping off the hosted rung stays possible while a provision is in flight.
    const chooseMachine = async (next: Machine): Promise<void> => {
        if (!choosable(next)) {
            return;
        }
        hostedError.value = undefined;
        // Choosing hosted starts nothing; the card below carries the button, so a pick has no side effect.
        if (next === `hosted`) {
            machine.value = next;
            return;
        }
        // A machine on the row is a disk with work on it; a provision still in flight is neither, so only the first asks.
        if (hostedRow.value !== null) {
            handBackAsked.value = true;
            return;
        }
        // A refusal leaves the rung where it was: the machine still exists, so saying otherwise would lie.
        if (created.value !== null && owesHandBack(lane.value) && !(await handBackMachine())) {
            return;
        }
        machine.value = next;
    };

    // Past the question the hand-back runs as a direct pick does, refusal included: a machine the platform would not
    // take back is still there, and the rung must not move as though it weren't.
    const confirmHandBack = async (): Promise<void> => {
        handBackAsked.value = false;
        if (await handBackMachine()) {
            machine.value = `mine`;
        }
    };

    // Picks up a machine already on the row: its story continues on the wait card, and a machine booting or asleep is
    // the wake reflex's to handle.
    const resumeHosted = (): void => {
        machine.value = `hosted`;
        hostedSince.value = Date.now();
    };

    // One start for a machine the provider says is down, guarded like every hosted call: an answer landing after the
    // reader moved on describes a machine this page no longer waits for.
    const wakeMachine = async (sandboxId: string, action: number): Promise<void> => {
        if (!wakeDue(power.value, Date.now())) {
            return;
        }
        note({ kind: `wake`, at: Date.now() });
        try {
            await platform.wake({ sandboxId });
            if (!current(action)) {
                return;
            }
            // Every estimate and fuse under the step list measures a boot, and this call just started one.
            note({ kind: `woke`, at: Date.now() });
            hostedSince.value = Date.now();
        } catch (err) {
            const refusal = wakeRefusalOf(err);
            // A bad minute is not a decision, and must not erase the decision an earlier start already met.
            if (action === lane.value.action && refusal !== undefined) {
                note({ kind: `refused`, refusal });
            }
        } finally {
            note({ kind: `settled` });
        }
    };

    // One throttled machine-state read riding the registry poll, under the action it was asked with: a reading that
    // lands after a restart describes the machine the restart replaced, and keeping it would restart the down clock.
    const readMachine = async (sandboxId: string, action: number): Promise<void> => {
        if (polls++ % MACHINE_EVERY !== 0) {
            return;
        }
        const reading: HostedStatus[`machine`] | undefined = (await platform.hostedStatus({ sandboxId }).catch(() => undefined))?.machine;
        if (!current(action)) {
            return;
        }
        note({ kind: `read`, reading, at: Date.now() });
        // Only for the reader waiting on this rung: a machine whose owner stepped over to their own computer is one
        // nobody watches, and starting it would bill them for it.
        if (machineStartable(reading) && machine.value === `hosted` && !hostedBusy.value) {
            await wakeMachine(sandboxId, action);
        }
    };

    // Answers still in flight when the page goes describe a machine nobody is waiting on.
    onScopeDispose(() => step({ kind: `left` }));

    return {
        machine,
        lane,
        hostedRead,
        hostedOffer,
        hostedRow,
        hostedOffered,
        hostedSpent,
        hostedSuspended,
        hostedFull,
        hostedHours,
        hostedHost,
        hostedBusy,
        releasingHosted,
        hostedError,
        hostedSince,
        hostedWait,
        handBackAsked,
        recordOffer,
        recheckCapacity,
        provisionHosted,
        restartHosted,
        handBackMachine,
        chooseMachine,
        confirmHandBack,
        resumeHosted,
        readMachine,
    };
};

export type HostedLaneApi = ReturnType<typeof useHostedLane>;
