import { computed, effectScope, ref, shallowRef, watch, type Ref, type WatchStopHandle } from "vue";
import { useNow } from "@intentic/ui/async";
import { useCopied } from "@intentic/ui/clipboard";
import { t } from "@intentic/ui/i18n";
import { track, trackBeforeExit } from "../analytics";
import {
    claimExpired,
    desktopInfo,
    dockerReady as dockerReadyProbe,
    expectedStop,
    forgetResumableSetup,
    freshSetupCode,
    parkSetupForPc,
    parseCommandFailure,
    parseStep,
    readMarker,
    restartForSetup,
    resumableSetup,
    revealLog,
    runStop,
    setupAlert,
    setupProgress,
    setupRun,
    signOutForSetup,
    takePendingSetup,
    workspaceOpen,
    type OnboardingCheck,
    type OnboardingSetup,
    type Requirement,
    type RequirementProgress,
    type RunEvent,
    type RunMarker,
    type SessionEnd,
    type FreshCode,
    type SetupArgs,
    type SetupReport,
    type SetupWaitingFor,
} from "../desktop";
import { currentPcCheck, followPcSetup, pcParts, setUpThisPc as startPcSetup, type PcParts } from "../onboarding/pc";
import { advance, type PlanStep, progressView, setupPlan, startProgress, tick, type Progress } from "../setupPlan";
import {
    endRequirements,
    failureLine,
    foldRequirement,
    homeOf,
    openStep,
    pullReportDue,
    runEnding,
    runFacts,
    scrubReason,
    stepLeft,
    type RequirementClocks,
    type RequirementTime,
    type StepOutcome,
    type StepTime,
} from "./installTelemetry";
import { dockerReady, info } from "./machine";
import { pcGate, type PcGate } from "./pcSetup/pcGate";
import { activeRun, eventsOf, linesOf, running, runOutcome, start } from "./runs";
import { sleep, within } from "@intentic/base/async";

// A SANDBOX'S SETUP ON THIS MACHINE, handed over from the workspace's /setup page (`intentic://setup`, parked by the
// app for the main window, windows.rs `park_setup`). It runs on arrival, unasked: installing and signing in to run a
// sandbox here already is the consent; administrator is still asked, on the requirements card. It leads This device
// while it is here, and reports its progress back to the workspace's page (`setup_progress`), which shows the same bar.
// This computer's own sandbox, which folders attach to, is not one of these: the app makes it by itself
// (machineSandbox.ts, the app's machine_sandbox.rs), whichever window is open.

// Setup codes last 30 minutes (the platform's setup-code.ts). A setup resumed on one older than 20 asks for a fresh one
// first, since its claim is still minutes of Docker ahead of it; one that cannot be had (signed out, offline, refused)
// leaves the old code to run while it has 5 minutes left, and the card saying it ran out past that.
const RENEW_AFTER_SECONDS = 20 * 60;
const RESUME_WINDOW_SECONDS = 25 * 60;
// A park this old is not resumed at all, however fresh a code could be: the restart it waited for was cancelled or
// refused, and whatever the reader did since (the sandbox set up elsewhere, on a hosted machine, or given up on) is not
// for this app to overrule by installing Docker unasked and claiming the sandbox again. The longest real restart round
// trip measured was under two hours (PostHog, 2026-10-08).
const PARK_LIMIT_SECONDS = 6 * 60 * 60;
// An unanswered ask for a code is asked again this many times in all, this far apart: the first seconds after a sign-in
// often have no network yet.
const RENEW_ATTEMPTS = 3;
const RENEW_PAUSE_MS = 5_000;
// How long a command that said it failed may keep its setup alive before the setup is stopped for it.
const COMMAND_FAILURE_GRACE_MS = 2_000;

/** The setup handed over, and the one resumed after a restart. */
export const pending = ref<SetupArgs | undefined>(undefined);
export const setupError = ref<string | undefined>(undefined);
// Held rather than derived: a setup is a setup from arrival until it finishes or is closed.
const setupOpen = ref(false);
/** Per-requirement progress, keyed by id, fed by the installer's state markers; cleared with its list. */
export const requirementState = ref<Readonly<Record<string, RequirementProgress>>>({});
/** Where the running (or last) setup wrote its transcript. */
export const setupLog = ref<string | undefined>(undefined);
/** Held here, not in the card, so every verb about the transcript sits in one row (SetupProgress opens it on failure). */
export const setupLogOpen = ref(false);
/** A stop has been asked for: the exit it produces reads as an answer, not a failure. */
export const stopping = ref(false);
/**
 * Who asked for a stop: the card's own Stop, or the workspace's setup page taking the sandbox to a machine of ours
 * (`intentic://setup-stop`, `stopForHosted`).
 */
type StopReason = `card` | `hosted`;
// Why the run being stopped was, for its events and its ending: a run stopped for a machine of ours does not bring This
// device up over the page the reader is watching that machine start on.
let stopReason: StopReason | undefined;
// Exit code of the last setup, to tell a designed stop from something going wrong.
const setupExit = ref<number | null | undefined>(undefined);
const setupCommandFailure = ref<string | undefined>(undefined);
/** A user-ended run is neither failure nor success; it needs its own state or it shows nothing at all. */
export const wasStopped = computed(() => stopping.value && setupExit.value !== undefined);
/** Unmet requirements from `intentic-requirement:` lines; cleared at the start of each attempt. */
export const requirements = ref<Requirement[]>([]);
// True while the previous run's list stays up during re-examination; a new requirement clears it.
const carried = ref(false);
// Whether the reader answered the requirements list; about this run of the app, not the link.
const consented = ref(false);
/** A setup resumed after a Windows restart, and whether its code has gone stale. */
export const resuming = ref(false);
export const expired = ref(false);
/** Which way the session ended for it, so a sign-out that changed nothing is answered with a restart (Requirements.vue). */
export const resumedHow = ref<SessionEnd | undefined>(undefined);

