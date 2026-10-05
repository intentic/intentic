<script setup lang="ts">
import {
    Button,
    DeviceAgentGroup,
    DeviceDetail,
    DeviceRunLog,
    Notice,
    Page,
    PageAction,
    PageHeader,
    RowGroup,
    SandboxResourcesDialog,
    SandboxVerbs,
    type Tip,
    ui,
    vAction,
} from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted } from "vue";
import DockerCard from "../components/DockerCard.vue";
import FixProgress from "../components/FixProgress.vue";
import Requirements from "../components/Requirements.vue";
import SetupProgress from "../components/SetupProgress.vue";
import { openUrl, signIn, workspaceOpen } from "../desktop";
import MachineSandboxSection from "./MachineSandboxSection.vue";
import { machineSandbox } from "./machineSandbox";
import { DEVICES_PATH, DOCKER_DOCS, REFRESH_EVERY_MS, useDevice } from "./useDevice";

// THIS DEVICE: the page the app adds to a local window's rail (host.ts), where the launcher window's card used to be.
// This computer's sandboxes with every verb the workspace's Devices tab has for them, its machine agent, the Docker
// engine they run in, and the work the app runs here: the recovery panel's fix and a setup handed over from the workspace
// lead the page for as long as they are here. A computer that runs no sandbox is told what one is for and offered the
// way to one, and nothing about Docker: somebody here for their files has no business with it.

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
    engine,
    listError,
    status,
    reportError,
    agentPanel,
    machineName,
    hardware,
    agentRestarting,
    agentRestartError,
    agentRestartOutcome,
    restartAgent,
    sandboxRows,
    groups,
    keptByOf,
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

// This computer's own sandbox (machineSandbox.ts), said at the top of the page from the moment there is anything to say
// about it: once someone is signed in, or a folder waits for it. Before that the page's own "no sandbox" card offers the
// sign-in, and one way to it is enough.
const machineShown = computed(() => {
    const record = machineSandbox.value;
    return record !== undefined && (record.state !== `signedOut` || record.folders.some((folder) => folder.state === `queued`));
});
// It waits on Docker: the engine's own card and notice are its way forward.
const machineNeedsDocker = computed(() => machineSandbox.value?.state === `needsDocker`);

// Whether this machine's Docker is this page's business: a sandbox runs or has run here, or one is being set up. On a
// machine that only opens files, an engine that is off is nobody's problem, and saying so was the launcher's old nag.
const dockerMatters = computed(
    () => facts.value?.hostsSandboxes === true || groups.value.length > 0 || pending.value !== undefined || machineNeedsDocker.value,
);

// The way to a sandbox, from a computer that has none: the workspace's setup once there is an account, a sign-in before.
const signedIn = computed(() => facts.value?.accountSeen === true);
const toSetup = async (): Promise<void> => {
    await (signedIn.value ? workspaceOpen(`/setup`) : signIn());
};

/* The way back says where it goes, and that leaving this page does not stop a live setup. */
const backTip = computed((): Tip => ({ title: t(`desktop.app.openWorkspace`), note: running.value ? t(`desktop.app.installKeepsRunning`) : `` }));

// Read on arrival and then again while the page is on screen, so a sandbox started from the workspace or an agent that
// came back shows up without a press. A hidden window reads nothing.
let timer: ReturnType<typeof setInterval> | undefined;
const readWhenShown = (): void => {
    if (document.visibilityState === `visible`) {
        void refresh();
    }
};
onMounted(() => {
    void refresh();
    timer = setInterval(readWhenShown, REFRESH_EVERY_MS);
    document.addEventListener(`visibilitychange`, readWhenShown);
});
onUnmounted(() => {
    clearInterval(timer);
    document.removeEventListener(`visibilitychange`, readWhenShown);
});
</script>

