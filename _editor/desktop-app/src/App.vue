<script setup lang="ts">
import {
    Button,
    Card,
    MachineDetail,
    MachineRunLog,
    type MachineSandboxGroup,
    type MachineSandboxRow,
    Notice,
    type SandboxVerb,
    SandboxVerbs,
    sandboxVerbPrompt,
    VERB_LABEL,
    vAction,
} from "@intentic/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { initAnalytics, track, trackBeforeExit } from "./analytics";
import Requirements from "./components/Requirements.vue";
import SetupProgress from "./components/SetupProgress.vue";
import { advance, type PlanStep, progressView, setupPlan, startProgress, tick, type Progress } from "./setupPlan";
import {
    desktopInfo,
    // Aliased: the ref holding the answer wants the plain name, this being the one place that asks the
    // question. See the ref's own comment for why the answer is a state of its own rather than a boolean.
    dockerReady as dockerReadyProbe,
    expectedStop,
    forgetResumableSetup,
    machineReport,
    onPendingRecreate,
    onPendingSetup,
    onRun,
    onUpdate,
    parseRequirement,
    parseRequirementState,
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
    setupAlert,
    setupRun,
    signOutForSetup,
    takePendingRecreate,
    takePendingSetup,
    updateInstall,
    updateState,
    workspaceOpen,
    type DesktopInfo,
    type MachineReport,
    type Requirement,
    type RequirementProgress,
    type RunEvent,
    type SandboxStatus,
    type SetupArgs,
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
 * They are two SCREENS of one window, and they arrive the same way: this face takes the frame the workspace
 * was filling and that one steps aside (windows.rs). The setup screen used to be the exception — a small
 * window in FRONT of the workspace, with that window left mapped behind it — and what it produced was two
 * Intentic windows during onboarding, which is the one flow where a new user has no idea which of them is the
 * product. An install is a screen of this app, so it looks like one.
 *
 * Nothing of the manager shows under it either way: a container list, a version and an "Open workspace"
 * button would be a set of decisions to make about a machine whose sandbox is still being built.
 *
 * The archived version had three personas here (a wizard, an environment checklist, a manager) in 527 lines.
 * The checklist is gone because the scripts do the reconciling and narrate it as they go; the wizard is gone
 * because it was a second copy of the SPA's setup screen.
 *
 * ONE LIST, AND IT IS THE WEB'S. This screen and the SPA's Computers tab manage the same containers on the same
 * machine, and they had drifted into two answers: this one printed its sandboxes as cards with their own buttons
 * and then printed the SAME sandboxes again underneath as folders and ports, under a second heading, with
 * nothing on screen relating the two: the exact double-rendering the Computers tab was rebuilt to remove. It
 * now hands its containers to <MachineDetail>, the way that tab does, so a sandbox is one row carrying its
 * folder, its ports, its image and its verbs. The verbs are the kit's too (<SandboxVerbs>), so "which buttons
 * exist here" is no longer a thing two apps can disagree about: this window had a log tail and no Restart, the
 * tab had a Restart and no log tail, and neither offered the rollback both of their backends could already do. */

const info = ref<DesktopInfo | undefined>(undefined);
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
// What desktop sync is doing here. Undefined = no agent on this computer, which is a fact about the machine and
// not a failure; a string = the agent is installed but would not answer, which is.
const report = ref<MachineReport | undefined>(undefined);
const reportError = ref<string | undefined>(undefined);
const busy = ref<{ slug: string; verb: SandboxVerb } | undefined>(undefined);

/* THE APP'S OWN VERSION, as one state rather than a boolean (desktop.ts `UpdateStage`). The screen draws
 * exactly what is true — checking, downloading with a figure, downloaded and one click away, or "this copy
 * can't replace itself, here is the download" — and the button exists in exactly the states where pressing it
 * does something immediately. What it replaces was a notice claiming an install that nothing performed. */
const update = ref<UpdateStage>({ kind: `idle` });
const updateError = ref<string | undefined>(undefined);

const applyUpdate = async (): Promise<void> => {
    updateError.value = undefined;
    try {
        await updateInstall();
    } catch (error) {
        // The refusal worth showing: a script run is in flight, so the swap waits for it rather than killing it.
        updateError.value = String(error);
    }
};

/* WHAT ONE ROW IS SHOWING BELOW ITSELF. The log tail is the only thing here that outlives its own run: every
 * other verb's lines are progress, and a container's last two hundred lines are read after they arrive, so the
 * open pane is remembered by slug rather than following whatever is busy. One at a time, because `activeRun`
 * already allows exactly one operation on this machine at a time. */
const openLog = ref<string | undefined>(undefined);
const logLines = ref<Record<string, string[]>>({});
// The machine's own words when a row's verb failed, kept beside that row rather than at the foot of the screen.
const rowFailure = ref<{ slug: string; message: string } | undefined>(undefined);

// How much of a container's tail to ask docker for: the same figure the machine agent uses for the same button.
const LOG_TAIL_LINES = 200;

// The setup the SPA handed over, and the run it turns into.
const pending = ref<SetupArgs | undefined>(undefined);
const setupError = ref<string | undefined>(undefined);
const runs = ref<Record<string, RunEvent[]>>({});
const activeRun = ref<string | undefined>(undefined);

/* WHETHER THIS WINDOW IS A SETUP, HELD RATHER THAN DERIVED.
 *
 * This used to be `pending !== undefined || activeRun === 'setup'`, which reads as a definition and behaves
 * as a race. `pending` is cleared by the run that starts (so a link cannot be run twice) and re-read from
 * two directions, so any of several perfectly ordinary orderings ends with both halves false WHILE a failed
 * setup is on screen, and this screen then hands the window to the manager face, taking the failure, the
 * requirements and the log with it. Nothing about "is this window a setup" is in doubt: a setup arrived, and
 * it is a setup until it finishes or the user closes it. So it is stated, and only those two things clear it.
 */
const setupOpen = ref(false);

/* WHAT EACH REQUIREMENT IS DOING: keyed by id, fed by the installer's own state markers (desktop.ts).
 * Cleared with the list it belongs to. */
const requirementState = ref<Record<string, RequirementProgress>>({});

/// Where the running (or last) setup wrote its transcript, and whether a stop has been asked for.
const setupLog = ref<string | undefined>(undefined);
const stopping = ref(false);
/// The exit code of the last setup, so the screen can tell a designed stop from something going wrong.
const setupExit = ref<number | null | undefined>(undefined);
/* A run the USER ended. It is neither a failure nor a success, and it needs its own state for one reason:
 * every way out of this card is drawn off "did something go wrong", so a stop with no error text left the
 * screen with no error, no requirements and no buttons: the same dead end, reached politely. */
const wasStopped = computed(() => stopping.value && setupExit.value !== undefined);

/* WHAT THIS COMPUTER STILL NEEDS: the Windows half of a failed setup, and the reason one exists at all.
 *
 * On Linux and macOS a setup that stops has usually hit something unforeseeable, and four lines of stderr is
 * the right thing to show. On Windows the common stops are none of them accidental: WSL2 is not turned on,
 * this PC has no package manager, virtualization is switched off in firmware. The installer knows all of
 * that specifically, and says so in `intentic-requirement:` lines (desktop.ts), so those get a list with a
 * button rather than a red box with a paragraph.
 *
 * Cleared at the START of every attempt, not at the end: a re-run that fixed two of three problems has to
 * draw the one that is left, and a list that only ever grows would keep showing the two that are gone. */
const requirements = ref<Requirement[]>([]);
/// Whether what is on screen is the PREVIOUS run's list, kept up while this one re-examines the machine. The
/// first requirement of the new run clears it and takes the list over. See `runSetup`.
const carried = ref(false);
/* Whether the user has answered the list. It is the second pass of a setup: the first deliberately changes
 * nothing, and it lives here rather than in the args because it is about this WINDOW's conversation, not
 * about the link the SPA handed over. */
const consented = ref(false);
// A setup this app is finishing after restarting Windows for it, and how stale its code is.
const resuming = ref(false);
const expired = ref(false);

/* WHERE THE OTHER HALF OF THIS SCREEN LIVES. The SPA's Computers tab manages the same containers on the same
 * machine: through the machine's own connection rather than natively, and it shows every computer the sandbox
 * can see, not only this one. Linked rather than duplicated, which is the same argument the manager makes for
 * handing its rows to <MachineDetail>: one screen per subject, reachable from wherever the reader started. */
const COMPUTERS_PATH = `/sandbox/computers`;

/* Wrapped rather than bound straight to a click: `workspaceOpen` takes an optional path now, and a bare
 * `@click="workspaceOpen"` would hand it a MouseEvent to navigate to. */
const openWorkspace = (path?: string): void => void workspaceOpen(path);

const eventsOf = (run: string): RunEvent[] => runs.value[run] ?? [];
const running = computed(() => activeRun.value !== undefined);
// A handed-over setup owns the window from the moment it arrives until it hands the window back, which
// includes having failed, because a failure is the one state the user most needs undivided. See `setupOpen`
// for why that is held rather than inferred.
const setupMode = computed(() => setupOpen.value || activeRun.value === `setup`);

/* WHETHER THIS SCREEN KNOWS YET WHICH FACE IT IS, and the reason the title below waits for it.
 *
 * `setupMode` is derived from a handed-over setup that is READ, asynchronously, after this component mounts
 * (`loadPending`). Until that read lands it is `false`, which is not "the manager is up" but "nobody has
 * looked yet". Titling the window on that guess puts `This computer` in the taskbar for the length of one
 * IPC round trip on every arriving install, and a label that changes twice in half a second is one nobody
 * can read. So the title is only ever changed here on a real transition.
 *
 * THE READ, AND NOTHING ELSE, IS WHAT IT WAITS FOR — see `loadPending`, which sets this. It used to be set
 * at the END of mount, after the container list and the handed-over setup had both finished, and the second
 * of those is the whole install: minutes, on the one path where the title matters most. A link answered from
 * a browser started the setup, drew the setup screen, and left the taskbar saying `Intentic` until the run
 * was over — the only outside signal of which screen is up, absent for the entire screen it describes. */
const faceKnown = ref(false);

/* The OS title follows the screen. Both faces of the app live in ONE frame (windows.rs), so the title is not
 * decoration: it is the taskbar entry, the alt-tab label, and the only thing outside this process that can
 * say which screen is up, which is what the desktop smoke tiers assert against, having deliberately no test
 * hook to read instead. The frame itself no longer follows anything — the two screens are the same window at
 * the same size, which is the whole point of them being screens. */
watchEffect(() => {
    if (!faceKnown.value) {
        return;
    }
    void getCurrentWindow().setTitle(setupMode.value ? `Intentic, Setting up your sandbox` : `Intentic, This computer`);
});

/* --- HOW FAR THROUGH THE INSTALL IT IS (setupPlan.ts) ---
 *
 * The plan is built before the script starts, so the first frame of this screen already says what will
 * happen and how many steps there are; the run's own `intentic: [phase] …` lines then move a cursor down it.
 * `now` is only here so a long silent step still moves: a pull that says nothing for four minutes is the
 * normal case, and a bar frozen through it is the screen this replaced. */
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
    try {
        sandboxes.value = await sandboxList();
        listError.value = undefined;
    } catch (error) {
        // Docker not being up is the ordinary case on a machine nobody has set up yet, so it reads as an
        // empty manager with an explanation rather than an error state.
        sandboxes.value = [];
        listError.value = String(error);
    }
    /* The sync half, read separately and allowed to fail separately: the two answers come from different places
     * (docker, and the sync agent) and either can be absent on a perfectly working computer. Folding them into
     * one try would let a machine with no sync agent read as a machine with no sandboxes. */
    try {
        report.value = await machineReport();
        reportError.value = undefined;
    } catch (error) {
        report.value = undefined;
        reportError.value = String(error);
    }
};