/** A designed stop (desktop.ts) isn't a failure; one fact the bar and the card both read. */
export const awaitingConsent = computed(() => !running.value && requirements.value.length > 0 && expectedStop(setupExit.value ?? null));
// True once every requirement reports `done`, so an answered list stops being drawn as unanswered.
const requirementsSettled = computed(
    () => requirements.value.length > 0 && requirements.value.every((requirement) => requirementState.value[requirement.id]?.state === `done`),
);
/** A handed-over setup owns the top of This device until it hands back, failed included. */
export const setupMode = computed(() => setupOpen.value || activeRun.value === `setup`);
/** The one thing on screen to act on, while it is up: the plan behind it goes quiet rather than competing with it. */
export const requirementsShown = computed(() => requirements.value.length > 0 && !expired.value && !requirementsSettled.value);

// Install progress (setupPlan.ts): the plan is built before the script starts; `now` only exists so a silent step still
// visibly moves.
const progress = ref<Progress | undefined>(undefined);
const now = ref(Date.now());
export const progressShown = computed(() => (progress.value === undefined ? undefined : progressView(progress.value, now.value)));

// The window's shared seconds clock, followed only while a setup runs here. Detached: the setup is this window's, not
// any one component's. `run()` returns undefined only for a stopped scope; this one is never stopped.
const setupClock = effectScope(true).run(() => useNow(() => activeRun.value === `setup`))!;
watch(setupClock, (at) => {
    if (activeRun.value !== `setup`) {
        return;
    }
    now.value = at;
    if (progress.value !== undefined) {
        progress.value = tick(progress.value, at);
        reportPull(progress.value, at);
    }
});

/* A COMMAND THAT SAID IT FAILED cannot leave its setup alive indefinitely. */
let commandFailureTimer: ReturnType<typeof setTimeout> | undefined;
const clearCommandFailureTimer = (): void => {
    clearTimeout(commandFailureTimer);
    commandFailureTimer = undefined;
};
const stopStuckInstaller = async (reason: string): Promise<void> => {
    commandFailureTimer = undefined;
    if (activeRun.value !== `setup` || setupCommandFailure.value !== reason) {
        return;
    }
    try {
        await runStop(`setup`);
    } catch (error) {
        setupError.value = `${reason}\n${t(`desktop.setup.stuckInstallerNotStopped`, { error: String(error) })}`;
    }
};
const reportCommandFailure = (reason: string): void => {
    setupCommandFailure.value = reason;
    setupError.value = reason;
    clearCommandFailureTimer();
    commandFailureTimer = setTimeout(() => void stopStuckInstaller(reason), COMMAND_FAILURE_GRACE_MS);
};

/* The sandbox name is copied into every report that carries one. */
const nameOf = (args: SetupArgs | undefined): { name?: string } => (args?.name === undefined ? {} : { name: args.name });

// Built from two directions (the run's start, and the Docker probe landing later), since its one conditional step
// depends on that answer. Optimistic while unknown: a missing Docker step corrects itself when the probe answers.
const planFor = (args: SetupArgs): readonly PlanStep[] =>
    setupPlan({
        dockerReady: dockerReady.value ?? true,
        syncing: (args.syncDir ?? ``) !== ``,
        os: info.value?.os ?? ``,
    });

/** The Docker probe answered: a plan nobody has started following yet is drawn again with the answer. */
export const replanForDocker = (): void => {
    if (pending.value !== undefined && progress.value !== undefined && progress.value.index === -1) {
        progress.value = startProgress(planFor(pending.value), progress.value.startedAt, progress.value.floor);
    }
};

// The highest a re-run's bar starts from: an attempt that got far and then stopped still has its last steps to do.
const HIGHEST_FLOOR = 90;
// Which setup the bar on screen belongs to, by its code: a re-run of the same one starts where the last attempt left
// the bar, and a new link starts from nothing.
let barFor: string | undefined;
const floorFor = (args: SetupArgs): number => {
    const floor = barFor === args.code && progress.value !== undefined ? Math.min(progress.value.percent, HIGHEST_FLOOR) : 0;
    barFor = args.code;
    return floor;
};

/* WHERE THE TIME GOES (installTelemetry.ts): every step the plan's cursor leaves, every requirement row that finishes,
   and at the run's end the step and rows it ended under. One event per step actually entered. */

// What each of this attempt's events says about the run it belongs to, fixed at its start.
let attemptFacts: { resumed: boolean; dockerReady: boolean | null } = { resumed: false, dockerReady: null };
// This attempt's requirement rows that are running, by id.
let clocks: RequirementClocks = {};
// When the run's exit was heard: what the step and rows still open at the end are timed to, rather than to the moment
// its command returned, which comes after the app's own bookkeeping for a finished setup.
let exitHeardAt: number | undefined;

const reportStep = (time: StepTime, outcome: StepOutcome): void => {
    track(`desktop_install_step`, { ...time, outcome, ...attemptFacts });
};

// A pull runs for minutes with no step to leave: where it has got to, every 30 seconds while it runs (installTelemetry.ts
// `pullReportDue`), is what says whether a slow one was the network, and how slow.
let pullSentAt: number | undefined;
const reportPull = (state: Progress, at: number): void => {
    if (!pullReportDue(state, pullSentAt, at)) {
        return;
    }
    pullSentAt = at;
    track(`desktop_install_progress`, { ...runFacts(state, progressView(state, at), at), ...attemptFacts });
};

const reportRequirement = (time: RequirementTime): void => {
    track(`desktop_install_requirement`, { ...time, resumed: attemptFacts.resumed });
};

// The run ended: the step it ended on, and every row still running, ended the way it did.
const reportEnding = (ok: boolean): void => {
    const at = exitHeardAt ?? Date.now();
    const ending = runEnding({ ok, code: setupExit.value, stopped: stopping.value });
    const last = progress.value === undefined ? undefined : openStep(progress.value, at);
    if (last !== undefined) {
        reportStep(last, ending);
    }
    for (const row of endRequirements(clocks, ending, at)) {
        reportRequirement(row);
    }
    clocks = {};
};

