import { GOOGLE_REQUIRED_REASON, type HostedOffer, type HostedStatus, type SandboxSummary } from "@intentic/api-contract";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf, useNow } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, onScopeDispose, type Ref, ref, shallowReactive } from "vue";
import { z } from "zod";
import { track } from "../../../app/analytics";
import { arrivingProfile } from "../../../app/useProfile";
import type { apiClient } from "../../../lib/useApi";
import type { useSandbox } from "../../../client/sandbox/useSandbox";
import { useOperations } from "../../../workbench/operations/operations";
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

// The platform's refusal of a free machine to an account that signs in only by email (FORBIDDEN with GOOGLE_REQUIRED_REASON):
// not a failure to show, but the offer's `needsGoogle` met at the press, answered with the same three ways on.
export const GoogleRequiredSchema = z.object({ code: z.literal(`FORBIDDEN`), data: z.object({ reason: z.literal(GOOGLE_REQUIRED_REASON) }) });

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
    readonly platform: Pick<Platform, `hostedOffer` | `hostedStatus` | `hostedRestart` | `wake` | `hostedProvision`>;
    readonly sandbox: Pick<SandboxStore, `hostedProvision` | `hostedRelease`>;
    readonly row: SetupRow;
    // The folder a project setup is for (`SetupProject.dirName`), which its machine is asked for with, so that it boots
    // with the folder as its project; undefined for any other setup.
    readonly project?: string | undefined;
    // Whether the app this page runs in copies a folder into a hosted sandbox's project (`desktopTakesProjects`). An
    // older build reads the hand-over's sync link as a whole-`/work` sync, so without its word no folder goes hosted.
    readonly appTakesProjects: () => boolean;
}

// A hosted machine can take the folder: the platform's machines can hold a project (`hostedOffer.projects`; a platform
// from before them says nothing, which reads as no), and the app can copy the folder into one.
const holdsProjects = (offer: Readonly<Ref<HostedOffer | null>>, appTakesProjects: () => boolean) => (): boolean =>
    offer.value?.projects === true && appTakesProjects();

// The store's provision names no folder, so a project's machine is asked of the platform directly, with the profile the
// store would have sent; the store's list learns the machine at the registry watch's next read.
const provisionFor = ({ platform, sandbox, project }: HostedLaneHost, sandboxId: string, token: string): Promise<SandboxSummary> =>
    project === undefined
        ? sandbox.hostedProvision(sandboxId, token)
        : platform.hostedProvision({ sandboxId, token, project, profile: arrivingProfile() });

// Why a machine call failed, and whether it was for want of room, which the card answers with another rung instead, or for
// want of a Google sign-in on the account, which it answers with the ways on from there.
interface HostedFailure {
    readonly notice: NoticeModel;
    readonly full: boolean;
    readonly google?: boolean;
}

// When somebody began waiting on each row's machine, by its sandbox id. The wait card escalates on it, and a reader who
// left setup mid-wait and came back (the arrival resumes the row from the platform) is still in the same wait.
// allow(module-state): one wait per setup row, keyed by the row's own sandbox id, for as long as the window lives
const waitingSince = shallowReactive(new Map<string, number>());

/** Test seam: the waits are module state, and one left in them would follow one test into the next. */
export const forgetHostedWaits = (): void => waitingSince.clear();