/* THE CONTAINERS, IN THE SHAPE THE SHARED VIEW READS. Docker's own answer carries `null` for the two facts it
 * may not have; the row type spells the same absence as an absent KEY, because absent and false are different
 * things there (no tunnel sidecar at all, versus a sidecar that is down). The join between a container and the
 * sync agent's pairing is <MachineDetail>'s own: this app used to make it here, by hand, into one line of text. */
const sandboxRows = computed<MachineSandboxRow[]>(() =>
    sandboxes.value.map((sandbox) => ({
        slug: sandbox.slug,
        running: sandbox.running,
        image: sandbox.image,
        ...(sandbox.name === null ? {} : { name: sandbox.name }),
        ...(sandbox.tunnelRunning === null ? {} : { tunnelRunning: sandbox.tunnelRunning }),
    })),
);

// The docker row behind one of the view's groups, which is what every verb below needs and the group carries.
const slugOf = (group: MachineSandboxGroup): string | undefined => group.sandbox?.slug;

/* Whether the shared view would draw anything at all. It groups containers, folders and ports, and a machine can
 * have the last two and none of the first (a pairing whose container is stopped and pruned), so "is there a row"
 * is all three, not just docker's answer. Below this, the screen says so in its own words rather than letting the
 * shared view fall through to a sentence written for the SPA's reader. */
