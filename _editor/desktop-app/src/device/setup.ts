import { computed, ref, watch } from "vue";
import { useCopied } from "@intentic/ui/clipboard";
import { t } from "@intentic/ui/i18n";
import { track, trackBeforeExit } from "../analytics";
import {
    claimExpired,
    expectedStop,
    forgetResumableSetup,
    freshSetupCode,
    parseCommandFailure,
    parseStep,
    readMarker,
    restartForSetup,
    resumableSetup,
    revealLog,
    runStop,
    setupAlert,
    setupProgress,
    onboardingSetUp,
    onboardingState,
    setupRun,
    signOutForSetup,
    takePendingSetup,
    workspaceOpen,
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
import { advance, type PlanStep, progressView, setupPlan, startProgress, tick, type Progress } from "../setupPlan";
import {
    endRequirements,
    failureLine,
    foldRequirement,
    homeOf,
    openStep,
    runEnding,
    scrubReason,
    stepLeft,
    type RequirementClocks,
    type RequirementTime,
    type StepOutcome,
    type StepTime,
} from "./installTelemetry";
import { dockerReady, info } from "./machine";
import { activeRun, eventsOf, linesOf, running, runOutcome, start } from "./runs";

// A SANDBOX'S SETUP ON THIS MACHINE, handed over from the workspace's /setup page (`intentic://setup`, parked by the
// app for the main window, windows.rs `park_setup`). It runs on arrival, unasked: installing and signing in to run a
// sandbox here already is the consent; administrator is still asked, on the requirements card. It leads This device
// while it is here, and reports its progress back to the workspace's page (`setup_progress`), which shows the same bar.
// This computer's own sandbox, which folders attach to, is not one of these: the app makes it by itself
// (machineSandbox.ts, the app's machine_sandbox.rs), whichever window is open.

// Setup codes last 30 minutes (the platform's setup-code.ts). A setup resumed on one older than 20 asks for a fresh one
// first, since its claim is still minutes of Docker ahead of it; one that cannot be had (signed out, offline, refused)
// leaves the old code to run while it has 5 minutes left, and the card saying it ran out past that.
/** On Windows, Docker/WSL for this PC goes through onboarding, not a sandbox setup run. */
const pcPrepareUsesOnboarding = async (): Promise<boolean> => {
    try {
        const snap = await onboardingState();
        const os = snap.check?.machine?.os ?? ``;
        if (!os.toLowerCase().includes(`windows`)) {
            return false;
        }
        return snap.check?.state !== `ready`;
    } catch {
        // allow(silent-catch): no onboarding state to read means the setup run's own prepare goes ahead, as before the
        // one setup path, and that run reports its own failures on the requirements card.
        return false;
    }
};

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

let ticker: ReturnType<typeof setInterval> | undefined;
const tickWhileRunning = (live: boolean): void => {
    clearInterval(ticker);
    ticker = undefined;
    if (!live) {
        return;
    }
    ticker = setInterval(() => {
        now.value = Date.now();
        if (progress.value !== undefined) {
            progress.value = tick(progress.value, now.value);
        }
    }, 1000);
};
watch(() => activeRun.value === `setup`, tickWhileRunning);

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
    expired.value = false;
    progress.value = startProgress(planFor(args), startedAt, floorFor(args));
    now.value = startedAt;
    // Unknown stays unknown (the probe may not have answered yet), as desktop_install_started reports it.
    attemptFacts = { resumed: resuming.value, dockerReady: dockerReady.value ?? null };
    clocks = {};
    exitHeardAt = undefined;
};

/**
 * What started a run, for the funnel: the app on a link's arrival or after a restart, or which of the reader's presses
 * (the requirements card's go-ahead or its "Check again", a stopped run's "Try again"), or the app again on a fresh code
 * after the platform refused the last one at the claim. A run that stops on a question and a reader who presses again
 * look the same from the outcome alone.
 */
export type InstallTrigger = `arrival` | `resume` | `consent` | `recheck` | `retry` | `renewed`;

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
    if (await pcPrepareUsesOnboarding()) {
        return;
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
    track(`desktop_install_finished`, { ...runOutcome(`setup`, ok, startedAt), ...requirementFacts(), ...(reason === undefined ? {} : { reason }) });
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
        // The main window is never topmost, so a run that stops while it is hidden would otherwise go unnoticed;
        // `setupAlert` brings it back to the front, in the workspace's place rather than beside it.
        await setupAlert();
        return;
    }
    // The last word the workspace page hears about this run, sent while there is still a setup to report on: the page
    // draws nothing for it (the workspace is about to open), and a strip left saying "97%" is what a later setup would
    // open on for its first second.
    void setupProgress({ ...nameOf(args), state: `done`, percent: 100 });
    pending.value = undefined;
    setupOpen.value = false;
    // Brings the workspace back without navigating it: the page waiting on `/setup` opens the workspace by itself the
    // moment the sandbox reports in (useRegistryWatch.ts), usually before this run's last checks end.
    await workspaceOpen();
};

/** `stopping` is set before the kill so the exit code it produces reads as an answer, not a failure. */
export const stopSetup = async (): Promise<void> => {
    if (!running.value) {
        return;
    }
    stopping.value = true;
    track(`desktop_install_stopped`, { percent: Math.round(progress.value?.percent ?? 0) });
    try {
        await runStop(`setup`);
    } catch (error) {
        stopping.value = false;
        setupError.value = String(error);
    }
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

// The card off the page, and the workspace's strip told so.
const putAway = (): void => {
    if (running.value) {
        return;
    }
    setupOpen.value = false;
    void setupProgress({ ...nameOf(pending.value), state: `closed`, percent: 0 });
};

/** A finished or failed setup's card dismissed by the reader: on a question still open, the likeliest place to leave. */
export const closeSetup = (): void => {
    if (running.value) {
        return;
    }
    track(`desktop_install_closed`, { state: setupState.value, ...whereLeft(), ...requirementFacts() });
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
watch(
    () => JSON.stringify(report.value),
    () => {
        if (report.value !== undefined) {
            void setupProgress(report.value);
        }
    },
);

/* THE WAY OUT THAT IS NOT "GIVE UP": offered by a machine that cannot meet the requirements, and by one that met them
   all and then stopped anyway. Both are the same question: run this sandbox somewhere else. */
export const setUpElsewhere = async (from: `requirements` | `stopped`): Promise<void> => {
    track(`desktop_install_elsewhere`, { from, requirements: requirements.value.map((requirement) => requirement.id) });
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

/** The reader's go-ahead after the first pass reported what it would change: the terminal path's typed "y". */
export const installRequirements = async (): Promise<void> => {
    consented.value = true;
    if (await pcPrepareUsesOnboarding()) {
        await onboardingSetUp();
        return;
    }
    await runSetup(`consent`);
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

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The answer, asked again while the platform cannot be reached at all.
const askForCode = async (args: SetupArgs, attempt = 1): Promise<FreshCode | null> => {
    const answer = await freshSetupCode(args).catch((error: unknown): FreshCode => ({ kind: `unreached`, reason: String(error) }));
    if (answer?.kind !== `unreached` || attempt >= RENEW_ATTEMPTS) {
        return answer;
    }
    await pause(RENEW_PAUSE_MS);
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
    if (await pcPrepareUsesOnboarding()) {
        return;
    }
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