// A fresh attempt: the previous list stays on screen through a re-run rather than being cleared, so items the reader
// just agreed to don't vanish while the installer re-examines the machine. Its first new requirement replaces it.
const beginAttempt = (args: SetupArgs, startedAt: number): void => {
    carried.value = requirements.value.length > 0;
    requirementState.value = {};
    setupExit.value = undefined;
    setupError.value = undefined;
    setupCommandFailure.value = undefined;
    clearCommandFailureTimer();
    stopping.value = false;
    stopReason = undefined;
    expired.value = false;
    progress.value = startProgress(planFor(args), startedAt, floorFor(args));
    now.value = startedAt;
    // Unknown stays unknown (the probe may not have answered yet), as desktop_install_started reports it.
    attemptFacts = { resumed: resuming.value, dockerReady: dockerReady.value ?? null };
    clocks = {};
    exitHeardAt = undefined;
    pullSentAt = undefined;
};

/**
 * What started a run, for the funnel: the app on a link's arrival or after a restart, or which of the reader's presses
 * (the requirements card's go-ahead or its "Check again", a stopped run's "Try again"), or the app again on a fresh code
 * after the platform refused the last one at the claim. A run that stops on a question and a reader who presses again
 * look the same from the outcome alone.
 */
export type InstallTrigger = `arrival` | `resume` | `consent` | `recheck` | `retry` | `renewed` | `pcReady`;

/* A SETUP HANDED OVER BEFORE THIS PC IS READY (pcSetup/pcGate.ts) is parked until this PC's own setup is done, the card offering
   that setup, and then carries on by itself. Before, it silently did nothing: the card had only "Back" and "Dismiss",
   and the workspace page waited on a run that never started (2026-10-12). */

/** Parked for this PC's own setup (Docker/WSL, onboarding.rs): the workspace page hears `waitingFor: "pcSetup"`. */
export const pcParked = ref(false);
// Onboarding's own reading of this PC (onboarding/pc.ts, as the Agents page follows it), from the first park on: its
// check for the card, and this PC's setup as it runs. Shallow: their fields are refs of their own.
interface PcFollowed {
    readonly host: PcParts;
    readonly setup: Readonly<Ref<OnboardingSetup>>;
}
const pcFollowed = shallowRef<PcFollowed | undefined>(undefined);
const followPc = (): PcFollowed => (pcFollowed.value ??= { host: pcParts(), setup: followPcSetup() });
/** The PC check while parked: what the card says this PC needs. */
export const pcCheck = computed(() => pcFollowed.value?.host.check.value);
/** This PC's own setup while parked: started, running, waiting on Windows, or stopped. */
export const pcSetup = computed(() => pcFollowed.value?.setup.value);
/** A press on the card that the app refused (a restart Windows would not do), in its own words. */
export const pcError = ref<string | undefined>(undefined);
// The park's watch on the gate, and its slow Docker probe, both stopped when the setup runs or is given up; and whether
// the gate has opened and the run is on its way, so a gate that opens twice runs it once.
let pcWatch: WatchStopHandle | undefined;
let pcProbe: ReturnType<typeof setInterval> | undefined;
let carrying = false;

// How long a setup waits for this PC's check before it parks rather than keep the page waiting on nothing: the check runs
// at launch, and usually answers in seconds. A park while it runs says "checking" on the card and carries on when it has.
const CHECK_QUICK_MS = 2_000;
// While parked, Docker is asked again this often: someone who installs Docker Desktop by hand meanwhile (2026-10-12) is
// picked up without a press.
const PARKED_PROBE_MS = 30_000;

// The app's own OS, which the window reads before it takes any work (useDevice.ts); asked here only if it has not.
const osOf = async (): Promise<string | undefined> =>
    info.value?.os ??
    (await desktopInfo().then(
        (answer) => answer?.os,
        () => undefined,
    ));

/**
 * The gate as it stands. The check is onboarding's own answer (`currentPcCheck`), never its silence: a check that has
 * not answered within CHECK_QUICK_MS is a park, never a go-ahead (pcSetup/pcGate.ts). Off Windows nothing is asked.
 */
const gateNow = async (): Promise<PcGate> => {
    const os = await osOf();
    if (os !== `windows` || dockerReady.value === true) {
        return `go`;
    }
    let check: OnboardingCheck | undefined;
    try {
        check = await within(currentPcCheck(), CHECK_QUICK_MS, undefined);
    } catch {
        // allow(silent-catch): the app cannot be asked about this PC at all, so the setup run's own prepare goes ahead,
        // as before the one setup path, and that run reports its own failures on the requirements card.
        return `go`;
    }
    return pcGate({ os, dockerReady: dockerReady.value, check: check?.state, pcSetup: followPcSetup().value.state });
};

// Docker asked again: a probe made at launch says nothing about a Docker installed by hand since.
const probeDocker = async (): Promise<void> => {
    try {
        dockerReady.value = await dockerReadyProbe();
    } catch (error) {
        console.error(`[setup] Docker could not be asked:`, error);
    }
};

// Onboarding's check asked again; its answer arrives through onboarding's own events, which the park follows.
const recheckPc = async (host: PcParts): Promise<void> => {
    try {
        await host.recheck();
    } catch (error) {
        console.error(`[setup] this PC could not be checked again:`, error);
    }
};

const saveParked = async (args: SetupArgs): Promise<void> => {
    try {
        await parkSetupForPc(args);
    } catch (error) {
        console.error(`[setup] the parked setup could not be saved:`, error);
    }
};

const unpark = (): void => {
    pcParked.value = false;
    pcError.value = undefined;
    pcWatch?.();
    pcWatch = undefined;
    clearInterval(pcProbe);
    pcProbe = undefined;
};