export const useHostedLane = (host: HostedLaneHost) => {
    const { platform, sandbox, row } = host;
    const { created } = row;
    // Which machine runs the sandbox: set by the arrival, and by the reader only through the picker.
    const machine = ref<Machine>(`mine`);
    const lane = ref<HostedLane>(HOSTED_IDLE);
    const power = ref<MachinePower>(UNREAD);
    // Three-valued: a platform that said no and one that never answered differ.
    const hostedRead = ref<OfferRead<{ enabled: boolean; remaining: number }>>({ kind: `unreachable` });
    // Null until answered; a platform without the route reads as disabled.
    const hostedOffer = ref<HostedOffer | null>(null);
    // The platform calls on this row's machine, in the ledger (operations.ts) by the row's sandbox: a start, a start-over
    // and a hand-back each take seconds to minutes, and the reader may leave and come back to the row meanwhile. One
    // `machine` call at a time (a start or a start-over) and one `release`; their answers still land on this lane only
    // under the action they were asked with, and what the ledger keeps is that they run and why they failed.
    const rowId = (): string => created.value?.id ?? ``;
    const work = useOperations<SandboxSummary | null, HostedFailure>(() => `setup/${rowId()}/hosted`);
    const machineCall = computed(() => work.at(`machine`));
    const releaseCall = computed(() => work.at(`release`));
    // Why the hosted lane failed, shown on the step where it was pressed; kept apart from the arrival's notice.
    const hostedFailure = computed(() =>
        [machineCall.value, releaseCall.value]
            .filter((call) => call?.state === `failed`)
            .toSorted((a, b) => (b?.order ?? 0) - (a?.order ?? 0))[0]?.failure,
    );
    // A refusal for want of Google is answered by the ways on from there (Setup.vue), not said as a failure.
    const hostedError = computed(() => (hostedFailure.value?.google === true ? undefined : hostedFailure.value?.notice));
    const clearHostedError = (): void => {
        work.dismiss(`machine`);
        work.dismiss(`release`);
    };
    // A refusal for room met by this browser, harder than a later count; cleared only by `recheckCapacity`.
    const refusedForRoom = ref(false);
    // The platform said, at the press, that this account needs a Google sign-in for a free machine.
    const refusedForGoogle = ref(false);
    const hostedRefusedForRoom = computed(() => refusedForRoom.value || hostedFailure.value?.full === true);
    // When the hosted wait began (ms): it only escalates a wait already progressing, never decides what the card says.
    const hostedSince = computed<number | undefined>({
        get: () => waitingSince.get(rowId()),
        set: (at) => {
            if (at === undefined) {
                waitingSince.delete(rowId());
            } else {
                waitingSince.set(rowId(), at);
            }
        },
    });
    // Asked before a hand-back that has something to lose: the row keeps its name, address and sharing, so the
    // workspace looks recoverable afterwards, but the disk under it does not come back.
    const handBackAsked = ref(false);
    // Armed only while somebody waits on the machine.
    const now = useNow(() => hostedSince.value !== undefined);
    let polls = 0;
    // The page went: an answer landing now is the next visit's to read, not this lane's.
    let left = false;

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
    const hostedProjects = computed(holdsProjects(hostedOffer, host.appTakesProjects));
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
    // A call this page made, or one a page before it made on this row that is still out.
    const hostedBusy = computed(() => laneBusy(lane.value) || machineCall.value?.state === `running`);
    const releasingHosted = computed(() => lane.value.kind === `releasing` || releaseCall.value?.state === `running`);
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
        refusedForRoom.value = false;
        clearHostedError();
        await refreshHostedOffer();
    };

    // Whether a provision's answer still lands: the lane, the rung and the row are the ones it was asked for.
    const provisionLands = (action: number, id: string): boolean =>
        action === lane.value.action && machine.value === `hosted` && created.value?.id === id;

    // Gives this row a platform-run machine, then the registry poll takes over; a refusal costs only the attempt and
    // leaves the sandbox untouched. False when it did not happen.
    const provisionHosted = async (): Promise<boolean> => {
        const target = created.value;
        const token = target?.token ?? null;
        if (target === null || token === null || lane.value.kind !== `idle`) {
            return false;
        }
        // A start a page before this one made is still out: it is happening, and its machine reaches the row through
        // the platform, where the arrival reads it.
        if (machineCall.value?.state === `running`) {
            return true;
        }
        step({ kind: `provision` });
        const { action } = lane.value;
        clearHostedError();
        try {
            const ran = await work.run(`machine`, {
                what: t(`setup.useHostedLane.starting`),
                tag: `provision`,
                failed: (err) => ({
                    notice: noticeFrom(err, t(`setup.useHostedLane.startFailed`)),
                    full: isAtCapacity(err),
                    google: GoogleRequiredSchema.safeParse(err).success,
                }),
                // A start abandoned with its draft is no news, and one that lands is the card's own to say.
                quiet: true,
                task: () => provisionFor(host, target.id, token),
            });
            if (ran?.state === `failed`) {
                if (action === lane.value.action) {
                    // No machines left isn't a failure notice: the card replaces itself with what to do instead. Nor is a
                    // free machine refused for want of Google: the ways on from there replace it.
                    refusedForRoom.value = ran.failure?.full === true;
                    refusedForGoogle.value = ran.failure?.google === true;
                } else if (!left) {
                    // Asked of a lane this page has moved on from (a hand-back): nobody waits on its failure. One that
                    // lands after the page went is kept, for the next visit to the row.
                    work.dismiss(`machine`);
                }
            }
            const updated = ran?.state === `done` ? ran.value : undefined;
            if (updated === undefined || updated === null || !provisionLands(action, target.id)) {
                return false;
            }
            created.value = updated;
            hostedSince.value = Date.now();
            // Zero-command milestone: `sandbox_connected` completes it once this machine checks in.
            track(`sandbox_hosted_created`, {});
            return true;
        } finally {
            if (action === lane.value.action) {
                step({ kind: `settled`, action });
                void refreshHostedOffer();
            }
        }
    };

    // `remake` discards the machine and has the lane build another (a bad address baked in), answering the row released;
    // otherwise restarts what exists, files kept, answering nothing.
    const startOver = async (target: SandboxSummary, remake: boolean): Promise<SandboxSummary | null> => {
        if (!remake) {
            await platform.hostedRestart({ sandboxId: target.id });
            return null;
        }
        return sandbox.hostedRelease(target.id);
    };

    // A rebuild needs a new machine, so it can meet a full fleet like any provision, worded the same way.
    const restartRefusal = (err: unknown): HostedFailure =>
        isAtCapacity(err)
            ? { notice: noticeOf(t(`setup.useHostedLane.outOfMachines`), { tone: `warning` }), full: true }
            : { notice: noticeFrom(err, t(`setup.useHostedLane.restartFailed`)), full: false };

    // The wait's one recovery, as the failure it answers says: rebuild or restart. The clock restarts with the machine.
    const restartHosted = async (): Promise<void> => {
        const target = created.value;
        if (target === null || lane.value.kind !== `idle` || machineCall.value?.state === `running`) {
            return;
        }
        // Read before the readings it depends on are cleared below.
        const remake = hostedWait.value.failure?.action === `remake`;
        step({ kind: `restart` });
        const { action } = lane.value;
        clearHostedError();
        // Cleared before the call, not after it: what the old machine said must not narrate the one replacing it.
        row.forgetBoot();
        note({ kind: `restarted` });
        hostedSince.value = Date.now();
        let released = false;
        try {
            const ran = await work.run(`machine`, {
                what: t(`setup.useHostedLane.restarting`),
                tag: `restart`,
                failed: restartRefusal,
                done: () => t(`setup.useHostedLane.restarted`),
                task: () => startOver(target, remake),
            });
            if (action !== lane.value.action) {
                // The lane moved on (a hand-back): nobody waits on this answer, failure included. One that lands after the
                // page went is kept, for the next visit to the row.
                if (ran?.state === `failed` && !left) {
                    work.dismiss(`machine`);
                }
            } else {
                if (ran?.state === `failed`) {
                    refusedForRoom.value = ran.failure?.full === true;
                }
                const updated = ran?.state === `done` ? ran.value : null;
                if (updated !== null && updated !== undefined) {
                    created.value = updated;
                    row.baseline.value = null;
                    released = true;
                }
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
            const ran = await work.run(`release`, {
                what: t(`setup.useHostedLane.removing`),
                failed: (err) => ({ notice: noticeFrom(err, t(`setup.useHostedLane.removeFailed`)), full: false }),
                done: () => t(`setup.useHostedLane.removed`),
                task: () => sandbox.hostedRelease(target.id),
            });
            // A hand-back a page before this one asked for is still out: the machine is not gone yet.
            if (ran?.state !== `done` || ran.value === null || ran.value === undefined) {
                step({ kind: `refused` });
                return false;
            }
            created.value = ran.value;
            step({ kind: `released` });
            hostedSince.value = undefined;
            row.baseline.value = null;
            row.forgetBoot();
            note({ kind: `forgot` });
            row.claimedAt.value = null;
            row.report.value = null;
            return true;
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
        clearHostedError();
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
    // A wait this window already began on the row goes on counting from when it began.
    const resumeHosted = (): void => {
        machine.value = `hosted`;
        hostedSince.value ??= Date.now();
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

    // Answers still in flight when the page goes describe a machine nobody is waiting on. A wait that already ended in
    // a check-in is over: a later visit to the row waits afresh.
    onScopeDispose(() => {
        left = true;
        step({ kind: `left` });
        if (row.announced.value) {
            hostedSince.value = undefined;
        }
    });

    return {
        machine,
        lane,
        hostedRead,
        hostedOffer,
        hostedRow,
        hostedOffered,
        hostedProjects,
        hostedSpent,
        hostedSuspended,
        // Read with the offer's `needsGoogle` by the setup screen, which offers the ways on (Setup.vue hostedNeedsGoogle).
        refusedForGoogle,
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
