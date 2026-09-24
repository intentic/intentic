<script setup lang="ts">
import {
    AppBrand,
    Button,
    DeviceAgentGroup,
    DeviceDetail,
    DeviceRunLog,
    type DeviceSandboxGroup,
    type DeviceSandboxRow,
    Notice,
    type ResourcesAsk,
    Row,
    RowGroup,
    RowNote,
    SandboxResourcesDialog,
    sandboxGroups,
    type SandboxVerb,
    SandboxVerbs,
    sandboxVerbPrompt,
    ui,
    VERB_LABEL,
    vAction,
} from "@intentic/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { initAnalytics, track, trackBeforeExit } from "./analytics";
import DockerCard from "./components/DockerCard.vue";
import Requirements from "./components/Requirements.vue";
import { desktopAgentPanel } from "./deviceAgent";
import SetupProgress from "./components/SetupProgress.vue";
import { dragWindow } from "./dragWindow";
import { useFitToContent } from "./fitWindow";
import { advance, type PlanStep, progressView, setupPlan, startProgress, tick, type Progress } from "./setupPlan";
import {
    desktopInfo,
    // Aliased so the ref below can use the plain name `dockerReady`.
    dockerReady as dockerReadyProbe,
    dockerEngine,
    dockerListening,
    dockerOpen,
    dockerStart,
    expectedStop,
    folderEntries,
    forgetResumableSetup,
    hostsSandboxes,
    deviceAgentRestart,
    deviceStatus,
    onPendingRecreate,
    onPendingSetup,
    onPendingSync,
    onRun,
    onUpdate,
    openUrl,
    readMarker,
    parseCommandFailure,
    parseStep,
    restartForSetup,
    resumableSetup,
    revealLog,
    runStop,
    sandboxList,
    sandboxLogs,
    sandboxPower,
    sandboxRecreate,
    sandboxRemove,
    sandboxReshape,
    setupAlert,
    setupProgress,
    setupRun,
    signOutForSetup,
    syncRun,
    takePendingDocker,
    takePendingRecreate,
    takePendingSetup,
    takePendingSync,
    updateInstall,
    updateState,
    workspaceOpen,
    type DesktopInfo,
    type DeviceStatus,
    type DockerEngine,
    type DockerStart,
    type Requirement,
    type RequirementProgress,
    type RunEvent,
    type SandboxStatus,
    type SessionEnd,
    type SetupArgs,
    type SetupReport,
    type SyncArgs,
    type UpdateStage,
} from "./desktop";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* THE APP'S OWN FACE: the other half of the one window, and deliberately not a wizard. */

const info = ref<DesktopInfo | undefined>(undefined);
/* The box the window is fitted to: whichever face is up, measured (fitWindow.ts). */
const content = ref<HTMLElement | undefined>(undefined);
// Resources form parked on its row until Apply or Cancel answers it. Declared with the fit rather than beside
// its handlers, because the window's height depends on whether it is open.
const reshaping = ref<DeviceSandboxGroup | undefined>(undefined);
/* A DIALOG NEEDS A WINDOW TO BE A DIALOG IN: an overlay is `position: fixed`, so a card-tall window clips it to its first row. */
const dialogFloor = computed(() => (reshaping.value === undefined ? 0 : globalThis.screen.availHeight));
useFitToContent(content, dialogFloor);
/* WHETHER DOCKER ANSWERS, AND `undefined` UNTIL IT HAS BEEN ASKED — a third state this screen genuinely has and used to pretend it did not. */
const dockerReady = ref<boolean | undefined>(undefined);
/* THE ENGINE, AND THIS WINDOW'S JOB OF STARTING IT — nothing else on the machine does (desktop.ts). */
// Whether anything is listening where the engine listens. Cheap, unlike `dockerReady`, which is why the list
// below is only asked for when this says yes.
const engineListening = ref<boolean | undefined>(undefined);
const dockerStarting = ref(false);
const dockerReport = ref<DockerStart | undefined>(undefined);
// When the running start began, in epoch ms: the card's clock.
const dockerStartedAt = ref<number | undefined>(undefined);
// This launch opened the app's own face BECAUSE the engine was asleep (lib.rs), so this launch is the one that
// hands over to the workspace once it wakes. A window opened from the tray was asked for and stays put.
const wokeForDocker = ref(false);
// The card is up while a start is running and while one has ended in anything other than an engine: `ready` is
// the list below coming back, which says it better than any card could.
const dockerCardShown = computed(() => dockerStarting.value || (dockerReport.value !== undefined && dockerReport.value.outcome !== `ready`));
const sandboxes = ref<SandboxStatus[]>([]);
const listError = ref<string | undefined>(undefined);
// Docker engine size for the Resources form's rails; undefined means no ceiling, not a wrong one.
const engine = ref<DockerEngine | undefined>(undefined);
// Undefined means no agent (not a failure); a string means the agent didn't answer (is one).
const status = ref<DeviceStatus | undefined>(undefined);
const reportError = ref<string | undefined>(undefined);
const busy = ref<{ slug: string; verb: SandboxVerb } | undefined>(undefined);

// App's own update state (desktop.ts UpdateStage), drawn as exactly what's true rather than a future promise.
const update = ref<UpdateStage>({ kind: `idle` });
const updateError = ref<string | undefined>(undefined);

const applyUpdate = async (): Promise<void> => {
    updateError.value = undefined;
    try {
        await updateInstall();
    } catch (error) {
        // Shown refusal: a script run is in flight, so the swap waits rather than killing it.
        updateError.value = String(error);
    }
};

// Log tail is remembered by slug, not by whichever row is busy, since it outlives its own run.
const openLog = ref<string | undefined>(undefined);
const logLines = ref<Record<string, string[]>>({});
// A row's own failure message, kept beside that row rather than at the foot of the screen.
const rowFailure = ref<{ slug: string; message: string } | undefined>(undefined);

// Tail length asked of docker; matches what the machine agent uses for the same button.
const LOG_TAIL_LINES = 200;

// The setup the SPA handed over, and the run it becomes.
const pending = ref<SetupArgs | undefined>(undefined);
const setupError = ref<string | undefined>(undefined);
const runs = ref<Record<string, RunEvent[]>>({});
const activeRun = ref<string | undefined>(undefined);

// Held rather than derived: a setup is a setup from arrival until it finishes or is closed.
const setupOpen = ref(false);

// Per-requirement progress, keyed by id, fed by the installer's state markers; cleared with its list.
const requirementState = ref<Record<string, RequirementProgress>>({});

// Where the running (or last) setup wrote its transcript, and whether a stop has been asked for.
const setupLog = ref<string | undefined>(undefined);
// Held here, not in the card, so every verb about the transcript sits in one row (SetupProgress opens it on failure).
const setupLogOpen = ref(false);
const stopping = ref(false);
// Exit code of the last setup, to tell a designed stop from something going wrong.
const setupExit = ref<number | null | undefined>(undefined);
const setupCommandFailure = ref<string | undefined>(undefined);
// A user-ended run is neither failure nor success; needs its own state or it shows nothing at all.
const wasStopped = computed(() => stopping.value && setupExit.value !== undefined);

// Unmet requirements from `intentic-requirement:` lines; cleared at the start of each attempt.
const requirements = ref<Requirement[]>([]);
// True while the previous run's list stays up during re-examination; a new requirement clears it.
const carried = ref(false);
// Whether the user answered the requirements list; about this window's conversation, not the link.
const consented = ref(false);
// A setup resumed after a Windows restart, and whether its code has gone stale.
const resuming = ref(false);
const expired = ref(false);
// Which way the session ended for it, so a sign-out that changed nothing is answered with a restart rather than
// asked for again (Requirements.vue).
const resumedHow = ref<SessionEnd | undefined>(undefined);