// Parked: saved so a restart this PC's setup asks for brings it back (commands.rs `park_setup_for_pc`), and followed
// until the gate opens: this PC's setup finishing, its check saying ready, or Docker answering. A newer setup handed over
// meanwhile takes the old one's place, on disk too.
const parkForPc = (args: SetupArgs, gate: PcGate, trigger: InstallTrigger): void => {
    void saveParked(args);
    if (pcParked.value) {
        return;
    }
    pcParked.value = true;
    track(`desktop_install_pc_setup`, { action: `parked`, gate, trigger, dockerReady: dockerReady.value ?? null });
    const { host, setup } = followPc();
    // A check made before Docker was installed by hand still says it is needed, and so does a launch's Docker probe:
    // both are asked again, once, unless this PC's setup is under way; Docker again every PARKED_PROBE_MS.
    void probeDocker();
    pcProbe = setInterval(() => void probeDocker(), PARKED_PROBE_MS);
    if (gate === `needsSetup` && setup.value.state !== `running`) {
        void recheckPc(host);
    }
    pcWatch = watch(
        () => pcGate({ os: `windows`, dockerReady: dockerReady.value, check: host.check.value?.state, pcSetup: setup.value.state }),
        (open) => {
            if (open === `go`) {
                void carryOn();
            }
        },
    );
    // A check still running when the setup arrived: its answer decides, the moment it has one.
    if (gate === `checking`) {
        void afterCheck();
    }
};

// The check answered, however long it took (onboarding.rs bounds it at two minutes): the gate is read again.
const afterCheck = async (): Promise<void> => {
    try {
        await currentPcCheck();
    } catch (error) {
        console.error(`[setup] this PC's check could not be read:`, error);
        return;
    }
    await carryOn();
};

// The gate may have opened: the parked setup runs again through the gate, once whatever else this window runs has ended.
// It stays parked until the run itself has read the gate open (`runSetup`), so the workspace's strip goes from waiting
// to running with nothing between, and a gate still shut parks it again with nothing said twice.
const carryOn = async (): Promise<void> => {
    if (!pcParked.value || carrying) {
        return;
    }
    carrying = true;
    try {
        while (running.value) {
            await sleep(RENEW_PAUSE_MS);
        }
        await runSetup(`pcReady`);
        if (!pcParked.value) {
            track(`desktop_install_pc_setup`, { action: `continued` });
        }
    } finally {
        carrying = false;
    }
};

/** The card's "Set up this PC": the Agents page's own press (onboarding/pc.ts `setUpThisPc`), which it follows itself. */
export const setUpThisPc = async (from: `card` | `consent` = `card`): Promise<void> => {
    followPc();
    pcError.value = undefined;
    track(`desktop_install_pc_setup`, { action: `pressed`, from });
    try {
        await startPcSetup(`device`);
    } catch (error) {
        // How it stopped is its own state (`pcSetup`), which the card draws; a press refused outright is said here.
        pcError.value = String(error);
    }
};

/** "Installed Docker yourself? Check again": the PC check and the Docker probe asked again. */
export const recheckThisPc = async (): Promise<void> => {
    track(`desktop_install_pc_setup`, { action: `recheck` });
    const { host } = followPc();
    await Promise.all([probeDocker(), recheckPc(host)]);
};

/** This PC's setup waits for a restart: restart now, the setup saved to carry on afterwards. */
export const restartThisPc = async (): Promise<void> => {
    const { host } = followPc();
    track(`desktop_install_pc_setup`, { action: `restart` });
    pcError.value = undefined;
    try {
        await host.restart(`now`);
    } catch (error) {
        pcError.value = String(error);
    }
};

/** A fresh code is being asked for: up to a minute and a half with no run active. */
const renewing = ref(false);
/** What a reader's own press starts, as against what the app starts by itself. */
const READER_PRESSES: ReadonlySet<InstallTrigger> = new Set([`consent`, `recheck`, `retry`]);

export const runSetup = async (trigger: InstallTrigger = `retry`): Promise<void> => {
    const args = pending.value;
    // While a fresh code is being asked for, no run is active yet, and a reader's press would run the setup on the old
    // code ahead of it: the press waits for the renewal's own run instead.
    if (args === undefined || running.value || (renewing.value && READER_PRESSES.has(trigger))) {
        return;
    }
    const gate = await gateNow();
    if (gate !== `go`) {
        parkForPc(args, gate, trigger);
        return;
    }
    if (pcParked.value) {
        unpark();
    }
    const startedAt = Date.now();
    beginAttempt(args, startedAt);
    track(`desktop_install_started`, {
        trigger,
        dockerReady: dockerReady.value ?? null,
        sync: (args.syncDir ?? ``) !== ``,
        consented: consented.value,
        resumed: resuming.value,
        // Where the bar starts: a re-run picks up from the last attempt's position rather than from nothing.
        fromPercent: Math.round(progress.value?.percent ?? 0),
    });
    const failure = await start(`setup`, () => setupRun(args, consented.value));
    await settleSetup(args, failure, startedAt);
};

// The requirements as the funnel hears them: ids, what each asks of the reader, and how far each row got, never their
// words (a requirement's sentences name the Windows account).
const requirementFacts = (): Record<string, unknown> => {
    const listed = requirements.value;
    if (listed.length === 0) {
        return {};
    }
    return {
        requirements: listed.map((requirement) => requirement.id),
        requirementActions: Object.fromEntries(listed.map((requirement) => [requirement.id, requirement.action])),
        requirementStates: Object.fromEntries(listed.map((requirement) => [requirement.id, requirementState.value[requirement.id]?.state ?? `pending`])),
    };
};

// Why a run failed, in its own words: the requirement row that failed and what it said, else the run's last error line;
// scrubbed of the home folder, the account, any address and the code (installTelemetry.ts `scrubReason`).
const reasonOf = (args: SetupArgs): string | undefined => {
    const failed = Object.values(requirementState.value).findLast((row) => row.state === `failed` && row.detail !== undefined);
    const said = failed?.detail ?? failureLine(eventsOf(`setup`));
    const reason = said === undefined ? `` : scrubReason(said, { home: homeOf(setupLog.value), code: args.code });
    return reason === `` ? undefined : reason;
};