const hasRows = computed(() => sandboxes.value.length > 0 || (report.value?.pairings.length ?? 0) > 0 || (report.value?.ports.length ?? 0) > 0);

/* HOW A FINISHED RUN IS REPORTED: the outcome, and where it stopped, and nothing else.
 *
 * The scripts narrate themselves in `intentic: [phase] …` lines (desktop.ts), so the last phase before a
 * failure is the most specific thing anybody can say about where an install died, and it is the PHASE ID
 * rather than the sentence, so the same failure reports the same word after the copy is next reworded, and
 * two releases' funnels can be compared at all. The log beside it is full of paths, names and tokens and
 * none of that leaves here. */
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
        // Only on the way out: on a run that worked, the last step is just the last step.
        ...(ok || phases.length === 0 ? {} : { failedStep: phases[phases.length - 1] }),
    };
};

/* Every operation is one script run and they all report the same way, so there is one place that starts a
 * run, one that renders it, and no per-action progress state. `activeRun` is what serializes them: the
 * scripts all drive docker on this one machine, and two recreates at once is not a thing to support. */
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

/* THE STEPS THIS INSTALL WILL TAKE, as one expression, because it is now built from two directions: when the
 * run starts, and again if the Docker probe lands after it (`onMounted`). One conditional step depends on that
 * answer, so a plan drawn before it arrives has to be able to be drawn again. */
const planFor = (args: SetupArgs): readonly PlanStep[] =>
    setupPlan({
        // Optimistic while unknown, which is the reading that costs least: a plan missing the Docker step is
        // corrected the moment the probe answers, where a plan that invented one would have to take a step
        // away from a reader who had already read it.
        dockerReady: dockerReady.value ?? true,
        syncing: (args.syncDir ?? ``) !== ``,
        os: info.value?.os ?? ``,
    });

