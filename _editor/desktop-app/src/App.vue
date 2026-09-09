<script setup lang="ts">
import {
    Button,
    DeviceDetail,
    DeviceRunLog,
    type DeviceSandboxGroup,
    type DeviceSandboxRow,
    type DeviceAgentState,
    Notice,
    type ResourcesAsk,
    SandboxResourcesDialog,
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
import Requirements from "./components/Requirements.vue";
import SetupProgress from "./components/SetupProgress.vue";
import { useFitToContent } from "./fitWindow";
import { advance, type PlanStep, progressView, setupPlan, startProgress, tick, type Progress } from "./setupPlan";
import {
    desktopInfo,
    // Aliased so the ref below can use the plain name `dockerReady`.
    dockerReady as dockerReadyProbe,
    dockerEngine,
    expectedStop,
    folderEntries,
    forgetResumableSetup,
    deviceAgentRestart,
    deviceStatus,
    onPendingRecreate,
    onPendingSetup,
    onPendingSync,
    onRun,
    onUpdate,
    readMarker,
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
    takePendingRecreate,
    takePendingSetup,
    takePendingSync,
    updateInstall,
    updateState,
    workspaceOpen,
    type DesktopInfo,
    type DeviceStatus,
    type DockerEngine,
    type Requirement,
    type RequirementProgress,
    type RunEvent,
    type SandboxStatus,
    type SetupArgs,
    type SetupReport,
    type SyncArgs,
    type UpdateStage,
} from "./desktop";

/* THE APP'S OWN FACE: the other half of the one window, and deliberately not a wizard.
 *
 * The workspace face shows the real product (the hosted SPA), so everything about naming a sandbox, picking
 * reachability and minting a setup code stays there, where it already works and where a change ships without
 * an app release. What is left for this one is the two things a web page on another origin cannot do:
 *
 *   • run the setup the SPA just handed over (an `intentic://setup` link), showing what the script says
 *   • manage the containers on THIS machine afterwards: the sandbox rows and their verbs
 *
 * They are two SCREENS of one window, and they arrive the same way: this face comes up in the middle of the
 * workspace's frame and that one steps aside (windows.rs). The setup screen used to be the exception — a small
 * window in FRONT of the workspace, with that window left mapped behind it — and what it produced was two
 * Intentic windows during onboarding, which is the one flow where a new user has no idea which of them is the
 * product. An install is a screen of this app, so it looks like one.
 *
 * AND THE WINDOW IS THE CARD. This face used to be drawn as a card at the top of the workspace's whole frame,
 * under an OS title bar, over a dark void the size of a monitor; what is on screen now is the card and
 * nothing else. The window has no decorations, its header is the page's own (draggable, with a small × that
 * says where it goes), and its height follows the content below (`useFitToContent`), so ten plan rows and a
 * requirements list above them are exactly what the window is tall enough for and a two-line manager is not
 * a screenful of nothing.
 *
 * Nothing of the manager shows under it either way: a container list, a version and an "Open workspace"
 * button would be a set of decisions to make about a machine whose sandbox is still being built.
 *
 * The archived version had three personas here (a wizard, an environment checklist, a manager) in 527 lines.
 * The checklist is gone because the scripts do the reconciling and narrate it as they go; the wizard is gone
 * because it was a second copy of the SPA's setup screen.
 *
 * ONE LIST, AND IT IS THE WEB'S. This screen and the SPA's Devices tab manage the same containers on the same
 * machine, and they had drifted into two answers: this one printed its sandboxes as cards with their own buttons
 * and then printed the SAME sandboxes again underneath as folders and ports, under a second heading, with
 * nothing on screen relating the two: the exact double-rendering the Devices tab was rebuilt to remove. It
 * now hands its containers to <DeviceDetail>, the way that tab does, so a sandbox is one row carrying its
 * folder, its ports, its image and its verbs. The verbs are the kit's too (<SandboxVerbs>), so "which buttons
 * exist here" is no longer a thing two apps can disagree about: this window had a log tail and no Restart, the
 * tab had a Restart and no log tail, and neither offered the rollback both of their backends could already do. */

const info = ref<DesktopInfo | undefined>(undefined);
/* The box the window is fitted to: whichever face is up, measured (fitWindow.ts). One ref for both faces
 * because the root around them is one element, and the window follows whatever it holds. */
const content = ref<HTMLElement | undefined>(undefined);
// Resources form parked on its row until Apply or Cancel answers it. Declared with the fit rather than beside
// its handlers, because the window's height depends on whether it is open.
const reshaping = ref<DeviceSandboxGroup | undefined>(undefined);
/* A DIALOG NEEDS A WINDOW TO BE A DIALOG IN: an overlay is `position: fixed`, so a card-tall window clips it
 * to its first row. The floor is the SCREEN's height and never the window's, which would feed the next
 * resize; Rust clamps it to the work area (windows.rs `fit_to_content`). */
const dialogFloor = computed(() => (reshaping.value === undefined ? 0 : globalThis.screen.availHeight));
useFitToContent(content, dialogFloor);
/* WHETHER DOCKER ANSWERS, AND `undefined` UNTIL IT HAS BEEN ASKED — a third state this screen genuinely has
 * and used to pretend it did not.
 *
 * It rode `info` until the probe behind it turned out to be the slowest thing this window does (desktop.ts,
 * and the Rust command's own comment): tens of seconds on a machine where Docker is installed and stopped,
 * which is the ordinary machine an `intentic://setup` link lands on. Waiting for it meant a window that drew
 * nothing and was not even titled while the user who had just clicked "Set up" watched it.
 *
 * So it is asked apart and nothing waits for it. Everything that reads it below already had to say what it
 * does when the answer is missing, because `info` was itself absent for the first tick; the difference now is
 * that the gap is measured in the machine's terms rather than the window's, and is honest about it. */
const dockerReady = ref<boolean | undefined>(undefined);
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
const stopping = ref(false);
// Exit code of the last setup, to tell a designed stop from something going wrong.
const setupExit = ref<number | null | undefined>(undefined);
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

// Path to the SPA's Devices tab, which manages the same containers via the machine's own connection.
const DEVICES_PATH = `/sandbox/devices`;

// Wrapped since `workspaceOpen` takes an optional path; a bare click handler would pass it a MouseEvent.
const openWorkspace = (path?: string): void => void workspaceOpen(path);

const eventsOf = (run: string): RunEvent[] => runs.value[run] ?? [];
const running = computed(() => activeRun.value !== undefined);

// A designed stop (desktop.ts) isn't a failure; hoisted so both the bar and the card read the same fact.
const awaitingConsent = computed(() => !running.value && requirements.value.length > 0 && expectedStop(setupExit.value ?? null));

// True once every requirement reports `done`, so an answered list stops being drawn as unanswered.
const requirementsSettled = computed(
    () => requirements.value.length > 0 && requirements.value.every((requirement) => requirementState.value[requirement.id]?.state === `done`),
);
// A handed-over setup owns the window until it hands back, including while failed.
const setupMode = computed(() => setupOpen.value || activeRun.value === `setup`);

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

const refresh = async (): Promise<void> => {
    // Alongside the list, not blocking it: this answer only sizes a form nobody has opened, and it's slow.
    void dockerEngine()
        .then((facts) => (engine.value = facts ?? undefined))
        .catch(() => (engine.value = undefined));
    try {
        sandboxes.value = await sandboxList();
        listError.value = undefined;
    } catch (error) {
        // Docker not being up is ordinary on an unset-up machine, so this reads as empty-with-explanation.
        sandboxes.value = [];
        listError.value = String(error);
    }
    // Read separately from the sandbox list: the agent and docker can each be absent independently on a working
    // device.
    try {
        status.value = await deviceStatus();
        reportError.value = undefined;
    } catch (error) {
        status.value = undefined;
        reportError.value = String(error);
    }
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

// Compares the agent's running build against what's installed, since the loop keeps serving its starting build
// until restarted after an upgrade.
const deviceAgent = computed<DeviceAgentState | undefined>(() => {
    const agent = status.value?.sync.agent;
    if (agent === undefined) {
        return undefined;
    }
    const runningBuild = agent.build;
    const installed = agent.installed;
    // An unstamped running build predates the stamp (older, not missing); `0.0.0` marks a working-tree agent, never
    // stale.
    if (!agent.running || installed === undefined || installed === `0.0.0` || runningBuild === installed) {
        return agent;
    }
    return { ...agent, staleBuild: { running: runningBuild, installed } };
});

// Restarting the loop from the window: this app runs ON the device the two commands were for, so nothing here has
// any business asking for a terminal. The report is re-read afterwards, since the agent's state IS the answer.
const agentRestarting = ref(false);
const agentRestartError = ref<string | undefined>(undefined);
const restartAgent = async (): Promise<void> => {
    if (agentRestarting.value) {
        return;
    }
    agentRestarting.value = true;
    agentRestartError.value = undefined;
    try {
        await deviceAgentRestart();
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

// Whether the shared view has anything to draw: containers, folders and ports independently, since a pruned
// container can leave only the latter two.
const hasRows = computed(
    () => sandboxes.value.length > 0 || (status.value?.sync.pairings.length ?? 0) > 0 || (status.value?.sync.ports.length ?? 0) > 0,
);

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

/* The sandbox's name as the user typed it, for every report that carries one (the workspace's strip says
 * "Installing work on this device"), absent rather than empty when there is none. */
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

/* HOW A RUN THAT HAS ENDED IS READ, apart from the run so each half stays readable. `failure` is what `start`
 * answered: nothing for a run that finished, the script's own words otherwise. */
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
    setupError.value = ok || stopping.value || deferredToTheList ? undefined : failure;
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
    // unnoticed; `setupAlert` points at it without stealing focus.
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
    /* WALKING AWAY FROM A LIVE RUN KEEPS THIS A SETUP. The run is still going, and if it stops while nobody is
     * looking `setupAlert` brings this window back — to THIS screen, holding the failure, which it could not
     * do while the dismissal cleared `setupOpen` on the way out: the alert then raised the manager's list of
     * containers, with the reason the install died nowhere on it. Only a card whose run has ended is closed
     * for good here, which is also the one case the workspace's own strip should come down. */
    if (!running.value) {
        setupOpen.value = false;
        void setupProgress({ ...nameOf(pending.value), state: `closed`, percent: 0 });
    }
    await workspaceOpen();
};

/* WHAT THE × SAYS IT DOES, because it was the reported question: "clicking Back to your workspace while the
 * sandbox is going through setup gives no clear way of understanding if that stops setup". It does not, and
 * the label says so while there is a run to say it about. The workspace then draws the run's progress for
 * itself, off `reportProgress` below, so the answer is on the next screen as well as on this button. */
const dismissLabel = computed(() =>
    running.value ? `Back to your workspace. The install keeps running, and your workspace shows its progress.` : `Back to your workspace`,
);

/* THE BAR, TOLD TO THE WORKSPACE PAGE on every change (desktop.ts `setupProgress`, windows.rs
 * `announce_setup`), so the page a dismissed install lands on shows the same figures this card does instead
 * of "follow it in the Intentic window" about a window that just stepped aside. The state is the card's own
 * reading of the run, the same one its heading and its bar colour come from. Only while this is a setup: the
 * manager has nothing to report. */
const reportState = computed<SetupReport[`state`]>(() => {
    if (running.value) {
        return `running`;
    }
    if (awaitingConsent.value) {
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


/* THE WAY OUT THAT IS NOT "GIVE UP".
 *
 * This app's whole premise is that the sandbox runs on THIS device, and for most people it should. But the
 * list this button sits under is the moment where that premise is being tested hardest: a PC with no WSL2
 * and no Docker is being asked for administrator, a 600 MB download and a restart, and some of those readers
 * are on a machine where none of that is going to happen: a work laptop, a locked-down build, a PC too
 * small for it. Until now the app had nothing to say to them, while the browser has handed that reader a
 * machine we host all along; it was hidden here on the argument that "this device" is the whole point of
 * being in the app.
 *
 * It is the point right up until it cannot work, and then it is a dead end. Local stays the loud default and
 * this stays one quiet line under it, in the one place where it is the more useful answer.
 */
const setUpElsewhere = async (): Promise<void> => {
    track(`desktop_install_elsewhere`, { requirements: requirements.value.map((requirement) => requirement.id) });
    setupOpen.value = false;
    await workspaceOpen(`/setup?elsewhere=1`);
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
    track(`desktop_recreate_finished`, { mode: `reshape`, source: `manager`, ...runOutcome(RUN_OF.resources(slug), failure === undefined, startedAt) });
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
};

/* ESCAPE IS THE ×: this window has no title bar to find one on, and a card that can be dismissed by a key is
 * a card that reads as a card. Not while a dialog of this screen's own is open, whose Escape is its own. */
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
        rowFailure.value = { slug, message: `Docker didn't describe this sandbox's share of this computer. Refresh and try again.` };
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
    const picked = await open({ directory: true, multiple: false, title: `Choose the folder to keep in sync with ${what}` });
    if (typeof picked !== `string` || picked === ``) {
        // Cancelled: nothing ran, so just return to the card that asked.
        await workspaceOpen();
        return;
    }
    const entries = await folderEntries(picked).catch(() => 0);
    const held = entries === 0 ? `` : `\n\nIt already holds ${entries} item${entries === 1 ? `` : `s`}, and the sandbox's own files land in it too.`;
    const agreed = await confirm(
        `${picked}\n\nEverything in this folder syncs BOTH ways with ${what}: changes agents make in the sandbox appear here, with no undo.${held}`,
        { title: `Keep this folder in sync with ${what}?`, kind: `warning`, okLabel: `Start syncing` },
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
    await Promise.all([refresh(), loadPending(), drainRecreate(), drainSync()]);
    // Only when nothing was handed over: a fresh link outranks a setup resumed from an earlier restart.
    if (pending.value === undefined) {
        await loadResumable();
    }
});
onUnmounted(() => {
    window.removeEventListener(`keydown`, onKey);
    clearInterval(ticker);
    stop.forEach((unlisten) => unlisten());
});
</script>

<template>
    <!-- ONE ROOT, TWO FACES, AND THE WINDOW IS THE CARD. Both screens share this scroll container and the
         measured column inside it (`content`): the window is fitted to the column's height (fitWindow.ts) and
         the container is what scrolls once the screen has run out of room. There is no card drawn inside,
         because the window's own edge is the card's edge now: this face has been all three shapes — a
         chromeless sheet across the screen, a small dialog window over the workspace, and a card at the top of
         the workspace's whole frame — and the last of those was a monitor's worth of dark canvas around one
         card's worth of content, under an OS title bar. -->
    <div class="h-dvh overflow-auto bg-canvas text-content">
        <div ref="content" class="flex w-full flex-col gap-3 p-4">
            <!-- SETUP: a SCREEN of this window, in the middle of the frame the workspace was filling (windows.rs),
                 not a second window standing in front of it. Anchored to the TOP of its window rather than
                 floating: the heading does not move as rows arrive under it, and the window grows downward. -->
            <template v-if="setupMode">
                <!-- THE HEADER IS THE TITLE BAR. There is no OS one to drag the card by or to close it with, so
                     this row is the drag region and carries the ×. The text inside is inert to the pointer so
                     a press anywhere on the row is a press on the row. -->
                <header data-tauri-drag-region class="flex items-start gap-2.5 select-none">
                    <Icon name="bolt" class="pointer-events-none mt-0.5 text-primary-400" />
                    <div class="pointer-events-none min-w-0 flex-1">
                        <h1 class="font-semibold leading-tight">Setting up {{ pending?.name ?? `your sandbox` }} on this device</h1>
                        <p class="text-2xs text-subtle">
                            Running exactly what the install command runs: starts your sandbox in Docker, connects its tunnel, and opens your
                            workspace once it answers.
                        </p>
                    </div>
                    <!-- SAYS WHERE IT GOES, in its label, because a bare × on a screen that fills its window
                         reads as "close Intentic", which is the one thing it does not do: it steps back to the
                         workspace and nothing else, and the install carries on, being a process on this
                         machine rather than something this window is holding up. The label says that too,
                         while there is a run to say it about. -->
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
                <!-- The code this window came back to is older than the platform will accept. Said plainly, with
                 the one thing that fixes it, instead of letting the run fail at the claim with something that
                 reads like a bad code. -->
                <Notice v-if="expired" tone="warning" class="text-2xs">
                    Your setup code ran out while this device restarted. Open the setup page again for a fresh one: everything the restart was for
                    is already done.
                </Notice>
                <p v-else-if="resuming" class="flex items-start gap-2 text-2xs text-subtle">
                    <Icon name="refresh" class="mt-0.5 shrink-0" />
                    <span>Picking up where the restart left off.</span>
                </p>
                <!-- `=== false`, not `!`: unknown is a real third state here, not yet a warning. -->
                <p v-if="dockerReady === false && !expired && requirements.length === 0" class="flex items-start gap-2 text-2xs text-warning">
                    <Icon name="box" class="mt-0.5 shrink-0" />
                    <span v-if="info?.os === `windows`"
                        >Docker isn't running yet: this checks what your PC needs first, and asks before changing anything.</span
                    >
                    <span v-else>Docker isn't running yet: setup installs it first, so your system will ask for your password once.</span>
                </p>

                <!--
                    Leads above the progress bar, since it's the only thing here to act on and the machines that
                    produce it have
                    the most rows to scroll past. Replaces the red box rather than sitting beside it, to avoid saying
                    it twice.
                -->
                <Requirements
                    v-if="requirements.length > 0 && !expired && !requirementsSettled"
                    :requirements="requirements"
                    :busy="running"
                    :progress="requirementState"
                    @install="installRequirements"
                    @restart="endSession(`restart`)"
                    @signout="endSession(`signout`)"
                    @recheck="runSetup"
                    @elsewhere="setUpElsewhere"
                />

                <Notice v-else-if="setupError && !expired" tone="danger" class="text-2xs">{{ setupError }}</Notice>

                <!-- A user-ended run isn't a failure, but still gets said out loud rather than just stopping silently. -->
                <p v-if="wasStopped" class="flex items-start gap-2 text-2xs text-subtle">
                    <Icon name="times" class="mt-0.5 shrink-0" />
                    <span>You stopped this install. Nothing else is running on this device.</span>
                </p>

                <SetupProgress
                    v-if="progressShown && !expired"
                    :events="eventsOf(`setup`)"
                    :view="progressShown"
                    :running="activeRun === `setup`"
                    :awaiting="awaitingConsent"
                />

                <!-- Only on failure: the way out otherwise is the header's, not a repeated button here. -->
                <div v-if="(setupError || wasStopped) && !expired && requirements.length === 0" class="flex flex-wrap items-center gap-2">
                    <Button label="Try again" :disabled="running" @click="runSetup">
                        <template #icon><Icon name="bolt" /></template>
                    </Button>
                </div>

                <!--
                    Stop and Copy log: a run that goes wrong can now be ended, not just abandoned. The transcript is
                    always written
                    (scripts.rs); these are the two ways to reach it.
                -->
                <div v-if="!expired" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-2xs">
                    <button v-if="running" type="button" class="text-link hover:underline" :disabled="stopping" v-action="stopSetup">
                        {{ stopping ? `Stopping…` : `Stop` }}
                    </button>
                    <button type="button" class="text-link hover:underline" v-action="copyLog">
                        {{ logCopied ? `Copied` : `Copy log` }}
                    </button>
                    <button v-if="setupLog" type="button" class="text-link hover:underline" v-action="openLogFolder">Open log folder</button>
                    <span v-if="setupLog" class="ml-auto truncate font-mono text-subtle">{{ setupLog }}</span>
                </div>
            </template>

            <!-- THE MANAGER: what this machine is running, once nothing is being handed over. The same card,
                 the same header row doing the title bar's job, and a × that is the way back to the workspace. -->
            <template v-else>
                <header data-tauri-drag-region class="flex items-center gap-3 select-none">
                    <h1 class="pointer-events-none flex-1 text-base font-semibold">This device</h1>
                    <span v-if="info" class="pointer-events-none font-mono text-2xs text-subtle">v{{ info.version }}</span>
                    <Button size="small" severity="secondary" :text="true" label="Refresh" :disabled="running" @click="refresh">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <button
                        type="button"
                        :class="ui.iconButton(`h-7 w-7`)"
                        aria-label="Back to your workspace"
                        v-tooltip.left="'Back to your workspace'"
                        @click="openWorkspace()"
                    >
                        <Icon name="times" />
                    </button>
                </header>

            <!--
                Describes what's true now, never what will happen later. Only `ready` gets a button (a restart, not a
                download), since by then the installer is already on this machine.
            -->
            <Notice v-if="update.kind === `ready`" tone="info" class="items-center">
                <span>Intentic {{ update.version }} is downloaded. It installs when you quit, or now:</span>
                <Button class="ml-2" size="small" severity="secondary" label="Update and restart" @click="applyUpdate" />
            </Notice>
            <Notice v-else-if="update.kind === `downloading`" tone="info" class="items-center">
                Downloading Intentic {{ update.version }}… {{ update.percent }}%
            </Notice>
            <!--
                Covers installs a .deb/.rpm release has no artifact for, and copies whose signature check can no longer
                pass.
            -->
            <Notice v-else-if="update.kind === `manual`" tone="warning" class="items-center">
                <span>{{ update.reason }}</span>
                <a class="ml-2 text-link hover:underline" :href="update.url" target="_blank" rel="noreferrer">Get the latest version</a>
            </Notice>
            <Notice v-if="updateError" tone="warning" class="items-center">{{ updateError }}</Notice>

            <p v-if="listError" class="flex items-start gap-2 text-2xs text-muted">
                <Icon name="box" class="mt-0.5 shrink-0" />
                <span>Docker isn't reachable, so there is nothing to show yet. Start Docker, or set a sandbox up from your workspace.</span>
            </p>
            <!-- Hidden while a sync enrollment is on screen, or the empty-state message would contradict it. -->
            <p v-else-if="!hasRows && !syncSetup" class="text-2xs text-muted">
                No sandboxes here yet. Set one up from your workspace: this screen is where you manage it afterwards.
            </p>

            <!--
                A sync enrollment in flight: folder picked in the system dialog, same script as the card's one-liner,
                narrating
                here. Gone on success (the card polls and flips to "Enabled" itself); stays, with a retry, on failure.
            -->
            <section v-if="syncSetup" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
                <div class="flex items-start gap-2.5">
                    <Icon name="sync" class="mt-0.5 text-primary-400" />
                    <div class="min-w-0 flex-1">
                        <h2 class="text-sm font-semibold leading-tight">
                            {{
                                syncSetup.args.mirror
                                    ? `Mirroring ports from ${syncSetup.args.name ?? `your sandbox`} to this device`
                                    : `Connecting a folder to ${syncSetup.args.name ?? `your sandbox`}`
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
                        Dismiss
                    </Button>
                </div>
                <Notice v-if="syncSetup.error" tone="danger" class="text-2xs">{{ syncSetup.error }}</Notice>
                <DeviceRunLog
                    :lines="syncLines"
                    :running="activeRun === `sync-setup`"
                    empty="Starting on this device…"
                    note="Installing the sync agent and starting the first sync."
                />
                <!--
                    The pairing is single-use, so a failed-after-enrolling run needs a fresh one from the sandbox's
                    Desktop sync
                    card.
                -->
                <div v-if="syncSetup.error" class="flex flex-wrap items-center gap-3">
                    <Button label="Try again" size="small" :disabled="running" @click="retrySync">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <span class="text-2xs text-subtle">If it says the pairing was already used or expired, regenerate it in your workspace.</span>
                </div>
            </section>

            <!--
                One row per sandbox with its folder, ports, image and verbs, matching the SPA's Devices tab. `syncDir`
                only ever
                fed connect.sh, so this is the only place these show for the same sandbox.
            -->
            <section v-if="hasRows || reportError" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
                <Notice v-if="reportError" tone="danger" class="text-2xs">{{ reportError }}</Notice>
                <!-- The agent's own refusal, in its words; the row above already shows whether the loop came back. -->
                <Notice v-if="agentRestartError" tone="danger" class="text-2xs">{{ agentRestartError }}</Notice>
                <DeviceDetail :pairings="status?.sync.pairings" :ports="status?.sync.ports" :sandboxes="sandboxRows" :agent="deviceAgent">
                    <!-- This window IS that device, so its agent is restarted here rather than named as two commands. -->
                    <template #agentAction>
                        <Button
                            size="small"
                            severity="secondary"
                            :label="agentRestarting ? `Restarting…` : `Restart agent`"
                            :loading="agentRestarting"
                            :disabled="running || busy !== undefined"
                            @click="void restartAgent()"
                        />
                    </template>
                    <!-- Agent state is a fact about the machine, shown once here rather than repeated per row. -->
                    <template #heading>
                        <span class="flex items-center gap-2 text-2xs font-semibold tracking-wide text-subtle uppercase">
                            Sandboxes on this device
                            <span v-if="status?.version" class="font-mono normal-case">agent v{{ status.version }}</span>
                        </span>
                    </template>
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
                            empty="Starting on this device…"
                            note="Running on this device: it keeps going even if you close this window."
                        />
                        <Notice v-if="rowFailure && rowFailure.slug === group.sandbox?.slug" tone="danger" class="text-2xs">
                            {{ rowFailure.message }}
                        </Notice>
                    </template>
                </DeviceDetail>
            </section>

            <footer class="flex flex-wrap items-center gap-2 pt-1">
                <Button size="small" severity="secondary" label="Open workspace" @click="openWorkspace()">
                    <template #icon><Icon name="arrow-up-right" /></template>
                </Button>
                <!--
                    The other screen that manages these same containers, reached through the machine's own connection
                    rather than
                    natively.
                -->
                <Button size="small" severity="secondary" :text="true" label="See all your devices" @click="openWorkspace(DEVICES_PATH)">
                    <template #icon><Icon name="desktop" /></template>
                </Button>
                <span v-if="info" class="truncate font-mono text-2xs text-subtle">{{ info.appUrl }}</span>
            </footer>

            <!--
                The sandbox's current share (from docker) and this engine's size for the form's rails; no self-warning,
                since
                this screen is never served by the sandbox it manages.
            -->
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
