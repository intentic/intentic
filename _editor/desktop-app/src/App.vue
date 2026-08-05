<script setup lang="ts">
import { Card, cmp, MachineDetail } from "@intentic/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import Button from "primevue/button";
import { computed, onMounted, onUnmounted, ref, watchEffect } from "vue";
import RunLog from "./components/RunLog.vue";
import SandboxCard from "./components/SandboxCard.vue";
import {
    desktopInfo,
    machineReport,
    onPendingRecreate,
    onPendingSetup,
    onRun,
    onUpdateAvailable,
    pendingSetup,
    sandboxList,
    sandboxPower,
    sandboxRecreate,
    sandboxRemove,
    setupRun,
    takePendingRecreate,
    workspaceOpen,
    type DesktopInfo,
    type MachineReport,
    type RunEvent,
    type SandboxStatus,
    type SetupArgs,
} from "./desktop";

/* THE APP'S OWN FACE — the other half of the one window, and deliberately not a wizard.
 *
 * The workspace face shows the real product (the hosted SPA), so everything about naming a sandbox, picking
 * reachability and minting a setup code stays there, where it already works and where a change ships without
 * an app release. What is left for this one is the two things a web page on another origin cannot do:
 *
 *   • run the setup the SPA just handed over (an `intentic://setup` link), showing what the script says
 *   • manage the containers on THIS machine afterwards — start/stop, update, remove, read the logs
 *
 * They are two SCREENS rather than two sections, and a setup is the whole window while it is happening
 * (`setupMode`). It arrives in the frame the SPA was filling a moment ago (windows.rs), and the manager's
 * furniture beside it — a container list, a version, an "Open workspace" button — would be a set of decisions
 * to make about a machine whose sandbox is still being built.
 *
 * The archived version had three personas here (a wizard, an environment checklist, a manager) in 527 lines.
 * The checklist is gone because the scripts do the reconciling and narrate it as they go; the wizard is gone
 * because it was a second copy of the SPA's setup screen. */

const info = ref<DesktopInfo | undefined>(undefined);
const sandboxes = ref<SandboxStatus[]>([]);
const listError = ref<string | undefined>(undefined);
// What desktop sync is doing here. Undefined = no agent on this computer, which is a fact about the machine and
// not a failure; a string = the agent is installed but would not answer, which is.
const report = ref<MachineReport | undefined>(undefined);
const reportError = ref<string | undefined>(undefined);
const busy = ref<{ slug: string; action: string } | undefined>(undefined);
const updateVersion = ref<string | undefined>(undefined);

// The setup the SPA handed over, and the run it turns into.
const pending = ref<SetupArgs | undefined>(undefined);
const setupError = ref<string | undefined>(undefined);
const runs = ref<Record<string, RunEvent[]>>({});
const activeRun = ref<string | undefined>(undefined);

const eventsOf = (run: string): RunEvent[] => runs.value[run] ?? [];
const running = computed(() => activeRun.value !== undefined);
// A handed-over setup owns the window from the moment it arrives until it hands the window back — which
// includes having failed, because a failure is the one state the user most needs undivided.
const setupMode = computed(() => pending.value !== undefined || activeRun.value === `setup`);

/* The OS title follows the screen. Both faces of the app live in ONE frame (windows.rs swaps them into each
 * other's place), so the title is not decoration: it is the taskbar entry, the alt-tab label, and the only
 * thing outside this process that can say which screen is up — which is what the desktop smoke tier asserts
 * against, having deliberately no test hook to read instead. */
watchEffect(() => {
    void getCurrentWindow().setTitle(setupMode.value ? `Intentic — Setting up your sandbox` : `Intentic — This computer`);
});

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

/* One sandbox's line in the manager: the folder it syncs into here, and how many of its ports reached localhost.
 * This is the join the app could not make before — docker knows the container, the agent knows the pairing, and
 * the slug is not the agent's key, so they meet on the sandbox id the pairing carries ending in the slug's own
 * subdomain label. A sandbox with no pairing gets no line rather than a wrong one. */
