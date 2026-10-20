<script setup lang="ts">
import {
    agentLines,
    Button,
    DeviceAgentNotes,
    DeviceDetail,
    DeviceEnvironmentRow,
    DeviceRunLog,
    Notice,
    Page,
    RowGroup,
    Section,
    SandboxResourcesDialog,
    SandboxVerbs,
    type Tip,
    ui,
    vAction,
} from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { usePoll } from "@intentic/ui/async";
import { computed, onMounted } from "vue";
import DockerCard from "../components/DockerCard.vue";
import EngineCard from "../components/EngineCard.vue";
import FixProgress from "../components/FixProgress.vue";
import Requirements from "../components/Requirements.vue";
import SetupProgress from "../components/SetupProgress.vue";
import { openUrl, signIn, workspaceOpen } from "../desktop";
import LeftoverSandboxes from "./machineSandbox/LeftoverSandboxes.vue";
import MachineSandboxSection from "./machineSandbox/MachineSandboxSection.vue";
import { machineNeedsDocker, machineShown } from "./machineSandbox";
import SystemCard from "./intenticOs/SystemCard.vue";
import { showOsLog } from "./intenticOs/system";
import SandboxWindowsCard from "./intenticOs/screen/SandboxWindowsCard.vue";
import SecurityCard from "./intenticOs/screen/SecurityCard.vue";
import ThisComputer from "./intenticOs/ThisComputer.vue";
import { followOnScreen, onScreen } from "../onScreen";
import PcSetupCard from "./pcSetup/PcSetupCard.vue";
import UninstallRow from "./uninstall/UninstallRow.vue";
import PasswordsOffer from "../passwords/PasswordsOffer.vue";
import { pcCardShown } from "./pcSetup/livePcCard";
import { DEVICES_PATH, DOCKER_DOCS, REFRESH_EVERY_MS, useDevice } from "./useDevice";
import { engineBackShown, engineDownSentence, engineEventful, engineQuiet, showMoveLog } from "./engine";
import { moveTargetOf } from "./engineMove";

// DEVICES, IN A LOCAL WINDOW: the page the app adds to a local window's rail (host.ts), where the launcher window's card
// used to be. It is the workspace's Devices view opened on one machine, the one this window runs on: the same masthead
// (the kit's DeviceEnvironmentRow: the computer's name, its OS, its engine's size, its agent and the agent's verb), the
// same Sandboxes list with every verb the workspace has for them, and the same Danger zone at the foot, holding what only
// this computer can do to itself (removing Intentic from it). There is no board to go back to here: "All devices" opens
// the workspace's. Between the masthead and the list sits what only the app on this computer can do: the recovery
// panel's fix and a setup handed over from the workspace, which lead for as long as they are here, this PC's own setup
// (pcSetup/PcSetupCard.vue), this computer's own sandbox, and the Docker engine they run in. A computer that runs no
// sandbox is told what one is for and offered the way to one, and nothing about Docker: somebody here for their files
// has no business with it. Until 2026-10-20 this page was "This computer", headed and laid out on its own, and had
// drifted from the workspace's page about the very same machine.

