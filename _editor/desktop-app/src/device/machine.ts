import { type DeviceSandboxRow, engineCapacity, osMarkOf, sandboxGroups } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import {
    deviceStatus,
    dockerEngine,
    dockerListening,
    homeFacts,
    machineAgents,
    sandboxList,
    type DesktopInfo,
    type DeviceStatus,
    type DockerEngine,
    type HomeFacts,
    type MachineEnvironment,
    type SandboxStatus,
} from "../desktop";
import { desktopAgentPanel } from "../deviceAgent";
import { keptBy, otherAgents } from "./keeper";
import { osNameOf } from "../osName";

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
/** This computer's environments and the machine agent each holds (agents.rs): a WSL distro's agent keeps the sandboxes
 *  set up from that distro, and the page says so beside them. */
export const environments = ref<MachineEnvironment[]>([]);

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

// Beside the rest and never in its way: an environment that cannot be read is one with nothing to say.
const refreshEnvironments = async (generation: number): Promise<void> => {
    const found = await machineAgents().catch((): MachineEnvironment[] => []);
    if (newest(generation)) {
        environments.value = found;
    }
};

/** Read the machine again: the engine and its sandboxes, the agent, its other environments, and what the app remembers. */
export const refresh = async (): Promise<void> => {
    refreshes += 1;
    await Promise.all([refreshDocker(refreshes), refreshAgent(refreshes), refreshEnvironments(refreshes), loadFacts()]);
    read.value = true;
};

/** The other environments of this computer whose own machine agent runs, by name. */
export const agentsElsewhere = computed(() => otherAgents(environments.value));

/* THE SANDBOXES, as the kit's rows: ic's own, exactly as the machine agent hands them to the workspace's Devices view
   (DeviceSandbox is the contract's row), so both pages say the same about one container: its version, how long the
   version before the last swap stays ready, and which side of this computer keeps it. Until 2026-10-20 this page copied
   four fields out of each and dropped the rest, and its rows said less than the workspace's about the same sandbox. */

// The side of this computer that keeps a sandbox, by the name a person reads it by: ic's own when it names one, else the
// distro this computer's own agents say it is (keeper.ts). <DeviceDetail> says it on the row's own line.
const rowOf = (sandbox: SandboxStatus): DeviceSandboxRow => {
    const keeper = keptBy(sandbox, environments.value);
    return keeper === undefined ? sandbox : { ...sandbox, keptElsewhereName: keeper };
};
export const sandboxRows = computed(() => sandboxes.value.map(rowOf));

// The rows the list draws, folded exactly as <DeviceDetail> folds them, so the count is the number of rows under it.
export const groups = computed(() => sandboxGroups(status.value?.sync.pairings ?? [], status.value?.sync.ports ?? [], sandboxRows.value));

// The agent as the kit's panel (deviceAgent.ts), the same object the workspace's Devices tab hands its group.
export const agentPanel = computed(() => desktopAgentPanel(status.value));

/* THE MASTHEAD, as the workspace's Devices view heads one machine's page (the kit's DeviceEnvironmentRow): the
   computer's name, its OS by the name people know it by and in its own mark, and the size of the engine its sandboxes
   share. Named once the machine agent has named it; before, the page says "This computer", which is all it knows. */
export const machineName = computed(() => status.value?.sync.hostname ?? t(`desktop.device.unnamed`));
/** The OS by its product name (osName.ts), never the agent's `win32`; this app's own platform before an agent reports. */
export const machineOs = computed(() => {
    const os = status.value?.sync.os ?? info.value?.os;
    return os === undefined || os === `` ? undefined : osNameOf(os);
});
// By the platform alone: the agent's `win32` or this app's `windows` (the kit knows both), since neither names a distro.
export const machineMark = computed(() => osMarkOf([], { platform: status.value?.sync.os ?? info.value?.os }));
/** The engine's size, once Docker has said it: the ceiling every sandbox here shares. */
export const hardware = computed(() => (engine.value === undefined ? undefined : engineCapacity(engine.value)));