// What the funnel hears of a finished run: its outcome, the requirements it stopped on, and why, when it failed. A
// designed stop (a question, a restart) and a reader's own Stop are not failures, and carry no reason.
const reportFinished = (args: SetupArgs, ok: boolean, startedAt: number): void => {
    const failed = !ok && !stopping.value && !expectedStop(setupExit.value ?? null);
    const reason = failed ? reasonOf(args) : undefined;
    // A stopped run says who stopped it: the card's Stop, or a machine of ours taking the sandbox over.
    const stopped = !ok && stopping.value && stopReason !== undefined ? { stopped: stopReason } : {};
    track(`desktop_install_finished`, {
        ...runOutcome(`setup`, ok, startedAt),
        ...requirementFacts(),
        ...(reason === undefined ? {} : { reason }),
        ...stopped,
    });
};

// A designed stop (desktop.ts) carries no error text, since the requirements list is the message; a stop nobody asked
// for isn't a failure either. If the list itself failed to arrive, the raw failure shows instead of nothing.
const failureOf = (failure: string | undefined): string | undefined => {
    const deferredToTheList = expectedStop(setupExit.value ?? null) && requirements.value.length > 0;
    return failure === undefined || stopping.value || deferredToTheList ? undefined : (setupCommandFailure.value ?? failure);
};

/* A completed run reports its outcome separately from its live state. */
const settleSetup = async (args: SetupArgs, failure: string | undefined, startedAt: number): Promise<void> => {
    const ok = failure === undefined;
    // This run passed the examination; a stale list here would describe a different failure.
    if (carried.value) {
        requirements.value = [];
        carried.value = false;
    }
    setupError.value = failureOf(failure);
    reportEnding(ok);
    reportFinished(args, ok, startedAt);
    if (!ok) {
        // A code the platform no longer takes is swapped for a fresh one and the run goes again on it; the card says the
        // code ran out only when no fresh one could be had.
        if (!stopping.value && claimExpired(linesOf(`setup`)) && (await rerunOnFreshCode(args))) {
            return;
        }
        // Stopped because the setup page took this sandbox to a machine of ours: the reader is on that page, watching it
        // start, and This device swapped in over it would take them off it.
        // Its card goes with it: the sandbox is the machine's now, and the card's "Try again" would set it up on this PC
        // as well. The page hears `stopped` first, so its button is handed back if the machine of ours falls through.
        if (stopping.value && stopReason === `hosted`) {
            tell({ ...nameOf(args), state: `stopped`, percent: Math.round(progress.value?.percent ?? 0) });
            pending.value = undefined;
            setupOpen.value = false;
            tell({ ...nameOf(args), state: `closed`, percent: 0 });
            return;
        }
        // The main window is never topmost, so a run that stops while it is hidden would otherwise go unnoticed;
        // `setupAlert` brings it back to the front, in the workspace's place rather than beside it.
        await setupAlert();
        return;
    }
    // The last word the workspace page hears about this run, sent while there is still a setup to report on: the page
    // draws nothing for it (the workspace is about to open), and a strip left saying "97%" is what a later setup would
    // open on for its first second.
    tell({ ...nameOf(args), state: `done`, percent: 100 });
    pending.value = undefined;
    setupOpen.value = false;
    // Brings the workspace back without navigating it: the page waiting on `/setup` opens the workspace by itself the
    // moment the sandbox reports in (useRegistryWatch.ts), usually before this run's last checks end.
    await workspaceOpen();
};

/** `stopping` is set before the kill so the exit code it produces reads as an answer, not a failure. */
const stopRun = async (reason: StopReason): Promise<void> => {
    if (!running.value) {
        return;
    }
    stopping.value = true;
    stopReason = reason;
    track(`desktop_install_stopped`, { percent: Math.round(progress.value?.percent ?? 0), reason });
    try {
        await runStop(`setup`);
    } catch (error) {
        stopping.value = false;
        stopReason = undefined;
        setupError.value = String(error);
    }
};

/** The card's Stop. Takes no argument: the press hands its handler the click. */
export const stopSetup = (): Promise<void> => stopRun(`card`);

/* THE SANDBOX TAKEN TO A MACHINE OF OURS (2026-10-12). The setup page offers a machine of ours beside a download too slow
   to wait for, and the reader who took it left this PC downloading two gigabytes for the same sandbox. The machine of
   ours adopts the sandbox's address, so that download ended in an announce the platform refused, and a failed setup on a
   row that was by then hosted. The page now says so to the app (`intentic://setup-stop`, windows.rs) before it starts
   the machine, and the run stops as the card's Stop stops it: told as `stopped`, never as a failure. The run's mark
   (scripts.rs `RunMark`) goes as for any run followed to its end, once the stopped run has exited (commands.rs
   `setup_run`). */

/** Stop the install this window runs for `sandboxId`; a request for another sandbox, or with no install running, does nothing. */
export const stopForHosted = async (sandboxId: string): Promise<void> => {
    if (activeRun.value !== `setup` || stopping.value || pending.value?.sandboxId !== sandboxId) {
        return;
    }
    await stopRun(`hosted`);
};

/**
 * The app is quitting with this window's setup running (windows.rs `quit_now`, which stops the run and waits a moment
 * for this): where the run was left, sent before the app goes. True when there was a run here to say it about.
 */
export const abandonOnQuit = async (): Promise<boolean> => {
    const state = progress.value;
    if (activeRun.value !== `setup` || state === undefined) {
        return false;
    }
    const at = Date.now();
    // Awaited, unlike other events here, and capped (analytics.ts): the next thing that happens is the process ending.
    await trackBeforeExit(`desktop_install_abandoned`, { ...runFacts(state, progressView(state, at), at), ...attemptFacts });
    return true;
};