const runSetup = async (): Promise<void> => {
    const args = pending.value;
    if (args === undefined || running.value) {
        return;
    }
    const startedAt = Date.now();
    /* THE LIST SURVIVES THE START OF THE NEXT PASS, and is replaced rather than emptied.
     *
     * It used to be cleared here, which is right in principle: a list belongs to the attempt that produced
     * it, and wrong in practice on the one click that matters. "Install and continue" re-runs the setup, and
     * emptying the list means the four things the user just agreed to disappear off the screen for the
     * seconds it takes the installer to re-examine the machine and say them again. The reader who has just
     * consented to a 600 MB download watches their reason for consenting vanish.
     *
     * So the previous list stays on screen and the FIRST requirement of the new run replaces it wholesale
     * (`carried`, below), which is also what drops the ones the last pass fixed, since a run only announces
     * what is still unmet. */
    carried.value = requirements.value.length > 0;
    requirementState.value = {};
    setupExit.value = undefined;
    stopping.value = false;
    expired.value = false;
    /* The plan, before the first line of output: that is the point of it. A machine with Docker already up
     * is not shown the step that installs it, and a setup that carries no folder is not shown the one that
     * pairs one: the list on screen is what WILL run here, so nothing on it is ever skipped in front of the
     * reader. Rebuilt per run, so "Try again" starts a clean bar rather than resuming a dead one's. */
    progress.value = startProgress(planFor(args), startedAt);
    now.value = startedAt;
    track(`desktop_install_started`, {
        dockerReady: dockerReady.value ?? null,
        sync: (args.syncDir ?? ``) !== ``,
        consented: consented.value,
        resumed: resuming.value,
    });
    const failure = await start(`setup`, () => setupRun(args, consented.value));
    const ok = failure === undefined;
    // Nothing was reported this time, so the list on screen is the last run's and is now a lie: this run got
    // past the examination, and whatever stopped it is somewhere else entirely.
    if (carried.value) {
        requirements.value = [];
        carried.value = false;
    }
    /* WHAT A NON-ZERO EXIT MEANS, WHICH IS NOT ALWAYS "SOMETHING BROKE".
     *
     * Every Windows install that needs anything at all ends its first pass non-zero, on purpose: the
     * installer reports what it would change and stops, because there is no terminal here to ask the one
     * question on. Reporting that as `connect.ps1 exited with status 3` in a red box is this screen calling
     * its own design a crash, and on the run that was reported to us, the red box was the only thing that
     * had anything to say. So the designed stops (desktop.ts) carry no error text: the requirements list IS
     * the message, and a stop the user asked for is not a failure either.
     *
     * …with one guard, because the whole point here is that a stopped run always says SOMETHING. A designed
     * stop is silent only when the list it defers to actually arrived; if it did not: a marker that failed
     * to parse, a CLI that never printed one: the raw failure is shown rather than nothing at all. That is
     * the exact hole the reported install fell through, and it stays closed even if the list breaks again. */
    const deferredToTheList = expectedStop(setupExit.value ?? null) && requirements.value.length > 0;
    setupError.value = ok || stopping.value || deferredToTheList ? undefined : failure;
    /* THE DESKTOP FUNNEL'S LAST STEP, REPORTED FROM WHERE IT ACTUALLY HAPPENS. The SPA has its own
     * `sandbox_connected`, but on this path it is fired by a page that has been behind this window for the
     * whole install: late at best, and never at all when the handover came from a browser tab the user then
     * closed. Exit zero here means the daemon booted and announced itself, which is the same fact that page
     * was waiting to observe. */
    track(`desktop_install_finished`, {
        ...runOutcome(`setup`, ok, startedAt),
        // Which prerequisite stopped it, by id: the ids never change wording, so two releases' funnels can
        // be compared. Nothing else about the machine leaves here.
        ...(requirements.value.length === 0 ? {} : { requirements: requirements.value.map((requirement) => requirement.id) }),
    });
    if (ok) {
        pending.value = undefined;
        setupOpen.value = false;
        /* AND THE WINDOW LANDS IN THE WORKSPACE, not on the page that was waiting for it.
         *
         * Handing the frame back without a destination returns the webview to `/setup`, which then has to
         * notice for itself that the daemon is up — it polls, and it re-polls on focus, so it gets there, but
         * the last thing a four-minute install shows is a screen saying it is still waiting. The sandbox
         * announced itself to the platform on boot; that question is already answered. So this navigates to
         * the app's root, which is the same place the SPA's own `enterWorkspace` goes, and the install ends
         * on the product rather than one poll short of it. */
        await workspaceOpen(`/`);
        return;
    }
    /* AND IF IT DID NOT FINISH, MAKE SURE SOMEBODY FINDS OUT.
     *
     * This window is deliberately not topmost and deliberately minimisable: an install runs for minutes and
     * holding someone's screen for it would be indefensible. The price is exactly this case: a setup that
     * stops while the window is minimised, or behind the workspace, changes only pixels nobody is looking
     * at. A user reported that as "the error did not surface and did not notify user", and they were right.
     * `setupAlert` is the OS's own way to point at a window without stealing focus from whatever they moved
     * on to. */
    await setupAlert();
};

/* END THE RUN: the button this screen never had.
 *
 * "You can close this, the install keeps going" was the whole of what was on offer: a run that had gone
 * wrong could be walked away from and not stopped, and the next attempt then raced the one still going.
 * `stopping` is set BEFORE the kill so the exit it produces reads as an answer rather than a failure. */
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

/// Put the transcript on the clipboard: the thing somebody stuck on this actually needs to hand over.
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

/* WALKING AWAY FROM AN INSTALL, REPORTED AS ITS OWN THING.
 *
 * The × hands the window back to the workspace and stops NOTHING: the script is a process on this machine
 * (see the button itself), so a run dismissed here still reports its own `desktop_install_finished` when it
 * ends. What this says is that nobody was watching any more, and that was invisible: a setup somebody left
 * ninety seconds into a four-minute pull and one they sat through to the end read identically.
 *
 * WHERE it was left is the whole value, so it carries the phase id the finish event reports against and the
 * bar's own position. Nothing about the machine leaves here, exactly as everywhere else on this screen. */
const dismissSetup = async (): Promise<void> => {
    const state = progress.value;
    const step = state?.plan[state.index]?.phase;
    track(`desktop_install_dismissed`, {
        // A dismissal after the run ended is somebody closing a finished, or failed: card, which is the
        // ordinary way out of this screen and not the same event at all.
        running: running.value,
        ...(state === undefined ? {} : { percent: Math.round(state.percent), elapsedMs: Date.now() - state.startedAt }),
        ...(step === undefined ? {} : { step }),
    });
    // The one thing that closes this screen other than a setup finishing: see `setupOpen`.
    setupOpen.value = false;
    await workspaceOpen();
};

/* THE WAY OUT THAT IS NOT "GIVE UP".
 *
 * This app's whole premise is that the sandbox runs on THIS computer, and for most people it should. But the
 * list this button sits under is the moment where that premise is being tested hardest: a PC with no WSL2
 * and no Docker is being asked for administrator, a 600 MB download and a restart, and some of those readers
 * are on a machine where none of that is going to happen: a work laptop, a locked-down build, a PC too
 * small for it. Until now the app had nothing to say to them, while the browser has offered a machine in
 * their own cloud account and one we host for them all along; it was hidden here on the argument that "this
 * computer" is the whole point of being in the app.
 *
 * It is the point right up until it cannot work, and then it is a dead end. Local stays the loud default and
 * this stays one quiet line under it, in the one place where it is the more useful answer.
 */
const setUpElsewhere = async (): Promise<void> => {
    track(`desktop_install_elsewhere`, { requirements: requirements.value.map((requirement) => requirement.id) });
    setupOpen.value = false;
    await workspaceOpen(`/setup?elsewhere=1`);
};

/* THE ONE QUESTION THIS FLOW ASKS, ANSWERED. The first attempt reported what it would change and changed
 * nothing; this is the user saying go ahead, and it is the same pre-consent the terminal path takes as a
 * typed "y". It stays set for the rest of this window's conversation: a re-check after fixing something by
 * hand should not put the question back. */