const t = useT();
const device = useDevice();
const {
    info,
    facts,
    refresh,
    read,
    dockerReady,
    engineListening,
    dockerStarting,
    dockerReport,
    dockerStartedAt,
    dockerCardShown,
    startDocker,
    openDocker,
    engineState,
    onOurEngine,
    engineMoving,
    engineMoveEnd,
    engineMoveError,
    engineCleaning,
    engineCleanupNote,
    engineOfferError,
    loadEngine,
    followEngine,
    moveEngine,
    declineEngineMove,
    removeEngineCopies,
    dismissEngineMove,
    engineOfferShown,
    engine,
    osState,
    osRun,
    osRunEnd,
    osRunError,
    osCheck,
    osChecking,
    osCheckError,
    loadOs,
    followOs,
    restartOs,
    downloadOsUpdate,
    rollBackOs,
    switchOsChannel,
    checkOsUpdate,
    dismissOsRun,
    sandboxes,
    listError,
    status,
    reportError,
    agentPanel,
    machineName,
    machineOs,
    machineMark,
    hardware,
    agentRestarting,
    agentRestartError,
    agentRestartOutcome,
    restartAgent,
    sandboxRows,
    groups,
    agentsElsewhere,
    busy,
    act,
    busyVerb,
    logOpen,
    paneLines,
    rowFailure,
    resizing,
    applyResources,
    saveResources,
    cancelResources,
    update,
    updateError,
    applyUpdate,
    pending,
    setupMode,
    setupError,
    activeRun,
    running,
    eventsOf,
    requirements,
    requirementState,
    requirementsShown,
    awaitingConsent,
    progressShown,
    setupLog,
    setupLogOpen,
    stopping,
    wasStopped,
    resuming,
    expired,
    resumedHow,
    runSetup,
    stopSetup,
    copyLog,
    logCopied,
    openLogFolder,
    backToWorkspace,
    closeSetup,
    toggleSetupLog,
    sessionEndAwaited,
    waitingFor,
    setUpElsewhere,
    installRequirements,
    endSession,
    freshCode,
    pcParked,
    syncSetup,
    syncLines,
    retrySync,
    dismissSync,
    fix,
    fixQueued,
    fixLimitMinutes,
    fixName,
    runFix,
    dismissFix,
} = device;

// Whether this machine's Docker is this page's business: a sandbox runs or has run here, or one is being set up. On a
// machine that only opens files, an engine that is off is nobody's problem, and saying so was the launcher's old nag.
const dockerMatters = computed(
    () => facts.value?.hostsSandboxes === true || groups.value.length > 0 || pending.value !== undefined || machineNeedsDocker.value,
);

// Which engine the sandboxes run on, and the move to the other (engine.ts). It stands back while Docker's own card is up,
// which is the one thing to act on then, but never from a move: its card is the move's while it runs and just after.
const engineShown = computed(() => engineState.value !== undefined && !engineQuiet.value && (!dockerCardShown.value || engineEventful.value));
// The engine is down on a computer that has hosted a sandbox: an empty list says nothing about what is here.
const engineDownWithSandboxes = computed(() => engineListening.value === false && facts.value?.hostsSandboxes === true);
// A sandbox by the name this app knows it by, else its slug: what a move says it is moving.
const sandboxName = (slug: string): string => sandboxes.value.find((sandbox) => sandbox.slug === slug)?.name ?? slug;

// The way to a sandbox, from a computer that has none: the workspace's setup once there is an account, a sign-in before.
const signedIn = computed(() => facts.value?.accountSeen === true);
const toSetup = async (): Promise<void> => {
    await (signedIn.value ? workspaceOpen(`/setup`) : signIn());
};

// The masthead's errands, on its own spine as the workspace's page hangs them: what the agent wants, the answer to the
// last Restart, an agent that did not answer, and the other sides of this computer that keep sandboxes of their own.
const agentNotes = computed(() => (agentPanel.value === undefined ? [] : agentLines(agentPanel.value)));
const mastheadErrands = computed(
    () =>
        agentNotes.value.length > 0 ||
        agentRestartError.value !== undefined ||
        agentRestartOutcome.value !== undefined ||
        reportError.value !== undefined ||
        agentsElsewhere.value.length > 0,
);

// The row a verb is working on, by the id the list knows it by: its status glyph spins, as on the workspace's page.
const busyIds = computed(() => {
    const slug = busy.value?.slug;
    return slug === undefined ? [] : groups.value.filter((group) => group.sandbox?.slug === slug).map((group) => group.sandboxId);
});

/* The way back says where it goes, and that leaving this page does not stop a live setup. */
const backTip = computed((): Tip => ({ title: t(`desktop.app.openWorkspace`), note: running.value ? t(`desktop.app.installKeepsRunning`) : `` }));

