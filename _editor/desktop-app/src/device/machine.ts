import { type DeviceSandboxRow, sandboxGroups } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import {
    deviceStatus,
    dockerEngine,
    dockerListening,
    homeFacts,
    sandboxList,
    type DesktopInfo,
    type DeviceStatus,
    type DockerEngine,
    type HomeFacts,
    type SandboxStatus,
} from "../desktop";
import { desktopAgentPanel } from "../deviceAgent";

// THIS COMPUTER, AS THE APP READS IT: what the app is, what it remembers, whether the Docker engine answers, the
// sandboxes `ic` lists here and the machine agent's own report. Read again on every `refresh` (the page's arrival, its
// timer, every run's end), and drawn by This device (DeviceView.vue) in the rows the workspace's Devices tab draws.
// One reading per window, kept at module scope so the page and the rail's tile read the same one.

export const info = ref<DesktopInfo | undefined>(undefined);
export const facts = ref<HomeFacts | undefined>(undefined);

/** Whether Docker answers `docker info`, and `undefined` until it has been asked: a third state this page has. */
export const dockerReady = ref<boolean | undefined>(undefined);
/** Whether anything listens where the engine listens: cheap, unlike `dockerReady`, so the list is only asked after it. */
export const engineListening = ref<boolean | undefined>(undefined);
/** A start of the engine is under way (docker.ts), which owns the page through its card while it lasts. */
export const dockerStarting = ref(false);

export const sandboxes = ref<SandboxStatus[]>([]);
/** Docker answered and refused, or never answered: its own words. */
export const listError = ref<string | undefined>(undefined);
/** The engine's size, for the Resources form's rails; undefined means no ceiling, not a wrong one. */
export const engine = ref<DockerEngine | undefined>(undefined);
/** The machine agent's report; undefined means no agent, an ordinary state rather than a failure. */
export const status = ref<DeviceStatus | undefined>(undefined);
/** The agent is installed and did not answer, which is a failure. */
export const reportError = ref<string | undefined>(undefined);
/** Whether the machine has been read at all: until then the page says it is looking, not that nothing is there. */
export const read = ref(false);

export const loadFacts = async (): Promise<void> => {
    try {
        facts.value = await homeFacts();
    } catch (error) {
        console.error(`[device] home_facts could not be read:`, error);
    }
};

/* Only the newest refresh writes: an older one answering late would put back a screen that has since moved on. */
let refreshes = 0;
const newest = (generation: number): boolean => generation === refreshes;

// Nothing to list: the engine is down (the page's card or notice says so), or a start owns the page.
const listNothing = (): void => {
    sandboxes.value = [];
    engine.value = undefined;
    listError.value = undefined;
};

const refreshDocker = async (generation: number): Promise<void> => {
    // Asked first and answered in microseconds, because everything below it is a docker call: a `docker ps` against a
    // daemon that is not there spends tens of seconds on the socket before it fails.
    const listening = await dockerListening();
    if (!newest(generation)) {
        return;
    }
    engineListening.value = listening;
    if (!listening || dockerStarting.value) {
        listNothing();
        return;
    }
    // Alongside the list, not blocking it: this answer only sizes a form nobody has opened, and it's slow.
    void dockerEngine().then(
        (answer) => (engine.value = answer ?? undefined),
        () => (engine.value = undefined),
    );
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
        const answer = await deviceStatus();
        if (newest(generation)) {
            status.value = answer;
            reportError.value = undefined;
        }
    } catch (error) {
        if (newest(generation)) {
            status.value = undefined;
            reportError.value = String(error);
        }
    }
};

/** Read the machine again: the engine and its sandboxes, the agent, and what the app remembers. */
export const refresh = async (): Promise<void> => {
    refreshes += 1;
    await Promise.all([refreshDocker(refreshes), refreshAgent(refreshes), loadFacts()]);
    read.value = true;
};

/* THE SANDBOXES, as the kit's rows (the same rows the workspace's Devices tab draws). */

// ic's rows already leave a key absent rather than null, since absent and false differ (no sidecar vs. a down one).
const rowOf = (sandbox: SandboxStatus): DeviceSandboxRow => {
    const row: DeviceSandboxRow = { slug: sandbox.slug, running: sandbox.running, image: sandbox.image };
    if (sandbox.name !== undefined) {
        row.name = sandbox.name;
    }
    if (sandbox.tunnelRunning !== undefined) {
        row.tunnelRunning = sandbox.tunnelRunning;
    }
    if (sandbox.resources !== undefined) {
        row.resources = sandbox.resources;
    }
    return row;
};
export const sandboxRows = computed(() => sandboxes.value.map(rowOf));

// The rows the list draws, folded exactly as <DeviceDetail> folds them, so the count is the number of rows under it.
export const groups = computed(() => sandboxGroups(status.value?.sync.pairings ?? [], status.value?.sync.ports ?? [], sandboxRows.value));

// The agent as the kit's panel (deviceAgent.ts), the same object the workspace's Devices tab hands its group.
export const agentPanel = computed(() => desktopAgentPanel(status.value));

// The machine's own facts in the quietest ink: what identifies this computer among several enrolled ones. Only once the
// machine agent has named it: the OS alone tells the reader nothing about which computer this is.
export const hardware = computed(() =>
    status.value === undefined ? `` : [status.value.sync.hostname, status.value.sync.os].filter((fact) => fact !== ``).join(` · `),
);
// Named rather than "this device" wherever the machine can name itself; the hover sentence reads as prose.
export const machineName = computed(() => status.value?.sync.hostname ?? t(`desktop.device.thisDevice`));