const installRequirements = async (): Promise<void> => {
    consented.value = true;
    await runSetup();
};

/* Restart Windows, or sign out of it, and pick this setup up afterwards. The args go to disk before
 * anything else happens, so a machine that goes down between here and the reboot still comes back to a setup
 * it can finish.
 *
 * The two are one function because they are one idea: something Windows only applies between sessions, and a
 * setup that survives the gap. A restart is for features that need one; a sign-out is for the docker-users
 * group, whose whole problem is that a login token is issued once and this account's was issued before it
 * joined. That row used to offer "Check again", which could never work. */
const endSession = async (how: `restart` | `signout`): Promise<void> => {
    const args = pending.value;
    if (args === undefined || running.value) {
        return;
    }
    // Awaited, unlike every other event here: the line below takes the session down, and an event still in
    // flight when that happens is an event nobody ever sees (analytics.ts).
    await trackBeforeExit(`desktop_install_restart`, {
        how,
        requirements: requirements.value.map((requirement) => requirement.id),
    });
    try {
        await (how === `restart` ? restartForSetup(args) : signOutForSetup(args));
    } catch (error) {
        // Neither of these gets a second chance to explain itself, so a refusal says so in the card rather
        // than leaving a button that quietly did nothing.
        setupError.value = String(error);
    }
};

/* SETUP CODES OUTLIVE NEITHER A LONG RESTART NOR A SLOW ONE. They are good for thirty minutes from the moment
 * the platform minted one, and turning on WSL2, restarting, and letting Windows finish its own updates can
 * spend most of that. Resuming into a claim that fails with "invalid or expired" would read as a broken
 * install; this reads as what it is. Twenty-five minutes leaves the setup itself room to finish. */
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
    // Already agreed to, before the restart this app performed on the strength of that answer. Asking the
    // same question again on the other side of it would be the flow forgetting its own conversation.
    consented.value = true;
    track(`desktop_install_resumed`, { agedSeconds: parked.agedSeconds });
    await runSetup();
};

/* A parked setup RUNS on arrival rather than waiting to be asked. The SPA's "Set up on this computer" button
 * is the consent: it says what this does, in the sentence directly above it, and repeating the question on
 * a screen the user did not open is what made the handoff read as a second, unrelated installer. The guard in
 * `runSetup` is what keeps the two ways in here (the event, and the read below on mount) to one run.
 *
 * That consent only covers a link the SPA's own window navigated to. One arriving from the OS, which any page
 * can send, on nothing more than a browser's "Open Intentic?": is asked about in windows.rs BEFORE it is
 * parked, so anything that reaches this screen has been agreed to one way or the other. */
const loadPending = async (): Promise<void> => {
    /* TAKEN, and a `null` means somebody else took it: never "there is no setup here". Two callers race for
     * a parked request (the arrival event, and this window's read on mount), and the loser used to write its
     * empty answer over the winner's state, which handed the window back to the manager face in the middle
     * of the run it had just started. */
    const taken = await takePendingSetup();
    if (taken !== null) {
        pending.value = taken;
        setupOpen.value = true;
    }
    /* THE READ HAS LANDED, so this screen may now say which face it is — set here rather than after the run
     * below, and in the same tick as `setupOpen` so the frame is titled once rather than twice. See
     * `faceKnown`: everything after this line is the setup HAPPENING, which the title has already announced. */
    faceKnown.value = true;
    if (taken === null) {
        return;
    }
    await runSetup();
};

/* WHICH RUN A VERB IS. The ids predate the shared row and are kept as they are, because the analytics below
 * report against them and one of them is also what an `intentic://recreate` handover produces. */
const RUN_OF: Record<Exclude<SandboxVerb, `logs`>, (slug: string) => string> = {
    start: (slug) => `power:${slug}`,
    stop: (slug) => `power:${slug}`,
    restart: (slug) => `power:${slug}`,
    update: (slug) => `recreate:${slug}`,
    rollback: (slug) => `recreate:${slug}`,
    remove: (slug) => `remove:${slug}`,
};

/* `source` is the one thing the event cannot work out for itself: the same operation arrives either as a click
 * on this screen's own list, or as the SPA's Update/Environment card handing it over (`drainRecreate`). Which
 * of the two people actually use is the question the app's existence rests on. */
const recreate = async (slug: string, hash: string | undefined, rollback: boolean, source: `manager` | `link`): Promise<void> => {
    busy.value = { slug, verb: rollback ? `rollback` : `update` };
    const startedAt = Date.now();
    // The mode rides the argument shape here exactly as it does in the script (recreate.sh): a hash means the
    // owner-approved overlay, `--rollback` means the image before the last update, neither means the fresh base.
    const mode = rollback ? `rollback` : hash === undefined ? `update` : `rebuild`;
    track(`desktop_recreate_started`, { mode, source });
    const failure = await start(`recreate:${slug}`, () => sandboxRecreate(slug, hash, rollback));
    track(`desktop_recreate_finished`, { mode, source, ...runOutcome(`recreate:${slug}`, failure === undefined, startedAt) });
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
};

/* The SPA's "paste this on the machine that runs your sandbox" cards, arriving as a click instead: the Update
 * card sends a slug, the Environment card sends a slug and the approved overlay's digest, and the rollback on
 * the same card sends the flag. Taken rather than read, so coming back to this screen later does not re-run an
 * update that already ran. */
const drainRecreate = async (): Promise<void> => {
    const requested = await takePendingRecreate();
    if (requested === null || running.value) {
        return;
    }
    await recreate(requested.slug, requested.hash, requested.rollback, `link`);
};