<template>
    <Page>
        <PageHeader :title="t(`desktop.device.title`)">
            <template #info>
                <!-- The machine's own facts in the quietest ink: what tells this computer apart from the others enrolled. -->
                <span v-if="hardware !== ``" class="min-w-0 truncate text-xs text-subtle" v-tooltip.bottom="info?.appUrl">{{ hardware }}</span>
            </template>
            <template #actions>
                <PageAction :label="t(`ui.action.refresh`)" icon="refresh" quiet :disabled="running" @click="refresh" />
                <!-- The workspace's Devices tab manages these same containers, and every other computer of this account. -->
                <PageAction
                    v-if="signedIn"
                    :label="t(`desktop.app.seeAllDevices`)"
                    icon="desktop"
                    quiet
                    @click="workspaceOpen(DEVICES_PATH)"
                />
            </template>
            <template #description>{{ t(`desktop.device.lead`) }}</template>
        </PageHeader>

        <div class="flex flex-col gap-6">
            <!-- The app's own update: what is true now, never a promise about later. -->
            <Notice v-if="update.kind === `ready`" tone="info" class="items-center">
                <span>{{ t(`desktop.app.intenticDownloadedInstallsQuit`, { version: update.version }) }}</span>
                <Button class="ml-2" size="small" severity="secondary" :label="t(`desktop.app.updateRestart`)" @click="applyUpdate" />
            </Notice>
            <!-- A deb or rpm upgrade already replaced this app on disk: the restart onto it is all that is left. -->
            <Notice v-else-if="update.kind === `installed`" tone="info" class="items-center">
                <span>{{ t(`desktop.app.newerIntenticInstalled`) }}</span>
                <Button class="ml-2" size="small" severity="secondary" :label="t(`desktop.app.restartIntentic`)" @click="applyUpdate" />
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

            <!-- THIS COMPUTER'S OWN SANDBOX, made by the app in the background for the folders worked on with an agent. -->
            <MachineSandboxSection v-if="machineShown" />

            <!-- A SETUP HANDED OVER FROM THE WORKSPACE leads the page while it is here: the one thing on it with minutes of its own. -->
            <section v-if="setupMode" class="flex flex-col gap-4 rounded-xl bg-card shadow-sm p-5">
                <header class="flex items-start gap-3">
                    <Icon name="box" class="mt-1 shrink-0 text-lg text-link" />
                    <div class="min-w-0 flex-1">
                        <h2 class="text-base leading-tight font-semibold">
                            {{ t(`desktop.app.settingUp`) }} {{ pending?.name ?? t(`desktop.app.sandbox`) }}
                        </h2>
                        <!-- What the next few minutes are, in one sentence; gone once the run has stopped, when the card below is the true one. -->
                        <p v-if="!expired && !setupError && !wasStopped" class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">
                            <template v-if="resuming">{{ t(`desktop.app.pickingUpWhereRestart`) }}</template>
                            <template v-else-if="requirementsShown">{{ t(`desktop.app.nothingOnComputerChanges`) }}</template>
                            <template v-else>{{ t(`desktop.app.gettingComputerReadyStarting`) }}</template>
                        </p>
                    </div>
                    <!-- SAYS WHERE IT GOES: the setup came from the workspace, and leaving this page stops nothing. -->
                    <Button
                        size="small"
                        severity="secondary"
                        :text="true"
                        class="-my-1 shrink-0"
                        :label="t(`desktop.app.backToWorkspace`)"
                        v-tooltip.left="backTip"
                        @click="backToWorkspace"
                    >
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                </header>

                <!-- The code this window came back to is older than the platform will accept: not a dead end, one click. -->
                <Notice v-if="expired" tone="warning" class="items-center text-xs">
                    <span class="flex-1">{{ t(`desktop.app.setupCodeRanOut`) }}</span>
                    <Button class="ml-2 shrink-0" size="small" severity="secondary" :label="t(`desktop.app.getFreshCode`)" @click="freshCode" />
                </Notice>
                <!-- `=== false`, not `!`: unknown is a real third state here, not yet a warning. -->
                <p v-if="dockerReady === false && !expired && requirements.length === 0" class="flex items-start gap-2.5 text-xs text-subtle">
                    <Icon name="box" class="mt-0.5 shrink-0 text-warning" />
                    <span v-if="info?.os === `windows`">{{ t(`desktop.app.sandboxRunsInDocker`) }}</span>
                    <span v-else>{{ t(`desktop.app.sandboxRunsInDocker2`) }}</span>
                </p>

                <!-- Leads above the progress bar, since it's the only thing here to act on. -->
                <Requirements
                    v-if="requirementsShown"
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

                <!-- Only on failure: the hosted alternative rides the same row, as it does on the requirements card. -->
                <div v-if="(setupError || wasStopped) && !expired && requirements.length === 0" class="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Button :label="t(`ui.action.tryAgain`)" :disabled="running" @click="runSetup(`retry`)">
                        <template #icon><Icon name="bolt" /></template>
                    </Button>
                    <button type="button" :class="ui.textAction()" :disabled="running" @click="setUpElsewhere(`stopped`)">
                        <Icon name="server" class="shrink-0" />
                        <span>{{ t(`desktop.requirements.runOnMachineWe`) }}</span>
                    </button>
                </div>

                <!-- THE FOOT OF THE CARD: the true sentence about leaving, then the quiet verbs. None of them is the accent. -->
                <footer v-if="!expired" class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-subtle">
                    <span v-if="running" class="min-w-0 flex-1">{{ t(`desktop.app.closingWindowDoesntStop`) }}</span>
                    <span v-else class="flex-1" />
                    <button v-if="running" type="button" :class="ui.textAction(`shrink-0`)" :disabled="stopping" v-action="stopSetup">
                        {{ stopping ? t(`desktop.app.stopping`) : t(`ui.action.stop`) }}
                    </button>
                    <button v-if="progressShown" type="button" :class="ui.textAction(`shrink-0`)" @click="toggleSetupLog">
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
                    <!-- A card whose run is over goes when the reader says so; a live one stays, so a later failure has somewhere to land. -->
                    <button v-if="!running" type="button" :class="ui.textAction(`shrink-0`)" @click="closeSetup">
                        {{ t(`ui.action.dismiss`) }}
                    </button>
                </footer>
            </section>

            <!-- A sync enrollment in flight: folder picked in the system dialog, same script as the card's one-liner, narrating here. -->
            <section v-if="syncSetup" class="flex flex-col gap-3 rounded-xl bg-card shadow-sm p-4">
                <div class="flex items-start gap-2.5">
                    <Icon name="sync" class="mt-0.5 text-link" />
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
                    <Button v-if="syncSetup.error" size="small" severity="secondary" :text="true" class="-my-1 shrink-0" @click="dismissSync">
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
                <button type="button" :class="ui.textAction(`ml-3 shrink-0`)" @click="setUpElsewhere(`requirements`)">
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
                    @start="startDocker(`card`)"
                    @open="openDocker"
                    @install="openUrl(DOCKER_DOCS)"
                />
                <!-- Docker answered and refused, or never answered: its own words, and the press that asks again. -->
                <Notice v-else-if="listError" tone="warning" class="items-start text-2xs">
                    <span class="block font-medium">{{ t(`desktop.app.dockerDidntAnswer`) }}</span>
                    <span class="mt-0.5 block font-mono break-words text-subtle">{{ listError }}</span>
                    <Button class="mt-2" size="small" severity="secondary" :label="t(`desktop.docker.checkAgain`)" :disabled="running" @click="refresh" />
                </Notice>
                <!-- Docker is down and nothing here started it on its own: the start is offered rather than taken. This
                     computer's own sandbox offers the same start in its section, which is not said twice. -->
                <Notice v-else-if="engineListening === false && !machineNeedsDocker" tone="warning" icon="box" class="items-center">
                    <span class="min-w-0 flex-1">{{ t(`desktop.device.dockerIsntRunning`) }}</span>
                    <Button class="ml-2 shrink-0" size="small" severity="secondary" :label="t(`desktop.app.startDocker`)" @click="startDocker(`notice`)" />
                </Notice>
            </template>

            <!-- One row per sandbox with its folder, ports, image and verbs, in the workspace Devices tab's own group. -->
            <RowGroup v-if="groups.length > 0" :label="t(`desktop.app.sandboxesOnDevice`)" :count="groups.length" :flat="true" :undivided="true">
                <div class="flex flex-col">
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
                            <!-- Another side of this computer keeps it (a WSL distro's agent): its care runs there, and the verbs above still reach it. -->
                            <p
                                v-if="keptByOf(group.sandbox?.slug)"
                                class="flex items-start gap-1.5 text-2xs text-subtle"
                                v-tooltip.top="t(`desktop.device.keptByNote`)"
                            >
                                <Icon name="server" class="mt-0.5 shrink-0" />
                                <span>{{ t(`desktop.device.keptBy`, { place: keptByOf(group.sandbox?.slug) }) }}</span>
                            </p>
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
                </div>
            </RowGroup>

            <!-- NO SANDBOX HERE YET: what one is for, where it can run, and the one step to it. Never while a setup or a
                 sync is on the page, which is the sandbox arriving, nor before the machine has been read. -->
            <section
                v-else-if="read && !setupMode && !syncSetup && !listError && !machineShown"
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

            <!-- The agent didn't answer, which is a different absence from having none. -->
            <Notice v-if="reportError" tone="danger" class="text-2xs">{{ reportError }}</Notice>

            <!-- The machine agent, drawn from this computer's own reading: this window IS the device, so its one verb never
                 needs a command to go and type. Absent on a computer that has none, which is an ordinary state. -->
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
            <!-- This computer's other environments with an agent of their own (a WSL distro's), which keep the sandboxes set up there. -->
            <p v-if="agentsElsewhere.length > 0" class="flex items-start gap-2.5 text-xs text-subtle">
                <Icon name="server" class="mt-0.5 shrink-0" />
                <span>{{ t(`desktop.device.agentsElsewhere`, { places: agentsElsewhere.join(`, `) }) }}</span>
            </p>
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