/** Puts the transcript on the clipboard: what someone stuck actually needs to hand over. */
const logCopy = useCopied();
export const logCopied = logCopy.copied;
export const copyLog = async (): Promise<void> => {
    track(`desktop_install_log`, { action: `copied`, ...whereLeft() });
    const text = eventsOf(`setup`)
        .flatMap((event) => (event.kind === `line` ? [`${event.stream === `stderr` ? `! ` : ``}${event.text}`] : []))
        .join(`\n`);
    // A refused write leaves the flag down rather than rejecting into nothing; the log folder is the other way out.
    await logCopy.copy(text);
};

export const openLogFolder = async (): Promise<void> => {
    if (setupLog.value !== undefined) {
        track(`desktop_install_log`, { action: `folder`, ...whereLeft() });
        await revealLog(setupLog.value);
    }
};

// The card off the page, and the workspace's strip told so. A live run keeps it, and so does a setup parked for this PC's
// own setup: both are still going, and the workspace's strip goes on hearing from them.
const putAway = (): void => {
    if (running.value || pcParked.value) {
        return;
    }
    setupOpen.value = false;
    tell({ ...nameOf(pending.value), state: `closed`, percent: 0 });
};

/**
 * A finished or failed setup's card dismissed by the reader: on a question still open, the likeliest place to leave. A
 * setup parked for this PC's own setup is given up on here, the one press that does that: it no longer carries on by
 * itself, and no restart brings it back.
 */
export const closeSetup = (): void => {
    if (running.value) {
        return;
    }
    track(`desktop_install_closed`, { state: setupState.value, ...whereLeft(), ...requirementFacts() });
    if (pcParked.value) {
        unpark();
        void forgetResumableSetup();
    }
    putAway();
};

/** The transcript shown or hidden: someone stuck reading what the setup said. */
export const toggleSetupLog = (): void => {
    setupLogOpen.value = !setupLogOpen.value;
    if (setupLogOpen.value) {
        track(`desktop_install_log`, { action: `shown`, running: running.value, ...whereLeft() });
    }
};

/** Where the reader left a run when they went back: its phase and the bar's position; nothing about the machine. */
interface WhereLeft {
    readonly percent?: number;
    readonly elapsedMs?: number;
    readonly step?: string;
}

const whereLeft = (): WhereLeft => {
    const state = progress.value;
    if (state === undefined) {
        return {};
    }
    const at = { percent: Math.round(state.percent), elapsedMs: Date.now() - state.startedAt };
    const step = state.plan[state.index]?.phase;
    return step === undefined ? at : { ...at, step };
};

/** The way back to the workspace the setup came from. It stops nothing: the script keeps running and reports its end. */
export const backToWorkspace = async (): Promise<void> => {
    // A dismissal after the run ended is just closing a finished or failed card, not the same event.
    track(`desktop_install_dismissed`, { running: running.value, ...whereLeft() });
    /* A live run keeps its card so a later failure can come back to it. */
    putAway();
    await workspaceOpen();
};

/* THE WORKSPACE PAGE HEARS THE SETUP'S PROGRESS after every change. */
export const setupState = computed<SetupReport[`state`]>(() => {
    if (running.value) {
        return `running`;
    }
    if (pcParked.value) {
        return `waiting`;
    }
    // A requirements card is a question on this page whichever exit code put it there, and the workspace's strip should
    // say so rather than "stopped" (which reads as broken) beside a button that opens it.
    if (awaitingConsent.value || requirementsShown.value) {
        return `waiting`;
    }
    if (wasStopped.value) {
        return `stopped`;
    }
    return progress.value?.ended === `ok` ? `done` : `failed`;
});
const report = computed((): SetupReport | undefined => {
    if (setupMode.value && pcParked.value && !running.value) {
        // No run, so no plan to report from: where the bar stood, and what it waits for.
        return { ...nameOf(pending.value), state: `waiting`, percent: Math.round(progress.value?.percent ?? 0), waitingFor: `pcSetup` };
    }
    const view = progressShown.value;
    const state = progress.value;
    if (!setupMode.value || view === undefined || state === undefined) {
        return undefined;
    }
    const told: SetupReport = { ...nameOf(pending.value), state: setupState.value, percent: Math.round(view.percent) };
    if (view.position !== undefined) {
        told.position = view.position;
    }
    if (view.remaining !== undefined) {
        told.remaining = view.remaining;
    }
    if (view.remainingMs !== undefined) {
        told.remainingSeconds = Math.round(view.remainingMs / 1000);
    }
    if (view.download !== undefined) {
        told.downloaded = view.download.done;
        told.downloadTotal = view.download.total;
    }
    const step = state.plan[state.index]?.phase;
    if (step !== undefined) {
        told.step = step;
    }
    if (told.state === `waiting`) {
        told.waitingFor = waitingFor.value;
        told.requirements = requirements.value.map((requirement) => requirement.id);
    }
    return told;
});

// What the card's question asks, in the terms the workspace page words it in: a restart (or a sign-out the last
// sign-out did not settle, which the card answers with a restart too, Requirements.vue), a sign-out, or a go-ahead.
export const waitingFor = computed((): SetupWaitingFor => {
    const actions = new Set(requirements.value.map((requirement) => requirement.action));
    if (actions.has(`restart`) || (actions.has(`signOut`) && resumedHow.value === `signout`)) {
        return `restart`;
    }
    return actions.has(`signOut`) ? `signOut` : `consent`;
});

/** Whether this PC is waiting for Windows to end the session (a restart or a sign-out) before Docker can run. */
export const sessionEndAwaited = computed(() => waitingFor.value !== `consent` && requirements.value.length > 0 && !running.value);