// Path to the SPA's Devices tab, which manages the same containers via the machine's own connection.
const DEVICES_PATH = `/sandbox/devices`;

// Wrapped since `workspaceOpen` takes an optional path; a bare click handler would pass it a MouseEvent.
const openWorkspace = (path?: string): void => void workspaceOpen(path);

const eventsOf = (run: string): RunEvent[] => runs.value[run] ?? [];
const running = computed(() => activeRun.value !== undefined);

const COMMAND_FAILURE_GRACE_MS = 2_000;
let commandFailureTimer: ReturnType<typeof setTimeout> | undefined;
const clearCommandFailureTimer = (): void => {
    clearTimeout(commandFailureTimer);
    commandFailureTimer = undefined;
};

// An explicit terminal failure cannot leave its enclosing setup alive indefinitely.
const reportCommandFailure = (reason: string): void => {
    setupCommandFailure.value = reason;
    setupError.value = reason;
    clearCommandFailureTimer();
    commandFailureTimer = setTimeout(() => {
        commandFailureTimer = undefined;
        if (activeRun.value !== `setup` || setupCommandFailure.value !== reason) {
            return;
        }
        void runStop(`setup`).catch((error: unknown) => {
            setupError.value = `${reason}\nThe stuck installer could not be stopped: ${String(error)}`;
        });
    }, COMMAND_FAILURE_GRACE_MS);
};

// A designed stop (desktop.ts) isn't a failure; hoisted so both the bar and the card read the same fact.
const awaitingConsent = computed(() => !running.value && requirements.value.length > 0 && expectedStop(setupExit.value ?? null));

// True once every requirement reports `done`, so an answered list stops being drawn as unanswered.
const requirementsSettled = computed(
    () => requirements.value.length > 0 && requirements.value.every((requirement) => requirementState.value[requirement.id]?.state === `done`),
);
// A handed-over setup owns the window until it hands back, including while failed.
const setupMode = computed(() => setupOpen.value || activeRun.value === `setup`);

// The one thing on screen to act on, while it is up: the plan behind it goes quiet rather than competing with it.
const requirementsShown = computed(() => requirements.value.length > 0 && !expired.value && !requirementsSettled.value);

// True once a handed-over setup has been looked for; gates the title so it can't flash before that lands.
const faceKnown = ref(false);

// The OS title follows which screen is up: it's the taskbar/alt-tab label and the only outside signal of that,
// since both screens share one frame (windows.rs).
watchEffect(() => {
    if (!faceKnown.value) {
        return;
    }
    void getCurrentWindow().setTitle(setupMode.value ? `Intentic, Setting up your sandbox` : `Intentic, This device`);
});

// Install progress (setupPlan.ts): the plan is built before the script starts; `now` only exists so a silent step
// still visibly moves.
const progress = ref<Progress | undefined>(undefined);
const now = ref(Date.now());
const progressShown = computed(() => (progress.value === undefined ? undefined : progressView(progress.value, now.value)));

let ticker: ReturnType<typeof setInterval> | undefined;
watch(
    () => activeRun.value === `setup`,
    (live) => {
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
    },
);

// Only the newest refresh writes: an older one answering late would put back a screen that has since moved on.
let refreshes = 0;
const newest = (generation: number): boolean => generation === refreshes;

const refreshDocker = async (generation: number): Promise<void> => {
    // Asked first and answered in microseconds, because everything below it is a docker call: a `docker ps`
    // against a daemon that is not there spends tens of seconds on the socket before it fails.
    const listening = await dockerListening();
    if (!newest(generation)) {
        return;
    }
    engineListening.value = listening;
    // A start under way owns the screen through its card, and a listing against an engine still booting only waits.
    if (!listening || dockerStarting.value) {
        sandboxes.value = [];
        engine.value = undefined;
        // Not an error: the card says what is happening and what to press. `listError` is for a docker that
        // answered and refused, or never answered.
        listError.value = undefined;
        return;
    }
    // Alongside the list, not blocking it: this answer only sizes a form nobody has opened, and it's slow.
    void dockerEngine()
        .then((facts) => (engine.value = facts ?? undefined))
        .catch(() => (engine.value = undefined));
    try {
        const listed = await sandboxList();
        if (newest(generation)) {
            sandboxes.value = listed;
            listError.value = undefined;
        }
    } catch (error) {
        if (newest(generation)) {
            sandboxes.value = [];
            listError.value = String(error);
        }
    }
};

// Read beside the sandbox list, never behind it: the agent and docker are each absent on their own on a working device.
const refreshAgent = async (generation: number): Promise<void> => {
    try {
        const read = await deviceStatus();
        if (newest(generation)) {
            status.value = read;
            reportError.value = undefined;
        }
    } catch (error) {
        if (newest(generation)) {
            status.value = undefined;
            reportError.value = String(error);
        }
    }
};

const refresh = async (): Promise<void> => {
    refreshes += 1;
    await Promise.all([refreshDocker(refreshes), refreshAgent(refreshes)]);
};

/* STARTING THE ENGINE — the whole of what this window can do about a Docker that is not running, and it is a lot. */

// Where somebody sent to install Docker should land: our own page, which says what it is for here and links
// Docker's download, rather than dropping a non-technical reader on docker.com to choose an edition.
const DOCKER_DOCS = `https://intentic.dev/docs/docker`;

// Not guarded against a second caller: Docker Desktop is single-instance, so two starts are one start and both
// waits reach the same answer. The card hides its buttons while one is in flight because a second press says
// nothing, not because it would break.
const startDocker = async (): Promise<void> => {
    dockerStarting.value = true;
    dockerReport.value = undefined;
    const startedAt = Date.now();
    dockerStartedAt.value = startedAt;
    try {
        const report = await dockerStart();
        dockerReport.value = report;
        // How often a machine was found asleep, and how often waking it worked: the one measurement that says
        // whether this window is doing the job it opened to do.
        track(`desktop_docker_start`, {
            outcome: report.outcome,
            seconds: Math.round((Date.now() - startedAt) / 1000),
            atLaunch: wokeForDocker.value,
        });
        dockerReady.value = report.outcome === `ready`;
        // A refused engine is a RUNNING engine, so the list stops being the thing to wait for and starts being
        // the thing that reports its own refusal.
        engineListening.value = report.outcome === `ready` || report.outcome === `notAllowed`;
    } catch (error) {
        // The command itself failing is not one of its five answers, so it becomes the one that means "it did
        // not run" — the card keeps a sentence and a button either way.
        dockerReport.value = { outcome: `wouldNotStart`, detail: String(error) };
    } finally {
        dockerStarting.value = false;
    }
    if (dockerReport.value?.outcome !== `ready`) {
        return;
    }
    await refresh();
    // The launch that opened this face for the engine hands the window back to the workspace it was going to
    // open — once, and only that launch (desktop.ts `takePendingDocker`).
    if (wokeForDocker.value) {
        wokeForDocker.value = false;
        openWorkspace();
    }
};

// Docker Desktop's own window, for the two things this app cannot answer for anybody: its welcome screen and
// its sign-in.
const openDocker = async (): Promise<void> => {
    try {
        await dockerOpen();
    } catch (error) {
        dockerReport.value = { outcome: `wouldNotStart`, detail: String(error) };
    }
};

// The launch decision, asked again here because a window is not the only way to reach this screen: the tray's
// "This device" lands on the same face, and a machine whose engine is asleep should be woken from there too.
const wakeDockerIfNeeded = async (): Promise<void> => {
    // Taken whatever happens next: it is a one-shot fact about THIS launch (lib.rs).
    wokeForDocker.value = await takePendingDocker();
    // A setup owns the machine while it runs — `ic docker prepare` starts Docker as one of its own steps, and
    // two things starting it would draw two cards about one wait.
    if (pending.value !== undefined || dockerStarting.value) {
        return;
    }
    if (await dockerListening()) {
        return;
    }
    // A machine no sandbox has ever run on is nobody's to wake: somebody using this app as a window onto a
    // sandbox we host has a perfectly good reason for their Docker to be off (state.rs).
    if (!wokeForDocker.value && !(await hostsSandboxes())) {
        return;
    }
    await startDocker();
};