// Read on arrival and then again while the page is on screen, so a sandbox started from the workspace or an agent that
// came back shows up without a press. A hidden window reads nothing, and reads at once when it is shown again: hidden as
// the app says it (onScreen.ts), since a Windows webview in the tray still calls itself visible. One read at a time: a
// docker that is not there can hold a read past the next tick, which then waits for it instead of piling on.
followOnScreen();
const reading = usePoll({
    everyMs: REFRESH_EVERY_MS,
    visible: onScreen,
    check: async () => {
        await refresh();
        followEngine();
        followOs();
    },
});
onMounted(() => {
    // The engine on opening, not on the timer: `ic engine status` asks WSL and docker, and changes only by a move.
    void loadEngine();
    // This system on opening, and on the timer only now and then (system.ts `followOs`).
    void loadOs();
    reading.start();
});
</script>

<template>
    <Page>
        <div class="flex flex-col gap-6">
            <div class="flex flex-col gap-3">
                <!-- Where the workspace's page has its way back to the board: every machine of this account is there, one
                     window away. The arrow says it leaves this window, which a back chevron would not. -->
                <button
                    v-if="signedIn"
                    type="button"
                    :class="ui.textButton({ size: `xs` }, `inline-flex w-fit items-center`)"
                    v-tooltip.right="t(`desktop.app.openWorkspace`)"
                    @click="workspaceOpen(DEVICES_PATH)"
                >
                    {{ t(`ui.devicePage.allDevices`) }}
                    <Icon name="arrow-up-right" class="text-2xs" aria-hidden="true" />
                </button>

                <!-- THIS COMPUTER'S MASTHEAD, the workspace's own for a machine of one environment: its name, its OS, its
                     engine's size, its agent's build and state, and the agent's one verb. This window runs ON the device,
                     so the verb never needs a command to go and type. -->
                <DeviceEnvironmentRow
                    :masthead="true"
                    :name="machineName"
                    :kind="machineOs"
                    :mark="machineMark"
                    :hardware="hardware"
                    :version="agentPanel?.version"
                    :state="agentPanel?.state"
                    :actions="agentPanel?.actions"
                    :running="agentRestarting ? `restart` : undefined"
                    :busy="running || busy !== undefined"
                    @run="void restartAgent()"
                >
                    <template v-if="mastheadErrands" #below>
                        <DeviceAgentNotes :notes="agentNotes" />
                        <!-- The agent's own answer to Restart, refusal or otherwise; the badge above shows whether the loop came back. -->
                        <Notice v-if="agentRestartError" tone="danger" class="text-2xs">{{ agentRestartError }}</Notice>
                        <p v-else-if="agentRestartOutcome" class="text-xs text-muted">{{ agentRestartOutcome }}</p>
                        <!-- The agent didn't answer, which is a different absence from having none. -->
                        <Notice v-if="reportError" tone="danger" class="text-2xs">{{ reportError }}</Notice>
                        <!-- This computer's other environments with an agent of their own (a WSL distro's), which keep the sandboxes set up there. -->
                        <p v-if="agentsElsewhere.length > 0" class="flex items-start gap-1.5 text-xs text-subtle">
                            <Icon name="server" class="shrink-0" />
                            <span>{{ t(`desktop.device.agentsElsewhere`, { places: agentsElsewhere.join(`, `) }) }}</span>
                        </p>
                    </template>
                </DeviceEnvironmentRow>
            </div>

            <!-- The app's own update: what is true now, never a promise about later. -->
            <Notice v-if="update.kind === `ready`" tone="info" class="items-center">
                <span>{{ t(`desktop.app.intenticDownloadedInstallsQuit`, { version: update.version }) }}</span>
                <Button class="ml-2" size="small" tier="boring" :label="t(`desktop.app.updateRestart`)" @click="applyUpdate" />
            </Notice>
            <!-- A deb or rpm upgrade already replaced this app on disk: the restart onto it is all that is left. -->
            <Notice v-else-if="update.kind === `installed`" tone="info" class="items-center">
                <span>{{ t(`desktop.app.newerIntenticInstalled`) }}</span>
                <Button class="ml-2" size="small" tier="boring" :label="t(`desktop.app.restartIntentic`)" @click="applyUpdate" />
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
            <Notice v-if="updateError && (update.kind === `ready` || update.kind === `installed`)" tone="warning" class="items-center">{{
                updateError
            }}</Notice>

            <!-- The recovery panel's "Fix it", first: it is what the app brought this page forward for (fix.rs). -->
            <FixProgress
                v-if="fix"
                :view="fix.view"
                :name="fixName"
                :queued="fixQueued"
                :failure="fix.failure"
                :limit-minutes="fixLimitMinutes"
                :busy="running"
                @accept="(id) => void runFix([id])"
                @dismiss="dismissFix"
            />

            <!-- THIS PC'S OWN SETUP, ITS SIGN-IN AND THE FIRST TASK, on a Windows PC until it is ready and someone is signed in:
                 ahead of this computer's sandbox, which waits for it. -->
            <PcSetupCard />

            <!-- THIS COMPUTER'S OWN SANDBOX, made by the app in the background for the folders worked on with an agent. -->
            <MachineSandboxSection v-if="machineShown" />
            <!-- What this computer left on the account before it kept one sandbox: offered for removal, never removed by itself. -->
            <LeftoverSandboxes :signed-in="signedIn" />

            <!-- A SETUP HANDED OVER FROM THE WORKSPACE leads the page while it is here: the one thing on it with minutes of its own. -->
            <section v-if="setupMode" class="flex flex-col gap-4 rounded-xl bg-card shadow-sm p-5">
                <header class="flex items-start gap-3 text-base">
                    <Icon name="box" class="shrink-0 text-lg text-link" />
                    <div class="min-w-0 flex-1">
                        <h2 class="text-base leading-tight font-semibold">
                            {{ t(`desktop.app.settingUp`) }} {{ pending?.name ?? t(`desktop.app.sandbox`) }}
                        </h2>
                        <!-- What the next few minutes are, in one sentence; gone once the run has stopped, when the card below is the true one. -->
                        <p v-if="pcParked" class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.app.pcSetupFirst`) }}</p>
                        <p v-else-if="!expired && !setupError && !wasStopped" class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">
                            <template v-if="resuming">{{ t(`desktop.app.pickingUpWhereRestart`) }}</template>
                            <template v-else-if="requirementsShown">{{ t(`desktop.app.nothingOnComputerChanges`) }}</template>
                            <template v-else>{{ t(`desktop.app.gettingComputerReadyStarting`) }}</template>
                        </p>
                    </div>
                    <!-- SAYS WHERE IT GOES: the setup came from the workspace, and leaving this page stops nothing. -->
                    <Button
                        size="small"
                        tier="quiet"
                        class="-my-1 shrink-0"
                        :label="t(`desktop.app.backToWorkspace`)"
                        v-tooltip.left="backTip"
                        @click="backToWorkspace"
                    >
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                </header>

                <!-- The code is older than the platform will accept, and the app could not mint a fresh one itself: not a dead end, one click. -->
                <Notice v-if="expired" tone="warning" class="items-center text-xs">
                    <span class="flex-1">{{ resumedHow ? t(`desktop.app.setupCodeRanOut`) : t(`desktop.app.setupCodeRanOutHere`) }}</span>
                    <Button class="ml-2 shrink-0" size="small" tier="boring" :label="t(`desktop.app.getFreshCode`)" @click="freshCode" />
                </Notice>
                <!-- THIS PC'S OWN SETUP COMES FIRST: parked, the header's one line says so, and the card for this PC above
                     does it; the setup carries on by itself after. `=== false`, not `!`: unknown is a real third state here. -->
                <p v-if="!pcParked && dockerReady === false && !expired && requirements.length === 0" class="flex items-start gap-2.5 text-xs text-subtle">
                    <Icon name="box" class="shrink-0 text-warning" />
                    <span v-if="info?.os === `windows`">{{ t(`desktop.app.sandboxRunsInDocker`) }}</span>
                    <span v-else>{{ t(`desktop.app.sandboxRunsInDocker2`) }}</span>
                </p>

                <!-- Leads above the progress bar, since it's the only thing here to act on. -->
                <Requirements
                    v-if="requirementsShown && !pcParked"
                    :requirements="requirements"
                    :busy="running"
                    :progress="requirementState"
                    :resumed-from="resumedHow"
                    @install="installRequirements"
                    @restart="endSession(`restart`)"
                    @signout="endSession(`signout`)"
                    @recheck="runSetup(`recheck`)"
                    @elsewhere="setUpElsewhere(`requirements`)"
                />
                <!-- Only where the progress card cannot say it: with a plan on screen, the failure is told once, there. -->
                <Notice v-else-if="setupError && !expired && !progressShown && !pcParked" tone="danger" class="text-xs">{{ setupError }}</Notice>

                <!-- A user-ended run isn't a failure, but still gets said out loud rather than just stopping silently. -->
                <p v-if="wasStopped && !pcParked" class="flex items-start gap-2.5 text-xs text-subtle">
                    <Icon name="times" class="shrink-0" />
                    <span>{{ t(`desktop.app.stoppedInstallNothingElse`) }}</span>
                </p>

                <SetupProgress
                    v-if="progressShown && !expired && !pcParked"
                    :events="eventsOf(`setup`)"
                    :view="progressShown"
                    :running="activeRun === `setup`"
                    :reason="setupError"
                    :awaiting="awaitingConsent"
                    :blocked="requirementsShown"
                    v-model:open="setupLogOpen"
                />

                <!-- Only on failure: the hosted alternative rides the same row, as it does on the requirements card. -->
                <div
                    v-if="(setupError || wasStopped) && !expired && requirements.length === 0 && !pcParked"
                    class="flex flex-wrap items-center gap-x-4 gap-y-2"
                >
                    <Button :label="t(`ui.action.tryAgain`)" :disabled="running" @click="runSetup(`retry`)">
                        <template #icon><Icon name="bolt" /></template>
                    </Button>
                    <button type="button" :class="ui.textButton({ tone: `quiet` })" :disabled="running" @click="setUpElsewhere(`stopped`)">
                        <Icon name="server" class="shrink-0" />
                        <span>{{ t(`desktop.requirements.runOnMachineWe`) }}</span>
                    </button>
                </div>

                <!-- THE FOOT OF THE CARD: the true sentence about leaving, then the quiet verbs. None of them is the accent. -->
                <footer v-if="!expired" class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-subtle">
                    <span v-if="running" class="min-w-0 flex-1">{{ t(`desktop.app.closingWindowDoesntStop`) }}</span>
                    <span v-else class="flex-1" />
                    <button v-if="running" type="button" :class="ui.textButton({ tone: `quiet` }, `shrink-0`)" :disabled="stopping" v-action="stopSetup">
                        {{ stopping ? t(`desktop.app.stopping`) : t(`ui.action.stop`) }}
                    </button>
                    <button v-if="progressShown && !pcParked" type="button" :class="ui.textButton({ tone: `quiet` }, `shrink-0`)" @click="toggleSetupLog">
                        {{ setupLogOpen ? t(`desktop.app.hideLog`) : t(`desktop.app.showLog`) }}
                    </button>
                    <!-- Only beside an open log: away from it, "copy" and "folder" name a thing the reader has not been shown. -->
                    <template v-if="setupLogOpen && !pcParked">
                        <button type="button" :class="ui.textButton({ tone: `quiet` }, `shrink-0`)" v-action="copyLog">
                            {{ logCopied ? t(`ui.action.copied`) : t(`desktop.app.copy`) }}
                        </button>
                        <button v-if="setupLog" type="button" :class="ui.textButton({ tone: `quiet` }, `shrink-0`)" v-tooltip.top="setupLog" v-action="openLogFolder">
                            {{ t(`desktop.app.openFolder`) }}
                        </button>
                    </template>
                    <!-- A card whose run is over goes when the reader says so; a live one stays, so a later failure has somewhere to land. -->
                    <button v-if="!running" type="button" :class="ui.textButton({ tone: `quiet` }, `shrink-0`)" @click="closeSetup">
                        {{ t(`ui.action.dismiss`) }}
                    </button>
                </footer>
            </section>

            <!-- A sync enrollment in flight: folder picked in the system dialog, same script as the card's one-liner, narrating here. -->
            <section v-if="syncSetup" class="flex flex-col gap-3 rounded-xl bg-card shadow-sm p-4">
                <div class="flex items-start gap-2.5 text-sm">
                    <Icon name="sync" class="text-link" />
                    <div class="min-w-0 flex-1">
                        <h2 class="text-sm leading-tight font-semibold">
                            {{
                                syncSetup.args.mirror
                                    ? t(`desktop.app.mirroringPortsFrom`, { sandbox: syncSetup.args.name ?? t(`desktop.app.yourSandbox`) })
                                    : t(`desktop.app.connectingFolderTo`, { sandbox: syncSetup.args.name ?? t(`desktop.app.yourSandbox`) })
                            }}
                        </h2>
                        <p v-if="syncSetup.dir" class="font-mono text-2xs break-all text-subtle">{{ syncSetup.dir }}</p>
                    </div>
                    <Button v-if="syncSetup.error" size="small" tier="quiet" class="-my-1 shrink-0" @click="dismissSync">
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
                <!-- The same pairing again: good for this machine for ten minutes on a current sandbox; the note covers an older or late one. -->
                <div v-if="syncSetup.error" class="flex flex-wrap items-center gap-3">
                    <Button :label="t(`ui.action.tryAgain`)" size="small" :disabled="running" @click="retrySync">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <span class="text-2xs text-subtle">{{ t(`desktop.app.saysPairingAlreadyUsed`) }}</span>
                </div>
            </section>

            <!-- THIS SYSTEM, on a computer that runs Intentic OS: its version, its health, and what waits for its next boot,
                 with the restart into it. Ahead of the engine and the sandboxes, which that restart takes down and back. -->
            <SystemCard
                v-if="osState"
                :status="osState"
                :progress="osRun"
                :end="osRunEnd"
                :error="osRunError"
                :check="osCheck"
                :checking="osChecking"
                :check-error="osCheckError"
                :busy="running || busy !== undefined"
                @restart="(restart) => void restartOs(restart)"
                @check="checkOsUpdate"
                @download="downloadOsUpdate"
                @roll-back="rollBackOs"
                @channel="(channel) => void switchOsChannel(channel)"
                @dismiss="dismissOsRun"
                @log="showOsLog"
            />
            <!-- THIS COMPUTER, on Intentic OS: its network, sound, screens, keyboard and the drives plugged in, each a card. -->
            <ThisComputer v-if="osState" />
            <!-- The screen's PIN after the everyday settings: only the desktop edition has a screen to lock. -->
            <SecurityCard v-if="osState?.edition === `desktop`" />
            <!-- Which sandboxes may open windows on this screen: none until the owner turns one on. -->
            <SandboxWindowsCard v-if="osState?.edition === `desktop`" />

            <!-- A PC WAITING FOR WINDOWS TO END THE SESSION, with the setup card put away: Docker cannot run until then, and
                 a "Docker wouldn't start" card here sent a reader pressing its "Check again" instead of restarting. -->
            <Notice v-if="!setupMode && sessionEndAwaited" tone="warning" icon="refresh" class="items-center">
                <span class="min-w-0 flex-1">{{
                    waitingFor === `restart`
                        ? t(`desktop.app.dockerWaitsForRestart`)
                        : t(`desktop.app.dockerWaitsForSignOut`)
                }}</span>
                <Button
                    v-if="waitingFor === `restart`"
                    class="ml-2 shrink-0"
                    size="small"
                    :label="t(`desktop.requirements.restartNow`)"
                    @click="endSession(`restart`)"
                />
                <Button v-else class="ml-2 shrink-0" size="small" :label="t(`desktop.requirements.signOutNow`)" @click="endSession(`signout`)" />
                <button type="button" :class="ui.textButton({ tone: `quiet` }, `ml-3 shrink-0`)" @click="setUpElsewhere(`requirements`)">
                    <Icon name="server" class="shrink-0" />
                    <span>{{ t(`desktop.requirements.runOnMachineWe`) }}</span>
                </button>
            </Notice>
            <!-- THE ENGINE, while the app is starting it and after a start that did not work out. It leads the sandboxes
                 because a list drawn above a dead Docker is a list of things that are not there. A setup on screen owns
                 the engine (`ic docker prepare` starts it as one of its steps), so the card stands down beside one. -->
            <template v-else-if="dockerMatters && !setupMode">
                <DockerCard
                    v-if="dockerCardShown"
                    :starting="dockerStarting"
                    :started-at="dockerStartedAt"
                    :limit-seconds="info?.engineLimitSeconds"
                    :report="dockerReport"
                    :os="info?.os"
                    :ours="onOurEngine"
                    @start="startDocker(`card`)"
                    @open="openDocker"
                    @install="openUrl(DOCKER_DOCS)"
                />
                <!-- Docker answered and refused, or never answered: its own words, and the press that asks again. -->
                <Notice v-else-if="listError" tone="warning" class="items-start text-2xs">
                    <span class="block font-medium">{{ t(`desktop.app.dockerDidntAnswer`) }}</span>
                    <span class="mt-0.5 block font-mono break-words text-subtle">{{ listError }}</span>
                    <Button class="mt-2" size="small" tier="boring" :label="t(`desktop.docker.checkAgain`)" :disabled="running" @click="refresh" />
                </Notice>
                <!-- Docker is down and nothing here started it on its own: the start is offered rather than taken. This
                     computer's own sandbox offers the same start in its section, which is not said twice. -->
                <Notice v-else-if="engineListening === false && !machineNeedsDocker" tone="warning" icon="box" class="items-center">
                    <span class="min-w-0 flex-1">{{ engineDownSentence }}</span>
                    <Button
                        class="ml-2 shrink-0"
                        size="small"
                        tier="boring"
                        :label="onOurEngine ? t(`desktop.app.startEngine`) : t(`desktop.app.startDocker`)"
                        @click="startDocker(`notice`)"
                    />
                </Notice>
                <!-- WHICH ENGINE THE SANDBOXES RUN ON: Docker Desktop or Intentic's own, and the move to the other, ahead of
                     the sandboxes it would move. Quiet unless the move is worth making, runs, or has just ended. -->
                <EngineCard
                    v-if="engineShown && engineState"
                    :status="engineState"
                    :progress="engineMoving"
                    :end="engineMoveEnd"
                    :error="engineMoveError"
                    :busy="running || busy !== undefined"
                    :cleaning="engineCleaning"
                    :cleanup-note="engineCleanupNote"
                    :offer-error="engineOfferError"
                    :name-of="sandboxName"
                    @move="(to, offered) => void moveEngine(to, offered)"
                    @decline="declineEngineMove"
                    @cleanup="removeEngineCopies"
                    @dismiss="dismissEngineMove"
                    @log="showMoveLog"
                    @shown="engineOfferShown"
                />
            </template>

            <!-- THE SANDBOXES, as the workspace's page lists them: one card per sandbox with its folder, ports, image and
                 version, and one quiet ⋯ holding its verbs, done here through this computer's own ic. -->
            <Section v-if="groups.length > 0" :label="t(`ui.devicePage.sandboxes`)">
                <DeviceDetail :pairings="status?.sync.pairings" :ports="status?.sync.ports" :sandboxes="sandboxRows" :busy="busyIds">
                    <!-- No `busy`: the row's status glyph already spins (DeviceDetail `busy`). -->
                    <template #actions="{ group }">
                        <SandboxVerbs
                            v-if="group.sandbox"
                            :compact="true"
                            :running="group.sandbox.running"
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
            </Section>

            <!-- NO SANDBOX HERE YET: what one is for, where it can run, and the one step to it. Never while a setup or a
                 sync is on the page, which is the sandbox arriving, nor before the machine has been read, nor while the
                 engine of a computer that hosts sandboxes is down: the list is empty then because nothing can be asked,
                 and the notice above says its sandboxes are not running (seen on omen, 2026-10-10). Nor beside this PC's
                 own card, which carries the sign-in and the way to agents here: one way forward, not two. -->
            <section
                v-else-if="read && !setupMode && !syncSetup && !listError && !machineShown && !engineDownWithSandboxes && !pcCardShown"
                class="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line p-5"
            >
                <div class="flex items-start gap-3">
                    <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600/10 text-link">
                        <Icon name="box" class="text-lg" />
                    </span>
                    <div class="min-w-0 flex-1">
                        <h2 class="text-sm font-semibold text-content">{{ t(`desktop.device.noSandboxTitle`) }}</h2>
                        <p class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.device.noSandboxLead`) }}</p>
                    </div>
                </div>
                <Button
                    size="small"
                    :label="signedIn ? t(`desktop.device.setOneUp`) : t(`desktop.device.signInToSetUp`)"
                    class="ml-12"
                    @click="toSetup"
                >
                    <template #icon><Icon :name="signedIn ? `plus` : `sign-in`" /></template>
                </Button>
            </section>

            <!-- The way back to Docker Desktop, last and in the quietest ink: Intentic's engine is where sandboxes belong on a
                 PC, so the move away is there for whoever looks for it and never put in front of anyone. The move asks first. -->
            <p v-if="engineBackShown && engineState" class="flex flex-wrap items-center gap-x-1.5 text-2xs text-subtle">
                <span>{{ t(`desktop.engine.runsOn.intentic`) }}</span>
                <span aria-hidden="true">·</span>
                <button
                    type="button"
                    :class="ui.textButton({ tone: `quiet` })"
                    :disabled="running || busy !== undefined"
                    @click="void moveEngine(moveTargetOf(engineState) ?? `docker-desktop`, false)"
                >
                    {{ t(`desktop.engine.moveBack`) }}
                </button>
            </p>
            <!-- PASSWORDS, offered while this computer has not set it up: it has no rail tile until then. -->
            <PasswordsOffer />
            <!-- THE DANGER ZONE, last of all and in the group the workspace's page ends on, where it revokes a machine's
                 access: what only this computer can do to itself is remove Intentic, and it asks before anything goes.
                 Not on Intentic OS, where Intentic is the system itself. -->
            <RowGroup v-if="!osState" :label="t(`ui.devicePage.dangerZone`)">
                <UninstallRow :app-version="info?.version" />
            </RowGroup>
        </div>

        <!-- The sandbox's shape as ic reports it (running and saved for the next restart) and this engine's size for the form's rails. -->
        <SandboxResourcesDialog
            :open="resizing !== undefined"
            :name="resizing?.title ?? ``"
            :current="resizing?.sandbox?.resources"
            :engine="engine"
            can-save
            @cancel="cancelResources"
            @apply="applyResources"
            @save="saveResources"
        />
    </Page>
</template>