// The card's question as the funnel sees it, once per distinct list: which rows, what each asks, how far each got.
watch(
    () => (requirementsShown.value ? requirements.value.map((requirement) => `${requirement.id}:${requirement.action}`).join(`,`) : ``),
    (shown) => {
        if (shown !== ``) {
            track(`desktop_requirements_shown`, { waitingFor: waitingFor.value, resumedFrom: resumedHow.value ?? null, ...requirementFacts() });
        }
    },
);
/* THE HEARTBEAT (2026-10-12). The page took ten seconds without a report for an app that was gone, and the app sent one
   only when something in it changed: a pull whose bar sat still for minutes went quiet, and the page told the reader to
   start the app again, which started a second install beside the first. Every report now says when it was sent (`at`),
   and while the setup runs or waits it is sent again every HEARTBEAT_MS whether or not anything changed, so silence
   means the app is gone and nothing else does. This window is hidden whenever the workspace holds the frame, where its
   timers slow to one a minute, so the app also repeats the last report itself in this window's silence (windows.rs
   `keep_heartbeat`). */
const HEARTBEAT_MS = 4_000;

// Stamped as it goes: `at` is when the app sent it, never part of what makes two reports different.
const tell = (told: SetupReport): void => {
    void setupProgress({ ...told, at: Date.now() });
};

watch(
    () => JSON.stringify(report.value),
    () => {
        if (report.value !== undefined) {
            tell(report.value);
        }
    },
);

let heartbeat: ReturnType<typeof setInterval> | undefined;
watch(
    () => report.value?.state === `running` || report.value?.state === `waiting`,
    (live) => {
        clearInterval(heartbeat);
        heartbeat = live
            ? setInterval(() => {
                  if (report.value !== undefined) {
                      tell(report.value);
                  }
              }, HEARTBEAT_MS)
            : undefined;
    },
);

/* THE WAY OUT THAT IS NOT "GIVE UP": offered by a machine that cannot meet the requirements, and by one that met them
   all and then stopped anyway. Both are the same question: run this sandbox somewhere else. */
export const setUpElsewhere = async (from: `requirements` | `stopped`): Promise<void> => {
    track(`desktop_install_elsewhere`, { from, requirements: requirements.value.map((requirement) => requirement.id) });
    if (pcParked.value) {
        unpark();
        void forgetResumableSetup();
    }
    setupOpen.value = false;
    // The sandbox runs elsewhere now: the restart or sign-out this PC was waiting for is nobody's next step any more.
    requirements.value = [];
    // `elsewhere=1` is what stops /setup acting on arrival: the hosted rung is preselected, and it is the reader's click
    // on it that spends their allowance, never this handover. `sandbox` names the row this install was for.
    const query = new URLSearchParams({ elsewhere: `1`, machine: `hosted` });
    const sandboxId = pending.value?.sandboxId;
    if (sandboxId !== undefined && sandboxId !== ``) {
        query.set(`sandbox`, sandboxId);
    }
    await workspaceOpen(`/setup?${query.toString()}`);
};

/**
 * The reader's go-ahead after the first pass reported what it would change: the terminal path's typed "y". On a PC
 * whose own setup comes first, the go-ahead is for that: it starts, and the setup carries on once it is done.
 */
export const installRequirements = async (): Promise<void> => {
    consented.value = true;
    await runSetup(`consent`);
    if (pcParked.value && pcSetup.value?.state !== `running`) {
        void setUpThisPc(`consent`);
    }
};

/** Restart and sign-out are one verb, both applied by Windows between sessions; the setup is saved to disk first. */
export const endSession = async (how: `restart` | `signout`): Promise<void> => {
    const args = pending.value;
    if (args === undefined || running.value) {
        return;
    }
    // Awaited, unlike other events here: the next line ends the session, losing anything still in flight.
    await trackBeforeExit(`desktop_install_restart`, { how, requirements: requirements.value.map((requirement) => requirement.id) });
    try {
        await (how === `restart` ? restartForSetup(args) : signOutForSetup(args));
    } catch (error) {
        // Neither path gets a second chance to explain itself, so a refusal is shown rather than silently doing nothing.
        setupError.value = String(error);
    }
};

/* A FRESH CODE FOR THE SAME SANDBOX, minted by the app with the workspace's session (commands.rs `setup_fresh_code`):
   for a setup resumed on an old code, and for a run whose claim the platform refused as invalid or expired. */

// The answer, asked again while the platform cannot be reached at all.
const askForCode = async (args: SetupArgs, attempt = 1): Promise<FreshCode | null> => {
    const answer = await freshSetupCode(args).catch((error: unknown): FreshCode => ({ kind: `unreached`, reason: String(error) }));
    if (answer?.kind !== `unreached` || attempt >= RENEW_ATTEMPTS) {
        return answer;
    }
    await sleep(RENEW_PAUSE_MS);
    return askForCode(args, attempt + 1);
};

/** The same setup on a code the platform hands out now, or undefined when none could be had. */
const renewCode = async (args: SetupArgs, from: `resume` | `claim`): Promise<SetupArgs | undefined> => {
    renewing.value = true;
    const answer = await askForCode(args).finally(() => {
        renewing.value = false;
    });
    const renewed = answer?.kind === `code` ? answer.args : undefined;
    track(`desktop_install_code_renewed`, { from, answer: answer?.kind ?? `none`, fresh: renewed !== undefined && renewed.code !== args.code });
    // The bar a re-run of this setup starts from is the same setup's, whatever its code is now called.
    if (renewed !== undefined && barFor === args.code) {
        barFor = renewed.code;
    }
    return renewed;
};

// Codes minted here after a refused claim: one refused in turn is a failure to show, never a reason to mint again.
const renewedAfterClaim = new Set<string>();

/** The platform refused the code at the claim: the same sandbox runs again on a fresh one, once. False when it does not. */
const rerunOnFreshCode = async (args: SetupArgs): Promise<boolean> => {
    if (renewedAfterClaim.has(args.code)) {
        return false;
    }
    const renewed = await renewCode(args, `claim`);
    if (renewed === undefined || renewed.code === args.code) {
        // No fresh code to be had here (signed out, offline, refused): the card's own way to one.
        expired.value = true;
        return false;
    }
    renewedAfterClaim.add(renewed.code);
    pending.value = renewed;
    await runSetup(`renewed`);
    return true;
};