/* ONE CLICK ON ONE ROW, whichever of the shared verbs it was.
 *
 * The kit decides which buttons exist and what the destructive ones ask; this decides what each one DOES here,
 * which is the whole of what differs between this window and the SPA's Computers tab: there, a verb is a
 * message to a machine over a socket; here it is a script or a docker call on the machine this window is on.
 *
 * The question is asked in the OS's own dialog rather than one this window draws, and its words are the kit's,
 * so the two apps warn about the same thing in the same sentence. */
const act = async (group: MachineSandboxGroup, verb: SandboxVerb): Promise<void> => {
    const slug = slugOf(group);
    if (slug === undefined || busy.value !== undefined || running.value) {
        return;
    }
    if (verb === `logs`) {
        // A toggle: a pane the reader opened is theirs to close, and re-reading is the same click again.
        if (openLog.value === slug) {
            openLog.value = undefined;
            return;
        }
        // Opened before the lines arrive, so an empty pane says "reading" rather than the row looking like it
        // ignored the click. This one does NOT go through `start`: nothing is spawned, so there is no run.
        openLog.value = slug;
        logLines.value = { ...logLines.value, [slug]: [] };
        busy.value = { slug, verb };
        const text = await sandboxLogs(slug, LOG_TAIL_LINES).catch((error: unknown) => String(error));
        logLines.value = { ...logLines.value, [slug]: text.split(/\r?\n/).filter((line) => line !== ``) };
        busy.value = undefined;
        return;
    }
    const asked = sandboxVerbPrompt(verb, group.title);
    if (asked !== undefined && !(await confirm(asked, { title: group.title, kind: `warning`, okLabel: VERB_LABEL[verb] }))) {
        return;
    }
    // A pane holding the log this row printed a moment ago is about a container that is now being changed.
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

// Which of THIS row's buttons is the one spinning, and what its pane is showing. A run's lines are the script's
// own output; a log tail's are the container's: one pane, because a row only ever has one thing to say.
const busyVerb = (group: MachineSandboxGroup): SandboxVerb | undefined => {
    const inFlight = busy.value;
    return inFlight !== undefined && inFlight.slug === slugOf(group) ? inFlight.verb : undefined;
};
const logOpen = (group: MachineSandboxGroup): boolean => openLog.value !== undefined && openLog.value === slugOf(group);
const paneLines = (group: MachineSandboxGroup): string[] => {
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
    // Awaited, and safe to await, because it asks this process what it is and nothing else — see desktop.ts.
    // The question about the MACHINE used to be answered in the same breath, and that is what made this line
    // the one everything below queued behind.
    info.value = await desktopInfo();
    // Before the parked work below, because the first thing this screen does is often the setup it was opened
    // to run, and an install that reports nothing is exactly what this is here to stop happening.
    initAnalytics(info.value);
    /* THE MACHINE, ASKED IN PARALLEL WITH DRAWING THE WINDOW rather than in front of it. This probe is slowest
     * on the machine it matters most for — Docker installed and not running spends tens of seconds refusing to
     * answer — and nothing between here and the setup screen depends on what it says.
     *
     * `desktop_app_opened` carries the answer and so rides along with it, keeping the event's shape: it is the
     * property that says how many people open this app on a machine that is already ready, and reporting it as
     * "not known yet" on precisely the machines that are not would empty it of meaning. The event is therefore
     * as late as the probe, which on a normal machine is milliseconds. Nothing else waits: an install that
     * starts first still reports, `initAnalytics` having already run above. */
    void dockerReadyProbe().then((ready) => {
        dockerReady.value = ready;
        track(`desktop_app_opened`, { dockerReady: ready });
        /* A plan already on screen was drawn without this answer. Redrawn only while the cursor has not moved
         * (`index === -1`, setupPlan.ts): after the first phase marker the plan is something the reader has
         * begun following, and swapping it under them would be worse than the one step it corrects. */
        if (pending.value !== undefined && progress.value !== undefined && progress.value.index === -1) {
            progress.value = startProgress(planFor(pending.value), progress.value.startedAt);
        }
    });
    /* Listeners BEFORE the parked work, not after: `loadPending` starts the handed-over setup the moment it
     * finds one, and a script reaches this screen only as events, so a run begun before `onRun` is listening
     * would show an empty log through its first, most informative seconds. */
    stop = await Promise.all([
        onRun((event) => {
            runs.value = { ...runs.value, [event.run]: [...eventsOf(event.run), event] };
            // Folded as it arrives rather than derived from the whole log afterwards: the model needs to know
            // WHEN each phase started to estimate anything, and a line carries no clock of its own.
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
            // What this computer still needs, collected as the installer names it. Keyed by id so a run that
            // reports the same requirement twice (the fixer re-examines between passes) draws one row.
            const requirement = parseRequirement(event.text);
            if (requirement !== undefined) {
                // The first one of a new run replaces whatever the last run left on screen; the rest of that
                // run's requirements join it. Keyed by id, so a run that reports the same one twice: the
                // fixer re-examines between passes: still draws one row.
                const kept = carried.value ? [] : requirements.value.filter((seen) => seen.id !== requirement.id);
                carried.value = false;
                requirements.value = [...kept, requirement];
                return;
            }
            // …and how each one is going while it is being dealt with, which is the difference between a
            // checklist and one spinner sitting on "Set up Docker" for ten minutes.
            const state = parseRequirementState(event.text);
            if (state !== undefined) {
                requirementState.value = { ...requirementState.value, [state.id]: state };
            }
        }),
        onPendingSetup(() => void loadPending()),
        onPendingRecreate(() => void drainRecreate()),
        onUpdate((stage) => (update.value = stage)),
    ]);
    // …and the read the listener above cannot stand in for: this window is built on demand, so a download that
    // began at launch has usually already finished by the time it opens.
    updateState()
        .then((stage) => (update.value = stage))
        .catch(() => undefined);
    /* A link that arrived while this screen was opening was PARKED rather than delivered, so it is picked up
     * exactly once: by the event above or by these, whichever finds the request still there.
     *
     * `loadPending` owns `faceKnown` rather than this line owning it, and that is the point: this `await`
     * covers the container list AND the whole handed-over install, neither of which the frame's title has any
     * reason to wait for. See `faceKnown`. */
    await Promise.all([refresh(), loadPending(), drainRecreate()]);
    // Only when nothing was handed over: a fresh link is about a setup the user is starting right now, and it
    // outranks one this app restarted the machine for at some point in the past.
    if (pending.value === undefined) {
        await loadResumable();
    }
});
onUnmounted(() => {
    clearInterval(ticker);
    stop.forEach((unlisten) => unlisten());
});
</script>