const syncLineFor = (sandbox: SandboxStatus): string | undefined => {
    const pairing = report.value?.pairings.find((entry) => entry.sandboxId.split(`.`)[0] === sandbox.slug);
    if (pairing === undefined) {
        return undefined;
    }
    const ports = (report.value?.ports ?? []).filter((port) => port.sandboxId === pairing.sandboxId && port.state === `mirrored`).length;
    const where = pairing.mode === `sync` ? (pairing.localDir ?? `no folder`) : `ports only`;
    return ports === 0 ? where : `${where} · ${ports} port${ports === 1 ? `` : `s`} on localhost`;
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

const runSetup = async (): Promise<void> => {
    const args = pending.value;
    if (args === undefined || running.value) {
        return;
    }
    setupError.value = await start(`setup`, () => setupRun(args));
    if (setupError.value === undefined) {
        pending.value = undefined;
        // The daemon announced itself to the platform on boot, which is exactly what the SPA's setup screen
        // has been polling for — so handing the window back is one poll away from showing the workspace.
        await workspaceOpen();
    }
};

/* A parked setup RUNS on arrival rather than waiting to be asked. The SPA's "Set up on this computer" button
 * is the consent — it says what this does, in the sentence directly above it — and repeating the question on
 * a screen the user did not open is what made the handoff read as a second, unrelated installer. The guard in
 * `runSetup` is what keeps the two ways in here (the event, and the read below on mount) to one run. */
const loadPending = async (): Promise<void> => {
    pending.value = (await pendingSetup()) ?? undefined;
    await runSetup();
};

const power = async (slug: string, startIt: boolean): Promise<void> => {
    busy.value = { slug, action: `power` };
    await start(`power:${slug}`, () => sandboxPower(slug, startIt));
    busy.value = undefined;
};

const update = async (slug: string, hash?: string): Promise<void> => {
    busy.value = { slug, action: `update` };
    await start(`recreate:${slug}`, () => sandboxRecreate(slug, hash));
    busy.value = undefined;
};

/* The SPA's two "paste this on the machine that runs your sandbox" cards, arriving as a click instead: the
 * Update card sends a slug, the Environment card sends a slug and the approved overlay's digest. Taken rather
 * than read, so coming back to this screen later does not re-run an update that already ran. */
const drainRecreate = async (): Promise<void> => {
    const requested = await takePendingRecreate();
    if (requested === null || running.value) {
        return;
    }
    await update(requested.slug, requested.hash);
};

// Removing a sandbox deletes its /work and /history volumes, which is not recoverable and not what the
// neighbouring buttons do — so it asks, in the OS's own dialog rather than one this window draws.
const remove = async (slug: string): Promise<void> => {
    const sandbox = sandboxes.value.find((entry) => entry.slug === slug);
    const confirmed = await confirm(
        `This deletes ${sandbox?.name ?? slug} and everything in it — its files and its history. This cannot be undone.`,
        {
            title: `Remove this sandbox?`,
            kind: `warning`,
            okLabel: `Remove`,
        },
    );
    if (!confirmed) {
        return;
    }
    busy.value = { slug, action: `remove` };
    await start(`remove:${slug}`, () => sandboxRemove(slug));
    busy.value = undefined;
};

const busyFor = (slug: string): string | null => (busy.value?.slug === slug ? busy.value.action : null);

let stop: Array<() => void> = [];
onMounted(async () => {
    info.value = await desktopInfo();
    /* Listeners BEFORE the parked work, not after: `loadPending` starts the handed-over setup the moment it
     * finds one, and a script reaches this screen only as events — so a run begun before `onRun` is listening
     * would show an empty log through its first, most informative seconds. */
    stop = await Promise.all([
        onRun((event) => {
            runs.value = { ...runs.value, [event.run]: [...eventsOf(event.run), event] };
        }),
        onPendingSetup(() => void loadPending()),
        onPendingRecreate(() => void drainRecreate()),
        onUpdateAvailable((version) => (updateVersion.value = version)),
    ]);
    // A link that arrived while this screen was opening was PARKED rather than delivered, so it is picked up
    // exactly once — by the event above or by these, whichever finds the request still there.
    await Promise.all([refresh(), loadPending(), drainRecreate()]);
});
onUnmounted(() => stop.forEach((unlisten) => unlisten()));
</script>

<template>
    <div class="h-dvh overflow-auto bg-surface text-content">
        <!-- A column, not a stretched form: this face inherits the workspace's frame (windows.rs), which is a
             wide window, and everything on either screen is a short list of short things. Setup is ONE card in
             that frame, so it sits in the middle of it — pinned to the top it reads as a page that failed to
             load the rest of itself. -->
        <div :class="['mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 p-5', setupMode && 'justify-center']">
            <!-- SETUP — the whole window while it runs. Everything shown here was decided in the SPA; this
                 screen is where the part that touches the machine happens, and says so as it goes. -->
            <template v-if="setupMode">
                <Card class="flex flex-col gap-3">
                    <div class="flex items-start gap-2.5">
                        <Icon name="bolt" class="mt-0.5 text-primary-400" />
                        <div class="min-w-0 flex-1">
                            <h1 class="font-semibold leading-tight">Setting up {{ pending?.name ?? `your sandbox` }} on this computer</h1>
                            <p class="text-2xs text-subtle">
                                Running exactly what the install command runs: starts your sandbox in Docker, connects its tunnel, and opens your
                                workspace once it answers.
                            </p>
                        </div>
                    </div>
                    <p v-if="info && !info.dockerReady" class="flex items-start gap-2 text-2xs text-warning">
                        <Icon name="box" class="mt-0.5 shrink-0" />
                        <span v-if="info.os === `windows`"
                            >Docker isn't running yet — setup installs Docker Desktop first, which is a large download.</span
                        >
                        <span v-else>Docker isn't running yet — setup installs it first, so your system will ask for your password once.</span>
                    </p>
                    <RunLog
                        v-if="activeRun === `setup` || eventsOf(`setup`).length > 0"
                        :events="eventsOf(`setup`)"
                        :running="activeRun === `setup`"
                    />
                    <div v-if="setupError" :class="cmp.alertDanger('text-2xs')">{{ setupError }}</div>
                    <!-- Only on failure, and paired with a way out. A setup that stopped is the one place this
                         app can strand someone, and "try again" as the only control is a dead end wearing a
                         button. -->
                    <div v-if="setupError" class="flex flex-wrap items-center gap-2">
                        <Button label="Try again" :disabled="running" @click="runSetup">
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                        <Button severity="secondary" :text="true" label="Back to your workspace" @click="workspaceOpen">
                            <template #icon><Icon name="arrow-up-right" /></template>
                        </Button>
                    </div>
                </Card>
            </template>

            <!-- THE MANAGER — what this machine is running, once nothing is being handed over. -->
            <template v-else>
                <header class="flex items-center gap-3">
                    <h1 class="flex-1 text-base font-semibold">This computer</h1>
                    <span v-if="info" class="font-mono text-2xs text-subtle">v{{ info.version }}</span>
                    <Button size="small" severity="secondary" :text="true" label="Refresh" :disabled="running" @click="refresh">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                </header>

                <!-- The app updates itself; this is the notice, not a gate. -->
                <div v-if="updateVersion" :class="cmp.alertInfo('flex items-center gap-2 text-xs')">
                    <Icon name="arrow-circle-up" />
                    <span class="flex-1">Intentic {{ updateVersion }} is available — it installs the next time you quit.</span>
                </div>

                <p v-if="listError" class="flex items-start gap-2 text-2xs text-muted">
                    <Icon name="box" class="mt-0.5 shrink-0" />
                    <span>Docker isn't reachable, so there is nothing to show yet. Start Docker, or set a sandbox up from your workspace.</span>
                </p>
                <p v-else-if="sandboxes.length === 0" class="text-2xs text-muted">
                    No sandboxes here yet. Set one up from your workspace — this screen is where you manage it afterwards.
                </p>

                <SandboxCard
                    v-for="sandbox in sandboxes"
                    :key="sandbox.slug"
                    :sandbox="sandbox"
                    :busy="busyFor(sandbox.slug)"
                    :sync-line="syncLineFor(sandbox)"
                    @power="power"
                    @update="update"
                    @remove="remove"
                />

                <!-- DESKTOP SYNC — the half of this computer this window has never shown.
                     `syncDir` rides the setup link into connect.sh and was never heard from again, so the app
                     whose whole premise is not needing a terminal could say a container was up and nothing about
                     the sync the same setup had just configured. The only place these facts lived was
                     `intentic-sync status`. Below the sandboxes because it is about all of them at once. -->
                <section v-if="report || reportError" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
                    <div class="flex items-center gap-2">
                        <Icon name="sync" class="shrink-0 text-muted" />
                        <h2 class="flex-1 text-sm font-semibold">Desktop sync</h2>
                        <span v-if="report?.agents.sync" class="font-mono text-2xs text-subtle">agent v{{ report.agents.sync }}</span>
                    </div>
                    <div v-if="reportError" :class="cmp.alertDanger('text-2xs')">{{ reportError }}</div>
                    <MachineDetail v-if="report" :pairings="report.pairings" :ports="report.ports" :watcher="report.watcher" />
                </section>

                <!-- One run at a time, so one log: whichever operation is in flight owns this. -->
                <RunLog
                    v-if="activeRun !== undefined"
                    :events="eventsOf(activeRun)"
                    :running="true"
                    class="rounded-xl border border-line bg-canvas p-4"
                />

                <footer class="mt-auto flex items-center gap-2 pt-2">
                    <Button size="small" severity="secondary" label="Open workspace" @click="workspaceOpen">
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <span v-if="info" class="truncate font-mono text-2xs text-subtle">{{ info.appUrl }}</span>
                </footer>
            </template>
        </div>
    </div>
</template>