/** The setup a Windows restart interrupted, run again unasked, on a fresh code when its own is getting old. */
export const loadResumable = async (): Promise<void> => {
    const parked = await resumableSetup();
    if (parked === null) {
        return;
    }
    if (parked.agedSeconds > PARK_LIMIT_SECONDS) {
        await forgetResumableSetup();
        pending.value = parked.args;
        setupOpen.value = true;
        expired.value = true;
        track(`desktop_install_resume_expired`, { agedSeconds: parked.agedSeconds, codeAgeSeconds: parked.codeAgeSeconds, tooOld: true });
        return;
    }
    pending.value = parked.args;
    setupOpen.value = true;
    resumedHow.value = parked.how;
    const renewed = parked.codeAgeSeconds > RENEW_AFTER_SECONDS ? await renewCode(parked.args, `resume`) : undefined;
    // A link that arrived while the code was being renewed is newer than this park, and is already this window's setup.
    // Compared by code: the ref hands back a reactive proxy of what it was given, never the object itself.
    if (pending.value?.code !== parked.args.code || running.value) {
        return;
    }
    if (renewed === undefined && parked.codeAgeSeconds > RESUME_WINDOW_SECONDS) {
        await forgetResumableSetup();
        expired.value = true;
        track(`desktop_install_resume_expired`, { agedSeconds: parked.agedSeconds, codeAgeSeconds: parked.codeAgeSeconds });
        return;
    }
    if (renewed !== undefined) {
        pending.value = renewed;
    }
    resuming.value = true;
    // Already agreed to before the restart this app performed on that answer; not asked again.
    consented.value = true;
    track(`desktop_install_resumed`, { agedSeconds: parked.agedSeconds, codeAgeSeconds: parked.codeAgeSeconds, renewed: renewed !== undefined });
    await runSetup(`resume`);
};

/** The way on from a code that ran out: the setup page mints a fresh one and, inside this app, hands it straight back. */
export const freshCode = async (): Promise<void> => {
    track(`desktop_install_fresh_code`, {});
    await workspaceOpen(`/setup`);
};

/** The setup the app parked for this window, taken (never read: two callers race for it) and run on arrival. */
export const loadPending = async (): Promise<void> => {
    const taken = await takePendingSetup();
    if (taken === null) {
        return;
    }
    pending.value = taken;
    setupOpen.value = true;
    // A fresh link is a fresh conversation: nothing about an earlier session's ending applies to it.
    resumedHow.value = undefined;
    expired.value = false;
    // Parked rather than run when this PC's own setup comes first (`gateNow`).
    await runSetup(`arrival`);
};

/* THE SETUP'S OWN RUN, as its events arrive (useDevice.ts hands every event of `setup` here first). */

// What this device still needs, keyed by id, as the installer reports it: the first requirement of a new run replaces
// the last run's list, and keying by id collapses a duplicate. Live per-requirement progress is what makes the list a
// checklist rather than one frozen spinner.
const takeMarker = (marker: RunMarker): void => {
    if (marker.kind === `requirement`) {
        const kept = carried.value ? [] : requirements.value.filter((seen) => seen.id !== marker.requirement.id);
        carried.value = false;
        requirements.value = [...kept, marker.requirement];
        return;
    }
    const folded = foldRequirement(clocks, marker.state, Date.now());
    clocks = folded.clocks;
    if (folded.finished !== undefined) {
        reportRequirement(folded.finished);
    }
    requirementState.value = { ...requirementState.value, [marker.state.id]: marker.state };
};

// A step heard after a command said it failed: the setup went on after all, so the failure is not its last word.
const stepHeard = (text: string): void => {
    if (parseStep(text) !== undefined && setupCommandFailure.value !== undefined) {
        clearCommandFailureTimer();
        setupCommandFailure.value = undefined;
        setupError.value = undefined;
    }
};

// The run's start (its transcript's path) and its end (the exit code that tells a designed stop from a failure).
const boundaryHeard = (event: RunEvent): void => {
    if (event.kind === `started`) {
        setupLog.value = event.log ?? undefined;
    }
    if (event.kind === `exit`) {
        clearCommandFailureTimer();
        setupExit.value = event.code;
        exitHeardAt = Date.now();
    }
};

/**
 * One event of the setup's run. Its markers (`intentic-requirement:` lines) are protocol for this page, not output: they
 * are taken here and the answer is true, so the caller keeps them out of the log pane. The transcript on disk
 * (scripts.rs) still records every byte.
 */
export const takeSetupEvent = (event: RunEvent): boolean => {
    // Another window's setup (every window hears every run): its lines are kept as any run's, and its requirements are
    // that window's question, never a card here for a setup this window cannot answer for.
    if (pending.value === undefined && progress.value === undefined) {
        return false;
    }
    const failure = parseCommandFailure(event);
    if (failure !== undefined) {
        reportCommandFailure(failure);
    }
    // Folded as each event arrives, since the plan needs to know when each phase started.
    if (progress.value !== undefined) {
        now.value = Date.now();
        const before = progress.value;
        progress.value = advance(before, event, now.value);
        const left = stepLeft(before, progress.value, now.value);
        if (left !== undefined) {
            reportStep(left, `done`);
        }
        // Also on each line, not on the clock alone: this window's clock slows to a minute while it is hidden, and ic
        // says where the pull is every two seconds.
        reportPull(progress.value, now.value);
    }
    if (event.kind !== `line`) {
        boundaryHeard(event);
        return false;
    }
    stepHeard(event.text);
    const marker = readMarker(event.text);
    if (marker !== undefined) {
        takeMarker(marker);
    }
    return marker !== undefined;
};