<template>
    <!-- SETUP: a SCREEN of this window, in the frame the workspace was filling (windows.rs), not a second
         window standing in front of it. It has been all three shapes now — a chromeless sheet across the
         screen, a small dialog window over the workspace, and this — and the two it replaced share one fault:
         they made the app be in two places at once during the flow that has to be the easiest one there is.

         A column anchored to the TOP rather than a card floating in the middle: the thing this screen has to
         draw on the machines it exists for is long (a ten-step plan, and above it everything wrong with this
         PC), and a full window's height is now the room it gets rather than a frame that had to grow to fit
         it. Top-anchored also means the heading does not move as rows arrive. -->
    <div v-if="setupMode" class="h-dvh overflow-auto bg-canvas text-content">
        <div class="mx-auto w-full max-w-3xl p-5">
            <Card class="flex w-full flex-col gap-3">
                <div class="flex items-start gap-2.5">
                    <Icon name="bolt" class="mt-0.5 text-primary-400" />
                    <div class="min-w-0 flex-1">
                        <h1 class="font-semibold leading-tight">Setting up {{ pending?.name ?? `your sandbox` }} on this computer</h1>
                        <p class="text-2xs text-subtle">
                            Running exactly what the install command runs: starts your sandbox in Docker, connects its tunnel, and opens your
                            workspace once it answers.
                        </p>
                    </div>
                    <!-- SAYS WHERE IT GOES, because this is a screen and not a dialog any more. As a bare ×
                     on a window-filling screen it reads as "close Intentic", which is the one thing it does
                     not do: it steps back to the workspace and nothing else, and the install carries on,
                     being a process on this machine rather than something this window is holding up. -->
                    <button
                        type="button"
                        class="-my-1 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs text-subtle hover:bg-canvas hover:text-content"
                        v-action="dismissSetup"
                    >
                        <Icon name="arrow-up-right" />
                        <span>Back to your workspace</span>
                    </button>
                </div>
                <!-- The code this window came back to is older than the platform will accept. Said plainly, with
                 the one thing that fixes it, instead of letting the run fail at the claim with something that
                 reads like a bad code. -->
                <Notice v-if="expired" tone="warning" class="text-2xs">
                    Your setup code ran out while this computer restarted. Open the setup page again for a fresh one: everything the restart was for
                    is already done.
                </Notice>
                <p v-else-if="resuming" class="flex items-start gap-2 text-2xs text-subtle">
                    <Icon name="refresh" class="mt-0.5 shrink-0" />
                    <span>Picking up where the restart left off.</span>
                </p>
                <!-- `=== false`, not `!`: unknown is a third state here now (see the ref), and a warning about
                     this computer must not be drawn on a question nobody has answered yet. -->
                <p v-if="dockerReady === false && !expired && requirements.length === 0" class="flex items-start gap-2 text-2xs text-warning">
                    <Icon name="box" class="mt-0.5 shrink-0" />
                    <span v-if="info?.os === `windows`"
                        >Docker isn't running yet: this checks what your PC needs first, and asks before changing anything.</span
                    >
                    <span v-else>Docker isn't running yet: setup installs it first, so your system will ask for your password once.</span>
                </p>

                <!-- WHAT STOPPED IT, WHEN THE INSTALLER KNOWS SPECIFICALLY, and ABOVE the progress list rather
                 than under it. This is the only thing on the card the reader has to act on, and it used to be
                 last: below a header, a caution, a bar and ten plan rows, in a 640-pixel window, inside a
                 scroll container with nothing on screen to say there was more. On the machines that produce
                 this list (the ones with no WSL2 and no Docker) that is every pixel of it off the bottom.
                 So it leads, and the plan it interrupted becomes the thing you scroll to.
                 It also replaces the red box rather than sitting beside it: "4 things are in the way, here is
                 the button" and the same text again as stderr underneath is one message written twice, and
                 the second copy is the one that reads like a crash. -->
                <Requirements
                    v-if="requirements.length > 0 && !expired"
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

                <!-- A run the user ended is not a failure and gets no red box, but it does get said out loud,
                     because a card that simply stops moving is the thing this whole screen is here to stop
                     being. -->
                <p v-if="wasStopped" class="flex items-start gap-2 text-2xs text-subtle">
                    <Icon name="times" class="mt-0.5 shrink-0" />
                    <span>You stopped this install. Nothing else is running on this computer.</span>
                </p>

                <SetupProgress v-if="progressShown && !expired" :events="eventsOf(`setup`)" :view="progressShown" :running="activeRun === `setup`" />

                <!-- Only on failure. A setup that stopped is the one place this app can strand someone, so
                 "try again" is never the only control on screen — the way out is the header's, which is up
                 there in every state this row renders in and used to be repeated here as a second button
                 with the same words on it. -->
                <div v-if="(setupError || wasStopped) && !expired && requirements.length === 0" class="flex flex-wrap items-center gap-2">
                    <Button label="Try again" :disabled="running" @click="runSetup">
                        <template #icon><Icon name="bolt" /></template>
                    </Button>
                </div>

                <!-- THE FOOT OF EVERY SETUP: a way to end it, and a way to take the evidence with you.
                 Stopping had no button at all: "you can close this, the install keeps going" was the whole
                 offer, so a run that had gone wrong could be abandoned and not ended. The log is written for
                 every run whether or not anyone asks (scripts.rs); these are the two ways to reach it. -->
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
            </Card>
        </div>
    </div>

    <div v-else class="h-dvh overflow-auto bg-surface text-content">
        <!-- A column, not a stretched form: this face inherits the workspace's frame (windows.rs), which is a
             wide window, and everything on this screen is a short list of short things. -->
        <!-- THE MANAGER: what this machine is running, once nothing is being handed over. -->
        <div class="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 p-5">
            <header class="flex items-center gap-3">
                <h1 class="flex-1 text-base font-semibold">This computer</h1>
                <span v-if="info" class="font-mono text-2xs text-subtle">v{{ info.version }}</span>
                <Button size="small" severity="secondary" :text="true" label="Refresh" :disabled="running" @click="refresh">
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </header>

            <!-- WHAT THIS APP IS DOING ABOUT ITS OWN VERSION, and never a gate.
                 The rule is that the sentence describes what is TRUE right now rather than what is meant to
                 happen later. This line used to read "it installs the next time you quit" while nothing in the
                 app installed anything, on any path, ever: the one kind of copy that is worse than none,
                 because it is also the reason nobody investigated.
                 Only `ready` gets a button, and it is a restart rather than a download: by the time it is drawn
                 the installer is already on this machine (update.rs). -->
            <Notice v-if="update.kind === `ready`" tone="info" class="items-center">
                <span>Intentic {{ update.version }} is downloaded. It installs when you quit, or now:</span>
                <Button class="ml-2" size="small" severity="secondary" label="Update and restart" @click="applyUpdate" />
            </Notice>
            <Notice v-else-if="update.kind === `downloading`" tone="info" class="items-center">
                Downloading Intentic {{ update.version }}… {{ update.percent }}%
            </Notice>
            <!-- The two populations that can never update themselves: a .deb or .rpm install, which the release
                 manifest has no artifact for, and a copy installed at or before v1.213.0, compiled with a key
                 that can no longer verify anything we sign. Both used to be told nothing whatsoever. -->
            <Notice v-else-if="update.kind === `manual`" tone="warning" class="items-center">
                <span>{{ update.reason }}</span>
                <a class="ml-2 text-link hover:underline" :href="update.url" target="_blank" rel="noreferrer">Get the latest version</a>
            </Notice>
            <Notice v-if="updateError" tone="warning" class="items-center">{{ updateError }}</Notice>

            <p v-if="listError" class="flex items-start gap-2 text-2xs text-muted">
                <Icon name="box" class="mt-0.5 shrink-0" />
                <span>Docker isn't reachable, so there is nothing to show yet. Start Docker, or set a sandbox up from your workspace.</span>
            </p>
            <p v-else-if="!hasRows" class="text-2xs text-muted">
                No sandboxes here yet. Set one up from your workspace: this screen is where you manage it afterwards.
            </p>

            <!-- WHAT THIS COMPUTER IS RUNNING: one row per sandbox, carrying its folder, its ports, its
                     image and its verbs, exactly as the SPA's Computers tab draws the same machine.
                     `syncDir` rides the setup link into connect.sh and was never heard from again, so the app
                     whose whole premise is not needing a terminal could say a container was up and nothing about
                     the sync the same setup had just configured: the folders and ports below are that half, and
                     they belong ON the sandbox they are for rather than under a heading of their own. -->
            <section v-if="hasRows || reportError" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
                <Notice v-if="reportError" tone="danger" class="text-2xs">{{ reportError }}</Notice>
                <MachineDetail :pairings="report?.pairings" :ports="report?.ports" :sandboxes="sandboxRows" :watcher="report?.watcher">
                    <!-- What the list is, and the state of the agent behind it, on one line: the watcher is
                             a fact about the MACHINE rather than about any row under it. -->
                    <template #heading>
                        <span class="flex items-center gap-2 text-2xs font-semibold tracking-wide text-subtle uppercase">
                            Sandboxes on this computer
                            <span v-if="report?.agents.sync" class="font-mono normal-case">agent v{{ report.agents.sync }}</span>
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
                    <!-- The machine's own output: while a row works, and afterwards for as long as a log tail
                             is being read. -->
                    <template #footer="{ group }">
                        <MachineRunLog
                            v-if="busyVerb(group) || logOpen(group)"
                            :lines="paneLines(group)"
                            :running="busyVerb(group) !== undefined"
                            empty="Starting on this computer…"
                            note="Running on this computer: it keeps going even if you close this window."
                        />
                        <Notice v-if="rowFailure && rowFailure.slug === group.sandbox?.slug" tone="danger" class="text-2xs">
                            {{ rowFailure.message }}
                        </Notice>
                    </template>
                </MachineDetail>
            </section>

            <footer class="mt-auto flex flex-wrap items-center gap-2 pt-2">
                <Button size="small" severity="secondary" label="Open workspace" @click="openWorkspace()">
                    <template #icon><Icon name="arrow-up-right" /></template>
                </Button>
                <!-- THE OTHER SCREEN THAT MANAGES THESE SAME CONTAINERS. This window reaches them natively and
                     the SPA's Computers tab reaches them through the machine's own connection, and until now
                     neither admitted the other existed, so a reader who found one concluded the product had
                     only that one. Secondary and text: the workspace is still the way out of here. -->
                <Button size="small" severity="secondary" :text="true" label="See all your computers" @click="openWorkspace(COMPUTERS_PATH)">
                    <template #icon><Icon name="desktop" /></template>
                </Button>
                <span v-if="info" class="truncate font-mono text-2xs text-subtle">{{ info.appUrl }}</span>
            </footer>
        </div>
    </div>
</template>