// Maps to the shared row shape; docker's `null` becomes an absent key, since absent and false differ (no sidecar
// vs. a down one).
const sandboxRows = computed<DeviceSandboxRow[]>(() =>
    sandboxes.value.map((sandbox) => ({
        slug: sandbox.slug,
        running: sandbox.running,
        image: sandbox.image,
        ...(sandbox.name === null ? {} : { name: sandbox.name }),
        ...(sandbox.tunnelRunning === null ? {} : { tunnelRunning: sandbox.tunnelRunning }),
        // Share docker enforces, already in the kit's shape.
        ...(sandbox.resources === null ? {} : { resources: sandbox.resources }),
    })),
);

// The agent as the kit's panel (deviceAgent.ts), the same object the SPA's Devices tab hands <DeviceAgentGroup>.
const agentPanel = computed(() => desktopAgentPanel(status.value));

// Restarting the loop from the window: this app runs ON the device the two commands were for, so nothing here has
// any business asking for a terminal. The report is re-read afterwards, since the agent's state IS the answer.
const agentRestarting = ref(false);
const agentRestartError = ref<string | undefined>(undefined);
// What the loop said back, in its own words, the way the SPA's Devices tab reports the same op.
const agentRestartOutcome = ref<string | undefined>(undefined);
const restartAgent = async (): Promise<void> => {
    if (agentRestarting.value) {
        return;
    }
    agentRestarting.value = true;
    agentRestartError.value = undefined;
    agentRestartOutcome.value = undefined;
    try {
        const said = await deviceAgentRestart();
        agentRestartOutcome.value = said.trim() === `` ? t(`desktop.app.agentRestarted`) : said.trim();
    } catch (error) {
        agentRestartError.value = String(error);
    } finally {
        agentRestarting.value = false;
        // Always, including after a failure: the stop half may have landed, so the row must show what is there now.
        await refresh();
    }
};

// The docker row behind a view group, which every verb below needs.
const slugOf = (group: DeviceSandboxGroup): string | undefined => group.sandbox?.slug;

// The rows the list will draw, folded exactly as <DeviceDetail> folds them, so the group's count is the number
// of rows under it rather than a second arithmetic that can disagree.
const groups = computed(() => sandboxGroups(status.value?.sync.pairings ?? [], status.value?.sync.ports ?? [], sandboxRows.value));

// The machine's own facts in the quietest ink: what identifies this computer among several enrolled ones.
const hardware = computed(() =>
    [status.value?.sync.hostname, status.value?.sync.os ?? info.value?.os].filter((fact) => fact !== undefined && fact !== ``).join(` · `),
);

// Named rather than "this device" wherever the machine can name itself; the hover sentence reads as prose.
const machineName = computed(() => status.value?.sync.hostname ?? `this device`);

// Last phase id before a failure, not the sentence, so wording changes don't break funnel comparisons.
const stepOf = (event: RunEvent): string | undefined =>
    event.kind === `line` && event.stream === `stdout` ? parseStep(event.text)?.phase : undefined;

const runOutcome = (id: string, ok: boolean, startedAt: number): Record<string, unknown> => {
    const events = eventsOf(id);
    const exit = events.findLast((event) => event.kind === `exit`);
    const phases = events.map(stepOf).filter((phase): phase is string => phase !== undefined);
    return {
        ok,
        durationMs: Date.now() - startedAt,
        exitCode: exit?.kind === `exit` ? exit.code : null,
        steps: phases.length,
        // Only on failure: a successful run's last step is just the last step.
        ...(ok || phases.length === 0 ? {} : { failedStep: phases.at(-1) }),
    };
};

// Every operation is one script run reported the same way. `activeRun` serializes them, since the scripts all
// drive docker on one machine.
const start = async (id: string, action: () => Promise<void>): Promise<string | undefined> => {
    runs.value = { ...runs.value, [id]: [] };
    activeRun.value = id;
    try {
        await action();
        return undefined;
    } catch (error) {
        return String(error);
    } finally {
        activeRun.value = undefined;
        await refresh();
    }
};

// Built from two directions (run start, and the Docker probe landing later), since the one conditional step
// depends on that answer.
const planFor = (args: SetupArgs): readonly PlanStep[] =>
    setupPlan({
        // Optimistic while unknown: a missing Docker step self-corrects when the probe answers.
        dockerReady: dockerReady.value ?? true,
        syncing: (args.syncDir ?? ``) !== ``,
        os: info.value?.os ?? ``,
    });

/* The sandbox name is copied into every report that carries one. */
const nameOf = (args: SetupArgs | undefined): { name?: string } => (args?.name === undefined ? {} : { name: args.name });

const runSetup = async (): Promise<void> => {
    const args = pending.value;
    if (args === undefined || running.value) {
        return;
    }
    const startedAt = Date.now();
    // The previous list stays on screen through a re-run rather than being cleared, so items the user just agreed to
    // don't vanish while the installer re-examines the machine. Its first new requirement replaces it wholesale.
    carried.value = requirements.value.length > 0;
    requirementState.value = {};
    setupExit.value = undefined;
    setupError.value = undefined;
    setupCommandFailure.value = undefined;
    clearCommandFailureTimer();
    stopping.value = false;
    expired.value = false;
    // Plan reflects only what will actually run here; rebuilt fresh each run.
    progress.value = startProgress(planFor(args), startedAt);
    now.value = startedAt;
    track(`desktop_install_started`, {
        dockerReady: dockerReady.value ?? null,
        sync: (args.syncDir ?? ``) !== ``,
        consented: consented.value,
        resumed: resuming.value,
    });
    const failure = await start(`setup`, () => setupRun(args, consented.value));
    await settleSetup(args, failure, startedAt);
};

/* A completed run reports its outcome separately from its live state. */
const settleSetup = async (args: SetupArgs, failure: string | undefined, startedAt: number): Promise<void> => {
    const ok = failure === undefined;
    // This run passed the examination; a stale list here would describe a different failure.
    if (carried.value) {
        requirements.value = [];
        carried.value = false;
    }
    // A designed stop (desktop.ts) carries no error text, since the requirements list is the message; a stop nobody
    // asked for isn't a failure either. If the list itself failed to arrive, the raw failure shows instead of nothing.
    const deferredToTheList = expectedStop(setupExit.value ?? null) && requirements.value.length > 0;
    setupError.value = ok || stopping.value || deferredToTheList ? undefined : (setupCommandFailure.value ?? failure);
    // Reports the funnel's last step from where it happens, since the SPA's own event fires from a page that may
    // already be closed.
    track(`desktop_install_finished`, {
        ...runOutcome(`setup`, ok, startedAt),
        // Requirement ids only, never reworded, so funnels compare across releases.
        ...(requirements.value.length === 0 ? {} : { requirements: requirements.value.map((requirement) => requirement.id) }),
    });
    if (ok) {
        // The last word the workspace page hears about this run, sent while there is still a setup to report
        // on: the page draws nothing for it (the workspace is about to open), and a strip left saying "97%"
        // is what a later setup in the same window would open on for its first second.
        void setupProgress({ ...nameOf(args), state: `done`, percent: 100 });
        pending.value = undefined;
        setupOpen.value = false;
        // Navigates to the app root rather than the page waiting on `/setup`: the sandbox already announced itself on
        // boot, so there's nothing left to poll for.
        await workspaceOpen(`/`);
        return;
    }
    // This window is deliberately not topmost, so a run that stops while minimized or hidden would otherwise go
    // unnoticed; `setupAlert` brings it back to the front, in the workspace's place rather than beside it.
    await setupAlert();
};

