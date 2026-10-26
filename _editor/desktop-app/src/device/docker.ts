import { computed, ref } from "vue";
import { track } from "../analytics";
import { dockerListening, dockerOpen, dockerStart, folderSetupCheck, hostsSandboxes, type DockerStart } from "../desktop";
import { dockerEndingLine } from "../components/dockerWords";
import { dockerReasonOf } from "./dockerReason";
import { onOurEngine } from "./engine/engine";
import { dockerReady, dockerStarting, engineListening, info, refresh } from "./machine";

// STARTING THE ENGINE: the whole of what this app can do about a Docker that is not running, and it is a lot. Docker
// Desktop does not start itself (scripts.rs has why), so the morning after a restart a machine that hosts a sandbox
// has no engine, and nothing else on the machine will start one.

/** How the last start ended; absent before there has been one. */
export const dockerReport = ref<DockerStart | undefined>(undefined);
/** When the running start began, in epoch ms: the card's clock. */
export const dockerStartedAt = ref<number | undefined>(undefined);
/** The card is up while a start runs and after one ends in anything but an engine: `ready` is the list coming back. */
export const dockerCardShown = computed(() => dockerStarting.value || (dockerReport.value !== undefined && dockerReport.value.outcome !== `ready`));

/** Who asked for a start: the launch that found the engine asleep, or which of the page's two buttons. */
export type DockerTrigger = `launch` | `notice` | `card`;

// A start's answer, and what the page now knows of the engine from it. A refused engine is a RUNNING engine, so the list
// stops being the thing to wait for and starts being the thing that reports its own refusal.
const heard = (report: DockerStart, startedAt: number, trigger: DockerTrigger): void => {
    dockerReport.value = report;
    // How often a machine was found asleep, and how often waking it worked: the one measurement that says whether the
    // app is doing the job it opened for. `reason` is why a start that did not work did not (dockerReason.ts).
    track(`desktop_docker_start`, {
        outcome: report.outcome,
        ...dockerReasonOf(report),
        trigger,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        atLaunch: trigger === `launch`,
    });
    dockerReady.value = report.outcome === `ready`;
    engineListening.value = report.outcome === `ready` || report.outcome === `notAllowed`;
};

// Not guarded against a second caller: Docker Desktop is single-instance, so two starts are one start and both waits
// reach the same answer. The card hides its buttons while one is in flight because a second press says nothing.
export const startDocker = async (trigger: DockerTrigger = `card`): Promise<void> => {
    dockerStarting.value = true;
    dockerReport.value = undefined;
    const startedAt = Date.now();
    dockerStartedAt.value = startedAt;
    try {
        heard(await dockerStart(), startedAt, trigger);
    } catch (error) {
        // The command itself failing is not one of its five answers, so it becomes the one that means "it did not run":
        // the card keeps a sentence and a button either way.
        dockerReport.value = { outcome: `wouldNotStart`, detail: String(error) };
        track(`desktop_docker_start`, { outcome: `wouldNotStart`, reason: `commandFailed`, trigger, seconds: Math.round((Date.now() - startedAt) / 1000) });
    } finally {
        dockerStarting.value = false;
    }
    if (dockerReport.value?.outcome !== `ready`) {
        return;
    }
    // A folder's own sandbox may be waiting on exactly this engine: the app looks again now rather than at its next round.
    folderSetupCheck().catch((error: unknown) => console.error(`[device] the folders' setups were not told Docker is up:`, error));
    await refresh();
};

/**
 * A start pressed where the Docker card is not drawn (a folder window's card, host.ts `act`): the same start, and a start
 * that did not bring the engine up rejects with the card's own words for how it ended (dockerWords.ts), so the press
 * says it where it was made. Until 2026-10-12 that ending was said on This computer alone.
 */
export const startDockerAndSay = async (): Promise<void> => {
    await startDocker(`card`);
    const report = dockerReport.value;
    if (report !== undefined && report.outcome !== `ready`) {
        throw new Error(dockerEndingLine(report.outcome, { ours: onOurEngine.value, windows: info.value?.os === `windows` }));
    }
};

/** Docker Desktop's own window, for the two things this app cannot answer for anybody: its welcome and its sign-in. */
export const openDocker = async (): Promise<void> => {
    try {
        await dockerOpen();
        track(`desktop_docker_open`, { ok: true, lastOutcome: dockerReport.value?.outcome ?? null });
    } catch (error) {
        dockerReport.value = { outcome: `wouldNotStart`, detail: String(error) };
        track(`desktop_docker_open`, { ok: false, ...dockerReasonOf(dockerReport.value) });
    }
};

/**
 * The launch decision, asked again by the main window: an engine asleep under a sandbox of this machine is woken, and
 * only then. `settingUp` is a setup owning the machine: `ic docker prepare` starts Docker as one of its own steps, and
 * two things starting it would draw two cards about one wait.
 */
export const wakeDockerIfNeeded = async (settingUp: boolean): Promise<void> => {
    if (settingUp || dockerStarting.value || (await dockerListening())) {
        return;
    }
    // A machine no sandbox has ever run on is nobody's to wake: somebody using this app for their files, or as a window
    // onto a sandbox we host, has a perfectly good reason for their Docker to be off (state.rs). The start is a process on
    // both faces' rails (deviceProcesses.ts), out of sight; nothing hands over anywhere when it ends.
    if (!(await hostsSandboxes())) {
        return;
    }
    await startDocker(`launch`);
};
