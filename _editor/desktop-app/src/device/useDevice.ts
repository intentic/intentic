import { t } from "@intentic/ui/i18n";
import { ref } from "vue";
import { initAnalytics, track } from "../analytics";
import {
    desktopInfo,
    deviceAgentRestart,
    dockerReady as dockerReadyProbe,
    onPendingFix,
    onPendingRecreate,
    onPendingSetup,
    onPendingSync,
    onRun,
    onUpdate,
    updateInstall,
    updateState,
    type RunEvent,
    type UpdateStage,
} from "../desktop";
import * as docker from "./docker";
import * as fixing from "./fix";
import * as machine from "./machine";
import * as runs from "./runs";
import * as sandboxes from "./sandboxes";
import * as setup from "./setup";
import * as sync from "./sync";
import { titleTheSetup } from "./title";

// THIS COMPUTER, AS THE APP ITSELF SEES IT: its sandboxes, its machine agent, its Docker engine, and the work the app runs
// on it (a sandbox's setup handed over from the workspace, a sync enrollment, a sandbox recreated, resized or fixed).
// What the launcher window's card used to hold, as one store the This device view draws (DeviceView.vue) and the rail's
// tile reads its badge from (host.ts), so a setup keeps its progress while the reader is looking at their files. Its
// parts are modules of their own: the machine's reading (machine.ts), the app's runs on it (runs.ts), the engine
// (docker.ts), a setup (setup.ts), the sandboxes' verbs (sandboxes.ts), a sync enrollment (sync.ts) and the recovery
// panel's fix (fix.ts). This one starts them.
//
// Only the app's main window TAKES WORK (`takesWork`): a setup, a recreate, a sync or a fix the app parked for its own
// face, and the Docker start a launch asked for. Every other local window draws the same view of the machine and runs
// its verbs, but leaves parked work to the main window, which the app shows for it (windows.rs `show_home`).

export interface DeviceOptions {
    /** This is the app's main window, which the app parks setups, recreates, syncs, fixes and a sleeping engine for. */
    readonly takesWork: boolean;
}

// Where somebody sent to install Docker should land: our own page, which says what it is for here and links Docker's
// download, rather than dropping a non-technical reader on docker.com to choose an edition.
export const DOCKER_DOCS = `https://intentic.dev/docs/docker`;

// Path to the workspace's Devices view, which manages the same containers via the machine's own connection. Its old
// hub address on purpose: a workspace from before the view moved to /devices serves only that one, and every one since
// redirects it.
export const DEVICES_PATH = `/sandbox/devices`;

// While the view is on screen, the machine is read again this often: a sandbox started from the workspace, or an agent
// that came back, shows up without a press on Refresh.
export const REFRESH_EVERY_MS = 30_000;

/* THE APP'S OWN UPDATE, drawn as exactly what's true rather than a future promise. */
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

/* THE AGENT'S ONE VERB: this app runs ON the device, so nothing here asks for a terminal. */
const agentRestarting = ref(false);
const agentRestartError = ref<string | undefined>(undefined);
// What the loop said back, in its own words, the way the workspace's Devices tab reports the same op.
const agentRestartOutcome = ref<string | undefined>(undefined);
const restartAgent = async (): Promise<void> => {
    if (agentRestarting.value) {
        return;
    }
    agentRestarting.value = true;
    agentRestartError.value = undefined;
    agentRestartOutcome.value = undefined;
    try {
        const said = (await deviceAgentRestart()).trim();
        agentRestartOutcome.value = said === `` ? t(`desktop.app.agentRestarted`) : said;
    } catch (error) {
        agentRestartError.value = String(error);
    } finally {
        agentRestarting.value = false;
        // Always, including after a failure: the stop half may have landed, so the row must show what is there now.
        await machine.refresh();
    }
};

// Every event of every run is kept for the page, but the setup's markers, which are its own protocol and not output.
// A fix's lines also build its view as they arrive.
const onRunEvent = (event: RunEvent): void => {
    const marker = event.run === `setup` && setup.takeSetupEvent(event);
    if (!marker) {
        runs.record(event);
    }
    fixing.foldFix(event);
};

// Probed beside everything else, since it's slowest on the machines it matters for. `desktop_app_opened` waits for it,
// so the property means something on precisely the machines it's about.
const probeDocker = async (): Promise<void> => {
    const answer = await dockerReadyProbe();
    machine.dockerReady.value = answer;
    track(`desktop_app_opened`, { dockerReady: answer });
    setup.replanForDocker();
};

// The work the app parked for the main window: a link that arrived while it was opening is picked up once, by whichever
// of the event or this read finds it first. The engine is woken as soon as a setup is ruled out, since a setup starts
// Docker itself; a fresh link outranks a setup resumed from an earlier restart.
const takeParkedWork = async (): Promise<void> => {
    void probeDocker();
    const handover = setup.loadPending();
    void handover.then(() => docker.wakeDockerIfNeeded(setup.pending.value !== undefined));
    await Promise.all([handover, sandboxes.drainRecreate(), sync.drainSync(), fixing.drainFix()]);
    if (setup.pending.value === undefined) {
        await setup.loadResumable();
    }
};

const startOnce = async (options: DeviceOptions): Promise<void> => {
    // Awaited, and safe to await, because it asks this process what it is and nothing else (desktop.ts).
    machine.info.value = await desktopInfo();
    initAnalytics(machine.info.value);
    void machine.loadFacts();
    // Registered before a parked setup can start a run, or its first seconds would show an empty log.
    const listening = [onRun(onRunEvent), onUpdate((stage) => (update.value = stage))];
    const parked = options.takesWork
        ? [
              onPendingSetup(() => void setup.loadPending()),
              onPendingRecreate(() => void sandboxes.drainRecreate()),
              onPendingSync(() => void sync.drainSync()),
              onPendingFix(() => void fixing.drainFix()),
          ]
        : [];
    await Promise.all([...listening, ...parked]);
    // The read the listener can't replace: this window often opens after a launch-time download finished.
    updateState().then(
        (stage) => (update.value = stage),
        // allow(silent-catch): the listener above carries every later stage, and an unread one is `idle`, which draws nothing.
        () => undefined,
    );
    if (options.takesWork) {
        titleTheSetup();
        await takeParkedWork();
    }
};

let started: Promise<void> | undefined;
/** Listen for the app's runs and updates, and in the main window take whatever work the app parked for it. Once. */
const startDevice = (options: DeviceOptions): Promise<void> => (started ??= startOnce(options));

const device = {
    startDevice,
    ...machine,
    ...docker,
    running: runs.running,
    activeRun: runs.activeRun,
    eventsOf: runs.eventsOf,
    ...sandboxes,
    ...setup,
    ...sync,
    fix: fixing.fix,
    fixQueued: fixing.fixQueued,
    fixRunning: fixing.fixRunning,
    fixLimitMinutes: fixing.fixLimitMinutes,
    fixName: fixing.fixName,
    runFix: fixing.runFix,
    dismissFix: fixing.dismissFix,
    update,
    updateError,
    applyUpdate,
    agentRestarting,
    agentRestartError,
    agentRestartOutcome,
    restartAgent,
};

export type Device = typeof device;

/** This window's one reading of the machine and the app's work on it. */
export const useDevice = (): Device => device;