// `stopping` is set before the kill so the exit code it produces reads as an answer, not a failure.
const stopSetup = async (): Promise<void> => {
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

// Puts the transcript on the clipboard: what someone stuck actually needs to hand over.
const logCopied = ref(false);
const copyLog = async (): Promise<void> => {
    const text = eventsOf(`setup`)
        .flatMap((event) => (event.kind === `line` ? [`${event.stream === `stderr` ? `! ` : ``}${event.text}`] : []))
        .join(`\n`);
    await navigator.clipboard.writeText(text);
    logCopied.value = true;
    setTimeout(() => (logCopied.value = false), 2000);
};

const openLogFolder = async (): Promise<void> => {
    if (setupLog.value !== undefined) {
        await revealLog(setupLog.value);
    }
};

// Dismissing hands the window back but stops nothing — the script keeps running and still reports its own finish
// event. Carries where it was left (phase, bar position); nothing about the machine leaves here.
const dismissSetup = async (): Promise<void> => {
    const state = progress.value;
    const step = state?.plan[state.index]?.phase;
    track(`desktop_install_dismissed`, {
        // A dismissal after the run ended is just closing a finished or failed card, not the same event.
        running: running.value,
        ...(state === undefined ? {} : { percent: Math.round(state.percent), elapsedMs: Date.now() - state.startedAt }),
        ...(step === undefined ? {} : { step }),
    });
    /* A live run keeps setup open so a later failure can return here. */
    if (!running.value) {
        setupOpen.value = false;
        void setupProgress({ ...nameOf(pending.value), state: `closed`, percent: 0 });
    }
    await workspaceOpen();
};

/* The dismiss label makes clear that leaving this screen does not stop a live setup run. */
const dismissLabel = computed(() =>
    running.value ? `Back to your workspace. The install keeps running, and your workspace shows its progress.` : `Back to your workspace`,
);

/* The workspace page receives setup progress after every change. */
const reportState = computed<SetupReport[`state`]>(() => {
    if (running.value) {
        return `running`;
    }
    // A requirements card is a question on this screen whichever exit code put it there, and the workspace's
    // strip should say so rather than "stopped" (which reads as broken) beside a button that opens it.
    if (awaitingConsent.value || requirementsShown.value) {
        return `waiting`;
    }
    if (wasStopped.value) {
        return `stopped`;
    }
    return progress.value?.ended === `ok` ? `done` : `failed`;
});
const report = computed<SetupReport | undefined>(() => {
    const view = progressShown.value;
    const state = progress.value;
    if (!setupMode.value || view === undefined || state === undefined) {
        return undefined;
    }
    const step = state.plan[state.index]?.phase;
    return {
        ...nameOf(pending.value),
        state: reportState.value,
        percent: Math.round(view.percent),
        ...(view.position === undefined ? {} : { position: view.position }),
        ...(view.remaining === undefined ? {} : { remaining: view.remaining }),
        ...(step === undefined ? {} : { step }),
    };
});
watch(
    () => JSON.stringify(report.value),
    (next) => {
        if (next !== undefined && report.value !== undefined) {
            void setupProgress(report.value);
        }
    },
);

/* THE WAY OUT THAT IS NOT "GIVE UP" — offered by a machine that cannot meet the requirements, and by one that
   met them all and then stopped anyway. Both are the same question: run this sandbox somewhere else. */
const setUpElsewhere = async (from: `requirements` | `stopped`): Promise<void> => {
    track(`desktop_install_elsewhere`, { from, requirements: requirements.value.map((requirement) => requirement.id) });
    setupOpen.value = false;
    // `elsewhere=1` is what stops /setup acting on arrival: the hosted rung is preselected, and it is the reader's
    // click on it that spends their allowance, never this handover. `sandbox` names the row this install was for —
    // without it the page has to guess, and guesses at a fresh one.
    const query = new URLSearchParams({ elsewhere: `1`, machine: `hosted` });
    const sandboxId = pending.value?.sandboxId;
    if (sandboxId !== undefined && sandboxId !== ``) {
        query.set(`sandbox`, sandboxId);
    }
    await workspaceOpen(`/setup?${query.toString()}`);
};

// The user's go-ahead after the first pass reported what it would change; the terminal path's equivalent of a
// typed "y". Stays set for the rest of this window's conversation.
const installRequirements = async (): Promise<void> => {
    consented.value = true;
    await runSetup();
};

// Restart and sign-out are one function since both are things Windows only applies between sessions; args are
// saved to disk first so a crash mid-transition still resumes.
const endSession = async (how: `restart` | `signout`): Promise<void> => {
    const args = pending.value;
    if (args === undefined || running.value) {
        return;
    }
    // Awaited, unlike other events here: the next line ends the session, losing anything still in flight.
    await trackBeforeExit(`desktop_install_restart`, {
        how,
        requirements: requirements.value.map((requirement) => requirement.id),
    });
    try {
        await (how === `restart` ? restartForSetup(args) : signOutForSetup(args));
    } catch (error) {
        // Neither path gets a second chance to explain itself, so a refusal is shown rather than silently doing
        // nothing.
        setupError.value = String(error);
    }
};

// Setup codes last 30 minutes; 25 leaves room for the restart and the setup itself to finish.
const RESUME_WINDOW_SECONDS = 25 * 60;

const loadResumable = async (): Promise<void> => {
    const parked = await resumableSetup();
    if (parked === null) {
        return;
    }
    pending.value = parked.args;
    setupOpen.value = true;
    resumedHow.value = parked.how;
    if (parked.agedSeconds > RESUME_WINDOW_SECONDS) {
        await forgetResumableSetup();
        expired.value = true;
        track(`desktop_install_resume_expired`, { agedSeconds: parked.agedSeconds });
        return;
    }
    resuming.value = true;
    // Already agreed to before the restart this app performed on that answer; not asked again.
    consented.value = true;
    track(`desktop_install_resumed`, { agedSeconds: parked.agedSeconds });
    await runSetup();
};

// The way on from a code that ran out: the setup page mints a fresh one and, inside this app, hands it straight
// back here (setupArrival.ts) — so this is one click rather than "open the setup page again".
const freshCode = async (): Promise<void> => {
    track(`desktop_install_fresh_code`, {});
    await workspaceOpen(`/setup`);
};

// A parked setup runs on arrival, unasked: installing and signing in to run a sandbox here already is the
// consent. Administrator is still asked separately, on the requirements screen. An OS-originated link is gated in
// windows.rs before it's ever parked.
const loadPending = async (): Promise<void> => {
    // Taken, not read: `null` means another caller already took it, not that there's no setup; two callers race for it
    // (the arrival event, and this mount).
    const taken = await takePendingSetup();
    if (taken !== null) {
        pending.value = taken;
        setupOpen.value = true;
        // A fresh link is a fresh conversation: nothing about an earlier session's ending applies to it.
        resumedHow.value = undefined;
        expired.value = false;
    }
    // Set now, in the same tick as `setupOpen`, so the frame titles once; everything after is the setup happening,
    // already announced.
    faceKnown.value = true;
    if (taken === null) {
        return;
    }
    await runSetup();
};

// Which run id each verb reports under; kept as legacy ids since analytics and `intentic://recreate` depend on
// them.
const RUN_OF: Record<Exclude<SandboxVerb, `logs`>, (slug: string) => string> = {
    start: (slug) => `power:${slug}`,
    stop: (slug) => `power:${slug}`,
    restart: (slug) => `power:${slug}`,
    update: (slug) => `recreate:${slug}`,
    rollback: (slug) => `recreate:${slug}`,
    // A reshape is a recreate (same image, different share), so it runs under the recreate id.
    resources: (slug) => `recreate:${slug}`,
    remove: (slug) => `remove:${slug}`,
};

// `source` distinguishes a click here from the SPA's Update/Environment card handing it over.
const recreate = async (slug: string, hash: string | undefined, rollback: boolean, source: `manager` | `link`): Promise<void> => {
    busy.value = { slug, verb: rollback ? `rollback` : `update` };
    const startedAt = Date.now();
    // Mode mirrors the script's argument shape: a hash means the approved overlay, rollback the pre-update image.
    const mode = rollback ? `rollback` : hash === undefined ? `update` : `rebuild`;
    track(`desktop_recreate_started`, { mode, source });
    const failure = await start(`recreate:${slug}`, () => sandboxRecreate(slug, hash, rollback));
    track(`desktop_recreate_finished`, { mode, source, ...runOutcome(`recreate:${slug}`, failure === undefined, startedAt) });
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
};

// Same recreate, different resource share; reports as `mode: "reshape"` so restart-counting funnels include it.
// The ask is only what the form changed.
const reshape = async (slug: string, ask: ResourcesAsk): Promise<void> => {
    busy.value = { slug, verb: `resources` };
    const startedAt = Date.now();
    track(`desktop_recreate_started`, { mode: `reshape`, source: `manager` });
    const failure = await start(RUN_OF.resources(slug), () => sandboxReshape(slug, ask));
    track(`desktop_recreate_finished`, {
        mode: `reshape`,
        source: `manager`,
        ...runOutcome(RUN_OF.resources(slug), failure === undefined, startedAt),
    });
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
};

/* Escape dismisses the card when no dialog is consuming the key. */
const onKey = (event: KeyboardEvent): void => {
    if (event.key !== `Escape` || reshaping.value !== undefined) {
        return;
    }
    void (setupMode.value ? dismissSetup() : workspaceOpen());
};
// The form rather than a run: nothing happens until it is applied. A container docker did not describe (its
// inspect failed) has nothing to open the form on, and says so where every other refusal on this row lands.
const openResources = (group: DeviceSandboxGroup, slug: string): void => {
    if (group.sandbox?.resources === undefined) {
        rowFailure.value = { slug, message: t(`desktop.app.dockerDidntDescribeSandboxs`) };
        return;
    }
    reshaping.value = group;
};
const applyReshape = async (ask: ResourcesAsk): Promise<void> => {
    const slug = reshaping.value === undefined ? undefined : slugOf(reshaping.value);
    reshaping.value = undefined;
    if (slug === undefined || busy.value !== undefined || running.value) {
        return;
    }
    // A log pane for a row that's about to change is now stale.
    openLog.value = undefined;
    rowFailure.value = undefined;
    await reshape(slug, ask);
};

// The SPA's copy-paste cards arriving as a click instead: Update sends a slug, Environment adds the approved
// digest, rollback sends the flag. Taken, not read, so revisiting this screen doesn't re-run it.
const drainRecreate = async (): Promise<void> => {
    const requested = await takePendingRecreate();
    if (requested === null || running.value) {
        return;
    }
    await recreate(requested.slug, requested.hash, requested.rollback, `link`);
};

// Enables desktop sync from a system dialog, since a webview can't pick a folder itself; runs the same
// sync.sh/sync.ps1 the card's one-liner does. The SPA's card polls and flips to "Enabled" once this finishes.
const syncSetup = ref<{ args: SyncArgs; dir?: string; error?: string } | undefined>(undefined);
const syncLines = computed(() => eventsOf(`sync-setup`).flatMap((event) => (event.kind === `line` ? [event.text] : [])));

const runSync = async (args: SyncArgs, dir: string | undefined): Promise<void> => {
    syncSetup.value = { args, ...(dir === undefined ? {} : { dir }) };
    const startedAt = Date.now();
    track(`desktop_sync_started`, { mirror: args.mirror, takeover: args.takeover });
    const failure = await start(`sync-setup`, () => syncRun(args, dir));
    track(`desktop_sync_finished`, { mirror: args.mirror, takeover: args.takeover, ...runOutcome(`sync-setup`, failure === undefined, startedAt) });
    if (failure === undefined) {
        syncSetup.value = undefined;
        // Returns to the page whose card is already polling for this enrollment.
        await workspaceOpen();
        return;
    }
    syncSetup.value = { args, ...(dir === undefined ? {} : { dir }), error: failure };
    // Same courtesy as a failed install: a stopped run must not go unnoticed in an unwatched window.
    await setupAlert();
};

// One confirmation after the folder is picked: sync is two-way with no undo. Counting what's already there makes
// the warning concrete; a mirror pairing skips all of it.
const drainSync = async (): Promise<void> => {
    const args = await takePendingSync();
    if (args === null || running.value) {
        return;
    }
    if (args.mirror) {
        await runSync(args, undefined);
        return;
    }
    const what = args.name ?? `your sandbox`;
    const picked = await open({ directory: true, multiple: false, title: t(`desktop.app.chooseFolderToKeep`, { what }) });
    if (typeof picked !== `string` || picked === ``) {
        // Cancelled: nothing ran, so just return to the card that asked.
        await workspaceOpen();
        return;
    }
    // A folder that couldn't be read is said as unread, never as empty: the count is the warning's only evidence.
    const held = await folderEntries(picked).then(
        (entries) => (entries === 0 ? `` : `\n\nIt already holds ${entries} item${entries === 1 ? `` : `s`}, and the sandbox's own files land in it too.`),
        (error: unknown) => `\n\nWhat it already holds couldn't be read (${String(error)}); anything in it syncs too.`,
    );
    const agreed = await confirm(
        `${picked}\n\nEverything in this folder syncs BOTH ways with ${what}: changes agents make in the sandbox appear here, with no undo.${held}`,
        { title: t(`desktop.app.keepFolderInSync`, { what }), kind: `warning`, okLabel: `Start syncing` },
    );
    if (!agreed) {
        await workspaceOpen();
        return;
    }
    await runSync(args, picked);
};

// Re-runs with the folder already chosen; the pairing token is single-use, so a run that failed after enrolling
// needs a fresh one from the card's Regenerate.
const retrySync = async (): Promise<void> => {
    const held = syncSetup.value;
    if (held === undefined || running.value) {
        return;
    }
    await runSync(held.args, held.dir);
};

// One click on one row: the kit decides which buttons exist and what they ask; this decides what each does here —
// a script or docker call, versus a socket message from the SPA's Devices tab.
// Log tail toggle, not a run: opened before lines arrive so an empty pane reads as "reading," not ignored. Doesn't
// go through `start`, since nothing is spawned.
const toggleLogs = async (slug: string): Promise<void> => {
    if (openLog.value === slug) {
        openLog.value = undefined;
        return;
    }
    openLog.value = slug;
    logLines.value = { ...logLines.value, [slug]: [] };
    busy.value = { slug, verb: `logs` };
    const text = await sandboxLogs(slug, LOG_TAIL_LINES).catch(String);
    logLines.value = { ...logLines.value, [slug]: text.split(/\r?\n/).filter(Boolean) };
    busy.value = undefined;
};

const act = async (group: DeviceSandboxGroup, verb: SandboxVerb): Promise<void> => {
    const slug = slugOf(group);
    if (slug === undefined || busy.value !== undefined || running.value) {
        return;
    }
    if (verb === `logs`) {
        await toggleLogs(slug);
        return;
    }
    if (verb === `resources`) {
        openResources(group, slug);
        return;
    }
    // Title and message match the web tab's ConfirmDialog header/body split.
    const asked = sandboxVerbPrompt(verb, group.title);
    if (asked !== undefined && !(await confirm(asked.body, { title: asked.header, kind: `warning`, okLabel: VERB_LABEL[verb] }))) {
        return;
    }
    // A log pane for a row that's about to change is now stale.
    openLog.value = undefined;
    rowFailure.value = undefined;
    if (verb === `update` || verb === `rollback`) {
        await recreate(slug, undefined, verb === `rollback`, `manager`);
        return;
    }
    busy.value = { slug, verb };
    const failure = await start(RUN_OF[verb](slug), verb === `remove` ? () => sandboxRemove(slug) : () => sandboxPower(slug, verb));
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
};

// Which of this row's buttons is spinning, and whose pane is showing: a row has one thing to say.
const busyVerb = (group: DeviceSandboxGroup): SandboxVerb | undefined => {
    const inFlight = busy.value;
    return inFlight !== undefined && inFlight.slug === slugOf(group) ? inFlight.verb : undefined;
};
const logOpen = (group: DeviceSandboxGroup): boolean => openLog.value !== undefined && openLog.value === slugOf(group);
const paneLines = (group: DeviceSandboxGroup): string[] => {
    const slug = slugOf(group);
    const verb = busyVerb(group);
    if (slug === undefined) {
        return [];
    }
    if (verb !== undefined && verb !== `logs`) {
        return eventsOf(RUN_OF[verb](slug)).flatMap((event) => (event.kind === `line` ? [event.text] : []));
    }
    return logLines.value[slug] ?? [];
};

let stop: Array<() => void> = [];
onMounted(async () => {
    window.addEventListener(`keydown`, onKey);
    // Awaited, and safe to await, because it asks this process what it is and nothing else — see desktop.ts.
    // The question about the MACHINE used to be answered in the same breath, and that is what made this line
    // the one everything below queued behind.
    info.value = await desktopInfo();
    // Before the parked work, since the first thing this screen does is often the install it exists to report.
    initAnalytics(info.value);
    // Probed in parallel with drawing the window, since it's slowest on the machines it matters for.
    // `desktop_app_opened` waits for it so the property means something on precisely the machines it's about.
    void dockerReadyProbe().then((ready) => {
        dockerReady.value = ready;
        track(`desktop_app_opened`, { dockerReady: ready });
        // Redrawn only before the cursor moves; swapping a plan the reader is already following would be worse.
        if (pending.value !== undefined && progress.value !== undefined && progress.value.index === -1) {
            progress.value = startProgress(planFor(pending.value), progress.value.startedAt);
        }
    });
    // Registered before `loadPending` can start a run, or its first seconds would show an empty log.
    stop = await Promise.all([
        onRun((event) => {
            // Requirement markers are protocol for this window, not output; parsed here and dropped so raw JSON never
            // reaches
            // the log pane. The transcript on disk (scripts.rs) still records every byte.
            const marker = event.run === `setup` && event.kind === `line` ? readMarker(event.text) : undefined;
            const commandFailure = event.run === `setup` ? parseCommandFailure(event) : undefined;
            if (commandFailure !== undefined) {
                reportCommandFailure(commandFailure);
            }
            const phase = event.run === `setup` && event.kind === `line` ? parseStep(event.text)?.phase : undefined;
            if (phase !== undefined && setupCommandFailure.value !== undefined) {
                clearCommandFailureTimer();
                setupCommandFailure.value = undefined;
                setupError.value = undefined;
            }
            if (marker === undefined) {
                runs.value = { ...runs.value, [event.run]: [...eventsOf(event.run), event] };
            }
            // Folded as each line arrives, since the model needs to know when each phase started.
            if (event.run === `setup` && progress.value !== undefined) {
                now.value = Date.now();
                progress.value = advance(progress.value, event, now.value);
            }
            if (event.run !== `setup`) {
                return;
            }
            if (event.kind === `started`) {
                setupLog.value = event.log ?? undefined;
                return;
            }
            if (event.kind === `exit`) {
                clearCommandFailureTimer();
                setupExit.value = event.code;
                return;
            }
            // What this device still needs, keyed by id, as the installer reports it.
            const requirement = marker?.kind === `requirement` ? marker.requirement : undefined;
            if (requirement !== undefined) {
                // First requirement of a new run replaces the last run's list; keying by id collapses a duplicate.
                const kept = carried.value ? [] : requirements.value.filter((seen) => seen.id !== requirement.id);
                carried.value = false;
                requirements.value = [...kept, requirement];
                return;
            }
            // Live per-requirement progress, the difference between a checklist and one frozen spinner.
            const state = marker?.kind === `state` ? marker.state : undefined;
            if (state !== undefined) {
                requirementState.value = { ...requirementState.value, [state.id]: state };
            }
        }),
        onPendingSetup(() => void loadPending()),
        onPendingRecreate(() => void drainRecreate()),
        onPendingSync(() => void drainSync()),
        onUpdate((stage) => (update.value = stage)),
    ]);
    // The read the listener can't replace: this window often opens after a launch-time download finished.
    updateState()
        .then((stage) => (update.value = stage))
        .catch(() => undefined);
    // A link that arrived while this screen was opening is parked, picked up once by whichever of the event or this
    // read finds it first. `loadPending` owns `faceKnown` so the title waits only for what matters.
    //
    // The engine is woken as soon as THAT question is answered rather than after everything else here: a setup
    // handles Docker itself, and where there is no setup the wait has already started by the time the first
    // listing comes back.
    const handover = loadPending();
    void handover.then(wakeDockerIfNeeded);
    // Not awaited: a setup parked across a restart must resume whatever a booting Docker is doing to the listing.
    void refresh();
    await Promise.all([handover, drainRecreate(), drainSync()]);
    // Only when nothing was handed over: a fresh link outranks a setup resumed from an earlier restart.
    if (pending.value === undefined) {
        await loadResumable();
    }
});
onUnmounted(() => {
    window.removeEventListener(`keydown`, onKey);
    clearInterval(ticker);
    clearCommandFailureTimer();
    stop.forEach((unlisten) => unlisten());
});
</script>

<template>
    <!-- ONE ROOT, TWO FACES, AND THE WINDOW IS THE CARD. -->
    <!-- The setup face wears the entry skin (@intentic/entry-css) — the same metals, ground and type /setup was wearing
     when it handed this window the install. The manager face is the workspace's own look, and keeps it. -->
    <div class="h-dvh overflow-auto bg-canvas text-content" :class="setupMode ? `entry launcher` : ``">
        <div ref="content" class="flex w-full flex-col gap-3 p-4" :class="setupMode ? `gap-5 p-6` : ``">
            <!-- SETUP: a SCREEN of this window, in the middle of the frame the workspace was filling (windows.rs), not a second window standing in front of it. -->
            <template v-if="setupMode">
                <!-- THE HEADER IS THE TITLE BAR: every press on it that isn't the way back moves the window (dragWindow.ts). -->
                <header class="flex items-center gap-3 select-none" @mousedown="dragWindow">
                    <AppBrand shape="mark" class="shrink-0 text-2xl" />
                    <h1 class="min-w-0 flex-1 text-2xl leading-tight font-semibold">
                        {{ t(`desktop.app.settingUp`) }} {{ pending?.name ?? t(`desktop.app.sandbox`) }}<span class="text-primary-fill">.</span>
                    </h1>
                    <!-- SAYS WHERE IT GOES, in its label, because a bare × on a screen that fills its window reads as "close Intentic", which is the one thing it does not do. -->
                    <button
                        type="button"
                        :class="ui.iconButton(`-my-0.5 h-7 w-7`)"
                        :aria-label="dismissLabel"
                        v-tooltip.left="dismissLabel"
                        @click="dismissSetup"
                    >
                        <Icon name="times" />
                    </button>
                </header>

                <!-- What the next few minutes are, in one sentence; gone once the run has stopped, when the card below is the true one. -->
                <p v-if="!expired && !setupError && !wasStopped" class="-mt-2 max-w-read-sm text-sm leading-relaxed text-muted">
                    <template v-if="resuming">{{ t(`desktop.app.pickingUpWhereRestart`) }}</template>
                    <template v-else-if="requirementsShown">{{ t(`desktop.app.nothingOnComputerChanges`) }}</template>
                    <template v-else>{{ t(`desktop.app.gettingComputerReadyStarting`) }}</template>
                </p>

                <!-- The code this window came back to is older than the platform will accept: not a dead end, one click. -->
                <Notice v-if="expired" tone="warning" class="items-center text-xs">
                    <span class="flex-1">
                        {{ t(`desktop.app.setupCodeRanOut`) }}
                    </span>
                    <Button class="ml-2 shrink-0" size="small" severity="secondary" :label="t(`desktop.app.getFreshCode`)" @click="freshCode" />
                </Notice>
                <!-- `=== false`, not `!`: unknown is a real third state here, not yet a warning. -->
                <p v-if="dockerReady === false && !expired && requirements.length === 0" class="flex items-start gap-2.5 text-xs text-subtle">
                    <Icon name="box" class="mt-0.5 shrink-0 text-warning" />
                    <span v-if="info?.os === `windows`">{{ t(`desktop.app.sandboxRunsInDocker`) }}</span>
                    <span v-else>{{ t(`desktop.app.sandboxRunsInDocker2`) }}</span>
                </p>

                <!-- Leads above the progress bar, since it's the only thing here to act on and the machines that produce it have the most rows to scroll past. -->
                <Requirements
                    v-if="requirementsShown"
                    :requirements="requirements"
                    :busy="running"
                    :progress="requirementState"
                    :resumed-from="resumedHow"
                    @install="installRequirements"
                    @restart="endSession(`restart`)"
                    @signout="endSession(`signout`)"
                    @recheck="runSetup"
                    @elsewhere="setUpElsewhere(`requirements`)"
                />

                <!-- Only where the progress card cannot say it: with a plan on screen, the failure is told once, there. -->
                <Notice v-else-if="setupError && !expired && !progressShown" tone="danger" class="text-xs">{{ setupError }}</Notice>

                <!-- A user-ended run isn't a failure, but still gets said out loud rather than just stopping silently. -->
                <p v-if="wasStopped" class="flex items-start gap-2.5 text-xs text-subtle">
                    <Icon name="times" class="mt-0.5 shrink-0" />
                    <span>{{ t(`desktop.app.stoppedInstallNothingElse`) }}</span>
                </p>

                <SetupProgress
                    v-if="progressShown && !expired"
                    :events="eventsOf(`setup`)"
                    :view="progressShown"
                    :running="activeRun === `setup`"
                    :reason="setupError"
                    :awaiting="awaitingConsent"
                    :blocked="requirementsShown"
                    v-model:open="setupLogOpen"
                />

                <!-- Only on failure: the way out otherwise is the header's, not a repeated button here. -->
                <!-- The hosted alternative rides the same row, as it does on the requirements card: a stopped install
     is the other place a reader learns this computer is not where they want their sandbox. -->
                <div v-if="(setupError || wasStopped) && !expired && requirements.length === 0" class="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Button :label="t(`ui.action.tryAgain`)" :disabled="running" @click="runSetup">
                        <template #icon><Icon name="bolt" /></template>
                    </Button>
                    <button type="button" :class="ui.textAction()" :disabled="running" @click="setUpElsewhere(`stopped`)">
                        <Icon name="server" class="shrink-0" />
                        <span>{{ t(`desktop.requirements.runOnMachineWe`) }}</span>
                    </button>
                </div>

                <!-- THE FOOT OF THE CARD: the true sentence about leaving, then the quiet verbs. None of them is the accent —
     nothing here is what the reader came to press, and `Stop` least of all. -->
                <footer v-if="!expired" class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-subtle">
                    <span v-if="running" class="min-w-0 flex-1">{{ t(`desktop.app.closingWindowDoesntStop`) }}</span>
                    <span v-else class="flex-1" />
                    <button v-if="running" type="button" :class="ui.textAction(`shrink-0`)" :disabled="stopping" v-action="stopSetup">
                        {{ stopping ? t(`desktop.app.stopping`) : t(`ui.action.stop`) }}
                    </button>
                    <button v-if="progressShown" type="button" :class="ui.textAction(`shrink-0`)" @click="setupLogOpen = !setupLogOpen">
                        {{ setupLogOpen ? t(`desktop.app.hideLog`) : t(`desktop.app.showLog`) }}
                    </button>
                    <!-- Only beside an open log: away from it, "copy" and "folder" name a thing the reader has not been shown. -->
                    <template v-if="setupLogOpen">
                        <button type="button" :class="ui.textAction(`shrink-0`)" v-action="copyLog">
                            {{ logCopied ? t(`ui.action.copied`) : t(`desktop.app.copy`) }}
                        </button>
                        <button v-if="setupLog" type="button" :class="ui.textAction(`shrink-0`)" v-tooltip.top="setupLog" v-action="openLogFolder">
                            {{ t(`desktop.app.openFolder`) }}
                        </button>
                    </template>
                </footer>
            </template>

            <!-- THE MANAGER: what this machine is running, once nothing is being handed over. -->
            <template v-else>
                <!-- THE MASTHEAD IS THE TITLE BAR: the SPA's device page masthead (DevicePage.vue), and every press on it that isn't a control moves the window (dragWindow.ts). -->
                <Row :flush="true" :heading="2" density="comfortable" :title="t(`desktop.app.device`)" class="select-none" @mousedown="dragWindow">
                    <template #lead="{ mark }">
                        <span
                            class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                            :style="{ width: `${mark}px`, height: `${mark}px` }"
                        >
                            <Icon name="desktop" class="text-sm" />
                        </span>
                    </template>
                    <template v-if="hardware !== ``" #description>{{ hardware }}</template>
                    <!-- This app's own version, not the agent's: the agent states its build in the group below, as it does on the web page. -->
                    <template v-if="info" #meta
                        ><span class="font-mono">v{{ info.version }}</span></template
                    >
                    <template #control>
                        <Button size="small" severity="secondary" :text="true" :label="t(`ui.action.refresh`)" :disabled="running" @click="refresh">
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <button
                            type="button"
                            :class="ui.iconButton(`h-7 w-7`)"
                            :aria-label="t(`desktop.app.backToWorkspace`)"
                            v-tooltip.left="t(`desktop.app.backToWorkspace`)"
                            @click="openWorkspace()"
                        >
                            <Icon name="times" />
                        </button>
                    </template>
                </Row>

                <!-- Describes what's true now, never what will happen later. -->
                <Notice v-if="update.kind === `ready`" tone="info" class="items-center">
                    <span>{{ t(`desktop.app.intenticDownloadedInstallsQuit`, { version: update.version }) }}</span>
                    <Button class="ml-2" size="small" severity="secondary" :label="t(`desktop.app.updateRestart`)" @click="applyUpdate" />
                </Notice>
                <Notice v-else-if="update.kind === `downloading`" tone="info" class="items-center">{{
                    t(`desktop.app.downloadingIntentic`, { version: update.version, percent: update.percent })
                }}</Notice>
                <!-- Covers installs a .deb/.rpm release has no artifact for, and copies whose signature check can no longer pass. -->
                <Notice v-else-if="update.kind === `manual`" tone="warning" class="items-center">
                    <span>{{ update.reason }}</span>
                    <button type="button" class="ml-2 cursor-pointer text-left text-link hover:underline" @click="openUrl(update.url)">
                        {{ t(`desktop.app.getLatestVersion`) }}
                    </button>
                </Notice>
                <!-- Only beside the offer it refused: a failed install turns the offer into the download notice above, which says why. -->
                <Notice v-if="updateError && update.kind === `ready`" tone="warning" class="items-center">{{ updateError }}</Notice>

                <!-- THE ENGINE, while this window is starting it and after a start that did not work out. It leads
                     the screen because a sandbox list drawn above a dead Docker is a list of things that are not there. -->
                <DockerCard
                    v-if="dockerCardShown"
                    :starting="dockerStarting"
                    :started-at="dockerStartedAt"
                    :limit-seconds="info?.engineLimitSeconds"
                    :report="dockerReport"
                    :os="info?.os"
                    @start="startDocker"
                    @open="openDocker"
                    @install="openUrl(DOCKER_DOCS)"
                />
                <!-- Docker answered and refused, or never answered: its own words, and the press that asks again. -->
                <Notice v-else-if="listError" tone="warning" class="items-start text-2xs">
                    <span class="block font-medium">{{ t(`desktop.app.dockerDidntAnswer`) }}</span>
                    <span class="mt-0.5 block font-mono break-words text-subtle">{{ listError }}</span>
                    <Button class="mt-2" size="small" severity="secondary" :label="t(`desktop.docker.checkAgain`)" :disabled="running" @click="refresh" />
                </Notice>
                <!-- Docker is down and nothing here started it on its own: no sandbox has run on this machine yet, so
                     the start is offered rather than taken. -->
                <p v-else-if="engineListening === false" class="flex flex-wrap items-center gap-x-3 gap-y-2 text-2xs text-muted">
                    <Icon name="box" class="shrink-0" />
                    <span class="min-w-0 flex-1">{{ t(`desktop.app.dockerIsntReachableNothing`) }}</span>
                    <Button size="small" severity="secondary" :label="t(`desktop.app.startDocker`)" @click="startDocker" />
                </p>
                <!-- Hidden while a sync enrollment is on screen, or the empty-state message would contradict it. -->
                <p v-else-if="groups.length === 0 && !syncSetup" class="text-2xs text-muted">
                    {{ t(`desktop.app.noSandboxesHereYet`) }}
                </p>

                <!-- The agent didn't answer, which is a different absence from having none: said here rather than under a list it explains the emptiness of. -->
                <Notice v-if="reportError" tone="danger" class="text-2xs">{{ reportError }}</Notice>

                <!--
    The SPA's own agent group (DeviceAgentGroup), drawn from this machine's own reading instead of a device
    registry. This window IS the device, so its one verb never needs a command to go and type.
-->
                <DeviceAgentGroup
                    v-if="agentPanel"
                    :panel="agentPanel"
                    :subject="machineName"
                    :busy="running || busy !== undefined"
                    :running="agentRestarting ? `restart` : undefined"
                    :activity="agentRestartError !== undefined || agentRestartOutcome !== undefined"
                    @run="void restartAgent()"
                >
                    <!-- The agent's own answer, refusal or otherwise; the row above already shows whether the loop came back. -->
                    <template #activity>
                        <Notice v-if="agentRestartError" tone="danger" class="text-2xs">{{ agentRestartError }}</Notice>
                        <p v-else class="text-xs text-muted">{{ agentRestartOutcome }}</p>
                    </template>
                </DeviceAgentGroup>

                <!-- A sync enrollment in flight: folder picked in the system dialog, same script as the card's one-liner, narrating here. -->
                <section v-if="syncSetup" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
                    <div class="flex items-start gap-2.5">
                        <Icon name="sync" class="mt-0.5 text-primary-400" />
                        <div class="min-w-0 flex-1">
                            <h2 class="text-sm font-semibold leading-tight">
                                {{
                                    syncSetup.args.mirror
                                        ? t(`desktop.app.mirroringPortsFrom`, { sandbox: syncSetup.args.name ?? t(`desktop.app.yourSandbox`) })
                                        : t(`desktop.app.connectingFolderTo`, { sandbox: syncSetup.args.name ?? t(`desktop.app.yourSandbox`) })
                                }}
                            </h2>
                            <p v-if="syncSetup.dir" class="break-all font-mono text-2xs text-subtle">{{ syncSetup.dir }}</p>
                        </div>
                        <Button
                            v-if="syncSetup.error"
                            size="small"
                            severity="secondary"
                            :text="true"
                            class="-my-1 shrink-0"
                            @click="() => (syncSetup = undefined)"
                        >
                            {{ t(`ui.action.dismiss`) }}
                        </Button>
                    </div>
                    <Notice v-if="syncSetup.error" tone="danger" class="text-2xs">{{ syncSetup.error }}</Notice>
                    <DeviceRunLog
                        :lines="syncLines"
                        :running="activeRun === `sync-setup`"
                        :empty="t(`desktop.app.startingOnDevice`)"
                        :note="t(`desktop.app.installingSyncAgentStarting`)"
                    />
                    <!-- The pairing is single-use, so a failed-after-enrolling run needs a fresh one from the sandbox's Desktop sync card. -->
                    <div v-if="syncSetup.error" class="flex flex-wrap items-center gap-3">
                        <Button :label="t(`ui.action.tryAgain`)" size="small" :disabled="running" @click="retrySync">
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <span class="text-2xs text-subtle">{{ t(`desktop.app.saysPairingAlreadyUsed`) }}</span>
                    </div>
                </section>

                <!-- One row per sandbox with its folder, ports, image and verbs, in the SPA's Devices tab's own group. -->
                <RowGroup v-if="groups.length > 0" :label="t(`desktop.app.sandboxesOnDevice`)" :count="groups.length">
                    <RowNote variant="block">
                        <DeviceDetail :pairings="status?.sync.pairings" :ports="status?.sync.ports" :sandboxes="sandboxRows">
                            <template #actions="{ group }">
                                <SandboxVerbs
                                    v-if="group.sandbox"
                                    :running="group.sandbox.running"
                                    :busy="busyVerb(group)"
                                    :disabled="running || busy !== undefined"
                                    :logs-open="logOpen(group)"
                                    @act="(verb) => act(group, verb)"
                                />
                            </template>
                            <!-- The machine's own output, while a row works and for as long as its log tail stays open. -->
                            <template #footer="{ group }">
                                <DeviceRunLog
                                    v-if="busyVerb(group) || logOpen(group)"
                                    :lines="paneLines(group)"
                                    :running="busyVerb(group) !== undefined"
                                    :empty="t(`desktop.app.startingOnDevice`)"
                                    :note="t(`desktop.app.runningOnDeviceKeeps`)"
                                />
                                <Notice v-if="rowFailure && rowFailure.slug === group.sandbox?.slug" tone="danger" class="text-2xs">
                                    {{ rowFailure.message }}
                                </Notice>
                            </template>
                        </DeviceDetail>
                    </RowNote>
                </RowGroup>

                <footer class="flex flex-wrap items-center gap-2 pt-1">
                    <Button size="small" severity="secondary" :label="t(`desktop.app.openWorkspace`)" @click="openWorkspace()">
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <!-- The other screen that manages these same containers, reached through the machine's own connection rather than natively. -->
                    <Button
                        size="small"
                        severity="secondary"
                        :text="true"
                        :label="t(`desktop.app.seeAllDevices`)"
                        @click="openWorkspace(DEVICES_PATH)"
                    >
                        <template #icon><Icon name="desktop" /></template>
                    </Button>
                    <span v-if="info" class="truncate font-mono text-2xs text-subtle">{{ info.appUrl }}</span>
                </footer>

                <!-- The sandbox's current share (from docker) and this engine's size for the form's rails; no self-warning. -->
                <SandboxResourcesDialog
                    :open="reshaping !== undefined"
                    :name="reshaping?.title ?? ``"
                    :current="reshaping?.sandbox?.resources"
                    :engine="engine"
                    @cancel="reshaping = undefined"
                    @apply="applyReshape"
                />
            </template>
        </div>
    </div>
</template>
